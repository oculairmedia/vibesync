/**
 * Public exports for the durable wait-on-beads module (vibesync-9g24).
 * One interface, standalone: it imports nothing from the formula, molecule,
 * dispatcher or scheduler-loop modules; shared state is only beads.
 */
export { MIN_BD_VERSION_FOR_WAITS, WAIT_LABEL, WAIT_READY_EVENT, WAIT_EXPIRED_EVENT, WAIT_FAILED_EVENT } from './types.js';
export type {
  NewWait,
  WaitLogger,
  WaitMode,
  WaitOutcome,
  WaitRecord,
  WaitState,
  WaitStore,
  WaitWakeSink,
  WaiterKind,
  WaitWaiter,
  WakeRequest,
} from './types.js';
export { evaluateWait, readyReason, describeWait } from './evaluator.js';
export type { EvaluableWait, WaitVerdict } from './evaluator.js';
export { BdWaitStore } from './bd-wait-store.js';
export { WaitService } from './service.js';
export type { WaitServiceDeps } from './service.js';
export { WaitWatcher, DEFAULT_WAIT_RECONCILE_INTERVAL_MS, DEFAULT_MAX_WAKE_ATTEMPTS } from './watcher.js';
export type { WaitReconcileReport, WaitWatcherDeps } from './watcher.js';
export { startWaitWatcher, createLogWakeSink } from './boot-waits.js';
export type { BootWaitsOptions, WaitsBootConfig, WaitsHandle } from './boot-waits.js';
