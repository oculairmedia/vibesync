/**
 * Public exports for the Gas Town scheduler layer (vibesync-63zx).
 *
 * Shipped: the sling-context atomic-claim layer (63zx.1) and the persistent
 * agent pool / concurrency governor (63zx.2). The scheduler loop (63zx.3) and
 * propulsion (63zx.4) land in later slices and will export from here too.
 */
export {
  SlingContextManager,
  serializeParams,
  tryParseParams,
  SLING_CONTEXT_LABEL,
  SLING_CONTEXT_VERSION,
  CIRCUIT_BREAKER_THRESHOLD,
} from './sling-context.js';
export type {
  SlingContextStore,
  SlingContextParams,
  SlingContextRecord,
  SlingCloseReason,
  ScheduleBeadInput,
  ScheduleResult,
  SlingContextManagerDeps,
} from './sling-context.js';

export { AgentPool } from './agent-pool.js';
export type {
  PoolSlotState,
  PoolMemberIdentity,
  PoolSession,
  PoolSlotView,
  AllocateInput,
  Allocation,
  AgentPoolDeps,
} from './agent-pool.js';

export { planDispatch, compareCandidates } from './plan-dispatch.js';
export type {
  DispatchCandidate,
  DispatchPlan,
  SkippedCandidate,
  SkipReason,
} from './plan-dispatch.js';

export { SchedulerLoop } from './scheduler-loop.js';
export type {
  SchedulerConfig,
  SchedulerLoopDeps,
  CapacitySource,
  ReadyWorkSource,
  CandidateMetadataSource,
  DispatchExecutor,
  SchedulerContextStore,
  DispatchLock,
  TickResult,
} from './scheduler-loop.js';

export {
  PropulsionExecutor,
  classifyOutcome,
  extractArtifacts,
  NEEDS_MERIDIAN_MARKER,
} from './propulsion-executor.js';
export type {
  PropulsionOutcome,
  CompletionArtifacts,
  DispatchRunResult,
  DispatchRunner,
  SlotReleaser,
  SelfCompletionSink,
  EscalationSink,
  PropulsionExecutorDeps,
} from './propulsion-executor.js';

export {
  EscalationManager,
  severityPriority,
  markerLine,
  DEFAULT_ESCALATION_CONFIG,
} from './escalation.js';
export type {
  EscalationSeverity,
  EscalationState,
  EscalationRecord,
  EscalationStore,
  NotificationTransport,
  EscalationConfig,
  EscalationManagerDeps,
  StaleSweepResult,
} from './escalation.js';

export {
  Refinery,
  evaluateGates,
} from './refinery.js';
export type {
  MergeRequest,
  MergeRequestState,
  GateName,
  GateFailure,
  ProcessedMergeRequest,
  PrFacts,
  GitHubPort,
  RefineryEscalationSink,
  RefineryDeps,
} from './refinery.js';

export {
  Witness,
  toWorkingSlot,
  DEFAULT_RECOVERY_ESCALATION_THRESHOLD,
} from './witness.js';
export type {
  RunLiveness,
  RecoveryReason,
  RunLivenessProbe,
  WorkingSlot,
  SlotReaper,
  WitnessEscalation,
  WitnessDeps,
  Recovery,
  PatrolResult,
} from './witness.js';

export {
  PmWaker,
  LoggingPmWakeSink,
  formatWakeMessage,
  registryPmAgentLookup,
  PM_WOKEN_EVENT,
  PM_WAKE_SKIPPED_EVENT,
  PM_WAKE_RETRY_BACKOFF_MS,
} from './pm-waker.js';
export type { WakeReason, PmWakeSink, PmWakeInput, PmWakeOutcome, PmWakerDeps, PmBacklogSnapshot } from './pm-waker.js';
export { IrohPmWakeSink } from './iroh-pm-wake-sink.js';
export type { IrohPmWakeSinkOptions } from './iroh-pm-wake-sink.js';
export { FilePmWakeStateStore } from './pm-wake-state.js';
export type { PmWakeStateStore, PmWakeProjectState } from './pm-wake-state.js';

export { SchedulerDaemon, DEFAULT_EVENT_DEBOUNCE_MS, DEFAULT_RUN_DEADLINE_MS } from './daemon.js';
export type {
  DaemonLogger,
  DaemonTickReport,
  DaemonTickResult,
  FormulaResolver,
  ReadyBeadSource,
  SchedulerDaemonDeps,
  TickReason,
  TickRequestOutcome,
} from './daemon.js';

export {
  startSchedulerDaemon,
  SCHEDULER_TICK_EVENT,
  SCHEDULER_STARTED_EVENT,
  SCHEDULER_STOPPED_EVENT,
  SCHEDULER_START_FAILED_EVENT,
  BEADS_ISSUE_STATUS_CHANGED_EVENT,
  TICK_TRIGGER_BEAD_STATUSES,
} from './boot-scheduler.js';
export type { BootSchedulerOptions, SchedulerBootConfig, SchedulerHandle } from './boot-scheduler.js';
