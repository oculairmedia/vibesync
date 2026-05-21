import { FormulaDispatcher, installWritebackHook, type ProviderResolver, type WritebackStore } from './dispatcher/index.js';
import { EventBus } from './events/index.js';
import { HealthPatrol } from './health/index.js';
import { MoleculeWalker } from './molecule/index.js';
import {
  LettaCodeSubagentProvider,
  LettaTeamsProvider,
  createDefaultPersonaLoader,
} from './runtime/index.js';
import type { PersonaLoader, RuntimeProvider, ToolAttacher } from './runtime/index.js';
import type { DoltClient } from './store/index.js';
import { LettaTeamsBackendConfig } from '../letta/LettaTeamsBackendConfig.js';
import { installLettaClientValidationFilter } from '../letta/LettaClientValidationFilter.js';
import { assertLettaTeamsVersionMatch } from '../letta/LettaTeamsVersionCheck.js';

export interface OrchestrationHandle {
  readonly dispatcher: FormulaDispatcher;
  readonly provider: LettaTeamsProvider;
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
   * Optional adapter that resolves role-declared tool names (from
   * roleConfig.tools, threaded through dispatcher → extra.tools) to
   * attach calls on the spawned teammate's Letta agent. When omitted,
   * declared tools are skipped with a single `runtime/teammate.tool_attach.skipped`
   * event per spawn (reason='no_attacher'). See vibesync-cs2.
   */
  readonly toolAttacher?: ToolAttacher;
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
  } | null;
}

export interface BootOrchestrationProviderRoutingOptions {
  /** Source of truth for per-project routing rows. */
  readonly store: ProjectProviderRoutingStore;
  /** Persona loader for letta-code-subagent. Default reads packs/gastown. */
  readonly personaLoader?: PersonaLoader;
  /**
   * Map of agent ids to use for each project that routes to
   * letta-code-subagent. Required because the routing row holds the
   * shim URL but not the PM agent id — boot wires that mapping from
   * the projects.letta_agent_id column at boot time (or a caller-
   * supplied static map for tests).
   *
   * The shape is { [projectIdentifier]: agentId }. Missing entries
   * fall back to the default provider.
   */
  readonly parentAgentIds?: Readonly<Record<string, string>>;
  /**
   * Optional cap on the per-shim provider cache. Tests inject 0 to
   * disable caching. Default: unlimited.
   */
  readonly cacheLimit?: number;
}

export async function bootOrchestrationPlane(opts: BootOrchestrationPlaneOptions): Promise<OrchestrationHandle> {
  const backend = new LettaTeamsBackendConfig();
  backend.applyToProcessEnv();

  // Boot-time SDK ↔ CLI version pin (vibesync-3dz). Refuses to start the
  // dispatcher on major/minor skew with an actionable error. Also
  // resolves LETTA_TEAMS_CLI_ENTRY so the SDK does not fall back to
  // process.argv[1] (vibesync's own entrypoint), which was the original
  // bring-up failure mode.
  assertLettaTeamsVersionMatch();

  // Opt-in silence of @letta-ai/letta-client "Failed to validate." spam
  // (vibesync-vkp). No-op unless LETTA_SILENCE_VALIDATION_SPAM is set.
  installLettaClientValidationFilter();

  // Verify the bd schema matches the version we vendored a fingerprint
  // for before any hot-path INSERT runs. See vibesync-bll.
  if (typeof (opts.dolt as { verifySchema?: () => Promise<void> }).verifySchema === 'function') {
    await (opts.dolt as { verifySchema: () => Promise<void> }).verifySchema();
  }

  const bus = new EventBus({ noPersist: opts.persistEvents === false });
  const provider = new LettaTeamsProvider({
    eventBus: bus,
    memoryBlockSeeder: backend.buildSeeder(),
    teammateDeleter: backend.buildDeleter(),
    ...(opts.toolAttacher ? { toolAttacher: opts.toolAttacher } : {}),
  });
  const patrol = new HealthPatrol(bus);
  const daemon = provider.daemonSupervisor();
  patrol.trackDaemon(daemon);
  patrol.start();
  await provider.ensureDaemonRunning();

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
  const dispatcher = new FormulaDispatcher({
    provider,
    walker,
    eventBus: bus,
    ...(maxConcurrentMolecules === undefined ? {} : { maxConcurrentMolecules }),
    ...(providerResolver ? { providerResolver } : {}),
  });

  // Molecule → motivating-bead writeback hook (vibesync-0xo). Idempotent
  // via a writeback stamp on the molecule_root metadata.
  let unsubscribeWriteback: (() => void) | null = null;
  if (hasWritebackStore(opts.dolt)) {
    unsubscribeWriteback = installWritebackHook({
      bus,
      walker,
      store: opts.dolt,
    });
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
      patrol.untrackDaemon(daemon.id);
      await daemon.stop();
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
 * back to the default LettaTeamsProvider wired in boot.
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
      if (!row || !row.providerKind || row.providerKind === 'letta-teams') {
        // No override or explicitly the default — let the dispatcher
        // use its default provider. (Avoids spinning up a redundant
        // LettaTeamsProvider per project.)
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
        const parentAgentId = opts.parentAgentIds?.[projectId];
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
