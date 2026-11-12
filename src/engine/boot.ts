import { realpathSync } from 'node:fs';
import {
  createGhDeliveryVerifier,
  createGhShippedWorkProbe,
  ghRepositoryTarget,
  type ShippedWorkProbe,
  type StepReplyJudge,
  createGhPrChecksReader,
  type ProjectMemorySource,
  type DeliveryVerifier,
  type ProjectBinding,
  type ProjectBindingResolver,
  UnknownProjectError,
  FormulaDispatcher,
  installWritebackHook,
  type ProviderResolver,
} from './dispatcher/index.js';
import { EventBus } from './events/index.js';
import { INTERRUPTED_EVENT, MoleculeWalker, recoverInterruptedMolecules } from './molecule/index.js';
import { IROH_PROVIDER_KIND, IrohWrapperProvider } from './runtime/index.js';
import type { IrohConnection } from './runtime/index.js';
import { createNativeIrohConnection, resolveNativeIrohConfig } from './runtime/iroh/native-dialer.js';
import type { AgentIdResolver, RuntimeProvider } from './runtime/index.js';
import { startSchedulerDaemon, SCHEDULER_START_FAILED_EVENT } from './scheduler/boot-scheduler.js';
import { StepDispatcher, StoreReadyStepSource } from './scheduler/step-dispatcher.js';
import { assertBdVersion } from './bd-version.js';
import { BeadsStore, createCheckoutGhRunner, createCliRunner, type CommandRunner } from './beads/index.js';
import { createBdProjectBeadStore } from './beads/project-bead-store.js';
import type { MoleculeStore } from './molecule/molecule.js';
import type { WritebackStore } from './dispatcher/writeback-hook.js';
import { createInboxCliAdapter } from './pm-wake/inbox-cli-adapter.js';
import type { BootSchedulerOptions, SchedulerHandle } from './scheduler/boot-scheduler.js';
import type { DoltClient } from './store/index.js';
import { startWaitWatcher } from './waits/boot-waits.js';
import type { BootWaitsOptions, WaitsHandle } from './waits/boot-waits.js';

export interface OrchestrationHandle {
  readonly dispatcher: FormulaDispatcher;
  readonly provider: RuntimeProvider;
  readonly bus: EventBus;
  readonly walker: MoleculeWalker;
  /** Ready-step loop (vibesync-efee). Engine-owned timer and event kicks. */
  readonly steps: StepDispatcher;
  /** Running scheduler daemons keyed by project identifier. */
  readonly schedulers: ReadonlyMap<string, SchedulerHandle>;
  /**
   * The running durable-wait watcher (vibesync-9g24), or null when
   * `waits.config.enabled` is false / not supplied / failed to start.
   */
  readonly waits: WaitsHandle | null;
  shutdown(): Promise<void>;
}

export interface BootOrchestrationPlaneOptions {
  readonly dolt: DoltClient;
  /** bd CLI bound to the same project as `dolt`; all molecule writes go through it. Defaults to `bd` in `dolt.beadsRoot`. */
  readonly bd?: CommandRunner;
  /**
   * Replace the Beads gateway wholesale (unit tests with an in-memory store).
   * Production leaves this unset: reads come from `dolt`, writes from `bd`.
   */
  readonly beadsStore?: MoleculeStore & WritebackStore;
  /** Molecule id prefix. Defaults to the project's bd `issue_prefix`, which bd enforces on create. */
  readonly moleculeIdPrefix?: string;
  readonly persistEvents?: boolean;
  readonly runDriftAuditOnBoot?: boolean;
  readonly maxConcurrentMolecules?: number;
  /**
   * Per-project provider routing (vibesync-f5g / vibesync-8hk). At dispatch
   * time the dispatcher reads the project's routing row (provider_kind and the
   * PM parent agent id). `letta-code-iroh` is the only provider kind; any
   * other value is a stale row and fails the dispatch loudly (vibesync-9lzk.29).
   *
   * `store` is an injectable adapter so boot doesn't reach into Registry
   * directly, which keeps the orchestration plane free of a SQLite import.
   */
  readonly providerRouting?: BootOrchestrationProviderRoutingOptions;
  /**
   * SchedulerDaemon activation (vibesync-z2ws, layering invariant 4: config is
   * the activation mechanism). Absent or `config.enabled === false` => the
   * daemon is never constructed: no timer, no `bd` call. Adapters (`bd`, `gh`,
   * pool-member lookup) are injected so this plane imports no database.
   */
  readonly schedulers?: readonly BootSchedulerOptions[];
  /**
   * Confirms declared formula deliveries (vibesync-9lzk.21). Defaults to the
   * `gh` CLI (the scheduler's gh runner when supplied, else `gh` on PATH).
   */
  readonly deliveryVerifier?: DeliveryVerifier;
  /** Checkout path of a registered project, or null when the registry does not know it. */
  readonly projectRoot?: (projectIdentifier: string) => string | null;
  /** The gh bound to a checkout (the home one included). Tests inject a fake; production runs the real CLI there. */
  readonly projectGh?: (root: string) => CommandRunner;
  /** The bd bound to a project checkout. Tests inject a fake; production uses bd in that root. */
  readonly projectBd?: (root: string) => CommandRunner;
  /**
   * Codebase memories injected into step prompts (vibesync-9lzk.25), keyed by
   * the step's project. Supplied by the app, which can resolve a project's
   * checkout; absent = no memory section.
   */
  readonly projectMemory?: ProjectMemorySource;
  /** Plan-only step guard (vibesync-9lzk.37). Defaults to the project's `gh`. */
  readonly shippedWorkProbe?: ShippedWorkProbe;
  /** vibesync-9lzk.39: step-reply decision model. Absent = marker lines only. */
  readonly stepJudge?: StepReplyJudge;
  /**
   * vibesync-9lzk.46: the fast PR checks the final step waits on (the engine's
   * inner loop). Slow merge gates (integration-bd) are deliberately not here.
   */
  readonly projectCiChecks?: (projectIdentifier: string | undefined) => readonly string[];
  /**
   * Durable wait-on-beads watcher (vibesync-9g24, invariant 4). Absent or
   * `config.enabled === false` => nothing is constructed: no watcher, no timer,
   * no `bd` call.
   */
  readonly waits?: BootWaitsOptions;
  /**
   * Test seam for provider kind 'letta-code-iroh' (vibesync-x38j): supplies the
   * Iroh connection instead of the native @number0/iroh dialer. Production
   * leaves this unset.
   */
  readonly irohConnectionFactory?: () => IrohConnection;
  /**
   * Returns the `bd --version` output. When supplied, boot refuses a bd older
   * than MIN_BD_VERSION (vibesync-efee: formula steps rely on `bd ready --mol`)
   * with a BdVersionTooOldError naming the version found. Production passes
   * `probeBdVersion`; tests that never touch bd omit it.
   */
  readonly bdVersion?: () => Promise<string>;
  /** Test seam: use this RuntimeProvider instead of building the env-configured default. */
  readonly provider?: RuntimeProvider;
  /** Step-loop interval. Default 1000 ms. */
  readonly stepTickIntervalMs?: number;
}

export interface ProjectProviderRoutingStore {
  /**
   * Return the per-project routing row for `projectIdentifier`, or
   * null if the project doesn't exist or has no override. The
   * dispatcher tolerates either shape — a null row OR a row with
   * null fields both fall through to the default provider.
   */
  getProjectProviderRouting(projectIdentifier: string): {
    readonly providerKind: string | null;
    readonly parentAgentId?: string | null;
  } | null;
}

export interface BootOrchestrationProviderRoutingOptions {
  /** Source of truth for per-project routing rows. */
  readonly store: ProjectProviderRoutingStore;
  /**
   * Legacy/static fallback map for tests and non-database callers.
   * Production routing reads the PM parent id from projects.letta_agent_id
   * via ProjectProviderRoutingStore.parentAgentId.
   */
  readonly parentAgentIds?: Readonly<Record<string, string>>;
  /**
   * vibesync-x38j: shared Iroh provider for projects routed to
   * 'letta-code-iroh'. Boot passes a memoized getter so the default provider
   * and per-project routing share ONE connection; when absent (direct use of
   * buildProviderResolver) the resolver builds its own from the environment.
   */
  readonly irohProvider?: () => IrohWrapperProvider;
  /**
   * vibesync-jni4: read side of project_role_agents. A project routed to
   * 'letta-code-iroh' dispatches each step DIRECTLY to the role agent this
   * returns for (project, role); there is no fallback agent, so without it (and
   * without extra.agentId) every Iroh step fails loudly. Production wires
   * `db.getRoleAgent`.
   */
  readonly roleAgentLookup?: RoleAgentLookup;
}

/** Minimal read view of project_role_agents (structural subset of Registry.getRoleAgent). */
export interface RoleAgentLookup {
  getRoleAgent(projectIdentifier: string, roleName: string): { readonly agentId: string } | null;
}

/**
 * vibesync-jni4: AgentIdResolver over project_role_agents for the Iroh provider.
 * Returns null (=> the step fails with a clear reason) when there is no row.
 */
export function createRoleAgentTableResolver(lookup: RoleAgentLookup | undefined): AgentIdResolver | undefined {
  if (!lookup) return undefined;
  return {
    async resolveRoleAgent(role, _parentAgentId, projectIdentifier) {
      if (!projectIdentifier) return null;
      return lookup.getRoleAgent(projectIdentifier, role)?.agentId ?? null;
    },
  };
}

/**
 * Release a Dolt pool that a boot attempt opened but did not hand off to a
 * live orchestration plane. `DoltClient.connect` cleans up its own failures,
 * so once it returns the retrying caller in `main()` owns the pool until boot
 * succeeds: on boot failure the pool must be closed before the next connect
 * attempt, otherwise each retry leaks a pool. Cleanup errors are swallowed
 * (reported via `onCleanupError`) so they never mask the original boot error.
 *
 * Extracted as a pure, awaitable helper so the retry-ownership contract can be
 * unit-tested without standing up `main()`. See CodeRabbit review on #44.
 */
export async function releaseDoltAfterFailedBoot(
  dolt: { close(): Promise<void> } | undefined,
  orchestrationInitialized: boolean,
  opts: { onCleanupError?: (err: unknown) => void } = {},
): Promise<void> {
  if (!dolt || orchestrationInitialized) return;
  try {
    await dolt.close();
  } catch (cleanupError) {
    opts.onCleanupError?.(cleanupError);
  }
}

/** Repository-bound collaborators for one checkout, all built from the gh that runs there. */
function createRepositoryBinding(gh: CommandRunner, ciCheckNames: readonly string[], workBeads: ProjectBinding['workBeads'] = null): ProjectBinding {
  const repositoryTarget = ghRepositoryTarget(gh);
  return {
    workBeads,
    deliveryVerifier: createGhDeliveryVerifier(gh, repositoryTarget),
    shippedWorkProbe: createGhShippedWorkProbe(gh, repositoryTarget),
    // Always a reader: a project that names no checks must fail closed at the final step, which
    // `null` (no reader at all, e.g. an embedder) would not: an approving reply would stand.
    prChecks: { reader: createGhPrChecksReader(gh), names: ciCheckNames },
    repository: async () => (await repositoryTarget()).repository,
  };
}

/**
 * vibesync-9lzk.55.1: the binding for a run's project. No project, or no
 * registry lookup, is the home project (the checkout that owns this engine's
 * tracker). A project whose registered checkout IS the home checkout is home
 * too. Any other registered project gets collaborators bound to its own
 * checkout. A project the registry does not know throws: nothing is ever
 * verified in the home repository on its behalf.
 *
 * The registry is asked on every call, because a project's checkout path can be
 * changed while the service runs (PATCH /api/registry/projects/:id). A binding
 * is reused only while the project still resolves to the same canonical path.
 */
function buildProjectBindings(args: {
  readonly homeRoot: string;
  readonly homeBinding: ProjectBinding;
  readonly projectRoot: ((projectIdentifier: string) => string | null) | undefined;
  readonly ghFor: (root: string) => CommandRunner;
  readonly bdFor: (root: string) => CommandRunner;
  readonly projectCiChecks: (projectIdentifier: string) => readonly string[];
}): ProjectBindingResolver {
  // Resolved on first use, not at boot: an engine that is never asked about a
  // project (single-repository use) needs no home checkout on disk.
  let homeRoot: string | null = null;
  const byProject = new Map<string, { readonly root: string; readonly binding: ProjectBinding }>();
  return (projectIdentifier) => {
    if (!projectIdentifier || !args.projectRoot) return args.homeBinding;
    const registered = args.projectRoot(projectIdentifier);
    if (!registered) throw new UnknownProjectError(projectIdentifier);
    const root = canonicalRoot(registered, projectIdentifier);
    const cached = byProject.get(projectIdentifier);
    if (cached?.root === root) return cached.binding;
    homeRoot ??= realpathSync(args.homeRoot);
    const binding = root === homeRoot ? args.homeBinding : createRepositoryBinding(
      args.ghFor(root),
      args.projectCiChecks(projectIdentifier),
      createBdProjectBeadStore(args.bdFor(root)),
    );
    byProject.set(projectIdentifier, { root, binding });
    return binding;
  };
}

/** The checkout's real path. A registered path that does not exist is as unusable as an unregistered project. */
function canonicalRoot(registered: string, projectIdentifier: string): string {
  try {
    return realpathSync(registered);
  } catch {
    throw new UnknownProjectError(projectIdentifier, `registered checkout ${registered} does not exist`);
  }
}


function withInboxAdapter<T>(adapter: T | undefined): { inboxAdapter?: T } {
  return adapter ? { inboxAdapter: adapter } : {};
}

export async function bootOrchestrationPlane(opts: BootOrchestrationPlaneOptions): Promise<OrchestrationHandle> {
  // vibesync-efee: fail before any side effect when bd is too old for the
  // primitives formula steps depend on.
  if (opts.bdVersion) assertBdVersion(await opts.bdVersion());

  // Also protect callers using the synchronous constructor. The caller owns
  // cleanup on boot failure; connect has already verified production clients.
  if (typeof opts.dolt.verifyFingerprint === 'function') {
    await opts.dolt.verifyFingerprint();
  }

  // Verify the bd schema matches the version we vendored a fingerprint
  // for before any hot-path read runs. See vibesync-bll.
  if (typeof (opts.dolt as { verifySchema?: () => Promise<void> }).verifySchema === 'function') {
    await (opts.dolt as { verifySchema: () => Promise<void> }).verifySchema();
  }

  // bd enforces the project's issue prefix on create; the SQL writes used to
  // bypass that and mint `mol-mol-*` ids under a `vibesync` prefix. Read it
  // with the other preflight checks so a bad config fails before any timer
  // or provider starts.
  const moleculeIdPrefix = opts.moleculeIdPrefix ?? await opts.dolt.readIssuePrefix();

  const bus = new EventBus({ noPersist: opts.persistEvents === false });
  // vibesync-x38j: ONE Iroh provider (one dialed connection) shared by the
  // default path and per-project routing; built lazily so nothing binds a
  // socket unless a 'letta-code-iroh' route is actually used.
  let irohProvider: IrohWrapperProvider | null = null;
  const getIrohProvider = (): IrohWrapperProvider => {
    irohProvider ??= buildIrohProvider(createRoleAgentTableResolver(opts.providerRouting?.roleAgentLookup), opts.irohConnectionFactory);
    return irohProvider;
  };
  assertProviderKind();
  const schedulerOptions = opts.schedulers ?? [];
  const schedulerProjects = new Set<string>();
  for (const scheduler of schedulerOptions) {
    if (schedulerProjects.has(scheduler.config.projectIdentifier)) {
      throw new Error(`Duplicate scheduler project identifier "${scheduler.config.projectIdentifier}"`);
    }
    schedulerProjects.add(scheduler.config.projectIdentifier);
  }
  const inboxScheduler = schedulerOptions.find((scheduler) => scheduler.config.enabled && scheduler.config.pmWake?.enabled);
  const wakeCfg = inboxScheduler?.config.pmWake;
  let inboxAdapter = inboxScheduler?.pmWake?.inboxAdapter;
  if (wakeCfg?.enabled && wakeCfg.sink === 'inbox' && !inboxScheduler?.pmWake?.sink && !inboxAdapter && wakeCfg.cli) {
    inboxAdapter = createInboxCliAdapter(wakeCfg.cli);
  }
  if (wakeCfg?.enabled && wakeCfg.sink === 'inbox' && inboxScheduler?.pmWake && !inboxScheduler.pmWake.sink && !inboxAdapter) {
    throw new Error("scheduler.pmWake.sink='inbox' requires an approved MobileAgentMessageSender service adapter");
  }
  const provider = opts.provider ?? buildDefaultRuntimeProvider({
    allowUnavailable: opts.providerRouting !== undefined,
    getIrohProvider,
  });
  if (opts.runDriftAuditOnBoot !== false) {
    bus.emit({
      layer: 'runtime',
      kind: 'runtime/teammate.drift_audit.skipped',
      payload: { reason: 'boot adapters not wired yet' },
    });
  }

  // vibesync-9lzk.9: reads from Dolt SQL, every write through the bd CLI.
  const beads = opts.beadsStore
    ?? new BeadsStore(opts.dolt, opts.bd ?? createCliRunner({ binary: 'bd', cwd: opts.dolt.beadsRoot, env: { BEADS_DIR: `${opts.dolt.beadsRoot}/.beads` } }));
  const walker = new MoleculeWalker(beads);
  const maxConcurrentMolecules = opts.maxConcurrentMolecules ?? readMaxConcurrentMoleculesFromEnv();
  const providerResolver = opts.providerRouting
    ? buildProviderResolver({ ...opts.providerRouting, irohProvider: opts.providerRouting.irohProvider ?? getIrohProvider })
    : undefined;
  // vibesync-efee: steps are beads; the bead graph decides what is ready and
  // the StepDispatcher offers it to the dispatcher. A cooked molecule wakes it.
  let steps: StepDispatcher | null = null;
  // The home project's gh runs in the checkout that owns this engine's tracker,
  // so `gh repo view` names the repository its runs' PRs live in. It is never
  // the scheduler's gh: that one belongs to the SCHEDULED project, which can be
  // unset (scheduler off) or a different checkout.
  const ghFor = opts.projectGh ?? createCheckoutGhRunner;
  const bdFor = opts.projectBd ?? ((root: string) => createCliRunner({
    binary: 'bd', cwd: root, env: { BEADS_DIR: `${root}/.beads`, BEADS_ACTOR: 'orchestration-daemon' },
  }));
  const projectCiChecks = (projectIdentifier: string | undefined) => opts.projectCiChecks?.(projectIdentifier) ?? [];
  const homeRepository = createRepositoryBinding(ghFor(opts.dolt.beadsRoot), projectCiChecks(undefined));
  // A verifier or probe passed to boot replaces the HOME project's only.
  const homeBinding: ProjectBinding = {
    workBeads: null,
    deliveryVerifier: opts.deliveryVerifier ?? homeRepository.deliveryVerifier,
    shippedWorkProbe: opts.shippedWorkProbe ?? homeRepository.shippedWorkProbe,
    prChecks: homeRepository.prChecks,
    ...(homeRepository.repository ? { repository: homeRepository.repository } : {}),
  };
  const projectBindings = buildProjectBindings({
    homeRoot: opts.dolt.beadsRoot,
    homeBinding,
    projectRoot: opts.projectRoot,
    ghFor,
    bdFor,
    projectCiChecks: (projectIdentifier) => projectCiChecks(projectIdentifier),
  });
  const dispatcher = new FormulaDispatcher({
    provider,
    walker,
    idPrefix: moleculeIdPrefix,
    eventBus: bus,
    onMoleculeCooked: () => steps?.kick(),
    ...(maxConcurrentMolecules === undefined ? {} : { maxConcurrentMolecules }),
    ...(providerResolver ? { providerResolver } : {}),
    ...(opts.projectMemory ? { projectMemory: opts.projectMemory } : {}),
    projectBindings,
    ...(opts.stepJudge ? { stepJudge: opts.stepJudge } : {}),
  });

  const schedulerPauseReaders = new Map<string, () => boolean>();
  steps = new StepDispatcher({
    source: new StoreReadyStepSource(
      beads,
      () => dispatcher.liveMoleculeIds(),
      (moleculeId) => {
        const projectIdentifier = dispatcher.projectOfLiveMolecule(moleculeId);
        return projectIdentifier ? schedulerPauseReaders.get(projectIdentifier)?.() ?? false : false;
      },
    ),
    runner: dispatcher,
    logger: { warn: (o, m) => console.error(`[orchestration:steps] ${m}`, o) }, // eslint-disable-line no-console
  });

  // Molecule → motivating-bead writeback hook (vibesync-0xo). Idempotent
  // via a writeback stamp on the molecule_root metadata.
  const unsubscribeWriteback = installWritebackHook({
    bus,
    walker,
    store: beads,
    projectBindings,
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
  console.log('[orchestration:writeback] writeback hook installed');

  // vibesync-9lzk.9: run context lives in memory, so a restart orphans every
  // molecule that was cooking or running. Retire them as `interrupted` before
  // the scheduler or step loop can start anything (so every open root here is
  // orphaned by construction) and after the writeback hook subscribes (so the
  // motivating beads are told). Their scheduler contexts are still open, so
  // the work itself is dispatched again. Decision: close and re-run, do not
  // resume (Emmanuel, 2026-11-04).
  const recovered = await recoverInterruptedMolecules(beads, (moleculeId, payload) =>
    bus.emit({ layer: 'dispatcher', kind: INTERRUPTED_EVENT, molecule_id: moleculeId, payload }));
  if (recovered.interrupted.length > 0 || recovered.failed.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[orchestration:recovery] interrupted molecules retired', { interrupted: recovered.interrupted, failed: recovered.failed });
  }

  // vibesync-z2ws: SchedulerDaemon. Started last so everything it dispatches
  // through (dispatcher, bus, writeback hook) is already wired. A start failure
  // (bad formula, no pool members) must not take the plane down with it.
  const schedulers = new Map<string, SchedulerHandle>();
  for (const scheduler of schedulerOptions) {
    if (!scheduler.config.enabled) continue;
    try {
      const handle = startSchedulerDaemon({
        ...scheduler,
        ...(scheduler.pmWake
          // A scheduler's own adapter wins; the shared one fills in only where none is set.
          ? { pmWake: { ...scheduler.pmWake, ...withInboxAdapter(scheduler.pmWake.inboxAdapter ?? inboxAdapter) } }
          : {}),
        dispatcher,
        bus,
      });
      schedulers.set(scheduler.config.projectIdentifier, handle);
      const schedulerConfig = scheduler.config;
      schedulerPauseReaders.set(schedulerConfig.projectIdentifier, () => schedulerConfig.paused);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const project = scheduler.config.projectIdentifier;
      // eslint-disable-next-line no-console
      console.error(`[orchestration:scheduler] SchedulerDaemon for project "${project}" failed to start — continuing without it: ${message}`);
      bus.emit({ layer: 'daemon', kind: SCHEDULER_START_FAILED_EVENT, payload: { error: message, project } });
    }
  }

  // vibesync-9g24: durable waits. Independent of the scheduler (no shared code);
  // a start failure must not take the plane down.
  let waits: WaitsHandle | null = null;
  if (opts.waits?.config.enabled) {
    try {
      waits = startWaitWatcher({ ...opts.waits, bus });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[orchestration:waits] wait watcher failed to start — continuing without it: ${message}`);
    }
  }
  // The engine owns the step loop regardless of scheduler activation. A
  // scheduler pause filters only that project's molecules at the source.
  steps.start(opts.stepTickIntervalMs);

  let shutDown = false;

  return {
    dispatcher,
    provider,
    bus,
    walker,
    steps,
    schedulers,
    waits,
    async shutdown(): Promise<void> {
      if (shutDown) return;
      shutDown = true;
      // Scheduler first: its ticks dispatch through everything torn down below.
      for (const scheduler of schedulers.values()) {
        try {
          await scheduler.stop();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[orchestration:scheduler] error while stopping SchedulerDaemon', err);
        }
      }
      if (waits) {
        try {
          await waits.stop();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[orchestration:waits] error while stopping wait watcher', err);
        }
      }
      await steps.stop();
      unsubscribeWriteback();
      if (irohProvider) {
        try {
          await irohProvider.close();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[orchestration:iroh] error while closing the Iroh connection', err);
        }
      }
    },
  };
}

/**
 * VIBESYNC_ORCHESTRATION_PROVIDER names a provider that does not exist. A
 * configuration error, not a transient one: retrying cannot fix it, so the
 * service must exit instead of starting with orchestration off.
 */
export class UnsupportedProviderError extends Error {
  constructor(readonly providerKind: string) {
    super(`Unsupported orchestration provider "${providerKind}": ${IROH_PROVIDER_KIND} is the only provider. Unset VIBESYNC_ORCHESTRATION_PROVIDER or set it to ${IROH_PROVIDER_KIND}.`);
    this.name = 'UnsupportedProviderError';
  }
}

/**
 * vibesync-9lzk.29: Iroh is the only runtime provider. The variable must be
 * unset or exactly `letta-code-iroh`; anything else (the removed admin-shim and
 * Teams providers, or an empty value) throws UnsupportedProviderError.
 */
export function assertProviderKind(): void {
  const providerKind = process.env['VIBESYNC_ORCHESTRATION_PROVIDER'];
  if (providerKind !== undefined && providerKind !== IROH_PROVIDER_KIND) {
    throw new UnsupportedProviderError(providerKind);
  }
}

/**
 * vibesync-x38j: the Iroh provider. Config (activation by config, invariant 4):
 *   VIBESYNC_IROH_HOST_ADDR       optional; <nodehex>@<ip:port>[,...]; default: `host:` row of the wrapper's address kv
 *   VIBESYNC_IROH_SECRET_KEY_PATH default /root/.letta/vibesync/iroh-secret.key
 *   VIBESYNC_IROH_PEER_NAME       default vibesync-orchestrator
 * Nothing is dialed here; the connection is lazy.
 */
function buildIrohProvider(agentIdResolver: AgentIdResolver | undefined, factory?: () => IrohConnection): IrohWrapperProvider {
  const connection = factory ? factory() : createNativeIrohConnection(resolveNativeIrohConfig(), {
    log: (m) => console.warn(`[orchestration:iroh] ${m}`), // eslint-disable-line no-console
  });
  return new IrohWrapperProvider({ connection, ...(agentIdResolver ? { agentIdResolver } : {}) });
}

function buildDefaultRuntimeProvider(opts: {
  readonly allowUnavailable?: boolean;
  readonly getIrohProvider: () => IrohWrapperProvider;
}): RuntimeProvider {
  const parentAgentId = process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] ?? process.env['LETTA_CODE_PARENT_AGENT_ID'];
  if (!parentAgentId) {
    if (opts.allowUnavailable) {
      // Per-project routing can still supply the PM parent id from the
      // projects row. Keep boot alive so routed dispatches work; unrouted
      // dispatches fail at start with this message.
      return buildUnavailableDefaultProvider(
        `${IROH_PROVIDER_KIND} orchestration requires VIBESYNC_LETTA_CODE_PARENT_AGENT_ID for default-project dispatch`,
      );
    }
    throw new Error(`${IROH_PROVIDER_KIND} orchestration requires VIBESYNC_LETTA_CODE_PARENT_AGENT_ID`);
  }
  return wrapWithParentAgentId(opts.getIrohProvider(), parentAgentId);
}

function buildUnavailableDefaultProvider(message: string, kind = IROH_PROVIDER_KIND): RuntimeProvider {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    kind,
    start: fail,
    stop: async () => {},
    prompt: fail,
    nudge: async () => {},
    async *observe() {
      yield { kind: 'error', ts: new Date().toISOString(), code: 'provider-unavailable', message };
    },
  };
}


/** A project's routing row names a provider kind that no longer exists. */
export class StaleProviderRoutingError extends Error {
  constructor(readonly projectIdentifier: string, readonly providerKind: string) {
    super(
      `project ${projectIdentifier} routes to provider_kind='${providerKind}', which was removed; `
      + `${IROH_PROVIDER_KIND} is the only provider. Clear projects.provider_kind or set it to ${IROH_PROVIDER_KIND}.`,
    );
    this.name = 'StaleProviderRoutingError';
  }
}

/**
 * Construct the dispatcher's per-project ProviderResolver. Reads the
 * project's routing row: no row or no provider_kind means the dispatcher's
 * default provider; `letta-code-iroh` means the shared Iroh provider with the
 * project's PM parent agent id. Any other provider_kind throws
 * StaleProviderRoutingError before the molecule is cooked (vibesync-9lzk.29):
 * a stale row never silently falls back to another path.
 *
 * Exported for unit tests; production callers go through
 * bootOrchestrationPlane.
 */
export function buildProviderResolver(opts: BootOrchestrationProviderRoutingOptions): ProviderResolver {
  let irohShared: IrohWrapperProvider | null = null;
  return {
    resolve(input): RuntimeProvider | null {
      const projectId = input.projectIdentifier;
      if (!projectId) return null;
      const row = opts.store.getProjectProviderRouting(projectId);
      if (!row || !row.providerKind) return null;
      if (row.providerKind !== IROH_PROVIDER_KIND) {
        throw new StaleProviderRoutingError(projectId, row.providerKind);
      }
      // vibesync-x38j: the Iroh host is configured via VIBESYNC_IROH_*; the
      // route only needs the PM parent agent id.
      const parentAgentId = row.parentAgentId ?? opts.parentAgentIds?.[projectId];
      if (!parentAgentId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[boot] provider routing: project ${projectId} routes to ${IROH_PROVIDER_KIND} but no parent agent id supplied — using the default provider`,
        );
        return null;
      }
      irohShared ??= opts.irohProvider ? opts.irohProvider() : buildIrohProvider(createRoleAgentTableResolver(opts.roleAgentLookup));
      return wrapWithParentAgentId(irohShared, parentAgentId);
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
