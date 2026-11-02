/**
 * Boot composition for the wait watcher (vibesync-9g24).
 *
 * Layering invariant 4: config is the activation mechanism. `startWaitWatcher`
 * is only reached from `bootOrchestrationPlane` when `config.enabled` is true;
 * with it false NOTHING is constructed — no watcher, no timer, no bd call.
 */

import type { EventBus } from '../events/index.js';
import type { CommandRunner } from '../scheduler/bd-adapters.js';
import { BdWaitStore } from './bd-wait-store.js';
import { WaitService } from './service.js';
import { WaitWatcher } from './watcher.js';
import type { WaitLogger, WaitWakeSink } from './types.js';

export interface WaitsBootConfig {
  readonly enabled: boolean;
  /** Slow safety-net reconcile interval (ms); the bus event is only a hint. */
  readonly reconcileIntervalMs: number;
  readonly maxWakeAttempts: number;
}

export interface BootWaitsOptions {
  readonly config: WaitsBootConfig;
  /** bd CLI runner bound to the project's beads dir (argv arrays only). */
  readonly bd: CommandRunner;
  /**
   * Where wakes go. Default: log only. The real waker (vibesync-2bgv / x38j) is
   * injected here; this module does not wake anything itself.
   */
  readonly sink?: WaitWakeSink;
  readonly logger?: WaitLogger;
}

export interface WaitsHandle {
  readonly watcher: WaitWatcher;
  readonly service: WaitService;
  stop(): Promise<void>;
}

export function createLogWakeSink(logger: WaitLogger | undefined): WaitWakeSink {
  return {
    wake(request) {
      logger?.info?.(
        { waitId: request.waitId, outcome: request.outcome, waiter: request.waiter, on: request.on },
        `wait wake (log only, no agent woken): ${request.reason}`,
      );
    },
  };
}

export function startWaitWatcher(opts: BootWaitsOptions & { readonly bus: EventBus }): WaitsHandle {
  if (!opts.config.enabled) {
    throw new Error('startWaitWatcher called with waits.enabled=false (caller must gate on config)');
  }
  const store = new BdWaitStore(opts.bd);
  const watcher = new WaitWatcher({
    store,
    sink: opts.sink ?? createLogWakeSink(opts.logger),
    bus: opts.bus,
    reconcileIntervalMs: opts.config.reconcileIntervalMs,
    maxWakeAttempts: opts.config.maxWakeAttempts,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  watcher.start();
  let stopped: Promise<void> | undefined;
  return {
    watcher,
    service: new WaitService({ store }),
    stop() {
      stopped ??= watcher.stop();
      return stopped;
    },
  };
}
