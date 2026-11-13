/**
 * WaitWatcher: resolves durable waits and delivers their wake (vibesync-9g24).
 *
 * The wake is driven by EVIDENCE (the named beads' bd status), never by a timer:
 * timers here only decide WHEN to look (boot reconcile, slow interval, a
 * `beads/issue.status_changed` hint), never WHETHER a wait is satisfied.
 *
 * Restart safety: the watcher keeps no state that matters. Every pass reads the
 * non-closed wait beads and re-derives what is owed, so a fresh watcher on the
 * same store continues exactly where the old one stopped.
 *
 * Exactly-one wake: a wait is moved to its resolved state (`ready` / `expired` /
 * `failed`, persisted) BEFORE the sink is called and the bead is closed only
 * AFTER the sink accepted. Closed waits are never listed again, so a repeated
 * reconcile cannot wake twice. The one residual window is a crash between "sink
 * accepted" and "bead closed": that wake is re-delivered once on restart
 * (at-least-once across a crash), so a real sink must key on `waitId`.
 */

import type { EventBus } from '../events/index.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../events/beads.js';
import { describeWait, evaluateWait, readyReason } from './evaluator.js';
import {
  WAIT_EXPIRED_EVENT,
  WAIT_FAILED_EVENT,
  WAIT_READY_EVENT,
  type WaitLogger,
  type WaitOutcome,
  type WaitRecord,
  type WaitState,
  type WaitStore,
  type WaitWakeSink,
  type WakeRequest,
} from './types.js';

export const DEFAULT_WAIT_RECONCILE_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_WAKE_ATTEMPTS = 5;

export interface WaitReconcileReport {
  /** Waits that transitioned pending -> ready/expired/failed in this pass. */
  readonly resolved: ReadonlyArray<{ readonly waitId: string; readonly outcome: WaitOutcome }>;
  /** Waits whose wake the sink accepted in this pass (and which were closed). */
  readonly woken: readonly string[];
  /** Waits that stay open (still pending, or a wake the sink rejected and will be retried). */
  readonly stillOpen: number;
  readonly errors: readonly string[];
}

export interface WaitWatcherDeps {
  readonly store: WaitStore;
  readonly sink: WaitWakeSink;
  readonly bus?: Pick<EventBus, 'emit' | 'subscribe'>;
  readonly now?: () => Date;
  readonly logger?: WaitLogger;
  /** Slow safety-net interval; the bus event is only a hint. 0 disables the interval. */
  readonly reconcileIntervalMs?: number;
  /** After this many sink failures a wait is closed `failed` instead of retrying forever. */
  readonly maxWakeAttempts?: number;
}

export class WaitWatcher {
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private inFlight: Promise<WaitReconcileReport> | undefined;
  private dirty = false;
  private stopped = false;

  constructor(private readonly deps: WaitWatcherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Reconcile once now (boot), then on every status-changed hint and slow interval. */
  start(): void {
    if (this.timer !== undefined || this.unsubscribe !== undefined) return;
    this.stopped = false;
    this.subscribeToCloses();
    this.armTimer();
    this.requestReconcile();
  }

  /** Only a close can satisfy a wait, so only a status change to closed asks for a pass. */
  private subscribeToCloses(): void {
    this.unsubscribe = this.deps.bus?.subscribe((event) => {
      if (event.kind === BEADS_ISSUE_STATUS_CHANGED_EVENT && event.payload?.['to'] === 'closed') this.requestReconcile();
    });
  }

  /** The slow safety-net interval; off when it is 0. */
  private armTimer(): void {
    const interval = this.deps.reconcileIntervalMs ?? DEFAULT_WAIT_RECONCILE_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => this.requestReconcile(), interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  /** Fire-and-forget; coalesces with a pass already running (which then re-runs once). */
  requestReconcile(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    void this.reconcile().catch((err: unknown) => {
      this.deps.logger?.warn?.({ err: errMessage(err) }, 'waits: reconcile failed');
    });
  }

  /** One full pass. Serialized: concurrent callers share the running pass. */
  reconcile(): Promise<WaitReconcileReport> {
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    const run = (async () => {
      let report = await this.pass();
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        report = await this.pass();
      }
      return report;
    })();
    this.inFlight = run;
    const clear = () => {
      if (this.inFlight === run) this.inFlight = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  private async pass(): Promise<WaitReconcileReport> {
    const { store } = this.deps;
    const report: MutableReport = { resolved: [], woken: [], stillOpen: 0, errors: [] };
    const active = await store.listActive();
    const pending = active.filter((w) => w.state === 'pending');
    const statuses = pending.length > 0
      ? await store.beadStatuses([...new Set(pending.flatMap((w) => w.on))])
      : new Map<string, string>();
    const nowMs = this.now().getTime();
    for (const wait of active) {
      try {
        await this.advance(wait, statuses, nowMs, report);
      } catch (err) {
        report.stillOpen += 1;
        report.errors.push(`${wait.id}: ${errMessage(err)}`);
        this.deps.logger?.warn?.({ waitId: wait.id, err: errMessage(err) }, 'waits: wait could not be advanced; will retry');
      }
    }
    return report;
  }

  /** Move one wait as far as it can go this pass, recording what happened in the report. */
  private async advance(wait: WaitRecord, statuses: ReadonlyMap<string, string>, nowMs: number, report: MutableReport): Promise<void> {
    const current = wait.state === 'pending' ? await this.resolvePending(wait, statuses, nowMs, report) : wait;
    if (!current) return;
    if (current.state === 'canceled') {
      await this.deps.store.close(current.id, current.reason ?? 'canceled');
      return;
    }
    if (await this.deliver(current)) report.woken.push(current.id);
    else report.stillOpen += 1;
  }

  /**
   * A pending wait whose condition is decided moves to ready, expired or failed.
   * Returns the updated wait, or null when there is nothing more to do this pass.
   */
  private async resolvePending(wait: WaitRecord, statuses: ReadonlyMap<string, string>, nowMs: number, report: MutableReport): Promise<WaitRecord | null> {
    const { store } = this.deps;
    const verdict = evaluateWait(wait, statuses, nowMs);
    if (verdict.kind === 'pending') {
      report.stillOpen += 1;
      return null;
    }
    // Re-read just before the transition: a cancel that landed since the
    // listing must win (bd has no compare-and-set; this narrows the window).
    const fresh = await store.get(wait.id);
    if (!fresh || fresh.state !== 'pending') {
      if (fresh && fresh.state !== 'canceled') report.stillOpen += 1;
      return null;
    }
    await store.patch(wait.id, { state: verdict.kind, reason: verdict.reason, resolvedAt: this.now().toISOString() });
    report.resolved.push({ waitId: wait.id, outcome: verdict.kind });
    return { ...fresh, state: verdict.kind, reason: verdict.reason };
  }

  /** @returns true when the wake was accepted and the wait closed. */
  private async deliver(wait: WaitRecord): Promise<boolean> {
    if (wait.state === 'closed') {
      // Defensive: an open bead already marked delivered (never written by this
      // version) must be closed, not woken again.
      await this.deps.store.close(wait.id, 'condition met; waiter woken');
      return false;
    }
    if (!isDeliverable(wait.state)) return false;
    const request = wakeRequest(wait, wait.state);
    try {
      await this.deps.sink.wake(request);
    } catch (err) {
      await this.wakeRejected(wait, err);
      return false;
    }
    await this.wakeAccepted(wait, request);
    return true;
  }

  /** Count the attempt; at the limit the wait is marked failed and closed. */
  private async wakeRejected(wait: WaitRecord, err: unknown): Promise<void> {
    const { store } = this.deps;
    const attempts = wait.wakeAttempts + 1;
    const max = this.deps.maxWakeAttempts ?? DEFAULT_MAX_WAKE_ATTEMPTS;
    this.deps.logger?.warn?.({ waitId: wait.id, attempts, max, err: errMessage(err) }, 'waits: wake sink rejected');
    if (attempts < max) {
      await store.patch(wait.id, { wakeAttempts: attempts });
      return;
    }
    await store.patch(wait.id, { state: 'failed', wakeAttempts: attempts, reason: `wake undeliverable after ${attempts} attempts: ${errMessage(err)}` });
    await store.close(wait.id, 'wake undeliverable');
  }

  private async wakeAccepted(wait: WaitRecord, request: WakeRequest): Promise<void> {
    const { store, bus } = this.deps;
    const outcome = request.outcome;
    bus?.emit({
      layer: 'daemon',
      kind: WAKE_EVENT[outcome],
      task_id: wait.id,
      payload: { waitId: wait.id, waiter: wait.waiter, note: wait.note ?? null, on: wait.on, mode: wait.mode, reason: request.reason },
    });
    // Close the bead FIRST (the durable "delivered" mark), then annotate: bd
    // allows metadata updates on a closed bead, and a crash between the two
    // leaves a closed bead that is never listed again. Annotating first could
    // strand an OPEN bead in a state the next pass no longer acts on.
    await store.close(wait.id, outcome === 'ready' ? 'condition met; waiter woken' : `${outcome}; waiter notified`);
    await store.patch(wait.id, { ...(outcome === 'ready' ? { state: 'closed' } : {}), wokenAt: this.now().toISOString() }).catch((err: unknown) => {
      this.deps.logger?.warn?.({ waitId: wait.id, err: errMessage(err) }, 'waits: wake delivered and wait closed, but the annotation failed');
    });
  }
}

type MutableReport = { resolved: Array<{ waitId: string; outcome: WaitOutcome }>; woken: string[]; stillOpen: number; errors: string[] };

const WAKE_EVENT: Readonly<Record<WaitOutcome, string>> = {
  ready: WAIT_READY_EVENT,
  expired: WAIT_EXPIRED_EVENT,
  failed: WAIT_FAILED_EVENT,
};

function isDeliverable(state: WaitState): state is WaitOutcome {
  return state === 'ready' || state === 'expired' || state === 'failed';
}

function wakeRequest(wait: WaitRecord, outcome: WaitOutcome): WakeRequest {
  return {
    waitId: wait.id,
    outcome,
    waiter: wait.waiter,
    reason: wait.reason ?? (outcome === 'ready' ? readyReason(wait) : `${describeWait(wait)} ${outcome}`),
    note: wait.note,
    on: wait.on,
    mode: wait.mode,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
