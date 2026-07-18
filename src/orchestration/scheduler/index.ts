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
