import { FormulaDispatcher, installWritebackHook, type WritebackStore } from './dispatcher/index.js';
import { EventBus } from './events/index.js';
import { HealthPatrol } from './health/index.js';
import { MoleculeWalker } from './molecule/index.js';
import { LettaTeamsProvider } from './runtime/index.js';
import type { ToolAttacher } from './runtime/index.js';
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
  const dispatcher = new FormulaDispatcher({
    provider,
    walker,
    eventBus: bus,
    ...(maxConcurrentMolecules === undefined ? {} : { maxConcurrentMolecules }),
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

function readMaxConcurrentMoleculesFromEnv(): number | undefined {
  const raw = process.env['VIBESYNC_MAX_CONCURRENT_MOLECULES'];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}
