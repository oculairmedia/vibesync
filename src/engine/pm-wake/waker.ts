/**
 * PmWaker — wakes a project's PM agent only when there is a REASON (vibesync-2bgv).
 *
 * The loop owns the timer; the PM never self-reschedules. A wake is a single
 * message through an injected {@link PmWakeSink} carrying the reason, so
 * vibesync stays a plain client of the app (no vibesync-specific verbs). The
 * default sink only logs. The Iroh-backed sink (a turn over the Iroh wrapper,
 * vibesync-x38j `runTurn`) is a follow-up that implements this same port; the
 * `wakeId` is stable per logical wake so it can become the client_message_id and
 * a retried send dedupes.
 *
 * WAKE RULES (one wake per tick per project, highest priority first):
 *   1. 'stall'    — the witness escalated a repeatedly-recovered slot. Pending
 *                   stalls coalesce; at most one stall wake per `minIntervalMs`.
 *   2. 'event'    — a daemon tick trigger of kind webhook/bead-status was
 *                   requested. Pending events coalesce (never lost: a trailing
 *                   wake fires when the interval allows); at most one event
 *                   wake per `minIntervalMs`. SEPARATE key from 'ready', so a
 *                   recent ready wake never suppresses an event (and vice versa).
 *   3. 'ready'    — after the scheduler phase, ready beads (minus those in
 *                   flight) remain AND capacity is free AND this tick dispatched
 *                   nothing (the loop is not already burning them down) AND the
 *                   scheduler is not paused. At most one per `minIntervalMs`.
 *   4. 'backstop' — nothing woke the PM for `backstopMs` (any reason counts).
 *
 * The backstop anchor is `lastWokenAt ?? firstSeenAt`, PERSISTED per project so
 * a restart neither resets it nor wakes at boot.
 *
 * FAILURE. A sink that throws or answers `ok:false` is logged, emitted as
 * `daemon/pm.woken` with ok:false, and does NOT update lastWokenAt (so the
 * backstop still fires). The retry waits {@link PM_WAKE_RETRY_BACKOFF_MS} and
 * reuses the same wakeId. Nothing here ever throws into the tick, and the sink
 * call is never awaited by the tick (a turn can take minutes).
 *
 * Stall sources: witness repeated-recovery escalations and run-deadline
 * expiries (vibesync-izn3), both routed to `noteStall` by boot-scheduler.
 *
 * Layering: pure scheduler-layer module — no bus, db or HTTP import. The bus,
 * registry lookup, clock and state store are injected.
 */

import type { PmWakeStateStore, PmWakeProjectState } from './state.js';
import type { PendingWakeRecord, PendingWakeStore } from './pending-store.js';

export {
  formatWakeMessage, PM_WAKE_RETRY_BACKOFF_MS, PM_WAKE_SKIPPED_EVENT, PM_WOKEN_EVENT,
  type PmWakeInput, type PmWakeOutcome, type PmWakeSink, type WakeReason,
} from './contract.js';
import { formatWakeMessage, PM_WAKE_RETRY_BACKOFF_MS, PM_WAKE_SKIPPED_EVENT, PM_WOKEN_EVENT, type PmWakeInput, type PmWakeOutcome, type PmWakeSink, type WakeReason } from './contract.js';

/** Default sink: records the wake in the log and reports success. Delivers nothing. */
export class LoggingPmWakeSink implements PmWakeSink {
  constructor(private readonly logger?: { info?(o: unknown, m: string): void }) {}

  async wake(input: PmWakeInput): Promise<{ ok: boolean }> {
    this.logger?.info?.(
      { agentId: input.agentId, project: input.projectIdentifier, reason: input.reason, wakeId: input.wakeId },
      formatWakeMessage(input),
    );
    return { ok: true };
  }
}

/**
 * Registry lookup for the PM target: `projects.letta_agent_id`. Structural so the
 * scheduler layer needs no database import; src/index.ts wires the real
 * Registry (`getProject`) here, and the tests use the same function against a
 * real database file. Resolved on every tick, so a corrected row needs no restart.
 */
export function registryPmAgentLookup(registry: {
  getProject(identifier: string): { readonly letta_agent_id?: string | null } | null | undefined;
}): (projectIdentifier: string) => string | null {
  return (projectIdentifier) => registry.getProject(projectIdentifier)?.letta_agent_id || null;
}

/** What the daemon exposes about the backlog after a tick's scheduler phase. */
export interface PmBacklogSnapshot {
  /** Ready work beads without a run in flight. */
  readonly readyCount: number;
  /** poolSize minus working slots. */
  readonly freeCapacity: number;
}

/** The slice of a daemon tick report the waker needs (structurally a DaemonTickReport). */
export interface PmWakeTickObservation {
  readonly result: {
    readonly scheduler: {
      readonly skippedReason?: string;
      readonly dispatched: readonly unknown[];
    };
  };
}

export interface PmWakerDeps {
  readonly projectIdentifier: string;
  /** Registry lookup (projects.letta_agent_id). Null/empty = no PM → no wake. */
  readonly lookupAgentId: (projectIdentifier: string) => string | null | undefined;
  readonly sink: PmWakeSink;
  readonly store: PmWakeStateStore;
  readonly pendingWakeStore?: PendingWakeStore;
  /** Backlog as of the tick that just ran; null when it could not be determined. */
  readonly backlog: () => PmBacklogSnapshot | null;
  readonly emit: (kind: string, payload: Record<string, unknown>) => void;
  readonly minIntervalMs: number;
  readonly backstopMs: number;
  readonly now?: () => number;
  readonly logger?: {
    info?(o: unknown, m: string): void;
    warn?(o: unknown, m: string): void;
  };
}

export class PmWaker {
  private readonly now: () => number;
  private state: PmWakeProjectState;
  private readonly pendingEvents: string[] = [];
  private readonly pendingStalls = new Map<string, string>();
  /** wakeId kept across a failed attempt so the retry dedupes. */
  private readonly retryWakeId = new Map<WakeReason, string>();
  private readonly failedAt = new Map<WakeReason, number>();
  private readonly retryInput = new Map<WakeReason, PmWakeInput>();
  private readonly durablePending = new Map<string, PendingWakeRecord>();
  private recoveryFailed = false;
  /** `${reason}:${why}` skip notices already emitted (cleared when that reason wakes). */
  private readonly skipNoticed = new Set<string>();
  private warnedNoAgent = false;
  private busy = false;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  private recovery: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PmWakerDeps) {
    this.now = deps.now ?? (() => Date.now());
    if (deps.pendingWakeStore) {
      this.recovery = this.recoverPending();
    }
    const loaded = deps.store.load(deps.projectIdentifier);
    if (loaded) {
      this.state = loaded;
    } else {
      // First ever sighting: anchor the backstop here (no wake at boot) and persist it.
      this.state = { firstSeenAt: new Date(this.now()).toISOString(), lastWokenAt: null, lastByReason: {} };
      this.persist();
    }
  }

  /** A daemon tick trigger of kind webhook/bead-status was requested. */
  noteEvent(kind: string, detail: string): void {
    if (this.disposed) return;
    this.pendingEvents.push(detail ? `${kind} ${detail}` : kind);
    if (this.pendingEvents.length > 50) this.pendingEvents.shift();
  }

  /** The witness escalated a repeatedly-recovered slot, or a run deadline expired. */
  noteStall(workBeadId: string, detail: string): void {
    if (this.disposed) return;
    this.pendingStalls.set(workBeadId, detail);
  }

  /** Called after every daemon tick. Fire-and-forget: never throws, never blocks the tick. */
  onTick(observation: PmWakeTickObservation): void {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.pending = this.evaluate(observation)
      .catch((err: unknown) => {
        this.deps.logger?.warn?.({ project: this.deps.projectIdentifier, error: errMsg(err) }, 'pm-wake: evaluation failed');
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /** Resolves when the evaluation in progress (if any) has finished. For tests and shutdown. */
  idle(): Promise<void> {
    return Promise.all([this.pending, this.recovery]).then(() => undefined);
  }

  /** Stop all further wakes and emissions. Idempotent. */
  dispose(): void {
    this.disposed = true;
  }

  private async recoverPending(): Promise<void> {
    try {
      const records = await this.deps.pendingWakeStore!.listPending();
      for (const record of records) {
        if (record.payload.projectIdentifier === this.deps.projectIdentifier) this.durablePending.set(record.id, record);
      }
      this.recoveryFailed = false;
    } catch (error) {
      this.recoveryFailed = true;
      this.deps.logger?.warn?.({ project: this.deps.projectIdentifier, error: errMsg(error) }, 'pm-wake: pending wake recovery failed');
    }
  }

  private async evaluate(obs: PmWakeTickObservation): Promise<void> {
    const project = this.deps.projectIdentifier;
    await this.recovery;
    if (this.recoveryFailed) await this.recoverPending();
    // A failed read cannot establish that no message is pending. Stay closed
    // rather than minting a replacement identity after an ambiguous send.
    if (this.recoveryFailed) return;
    const recovered = [...this.durablePending.values()].find((record) => record.payload.projectIdentifier === this.deps.projectIdentifier);
    if (recovered) {
      await this.retryDurablePending(recovered, this.now());
      return;
    }
    let agentId: string | null | undefined;
    try {
      agentId = this.deps.lookupAgentId(project);
    } catch (err) {
      this.deps.logger?.warn?.({ project, error: errMsg(err) }, 'pm-wake: PM agent lookup failed');
      return;
    }
    if (!agentId) {
      if (!this.warnedNoAgent) {
        this.warnedNoAgent = true;
        this.deps.logger?.warn?.({ project }, 'pm-wake: project has no PM agent (letta_agent_id) — not waking');
      }
      this.notifySkipped('any', 'no-pm-agent');
      return;
    }
    this.warnedNoAgent = false;

    const now = this.now();
    const candidates = this.candidates(obs, now);
    for (const c of candidates) {
      if (!c.due) {
        if (c.why) this.notifySkipped(c.reason, c.why);
        continue;
      }
      const failed = this.failedAt.get(c.reason);
      if (failed !== undefined && now - failed < PM_WAKE_RETRY_BACKOFF_MS) {
        this.notifySkipped(c.reason, 'retry-backoff');
        continue;
      }
      const correlation = this.correlationFor(c.reason);
      await this.send(agentId, c.reason, c.detail, now, correlation);
      return; // one wake per tick
    }
  }

  private candidates(
    obs: PmWakeTickObservation,
    now: number,
  ): Array<{ reason: WakeReason; due: boolean; detail: string; why?: string }> {
    const out: Array<{ reason: WakeReason; due: boolean; detail: string; why?: string }> = [];
    const intervalOk = (reason: WakeReason): boolean => {
      const last = this.state.lastByReason[reason];
      return last === undefined || now - Date.parse(last) >= this.deps.minIntervalMs;
    };

    if (this.pendingStalls.size > 0) {
      const ids = [...this.pendingStalls.keys()];
      const latest = this.pendingStalls.get(ids[ids.length - 1]!)!;
      out.push({
        reason: 'stall',
        due: intervalOk('stall'),
        detail: `stalled ${ids.join(', ')}: ${latest}`,
        why: 'min-interval',
      });
    }
    if (this.pendingEvents.length > 0) {
      const latest = this.pendingEvents[this.pendingEvents.length - 1]!;
      out.push({
        reason: 'event',
        due: intervalOk('event'),
        detail: this.pendingEvents.length === 1 ? latest : `${this.pendingEvents.length} events, latest: ${latest}`,
        why: 'min-interval',
      });
    }

    const sched = obs.result.scheduler;
    if (sched.skippedReason !== 'paused' && sched.dispatched.length === 0) {
      const backlog = this.safeBacklog();
      if (backlog && backlog.readyCount > 0 && backlog.freeCapacity > 0) {
        out.push({
          reason: 'ready',
          due: intervalOk('ready'),
          detail: `${backlog.readyCount} ready beads, capacity ${backlog.freeCapacity}`,
          why: 'min-interval',
        });
      }
    }

    const anchor = Date.parse(this.state.lastWokenAt ?? this.state.firstSeenAt);
    const sinceMs = now - anchor;
    const backstopDue = sinceMs >= this.deps.backstopMs;
    const backstopFailedAt = this.failedAt.get('backstop');
    out.push({
      reason: 'backstop',
      due: backstopDue || (backstopFailedAt !== undefined && now - backstopFailedAt >= PM_WAKE_RETRY_BACKOFF_MS),
      detail: `no wake for ${Math.floor(sinceMs / 60_000)} min`,
    });
    return out;
  }

  private safeBacklog(): PmBacklogSnapshot | null {
    try {
      return this.deps.backlog();
    } catch (err) {
      this.deps.logger?.warn?.({ project: this.deps.projectIdentifier, error: errMsg(err) }, 'pm-wake: backlog snapshot failed');
      return null;
    }
  }

  private correlationFor(reason: WakeReason): Readonly<Record<string, string>> | undefined {
    // Only correlate a single known bead from structured stall input. Display
    // text is not an identity source, and a batch has no single bead owner.
    if (reason === 'stall' && this.pendingStalls.size === 1) {
      const bead = this.pendingStalls.keys().next().value;
      return bead ? { bead } : undefined;
    }
    return undefined;
  }

  private async retryDurablePending(record: PendingWakeRecord, now: number): Promise<void> {
    const claim = await this.deps.pendingWakeStore?.claim(record.id);
    if (claim && (!claim.record || claim.record.status === 'closed')) {
      this.durablePending.delete(record.id);
      return;
    }
    if (!claim?.authorized || !claim.record || !this.deps.pendingWakeStore) return;
    const sent = await this.deps.pendingWakeStore.sendClaimed(claim.record, this.deps.sink, now);
    if (!sent.authorized || !sent.outcome) return;
    const input = inputFromRecord(record);
    this.applyOutcome(input, sent.outcome, now);
    if (sent.receipt?.accepted && sent.receipt.applicationDelivered) this.durablePending.delete(record.id);
  }

  private async send(
    agentId: string,
    reason: WakeReason,
    detail: string,
    now: number,
    correlation?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const project = this.deps.projectIdentifier;
    const wakeId = this.retryWakeId.get(reason) ?? `${project}-${reason}-${now}`;
    // A logical message ID must retain its recipient and complete payload,
    // even if newer events arrive or the registry changes before a retry.
    const input = this.retryInput.get(reason) ?? {
      agentId, projectIdentifier: project, reason, detail, wakeId,
      ...(correlation ? { correlation: { ...correlation } } : {}),
    };
    const pendingStore = this.deps.pendingWakeStore;
    if (pendingStore) {
      try {
        const record = await pendingStore.enqueue(input, now);
        this.durablePending.set(record.id, record);
        const result = await pendingStore.claim(record.id);
        if (!result.record || result.record.status === 'closed') {
          this.durablePending.delete(record.id);
          return;
        }
        if (!result.authorized || !result.record) return;
        const sent = await pendingStore.sendClaimed(result.record, this.deps.sink, now);
        if (!sent.authorized || !sent.outcome) return;
        this.retryWakeId.delete(reason);
        this.retryInput.delete(reason);
        this.failedAt.delete(reason);
        this.applyOutcome(inputFromRecord(record), sent.outcome, now);
        if (sent.receipt?.accepted && sent.receipt.applicationDelivered) this.durablePending.delete(record.id);
      } catch (error) {
        this.failedAt.set(reason, now);
        this.deps.logger?.warn?.({ project, reason, wakeId, error: errMsg(error) }, 'pm-wake: durable send failed closed');
      }
      return;
    }

    let outcome: PmWakeOutcome = { ok: false, error: 'sink returned no outcome' };
    try {
      outcome = await this.deps.sink.wake(input);
    } catch (err) {
      outcome = { ok: false, error: errMsg(err) };
    }
    this.applyOutcome(input, outcome, now);
  }

  private applyOutcome(input: PmWakeInput, outcome: PmWakeOutcome, now: number): void {
    const { agentId, projectIdentifier: project, reason, detail, wakeId } = input;
    const ok = outcome.applicationDelivered === undefined
      ? outcome.ok && outcome.accepted !== false
      : outcome.ok && outcome.accepted !== false && outcome.applicationDelivered;
    const error = outcome.reason ?? outcome.error ?? (outcome.accepted ? 'accepted but application delivery is unconfirmed' : undefined);
    if (this.disposed) return;

    if (ok) {
      const at = new Date(now).toISOString();
      this.state = {
        ...this.state,
        lastWokenAt: at,
        lastByReason: { ...this.state.lastByReason, [reason]: at },
      };
      this.persist();
      this.retryWakeId.delete(reason);
      this.retryInput.delete(reason);
      this.failedAt.delete(reason);
      for (const key of [...this.skipNoticed]) if (key.startsWith(`${reason}:`)) this.skipNoticed.delete(key);
      if (reason === 'stall') this.pendingStalls.clear();
      if (reason === 'event') this.pendingEvents.length = 0;
    } else {
      this.retryWakeId.set(reason, wakeId);
      this.retryInput.set(reason, input);
      this.failedAt.set(reason, now);
      this.deps.logger?.warn?.(
        { project, reason, wakeId, accepted: outcome.accepted ?? false, applicationDelivered: outcome.applicationDelivered ?? false, ...(outcome.reason ? { sinkReason: outcome.reason } : {}), error },
        'pm-wake: wake not confirmed delivered — lastWokenAt unchanged',
      );
    }
    this.emitSafely(PM_WOKEN_EVENT, {
      project,
      agentId,
      reason,
      detail,
      wakeId,
      ok,
      accepted: outcome.accepted ?? outcome.ok,
      applicationDelivered: outcome.applicationDelivered ?? false,
      ...(outcome.msgId ? { msgId: outcome.msgId } : {}),
      ...(outcome.reason ? { sinkReason: outcome.reason } : {}),
      ...(error ? { error } : {}),
    });
  }

  private notifySkipped(reason: WakeReason | 'any', why: string): void {
    const key = `${reason}:${why}`;
    if (this.skipNoticed.has(key)) return;
    this.skipNoticed.add(key);
    this.emitSafely(PM_WAKE_SKIPPED_EVENT, { project: this.deps.projectIdentifier, reason, why });
  }

  private emitSafely(kind: string, payload: Record<string, unknown>): void {
    try {
      this.deps.emit(kind, payload);
    } catch (err) {
      this.deps.logger?.warn?.({ kind, error: errMsg(err) }, 'pm-wake: bus emit failed');
    }
  }

  private persist(): void {
    try {
      this.deps.store.save(this.deps.projectIdentifier, this.state);
    } catch (err) {
      this.deps.logger?.warn?.(
        { project: this.deps.projectIdentifier, error: errMsg(err) },
        'pm-wake: could not persist state — a restart will reset the backstop clock',
      );
    }
  }
}

function inputFromRecord(record: PendingWakeRecord): PmWakeInput {
  return {
    agentId: record.payload.agentId,
    projectIdentifier: record.payload.projectIdentifier,
    reason: record.payload.reason,
    detail: record.payload.detail,
    wakeId: record.payload.msgId,
    ...(record.payload.correlation ? { correlation: record.payload.correlation } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
