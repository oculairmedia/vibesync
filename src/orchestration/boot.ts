import {
  FormulaDispatcher,
  installWritebackHook,
  type ProviderResolver,
  type RoleAgentBootstrapContextResolver,
  type RoleAgentBootstrapperLike,
  type WritebackStore,
} from './dispatcher/index.js';
import { EventBus, WorkActivityReporter } from './events/index.js';
import { HealthPatrol } from './health/index.js';
import { MoleculeWalker } from './molecule/index.js';
import {
  LettaCodeSubagentProvider,
  createDefaultPersonaLoader,
} from './runtime/index.js';
import type { PersonaLoader, RuntimeProvider } from './runtime/index.js';
import type { DoltClient } from './store/index.js';
import { installLettaClientValidationFilter } from '../letta/LettaClientValidationFilter.js';

export interface OrchestrationHandle {
  readonly dispatcher: FormulaDispatcher;
  readonly provider: RuntimeProvider;
  readonly bus: EventBus;
  readonly patrol: HealthPatrol;
  readonly walker: MoleculeWalker;
  shutdown(): Promise<void>;
}

export interface BootOrchestrationPlaneOptions {
  readonly dolt: DoltClient;
  readonly persistEvents?: boolean;
  readonly runDriftAuditOnBoot?: boolean;
  readonly maxConcurrentMolecules?: number;
  /**
   * Per-project provider routing (vibesync-f5g / vibesync-8hk).
   * When supplied with a routingStore, the dispatcher consults the
   * projects.provider_kind / projects.letta_base_url columns at
   * dispatch time and routes to LettaCodeSubagentProvider (or any
   * future provider) for projects that opt in.
   *
   * `routingStore` is an injectable adapter so boot doesn't reach
   * into SyncDatabase directly — keeps the orchestration plane free
   * of a SQLite import. The production caller wires up
   * { getProjectProviderRouting: db.getProjectProviderRouting.bind(db) }.
   *
   * `personaLoader` is required when at least one project routes to
   * `letta-code-subagent`; it reads packs/<pack>/.letta/agents/<role>.md
   * to build the inline persona block. Defaults to
   * createDefaultPersonaLoader(packs/gastown).
   */
  readonly providerRouting?: BootOrchestrationProviderRoutingOptions;
}

export interface ProjectProviderRoutingStore {
  /**
   * Return the per-project routing row for `projectIdentifier`, or
   * null if the project doesn't exist or has no override. The
   * dispatcher tolerates either shape — a null row OR a row with
   * null fields both fall through to the default provider.
   */
  getProjectProviderRouting(projectIdentifier: string): {
    readonly lettaBaseUrl: string | null;
    readonly providerKind: string | null;
    readonly parentAgentId?: string | null;
    // lcp-kamu: per-project pack/storage dirs read from the projects DB row,
    // replacing the hardcoded packDirsByProject/storageDirsByProject maps.
    readonly packDir?: string | null;
    readonly storageDir?: string | null;
  } | null;
}

export interface BootOrchestrationProviderRoutingOptions {
  /** Source of truth for per-project routing rows. */
  readonly store: ProjectProviderRoutingStore;
  /** Persona loader for letta-code-subagent. Default reads packs/gastown. */
  readonly personaLoader?: PersonaLoader;
  /**
   * Legacy/static fallback map for tests and non-database callers.
   * Production routing reads the PM parent id from projects.letta_agent_id
   * via ProjectProviderRoutingStore.parentAgentId.
   */
  readonly parentAgentIds?: Readonly<Record<string, string>>;
  /**
   * Optional cap on the per-shim provider cache. Tests inject 0 to
   * disable caching. Default: unlimited.
   */
  readonly cacheLimit?: number;
  /**
   * vibesync-mcz Phase D — persistent per-(project, role) subagent
   * bootstrap. When supplied alongside a per-project pack lookup,
   * the dispatcher will call `bootstrapper.ensureRoleAgent` for
   * each step's role on letta-code-subagent projects, threading the
   * resulting agentId through extra.agentId so the provider
   * dispatches against the persistent role agent (Phase C path).
   *
   * lcp-kamu: packDir and storageDir are now read from the
   * projects.pack_dir and projects.storage_dir DB columns with
   * defaults (packs/gastown, /root/.letta/lc-local-backend).
   * packDirsByProject and storageDirsByProject are DEPRECATED
   * legacy maps kept for backward-compat; new projects should leave
   * these DB columns null to use the defaults (no source edit required).
   */
  readonly roleAgentBootstrapper?: RoleAgentBootstrapperLike;
  /**
   * @deprecated lcp-kamu: Use projects.pack_dir column instead.
   * Legacy static map for tests.
   */
  readonly packDirsByProject?: Readonly<Record<string, string>>;
  /**
   * @deprecated lcp-kamu: Use projects.storage_dir column instead.
   * Legacy static map for tests.
   */
  readonly storageDirsByProject?: Readonly<Record<string, string>>;
}

export async function bootOrchestrationPlane(opts: BootOrchestrationPlaneOptions): Promise<OrchestrationHandle> {
  // Opt-in silence of @letta-ai/letta-client "Failed to validate." spam
  // (vibesync-vkp). No-op unless LETTA_SILENCE_VALIDATION_SPAM is set.
  installLettaClientValidationFilter();

  // Verify the bd schema matches the version we vendored a fingerprint
  // for before any hot-path INSERT runs. See vibesync-bll.
  if (typeof (opts.dolt as { verifySchema?: () => Promise<void> }).verifySchema === 'function') {
    await (opts.dolt as { verifySchema: () => Promise<void> }).verifySchema();
  }

  const bus = new EventBus({ noPersist: opts.persistEvents === false });
  const provider = buildDefaultRuntimeProvider({
    allowUnavailable: opts.providerRouting !== undefined,
  });
  const patrol = new HealthPatrol(bus);
  patrol.start();

  if (opts.runDriftAuditOnBoot !== false) {
    bus.emit({
      layer: 'runtime',
      kind: 'runtime/teammate.drift_audit.skipped',
      payload: { reason: 'boot adapters not wired yet' },
    });
  }

  const walker = new MoleculeWalker(opts.dolt);
  const maxConcurrentMolecules = opts.maxConcurrentMolecules ?? readMaxConcurrentMoleculesFromEnv();
  const providerResolver = opts.providerRouting
    ? buildProviderResolver(opts.providerRouting)
    : undefined;
  const roleAgentContextResolver = opts.providerRouting
    ? buildRoleAgentContextResolver(opts.providerRouting)
    : undefined;
  const dispatcher = new FormulaDispatcher({
    provider,
    walker,
    eventBus: bus,
    ...(maxConcurrentMolecules === undefined ? {} : { maxConcurrentMolecules }),
    ...(providerResolver ? { providerResolver } : {}),
    ...(roleAgentContextResolver ? { roleAgentContextResolver } : {}),
  });

  // Molecule → motivating-bead writeback hook (vibesync-0xo). Idempotent
  // via a writeback stamp on the molecule_root metadata.
  let unsubscribeWriteback: (() => void) | null = null;
  if (hasWritebackStore(opts.dolt)) {
    unsubscribeWriteback = installWritebackHook({
      bus,
      walker,
      store: opts.dolt,
      // vibesync-er21: writeback failures must be loud, never silent — a
      // dropped writeback is a broken loop-back to human-tracked work.
      // The `info` channel (vibesync-er21 hook-wiring) carries the
      // subscription-confirmed line and every per-invocation trace, so the
      // daemon log proves the hook is wired AND shows each time it fires.
      logger: {
        warn(obj: unknown, msg: string): void {
          // eslint-disable-next-line no-console
          console.error(`[orchestration:writeback] ${msg}`, obj);
        },
        info(obj: unknown, msg: string): void {
          // eslint-disable-next-line no-console
          console.log(`[orchestration:writeback] ${msg}`, obj);
        },
      },
    });
    // eslint-disable-next-line no-console
    console.log('[orchestration:writeback] writeback hook installed (store implements appendNoteToBead + recordMoleculeWriteback)');
  } else {
    // Loud, actionable boot line: without this, a store that doesn't expose
    // the writeback methods silently disables the entire loop-back and no
    // completed molecule ever writes back — with zero signal in the log.
    // eslint-disable-next-line no-console
    console.warn('[orchestration:writeback] writeback hook NOT installed — dolt store does not implement appendNoteToBead + recordMoleculeWriteback; molecule outcomes will NOT be written back to motivating beads');
  }

  // vibesync-ryhc: work-activity reporter for mobile active-subagent bar.
  // Enabled only when shimBaseUrl is configured AND VIBESYNC_WORK_ACTIVITY_REPORT
  // is not explicitly disabled.
  let workActivityReporter: WorkActivityReporter | null = null;
  const shimBaseUrl = process.env['VIBESYNC_LETTA_CODE_SHIM_URL'] ?? process.env['LETTA_CODE_SHIM_URL'];
  const workActivityEnabled = process.env['VIBESYNC_WORK_ACTIVITY_REPORT'] !== '0';
  if (shimBaseUrl && workActivityEnabled) {
    const password = process.env['VIBESYNC_LETTA_CODE_PASSWORD'] ?? process.env['LETTA_CODE_PASSWORD'];
    workActivityReporter = new WorkActivityReporter({
      eventBus: bus,
      shimBaseUrl,
      password,
    });
    workActivityReporter.start();
  }

  let shutDown = false;

  return {
    dispatcher,
    provider,
    bus,
    patrol,
    walker,
    async shutdown(): Promise<void> {
      if (shutDown) return;
      shutDown = true;
      unsubscribeWriteback?.();
      patrol.stop();
      workActivityReporter?.stop();
    },
  };
}

function buildDefaultRuntimeProvider(opts: { readonly allowUnavailable?: boolean } = {}): RuntimeProvider {
  const providerKind = process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] ?? 'letta-code-subagent';
  if (providerKind !== 'letta-code-subagent') {
    throw new Error(`Unsupported orchestration provider "${providerKind}". Letta Teams was removed; use VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-subagent.`);
  }
  const shimBaseUrl = process.env['VIBESYNC_LETTA_CODE_SHIM_URL'] ?? process.env['LETTA_CODE_SHIM_URL'];
  const parentAgentId = process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] ?? process.env['LETTA_CODE_PARENT_AGENT_ID'];
  if (!shimBaseUrl || !parentAgentId) {
    if (opts.allowUnavailable) {
      // Per-project routing can still supply both the shim URL and PM
      // parent id from the projects row. Keep boot alive so routed
      // dispatches work; unrouted dispatches fail at start with the
      // same actionable configuration message.
      return buildUnavailableDefaultProvider(
        'letta-code orchestration requires VIBESYNC_LETTA_CODE_SHIM_URL and VIBESYNC_LETTA_CODE_PARENT_AGENT_ID for default-project dispatch',
      );
    }
    throw new Error('letta-code orchestration requires VIBESYNC_LETTA_CODE_SHIM_URL and VIBESYNC_LETTA_CODE_PARENT_AGENT_ID');
  }
  return wrapWithParentAgentId(new LettaCodeSubagentProvider({
    shimBaseUrl,
    personaLoader: createDefaultPersonaLoader('packs/gastown'),
  }), parentAgentId);
}

function buildUnavailableDefaultProvider(message: string): RuntimeProvider {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    kind: 'letta-code-subagent',
    start: fail,
    stop: async () => {},
    prompt: fail,
    nudge: async () => {},
    async *observe() {
      yield { kind: 'error', ts: new Date().toISOString(), code: 'provider-unavailable', message };
    },
  };
}

function hasWritebackStore(dolt: unknown): dolt is WritebackStore {
  const candidate = dolt as { appendNoteToBead?: unknown; recordMoleculeWriteback?: unknown };
  return typeof candidate.appendNoteToBead === 'function' && typeof candidate.recordMoleculeWriteback === 'function';
}

/**
 * Construct the dispatcher's per-project ProviderResolver. Reads the
 * projects.provider_kind + projects.letta_base_url row for the
 * dispatch's projectIdentifier, and either returns a cached
 * provider for that shim or constructs a fresh one. Returns null
 * when the project has no override — the dispatcher then falls
 * back to the boot-level letta-code local backend provider.
 *
 * Exported for unit tests; production callers go through
 * bootOrchestrationPlane.
 */
export function buildProviderResolver(opts: BootOrchestrationProviderRoutingOptions): ProviderResolver {
  const cache = new Map<string, RuntimeProvider>();
  const cacheKey = (kind: string, url: string): string => `${kind}@${url}`;
  const personaLoader = opts.personaLoader ?? createDefaultPersonaLoader('packs/gastown');
  return {
    resolve(input): RuntimeProvider | null {
      const projectId = input.projectIdentifier;
      if (!projectId) return null;
      const row = opts.store.getProjectProviderRouting(projectId);
      if (!row || !row.providerKind) {
        // No override — let the dispatcher use its boot-level local
        // backend provider.
        return null;
      }
      if (row.providerKind === 'letta-teams') {
        // Legacy rows are no longer executable. Falling back to the
        // boot-level local backend keeps formulas running while making
        // the stale config visible in logs.
        // eslint-disable-next-line no-console
        console.warn(
          `[boot] provider routing: project ${projectId} requested removed provider_kind='letta-teams' — using letta-code-subagent default`,
        );
        return null;
      }
      if (row.providerKind === 'letta-code-subagent') {
        const url = row.lettaBaseUrl;
        if (!url) {
          // Misconfigured row — log and fall back. Throwing here would
          // break formula dispatch for projects that opted in but
          // didn't supply a URL, which is a degraded state but not a
          // dispatcher fault.
          // eslint-disable-next-line no-console
          console.warn(
            `[boot] provider routing: project ${projectId} has provider_kind='letta-code-subagent' but no letta_base_url — falling back to default`,
          );
          return null;
        }
        const parentAgentId = row.parentAgentId ?? opts.parentAgentIds?.[projectId];
        if (!parentAgentId) {
          // eslint-disable-next-line no-console
          console.warn(
            `[boot] provider routing: project ${projectId} routes to letta-code-subagent but no parent agent id supplied — falling back to default`,
          );
          return null;
        }
        const key = cacheKey('letta-code-subagent', url);
        const cached = cache.get(key);
        if (cached) {
          return wrapWithParentAgentId(cached, parentAgentId);
        }
        const provider = new LettaCodeSubagentProvider({
          shimBaseUrl: url,
          personaLoader,
        });
        if (opts.cacheLimit === undefined || opts.cacheLimit > 0) cache.set(key, provider);
        return wrapWithParentAgentId(provider, parentAgentId);
      }
      // Unknown provider kind — log once and fall back.
      // eslint-disable-next-line no-console
      console.warn(
        `[boot] provider routing: project ${projectId} requested unknown provider_kind='${row.providerKind}' — falling back to default`,
      );
      return null;
    },
  };
}

/**
 * vibesync-mcz Phase D / lcp-kamu — construct the dispatcher's persistent
 * role-agent bootstrap context resolver. Returns null when the project
 * is not on the letta-code-subagent path or when the
 * bootstrapper/pack-dir/storage-dir mapping isn't available.
 *
 * lcp-kamu: packDir and storageDir now come from the projects DB row
 * (projects.pack_dir, projects.storage_dir) with sensible defaults when
 * NULL. This removes the hardcoded map requirement — new projects
 * onboard with zero source edits.
 *
 * Exported for unit tests; production callers go through
 * bootOrchestrationPlane.
 */
export function buildRoleAgentContextResolver(
  opts: BootOrchestrationProviderRoutingOptions,
): RoleAgentBootstrapContextResolver {
  const DEFAULT_PACK_DIR = 'packs/gastown';
  const DEFAULT_STORAGE_DIR = '/root/.letta/lc-local-backend';

  return {
    resolve(input) {
      const projectId = input.projectIdentifier;
      if (!projectId) {
        // eslint-disable-next-line no-console
        console.warn(
          '[boot] buildRoleAgentContextResolver: no projectIdentifier in input — cannot resolve role-agent context',
        );
        return null;
      }

      const row = opts.store.getProjectProviderRouting(projectId);
      if (!row) {
        // eslint-disable-next-line no-console
        console.warn(
          `[boot] buildRoleAgentContextResolver: project '${projectId}' has no provider routing row — coder dispatch will fail`,
        );
        return null;
      }

      if (row.providerKind !== 'letta-code-subagent') {
        // Expected for projects not using letta-code-subagent; no warning needed.
        return null;
      }

      const bootstrapper = opts.roleAgentBootstrapper;
      if (!bootstrapper) {
        // eslint-disable-next-line no-console
        console.warn(
          `[boot] buildRoleAgentContextResolver: project '${projectId}' routes to letta-code-subagent but no bootstrapper configured — coder dispatch will fail`,
        );
        return null;
      }

      // lcp-kamu: read from DB row, fall back to legacy map, then use default.
      const packDir =
        row.packDir ??
        opts.packDirsByProject?.[projectId] ??
        DEFAULT_PACK_DIR;

      const storageDir =
        row.storageDir ??
        opts.storageDirsByProject?.[projectId] ??
        DEFAULT_STORAGE_DIR;

      const lettaBaseUrl = row.lettaBaseUrl;
      if (!lettaBaseUrl) {
        // eslint-disable-next-line no-console
        console.warn(
          `[boot] buildRoleAgentContextResolver: project '${projectId}' routes to letta-code-subagent but no lettaBaseUrl configured (projects.letta_base_url is NULL) — coder dispatch will fail`,
        );
        return null;
      }

      // All pieces present — return the bootstrap context.
      return { bootstrapper, packDir, storageDir, lettaBaseUrl };
    },
  };
}

/**
 * Return a thin RuntimeProvider façade that injects
 * `extra.parentAgentId` into every start() call before delegating to
 * the underlying provider. This lets the per-project routing carry
 * the PM agent id without polluting DispatchInput (the dispatcher
 * keeps its hands clean of provider-specific extras).
 *
 * Exported for unit tests.
 */
export function wrapWithParentAgentId(
  inner: RuntimeProvider,
  parentAgentId: string,
): RuntimeProvider {
  return {
    kind: inner.kind,
    start(spec) {
      return inner.start({
        ...spec,
        extra: { ...(spec.extra ?? {}), parentAgentId },
      });
    },
    stop: inner.stop.bind(inner),
    prompt: inner.prompt.bind(inner),
    nudge: inner.nudge.bind(inner),
    observe: inner.observe.bind(inner),
  };
}

function readMaxConcurrentMoleculesFromEnv(): number | undefined {
  const raw = process.env['VIBESYNC_MAX_CONCURRENT_MOLECULES'];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}
