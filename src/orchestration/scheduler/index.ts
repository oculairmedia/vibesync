/**
 * Public exports for the Gas Town scheduler layer (vibesync-63zx).
 *
 * This slice (63zx.1) ships ONLY the sling-context layer — the atomic-claim
 * foundation. The persistent pool (63zx.2), scheduler loop (63zx.3), and
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
