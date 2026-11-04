/**
 * Severity-routed escalation to Meridian (vibesync-63zx.5).
 *
 * Formalizes the NEEDS-MERIDIAN-DECISION marker (see escalation.md) into a
 * tracked, severity-routed escalation. This is the concrete backing for the
 * EscalationSink seam that the propulsion executor (63zx.4) calls when a
 * dispatched agent blocks.
 *
 * VibeSync adaptation (we reject Gas Town's email/SMS/Slack transports and its
 * Deacon→Mayor→Overseer tier chain): Meridian IS the Mayor/Overseer, and the
 * transport is the already-working pair — a NEEDS-MERIDIAN-DECISION marker
 * (tracked as a bead comment) PLUS an agent-messaging notification. The
 * human-in-the-loop supplies the DECISION, not the chasing.
 *
 * Route per severity:
 *   CRITICAL (P0) — marker + notify (urgent)
 *   HIGH     (P1) — marker + notify
 *   MEDIUM   (P2) — marker + notify
 * (All three notify Meridian; severity rides in the marker/notification so
 *  Meridian's scanner can triage. The Gas Town multi-channel fan-out is a
 *  future concern — here the single Meridian transport covers all levels.)
 *
 * Lifecycle: open → (stale re-fire ONCE past threshold) → open; ruled
 * (acknowledged/closed by Meridian) → closed (terminal, no more re-fires).
 *
 * Scope: ONLY escalation. The manager is pure over injected seams (store +
 * transport + clock); it does not import the agent-messaging skill, bd, or a
 * clock directly, so it stays testable and Kotlin-portable.
 */

/** Escalation severity. Maps to bead priority (P0/P1/P2). */
export type EscalationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

/** Severity → bead priority number (0 = P0 highest). */
export function severityPriority(sev: EscalationSeverity): number {
  switch (sev) {
    case 'CRITICAL': return 0;
    case 'HIGH': return 1;
    case 'MEDIUM': return 2;
  }
}

/** Escalation lifecycle state. */
export type EscalationState = 'open' | 'closed';

/** A tracked escalation record. */
export interface EscalationRecord {
  readonly id: string;
  readonly workBeadId: string;
  readonly runId: string;
  readonly severity: EscalationSeverity;
  readonly summary: string;
  readonly state: EscalationState;
  /** When first raised. */
  readonly createdAt: string;
  /** When last notified (initial or re-fire), for stale detection. */
  readonly lastNotifiedAt: string;
  /** Times this escalation has been re-fired due to staleness. */
  readonly reescalationCount: number;
}

/**
 * The marker line an escalation posts as the first line of a bead comment (the
 * convention Meridian's 15-min scanner detects). Kept identical to the manual
 * convention so the scanner needs no change.
 */
export function markerLine(summary: string): string {
  return `NEEDS-MERIDIAN-DECISION: ${summary}`;
}

/**
 * Persistence for escalation records + the tracked marker comment. Injected so
 * the manager stays bd-free. Production backs this with the beads/Dolt store:
 * createEscalation posts the NEEDS-MERIDIAN-DECISION marker as a bead comment
 * and records the escalation row; the others read/update that row.
 */
export interface EscalationStore {
  /**
   * Create a new escalation: post the marker comment on the work bead and
   * persist the record. Returns the stored record (with generated id).
   */
  createEscalation(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly severity: EscalationSeverity;
    readonly summary: string;
    readonly marker: string;
    readonly createdAt: string;
  }): Promise<EscalationRecord>;
  /** Find an OPEN escalation for a work bead, if any. */
  findOpenForWorkBead(workBeadId: string): Promise<EscalationRecord | null>;
  /** All OPEN escalations (for the stale sweep). */
  listOpen(): Promise<EscalationRecord[]>;
  /** Record a re-fire: bump reescalationCount + lastNotifiedAt. */
  markReescalated(id: string, at: string): Promise<EscalationRecord>;
  /** Close an escalation (Meridian ruled). Terminal. */
  closeEscalation(id: string, reason: string): Promise<void>;
}

/**
 * The Meridian notification transport (the agent-messaging skill). Injected so
 * the manager does not couple to the skill/CLI. Production wires this to the
 * agent-messaging send.
 */
export interface NotificationTransport {
  notifyMeridian(input: {
    readonly workBeadId: string;
    readonly severity: EscalationSeverity;
    readonly summary: string;
    readonly reescalation: boolean;
  }): Promise<void>;
}

export interface EscalationConfig {
  /** How long an open, un-ruled escalation may sit before a stale re-fire (ms). */
  readonly staleThresholdMs: number;
  /** Max stale re-fires per escalation. Bead spec: re-fire ONCE → default 1. */
  readonly maxReescalations: number;
}

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  staleThresholdMs: 4 * 60 * 60 * 1000, // 4h (escalation.md stale_threshold)
  maxReescalations: 1, // bead: an unanswered escalation re-fires ONCE
};

export interface EscalationManagerDeps {
  readonly store: EscalationStore;
  readonly transport: NotificationTransport;
  readonly config?: Partial<EscalationConfig>;
  readonly now?: () => Date;
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

/** Outcome of a stale sweep, for observability + tests. */
export interface StaleSweepResult {
  /** Escalation ids re-fired this sweep. */
  readonly reescalated: readonly string[];
  /** Open escalations left alone (not yet stale, or at max re-fires). */
  readonly skipped: readonly string[];
}

/**
 * Manages the escalation lifecycle over injected seams. Pure logic: the store
 * owns bd, the transport owns agent-messaging, the clock is injected.
 */
export class EscalationManager {
  private readonly store: EscalationStore;
  private readonly transport: NotificationTransport;
  private readonly config: EscalationConfig;
  private readonly now: () => Date;
  private readonly logger: EscalationManagerDeps['logger'];

  constructor(deps: EscalationManagerDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.config = { ...DEFAULT_ESCALATION_CONFIG, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  /**
   * Raise (or reuse) an escalation for a blocked work bead: post the
   * NEEDS-MERIDIAN-DECISION marker + notify Meridian. Idempotent per work bead:
   * if an OPEN escalation already exists, it is returned without a duplicate
   * marker/notification (a re-blocked agent does not spam Meridian).
   *
   * This is the concrete backing for the 63zx.4 EscalationSink.onBlocked.
   */
  async escalate(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly summary: string;
    readonly severity?: EscalationSeverity;
  }): Promise<EscalationRecord> {
    const existing = await this.store.findOpenForWorkBead(input.workBeadId);
    if (existing) {
      this.logger?.info?.({ id: existing.id, workBeadId: input.workBeadId }, 'escalation: already open, not duplicating');
      return existing;
    }
    const severity = input.severity ?? 'MEDIUM';
    const at = this.now().toISOString();
    const record = await this.store.createEscalation({
      workBeadId: input.workBeadId,
      runId: input.runId,
      severity,
      summary: input.summary,
      marker: markerLine(input.summary),
      createdAt: at,
    });
    await this.transport.notifyMeridian({
      workBeadId: input.workBeadId,
      severity,
      summary: input.summary,
      reescalation: false,
    });
    this.logger?.warn?.({ id: record.id, workBeadId: input.workBeadId, severity }, 'escalation: raised + Meridian notified');
    return record;
  }

  /**
   * Sweep open escalations and re-fire the stale ones (un-ruled past the
   * threshold), up to maxReescalations (default 1 → re-fire ONCE). Called
   * periodically by the daemon; cheap, non-LLM.
   */
  async sweepStale(): Promise<StaleSweepResult> {
    const nowMs = this.now().getTime();
    const open = await this.store.listOpen();
    const reescalated: string[] = [];
    const skipped: string[] = [];
    for (const esc of open) {
      const ageMs = nowMs - new Date(esc.lastNotifiedAt).getTime();
      const stale = ageMs >= this.config.staleThresholdMs;
      if (!stale || esc.reescalationCount >= this.config.maxReescalations) {
        skipped.push(esc.id);
        continue;
      }
      const updated = await this.store.markReescalated(esc.id, this.now().toISOString());
      await this.transport.notifyMeridian({
        workBeadId: esc.workBeadId,
        severity: esc.severity,
        summary: esc.summary,
        reescalation: true,
      });
      reescalated.push(esc.id);
      this.logger?.warn?.(
        { id: esc.id, workBeadId: esc.workBeadId, reescalationCount: updated.reescalationCount },
        'escalation: stale → re-fired to Meridian',
      );
    }
    return { reescalated, skipped };
  }

  /**
   * Resolve/clear an escalation once Meridian has ruled. Terminal — a closed
   * escalation is never re-fired by sweepStale.
   */
  async resolve(escalationId: string, reason: string): Promise<void> {
    await this.store.closeEscalation(escalationId, reason);
    this.logger?.info?.({ id: escalationId, reason }, 'escalation: ruled/cleared by Meridian');
  }
}
