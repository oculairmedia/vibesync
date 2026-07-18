/**
 * Witness — per-project lifecycle patrol + causal stall recovery (vibesync-63zx.7).
 *
 * The self-healing half of the engine. The scheduler dispatches into pool slots
 * (63zx.2/.4); if a dispatched agent CRASHES, hangs, or its completion signal is
 * lost, its slot stays `working` forever — capacity leaks and the burn-down loop
 * silently freezes. The witness patrols the `working` slots and RECOVERS the ones
 * whose owning run is PROVABLY in a bad state, freeing the slot so the scheduler
 * dispatches the next ready bead.
 *
 * CAUSAL, NOT WALL-CLOCK (hard constraint — same rule as letta-mobile c4igq.3).
 * The witness NEVER reaps a slot because "it has been N minutes". A long-running
 * agent that is actively making progress is HEALTHY regardless of elapsed time.
 * Recovery is triggered ONLY by a state CONTRADICTION — a provable liveness
 * signal from the injected RunLivenessProbe. The Gas Town zombie classes
 * (lifecycle-patrol.md) map to our reasons:
 *   - 'run-dead'          : the owning run is dead/errored but the slot is still
 *                           working (crash → session died mid-work).
 *   - 'run-zombie'        : the run reached a terminal/done-intent but never
 *                           freed the slot (gt done failed mid-execution).
 *   - 'bead-closed'       : the work bead is already closed but the slot is still
 *                           working (completion/merge signal lost).
 *   - 'run-missing'       : the probe can find NO run for this slot's work bead
 *                           (dispatch record lost). Treated as dead.
 * A slot whose run is 'alive' (progressing) is LEFT UNTOUCHED — no matter how long.
 *
 * On recovery the witness frees the slot (pool.onComplete) and records the
 * recovery so a persistent bad slot can be escalated (63zx.5). It does NOT force
 * the work bead to any state — the sling context / scheduler retry + circuit
 * breaker own that. Everything is pure/injected → Kotlin-portable, testable with
 * no real runtimes.
 */

import type { PoolSlotView } from './agent-pool.js';

/** Provable liveness of the run owning a working slot. Never time-derived. */
export type RunLiveness =
  | 'alive'        // progressing → leave untouched, regardless of elapsed time
  | 'run-dead'     // run errored / process died while the slot is still working
  | 'run-zombie'   // run reached terminal/done-intent but never freed the slot
  | 'bead-closed'  // work bead already closed but slot still working
  | 'run-missing'; // no run found for this work bead → treat as dead

/** The reasons that trigger recovery (everything except 'alive'). */
export type RecoveryReason = Exclude<RunLiveness, 'alive'>;

/**
 * Probes the PROVABLE state of the run owning a working slot. Injected — the
 * only I/O. Production wires this to the runtime/bead state (is the run's
 * process alive? did it emit a terminal? is the bead closed?). MUST be causal:
 * it inspects actual run/bead state, never "time since allocatedAt".
 */
export interface RunLivenessProbe {
  probe(slot: WorkingSlot): Promise<RunLiveness>;
}

/** A working slot the witness may recover: the fields it needs. */
export interface WorkingSlot {
  readonly slotId: string;
  readonly workBeadId: string;
  /** For provenance/logging only — NEVER used as a staleness signal. */
  readonly allocatedAt: Date;
}

/** Frees a recovered slot (63zx.2 AgentPool.onComplete). Idempotent. */
export interface SlotReaper {
  onComplete(slotId: string): boolean;
}

/** Escalates a slot that keeps needing recovery (reuse 63zx.5 transport). */
export interface WitnessEscalation {
  onRepeatedRecovery(input: {
    readonly slotId: string;
    readonly workBeadId: string;
    readonly reason: RecoveryReason;
    readonly recoveries: number;
  }): Promise<void>;
}

export interface WitnessDeps {
  readonly probe: RunLivenessProbe;
  readonly reaper: SlotReaper;
  readonly escalation: WitnessEscalation;
  /**
   * How many times a given work bead may be recovered before it is escalated
   * (a bead that repeatedly dies is a real problem, not a transient crash).
   * Default 3.
   */
  readonly recoveryEscalationThreshold?: number;
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

export const DEFAULT_RECOVERY_ESCALATION_THRESHOLD = 3;

/** One recovered slot in a patrol cycle. */
export interface Recovery {
  readonly slotId: string;
  readonly workBeadId: string;
  readonly reason: RecoveryReason;
}

/** Outcome of one patrol cycle. */
export interface PatrolResult {
  /** Slots recovered (freed) this cycle. */
  readonly recovered: readonly Recovery[];
  /** Working slots probed and found alive (left untouched). */
  readonly healthy: number;
}

/** Extract the WorkingSlot view from a pool slot, or null if not a working slot. */
export function toWorkingSlot(view: PoolSlotView): WorkingSlot | null {
  if (view.state !== 'working' || !view.session) return null;
  return {
    slotId: view.slotId,
    workBeadId: view.session.workBeadId,
    allocatedAt: view.session.allocatedAt,
  };
}

/**
 * The witness. `patrol(slots)` inspects the current pool slots, probes each
 * WORKING slot's run liveness, and recovers the ones in a contradictory/dead
 * state. Call from the daemon patrol loop. Pure w.r.t. everything except the
 * injected probe/reaper/escalation.
 */
export class Witness {
  private readonly deps: WitnessDeps;
  private readonly threshold: number;
  /** workBeadId → how many times we've recovered it (escalate at threshold). */
  private readonly recoveryCounts = new Map<string, number>();

  constructor(deps: WitnessDeps) {
    this.deps = deps;
    this.threshold = deps.recoveryEscalationThreshold ?? DEFAULT_RECOVERY_ESCALATION_THRESHOLD;
  }

  async patrol(slots: readonly PoolSlotView[]): Promise<PatrolResult> {
    const recovered: Recovery[] = [];
    let healthy = 0;

    for (const view of slots) {
      const slot = toWorkingSlot(view);
      if (!slot) continue; // idle/done slots are not the witness's concern

      let liveness: RunLiveness;
      try {
        liveness = await this.deps.probe.probe(slot);
      } catch (err) {
        // A probe failure must NOT cause a reap (fail safe — never kill a slot we
        // cannot prove is dead). Log and leave it for the next cycle.
        this.deps.logger?.warn?.(
          { slotId: slot.slotId, workBeadId: slot.workBeadId, error: err instanceof Error ? err.message : String(err) },
          'witness: liveness probe failed — leaving slot untouched (fail safe)',
        );
        continue;
      }

      if (liveness === 'alive') {
        healthy += 1;
        continue; // progressing → never reaped, regardless of elapsed time
      }

      // Contradiction proven → recover the slot.
      this.deps.reaper.onComplete(slot.slotId);
      recovered.push({ slotId: slot.slotId, workBeadId: slot.workBeadId, reason: liveness });

      const count = (this.recoveryCounts.get(slot.workBeadId) ?? 0) + 1;
      this.recoveryCounts.set(slot.workBeadId, count);
      this.deps.logger?.warn?.(
        { slotId: slot.slotId, workBeadId: slot.workBeadId, reason: liveness, recoveries: count },
        'witness: recovered slot (causal contradiction) — slot freed',
      );

      if (count >= this.threshold) {
        await this.safeEscalate(slot, liveness, count);
      }
    }

    return { recovered, healthy };
  }

  private async safeEscalate(slot: WorkingSlot, reason: RecoveryReason, recoveries: number): Promise<void> {
    try {
      await this.deps.escalation.onRepeatedRecovery({
        slotId: slot.slotId,
        workBeadId: slot.workBeadId,
        reason,
        recoveries,
      });
    } catch {
      // Escalation transport failure must never kill the patrol.
      this.deps.logger?.warn?.(
        { slotId: slot.slotId, workBeadId: slot.workBeadId },
        'witness: escalation sink failed (patrol continues)',
      );
    }
  }
}
