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
