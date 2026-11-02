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
 * TODO(vibesync-izn3): run-deadline expiries should call `noteStall` too once
 * that bead lands; only the witness escalation is wired today.
 *
 * Layering: pure scheduler-layer module — no bus, db or HTTP import. The bus,
 * registry lookup, clock and state store are injected.
 */

import type { PmWakeStateStore, PmWakeProjectState } from './pm-wake-state.js';

export type WakeReason = 'event' | 'ready' | 'stall' | 'backstop';

export const PM_WOKEN_EVENT = 'daemon/pm.woken';
export const PM_WAKE_SKIPPED_EVENT = 'daemon/pm.wake_skipped';

/** Wait after a failed wake before retrying it (ms). */
export const PM_WAKE_RETRY_BACKOFF_MS = 300_000;

export interface PmWakeInput {
  readonly agentId: string;
  readonly projectIdentifier: string;
  readonly reason: WakeReason;
  readonly detail: string;
  /** Stable per logical wake (reused on retry); becomes the client_message_id. */
  readonly wakeId: string;
}

export interface PmWakeSink {
  wake(input: PmWakeInput): Promise<{ readonly ok: boolean; readonly error?: string }>;
}

/** One-line wake message text, shared by every sink implementation. */
export function formatWakeMessage(input: Pick<PmWakeInput, 'reason' | 'detail' | 'wakeId'>): string {
  return `[vibesync wake] reason=${input.reason} detail=${input.detail.replace(/\s+/g, ' ').trim()} wakeId=${input.wakeId}`;
}

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
 * SyncDatabase (`getProject`) here, and the tests use the same function against a
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
  /** `${reason}:${why}` skip notices already emitted (cleared when that reason wakes). */
  private readonly skipNoticed = new Set<string>();
  private warnedNoAgent = false;
  private busy = false;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PmWakerDeps) {
    this.now = deps.now ?? (() => Date.now());
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

  /** The witness escalated a repeatedly-recovered slot (or, later, a run deadline expired). */
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
    return this.pending;
  }

  /** Stop all further wakes and emissions. Idempotent. */
  dispose(): void {
    this.disposed = true;
  }

  private async evaluate(obs: PmWakeTickObservation): Promise<void> {
    const project = this.deps.projectIdentifier;
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
      await this.send(agentId, c.reason, c.detail, now);
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
    out.push({
      reason: 'backstop',
      due: sinceMs >= this.deps.backstopMs,
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

  private async send(agentId: string, reason: WakeReason, detail: string, now: number): Promise<void> {
    const project = this.deps.projectIdentifier;
    const wakeId = this.retryWakeId.get(reason) ?? `${project}-${reason}-${now}`;
    let ok = false;
    let error: string | undefined;
    try {
      const res = await this.deps.sink.wake({ agentId, projectIdentifier: project, reason, detail, wakeId });
      ok = res.ok;
      error = res.error;
    } catch (err) {
      error = errMsg(err);
    }
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
      this.failedAt.delete(reason);
      for (const key of [...this.skipNoticed]) if (key.startsWith(`${reason}:`)) this.skipNoticed.delete(key);
      if (reason === 'stall') this.pendingStalls.clear();
      if (reason === 'event') this.pendingEvents.length = 0;
    } else {
      this.retryWakeId.set(reason, wakeId);
      this.failedAt.set(reason, now);
      this.deps.logger?.warn?.({ project, reason, wakeId, error }, 'pm-wake: wake failed — lastWokenAt unchanged');
    }
    this.emitSafely(PM_WOKEN_EVENT, {
      project,
      agentId,
      reason,
      detail,
      wakeId,
      ok,
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
