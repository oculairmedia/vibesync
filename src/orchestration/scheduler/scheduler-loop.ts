/**
 * Scheduler daemon loop (vibesync-63zx.3) — the burn-down engine.
 *
 * A CHEAP, NON-LLM TS loop (NOT an agent wake) that, per tick, does the Gas
 * Town scheduler step (scheduler.md):
 *
 *   flock (serialize) → check paused → load config (poolSize, batchSize) →
 *   count active (AgentPool 63zx.2) → query open sling contexts
 *   (SlingContextManager 63zx.1) → join with `bd ready` (unblocked beads only) →
 *   PlanDispatch(capacity, batchSize, ready) → for each planned bead:
 *     Execute (dispatch via the Letta executor) →
 *       OnSuccess: close context (reason: dispatched)
 *       OnFailure: dispatch_failures++, store last_failure, circuit-break at 3
 *
 * TOKEN EFFICIENCY INVARIANT: the loop itself spends ZERO LLM tokens. All the
 * loop does is bookkeeping (pool counts, sling-context queries, a pure
 * planDispatch sort) and calling the injected Execute callback. Only the
 * dispatched agents (inside Execute) cost tokens — and Execute is injected, so
 * this module never imports a model client.
 *
 * The loop is a direct port of Gas Town's `DispatchCycle`: a generic
 * orchestrator with injected callbacks. That keeps it pure, testable, and
 * Kotlin-portable. Composition of the two prior bricks (sling-context +
 * pool) under PlanDispatch happens HERE and only here.
 *
 * Scope: ONLY the loop. Propulsion / self-completion (63zx.4) and
 * witness/stall-detection (63zx.7) are separate downstream slices.
 */

import { CIRCUIT_BREAKER_THRESHOLD, type SlingContextRecord } from './sling-context.js';
import type { DispatchCandidate, DispatchPlan } from './plan-dispatch.js';
import { planDispatch } from './plan-dispatch.js';

/** Scheduler configuration (scheduler.md capacity management). */
export interface SchedulerConfig {
  /** Concurrency cap = pool size. The loop never dispatches beyond it. */
  readonly poolSize: number;
  /** Beads dispatched per tick (default 1). */
  readonly batchSize: number;
  /** When true, the loop is a no-op (town-wide pause). */
  readonly paused: boolean;
}

/** Minimal read surface the loop needs from the agent pool (63zx.2). */
export interface CapacitySource {
  /** Slots currently WORKING. capacity = poolSize - activeCount. */
  readonly activeCount: number;
}

/**
 * Source of `bd ready` work-bead ids (unblocked beads). Injected so the loop
 * stays pure and testable; the production adapter runs `bd ready --json`.
 */
export interface ReadyWorkSource {
  /** Return the set of work bead ids that are ready (unblocked) right now. */
  readyWorkBeadIds(): Promise<ReadonlySet<string>>;
}

/**
 * Metadata a candidate needs beyond the sling context: priority, how many
 * downstream beads it unblocks (critical path), and the files it touches.
 * Injected (bd metadata + a code-perception/AST source), keeping the loop
 * free of bd/AST specifics.
 */
export interface CandidateMetadataSource {
  metadataFor(record: SlingContextRecord): Promise<{
    readonly priority: number;
    readonly unblockCount: number;
    readonly files: readonly string[];
  }>;
}

/**
 * The dispatch executor — the ONLY place tokens are spent, and it is injected.
 * Production wires this to the existing Letta executor (FormulaDispatcher /
 * LettaCodeSubagentProvider). Resolves on successful dispatch, rejects on
 * failure (the loop turns a rejection into a dispatch_failures increment).
 */
export interface DispatchExecutor {
  execute(candidate: DispatchCandidate): Promise<void>;
}

/**
 * The loop's write surface over sling contexts. Extends the read side
 * (queryPending) with the two post-dispatch mutations. Kept narrow and
 * bd-free so it is testable with a fake and Kotlin-portable.
 */
export interface SchedulerContextStore {
  /** Open sling contexts (SCHEDULED). Same as SlingContextManager.queryPending. */
  queryPending(): Promise<SlingContextRecord[]>;
  /** Close a context (dispatched | circuit-broken). */
  closeContext(contextId: string, reason: 'dispatched' | 'circuit-broken'): Promise<void>;
  /**
   * Record a failed dispatch attempt: increment dispatch_failures and store
   * last_failure on the CONTEXT bead (never the work bead). Returns the new
   * dispatch_failures count so the loop can decide whether to circuit-break.
   */
  recordDispatchFailure(contextId: string, error: string): Promise<number>;
}

/**
 * A serialization guard around the whole tick (Gas Town's
 * flock(scheduler-dispatch.lock)). Default is an in-process mutex so two ticks
 * never overlap; production may back it with a real file lock across
 * processes. Returns false if the lock is already held (tick is skipped).
 */
export interface DispatchLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

export interface SchedulerLoopDeps {
  readonly config: () => SchedulerConfig;
  readonly capacity: CapacitySource;
  readonly contextStore: SchedulerContextStore;
  readonly readyWork: ReadyWorkSource;
  readonly candidateMetadata: CandidateMetadataSource;
  readonly executor: DispatchExecutor;
  readonly lock?: DispatchLock;
  readonly circuitBreakerThreshold?: number;
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

/** Summary of one tick, for observability + tests. */
export interface TickResult {
  readonly skippedReason?: 'paused' | 'locked' | 'no-capacity' | 'no-ready';
  readonly plan?: DispatchPlan;
  readonly dispatched: readonly string[]; // workBeadIds successfully dispatched
  readonly failed: readonly string[]; // workBeadIds whose dispatch failed this tick
  readonly circuitBroken: readonly string[]; // contextIds closed circuit-broken
}

/** Default in-process mutex lock (single-node dispatch serialization). */
class InProcessLock implements DispatchLock {
  private held = false;
  async tryAcquire(): Promise<boolean> {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  async release(): Promise<void> {
    this.held = false;
  }
}

export class SchedulerLoop {
  private readonly deps: SchedulerLoopDeps;
  private readonly lock: DispatchLock;
  private readonly threshold: number;

  constructor(deps: SchedulerLoopDeps) {
    this.deps = deps;
    this.lock = deps.lock ?? new InProcessLock();
    this.threshold = deps.circuitBreakerThreshold ?? CIRCUIT_BREAKER_THRESHOLD;
  }

  /**
   * Run ONE scheduler tick. Cheap and non-LLM. Idempotent under the dispatch
   * lock: a second concurrent tick is skipped (skippedReason: 'locked').
   */
  async runTick(): Promise<TickResult> {
    const cfg = this.deps.config();
    if (cfg.paused) {
      return { skippedReason: 'paused', dispatched: [], failed: [], circuitBroken: [] };
    }

    if (!(await this.lock.tryAcquire())) {
      return { skippedReason: 'locked', dispatched: [], failed: [], circuitBroken: [] };
    }
    try {
      return await this.runTickLocked(cfg);
    } finally {
      await this.lock.release();
    }
  }

  private async runTickLocked(cfg: SchedulerConfig): Promise<TickResult> {
    // Capacity = poolSize - active. No capacity → nothing to do this tick.
    const capacity = cfg.poolSize - this.deps.capacity.activeCount;
    if (capacity <= 0) {
      return { skippedReason: 'no-capacity', dispatched: [], failed: [], circuitBroken: [] };
    }

    // Query open sling contexts and join against bd ready (unblocked beads).
    const pending = await this.deps.contextStore.queryPending();
    const readyIds = await this.deps.readyWork.readyWorkBeadIds();
    const readyContexts = pending.filter((c) => readyIds.has(c.params.work_bead_id));
    if (readyContexts.length === 0) {
      return { skippedReason: 'no-ready', dispatched: [], failed: [], circuitBroken: [] };
    }

    // Build candidates (priority / unblock-count / files) for planning.
    const candidates: DispatchCandidate[] = [];
    for (const ctx of readyContexts) {
      const meta = await this.deps.candidateMetadata.metadataFor(ctx);
      candidates.push({
        contextId: ctx.id,
        workBeadId: ctx.params.work_bead_id,
        priority: meta.priority,
        unblockCount: meta.unblockCount,
        enqueuedAt: ctx.params.enqueued_at,
        files: meta.files,
        dispatchFailures: ctx.params.dispatch_failures,
      });
    }

    // Pure selection: min(capacity, batchSize, ready), priority-sorted, with
    // file-overlap serialization. Circuit-broken candidates are filtered here.
    const plan = planDispatch(candidates, capacity, cfg.batchSize, this.threshold);

    const dispatched: string[] = [];
    const failed: string[] = [];
    const circuitBroken: string[] = [];

    for (const candidate of plan.toDispatch) {
      try {
        await this.deps.executor.execute(candidate);
        await this.deps.contextStore.closeContext(candidate.contextId, 'dispatched');
        dispatched.push(candidate.workBeadId);
        this.deps.logger?.info?.(
          { workBeadId: candidate.workBeadId, contextId: candidate.contextId },
          'scheduler: dispatched',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failures = await this.deps.contextStore.recordDispatchFailure(candidate.contextId, message);
        failed.push(candidate.workBeadId);
        if (failures >= this.threshold) {
          // Circuit breaker: close the context so it stops retrying. Work bead
          // is untouched — a human/Meridian decides what to do next.
          await this.deps.contextStore.closeContext(candidate.contextId, 'circuit-broken');
          circuitBroken.push(candidate.contextId);
          this.deps.logger?.warn?.(
            { workBeadId: candidate.workBeadId, contextId: candidate.contextId, failures, error: message },
            'scheduler: circuit-broken (>=3 dispatch failures)',
          );
        } else {
          this.deps.logger?.warn?.(
            { workBeadId: candidate.workBeadId, contextId: candidate.contextId, failures, error: message },
            'scheduler: dispatch failed (will retry next tick)',
          );
        }
      }
    }

    return { plan, dispatched, failed, circuitBroken };
  }
}
