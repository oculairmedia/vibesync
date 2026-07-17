/**
 * PlanDispatch — the pure selection algorithm at the heart of the scheduler
 * burn-down loop (vibesync-63zx.3, see .gastown-reference/scheduler.md).
 *
 * Given the ready candidates (open sling contexts whose work bead is in
 * `bd ready`, minus circuit-broken ones), the available capacity, and the
 * per-tick batch size, decide EXACTLY which beads to dispatch this tick and
 * in what order.
 *
 * This function is PURE — no I/O, no clock, no tokens. That is the token
 * efficiency invariant: selection is free; only the dispatched agents cost
 * tokens. It is also the most Kotlin-portable piece (a deterministic sort +
 * slice), so it lives in its own file with a stable contract.
 *
 * Dispatch count formula (scheduler.md):
 *     toDispatch = min(capacity, batchSize, readyCount)
 *
 * Selection order (scheduler.md): sort candidates by
 *   1. priority        — P0 (0) before P1 (1) before P2 (2)  [ascending number]
 *   2. unblockCount    — how many downstream beads this one unblocks  [DESC]
 *   3. enqueuedAt      — older first (age / fairness)  [ASC]
 *
 * File-overlap serialization (scheduler.md safety property): two candidates
 * whose file/contract sets overlap must NOT be dispatched in the same tick —
 * the later one is skipped (reason: file-overlap) and picked up next tick when
 * the first has moved on. This prevents two agents racing the same files.
 */

/** A ready candidate = a scheduled work bead eligible for dispatch this tick. */
export interface DispatchCandidate {
  /** The sling-context bead id (what gets closed on success/circuit-break). */
  readonly contextId: string;
  /** The work bead id being dispatched. */
  readonly workBeadId: string;
  /** Priority as a number: 0 = P0 (highest) … larger = lower. */
  readonly priority: number;
  /** How many downstream beads closing this one unblocks (critical path). */
  readonly unblockCount: number;
  /** RFC3339 enqueue timestamp (age / fairness tiebreak). */
  readonly enqueuedAt: string;
  /** Files/contracts this bead would touch. Empty = unknown → treated as
   *  non-overlapping (no serialization constraint). */
  readonly files?: readonly string[];
  /** Consecutive dispatch failures so far (for circuit-breaker filtering). */
  readonly dispatchFailures: number;
}

/** Why a candidate was skipped this tick. */
export type SkipReason = 'no-capacity' | 'batch-full' | 'file-overlap';

export interface SkippedCandidate {
  readonly candidate: DispatchCandidate;
  readonly reason: SkipReason;
}

/** The plan for one tick. */
export interface DispatchPlan {
  /** Ordered beads to dispatch this tick (respects capacity, batch, overlap). */
  readonly toDispatch: readonly DispatchCandidate[];
  /** Candidates not dispatched this tick, with the reason. */
  readonly skipped: readonly SkippedCandidate[];
}

/**
 * Deterministic selection sort per scheduler.md:
 * (priority ASC, unblockCount DESC, enqueuedAt ASC, then workBeadId for a
 * stable total order).
 */
export function compareCandidates(a: DispatchCandidate, b: DispatchCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority; // P0 first
  if (a.unblockCount !== b.unblockCount) return b.unblockCount - a.unblockCount; // more unblocks first
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt < b.enqueuedAt ? -1 : 1; // older first
  return a.workBeadId < b.workBeadId ? -1 : a.workBeadId > b.workBeadId ? 1 : 0; // stable
}

/**
 * Plan one dispatch tick. Pure: no side effects. Callers filter circuit-broken
 * candidates BEFORE calling (or rely on the `dispatchFailures >= threshold`
 * filter here via `circuitBreakerThreshold`).
 *
 * @param candidates ready candidates (already joined against bd ready)
 * @param capacity   free pool slots (poolSize - activeCount); <=0 → dispatch none
 * @param batchSize  max beads to dispatch this tick (>=1)
 * @param circuitBreakerThreshold candidates with dispatchFailures >= this are excluded
 */
export function planDispatch(
  candidates: readonly DispatchCandidate[],
  capacity: number,
  batchSize: number,
  circuitBreakerThreshold: number,
): DispatchPlan {
  const skipped: SkippedCandidate[] = [];

  // Exclude circuit-broken candidates up front — they are not dispatchable.
  const eligible = candidates.filter((c) => c.dispatchFailures < circuitBreakerThreshold);

  // Deterministic priority order.
  const ordered = [...eligible].sort(compareCandidates);

  const effectiveCap = Math.max(0, Math.min(capacity, batchSize));
  const toDispatch: DispatchCandidate[] = [];
  const claimedFiles = new Set<string>();

  for (const candidate of ordered) {
    if (toDispatch.length >= effectiveCap) {
      // Past the min(capacity, batchSize) budget for this tick.
      skipped.push({ candidate, reason: capacity <= toDispatch.length ? 'no-capacity' : 'batch-full' });
      continue;
    }
    // File-overlap serialization: skip if this candidate touches a file already
    // claimed by an earlier-planned candidate this tick.
    const files = candidate.files ?? [];
    const overlaps = files.some((f) => claimedFiles.has(f));
    if (overlaps) {
      skipped.push({ candidate, reason: 'file-overlap' });
      continue;
    }
    for (const f of files) claimedFiles.add(f);
    toDispatch.push(candidate);
  }

  return { toDispatch, skipped };
}
