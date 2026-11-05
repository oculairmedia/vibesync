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
 *     Execute (START the run via the Letta executor; do NOT await its end) →
 *       start failure: dispatch_failures++, store last_failure, circuit-break at 3
 *       started: record the bead as IN FLIGHT; the run settles off the tick:
 *         run OK     → close context (reason: dispatched)
 *         run FAILED → dispatch_failures++, circuit-break at 3 (context stays
 *                      open otherwise, so the next tick retries the bead)
 *
 * A tick DISPATCHES AND RETURNS (vibesync-q50w). A formula run takes minutes;
 * awaiting it inside the tick would leave poolSize>1 unused and stall the
 * refinery/witness phases for the whole run. The sling context stays OPEN while
 * the run is in flight, and in-flight work beads are filtered out of planning,
 * so one bead never has two concurrent runs.
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
 * Production wires this to FormulaDispatcher over the Iroh provider. Resolves on successful dispatch, rejects on
 * failure (the loop turns a rejection into a dispatch_failures increment).
 */
export interface DispatchExecutor {
  /**
   * Resolves once the dispatch has been handled:
   *  - `void`: the run already finished successfully (synchronous executor);
   *    the loop closes the context immediately.
   *  - a {@link DispatchRunHandle}: the run has STARTED and is still going. The
   *    loop does not wait for it; it tracks the bead as in flight and settles
   *    the context when `handle.settled` settles.
   * Rejects when the dispatch could not be started (counted as a failure now).
   */
  execute(candidate: DispatchCandidate): Promise<void | DispatchRunHandle>;
}

/** A started, still-running dispatch. */
export interface DispatchRunHandle {
  /**
   * Resolves when the run finished successfully (completed or blocked-and-
   * escalated); REJECTS when it failed. The loop attaches handlers, so the
   * rejection is never unhandled.
   */
  readonly settled: Promise<void>;
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
  /**
   * Called after a started run has settled (success or failure) and its
   * bookkeeping finished — the capacity it held is free again (vibesync-p489).
   * An interface seam: the loop never imports the daemon. Must not throw
   * (errors are logged and swallowed).
   */
  readonly onRunSettled?: () => void;
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

/** Summary of one tick, for observability + tests. */
export interface TickResult {
  readonly skippedReason?: 'paused' | 'locked' | 'no-capacity' | 'no-ready';
  readonly plan?: DispatchPlan;
  readonly dispatched: readonly string[]; // workBeadIds whose run was started this tick
  /**
   * workBeadIds whose dispatch failed since the previous tick report: start
   * failures from this tick plus runs that failed off-tick in between.
   */
  readonly failed: readonly string[];
  /** contextIds closed circuit-broken since the previous tick report. */
  readonly circuitBroken: readonly string[];
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
  /** work_bead_id → context id for runs that started and have not settled. */
  private readonly inFlight = new Map<string, string>();
  /** Settlement chains of started runs, so a caller can drain them (rig/tests). */
  private readonly settlements = new Set<Promise<void>>();
  /** Off-tick failure outcomes not yet reported in a TickResult. */
  private settledFailed: string[] = [];
  private settledBroken: string[] = [];

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
      return { skippedReason: 'paused', dispatched: [], ...this.drainSettled() };
    }

    if (!(await this.lock.tryAcquire())) {
      return { skippedReason: 'locked', dispatched: [], ...this.drainSettled() };
    }
    try {
      return await this.runTickLocked(cfg);
    } finally {
      await this.lock.release();
    }
  }

  /** Work bead ids whose run has started and not yet settled. */
  inFlightWorkBeadIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Take (and clear) the off-tick failure outcomes for the next TickResult. */
  private drainSettled(extraFailed: readonly string[] = [], extraBroken: readonly string[] = []): {
    failed: string[];
    circuitBroken: string[];
  } {
    const out = {
      failed: [...this.settledFailed, ...extraFailed],
      circuitBroken: [...this.settledBroken, ...extraBroken],
    };
    this.settledFailed = [];
    this.settledBroken = [];
    return out;
  }

  private async runTickLocked(cfg: SchedulerConfig): Promise<TickResult> {
    // Capacity = poolSize - active. No capacity → nothing to do this tick.
    const capacity = cfg.poolSize - this.deps.capacity.activeCount;
    if (capacity <= 0) {
      return { skippedReason: 'no-capacity', dispatched: [], ...this.drainSettled() };
    }

    // Snapshot the in-flight set BEFORE reading contexts: a run that settles
    // after this point is still excluded (it is in the snapshot), and one that
    // settled before it has already closed its context (close precedes the
    // in-flight delete), so the pending read below cannot return it.
    const busy = new Set(this.inFlight.keys());

    // Query open sling contexts and join against bd ready (unblocked beads).
    // A bead with a run in flight keeps its context OPEN until the run settles
    // but must never be planned again — no two concurrent runs for one bead.
    const pending = (await this.deps.contextStore.queryPending()).filter(
      (c) => !busy.has(c.params.work_bead_id),
    );
    const readyIds = await this.deps.readyWork.readyWorkBeadIds();
    const readyContexts = pending.filter((c) => readyIds.has(c.params.work_bead_id));
    if (readyContexts.length === 0) {
      return { skippedReason: 'no-ready', dispatched: [], ...this.drainSettled() };
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
      if (this.inFlight.has(candidate.workBeadId)) continue; // defensive: never two runs per bead
      try {
        const handle = await this.deps.executor.execute(candidate);
        if (handle) {
          // Run STARTED. Do not await it: track it and settle off the tick.
          this.trackRun(candidate, handle);
        } else {
          await this.deps.contextStore.closeContext(candidate.contextId, 'dispatched');
        }
        dispatched.push(candidate.workBeadId);
        this.deps.logger?.info?.(
          { workBeadId: candidate.workBeadId, contextId: candidate.contextId, async: handle !== undefined },
          'scheduler: dispatched',
        );
      } catch (err) {
        // Synchronous start failure: still a tick-time dispatch failure.
        failed.push(candidate.workBeadId);
        if (await this.accountFailure(candidate, err)) circuitBroken.push(candidate.contextId);
      }
    }

    return { plan, dispatched, ...this.drainSettled(failed, circuitBroken) };
  }

  /**
   * Count a failure on the context; circuit-break (close) at the threshold.
   * Returns true when the context was circuit-broken. Shared by start failures
   * (tick time) and run failures (settlement time).
   */
  private async accountFailure(candidate: DispatchCandidate, err: unknown): Promise<boolean> {
    const message = err instanceof Error ? err.message : String(err);
    const failures = await this.deps.contextStore.recordDispatchFailure(candidate.contextId, message);
    if (failures >= this.threshold) {
      // Circuit breaker: close the context so it stops retrying. Work bead
      // is untouched — a human/Meridian decides what to do next.
      await this.deps.contextStore.closeContext(candidate.contextId, 'circuit-broken');
      this.deps.logger?.warn?.(
        { workBeadId: candidate.workBeadId, contextId: candidate.contextId, failures, error: message },
        'scheduler: circuit-broken (>=3 dispatch failures)',
      );
      return true;
    }
    this.deps.logger?.warn?.(
      { workBeadId: candidate.workBeadId, contextId: candidate.contextId, failures, error: message },
      'scheduler: dispatch failed (will retry next tick)',
    );
    return false;
  }

  /** Record a started run as in flight and attach its settlement handlers. */
  private trackRun(candidate: DispatchCandidate, handle: DispatchRunHandle): void {
    this.inFlight.set(candidate.workBeadId, candidate.contextId);
    const chain: Promise<void> = handle.settled
      .then(
        () => this.onRunSettled(candidate, null),
        (err: unknown) => this.onRunSettled(candidate, err ?? new Error('run failed')),
      )
      .catch((err: unknown) => {
        // onRunSettled never rejects; this is the last-resort guard so a
        // background run can never become an unhandled rejection.
        this.deps.logger?.warn?.(
          { workBeadId: candidate.workBeadId, contextId: candidate.contextId, error: errMessage(err) },
          'scheduler: run settlement handler failed',
        );
      })
      .finally(() => {
        this.settlements.delete(chain);
      });
    this.settlements.add(chain);
  }

  /**
   * Wait for every started run to settle (and its bookkeeping to finish). NOT
   * used by the daemon loop or stop(); for supervised one-shot rigs and tests.
   */
  async drainRuns(): Promise<void> {
    while (this.settlements.size > 0) await Promise.all([...this.settlements]);
  }

  /**
   * Off-tick settlement. The bead leaves the in-flight set only AFTER its
   * context has been closed (success / circuit-broken) or its failure counted,
   * so a concurrent tick can neither re-plan it early nor see a stale open
   * context for a finished run.
   */
  private async onRunSettled(candidate: DispatchCandidate, error: unknown): Promise<void> {
    try {
      if (error === null) {
        await this.deps.contextStore.closeContext(candidate.contextId, 'dispatched');
        this.deps.logger?.info?.(
          { workBeadId: candidate.workBeadId, contextId: candidate.contextId },
          'scheduler: run settled — context closed (dispatched)',
        );
      } else {
        this.settledFailed.push(candidate.workBeadId);
        if (await this.accountFailure(candidate, error)) this.settledBroken.push(candidate.contextId);
      }
    } catch (err) {
      this.deps.logger?.warn?.(
        { workBeadId: candidate.workBeadId, contextId: candidate.contextId, error: errMessage(err) },
        'scheduler: run settlement bookkeeping failed',
      );
    } finally {
      this.inFlight.delete(candidate.workBeadId);
      try {
        this.deps.onRunSettled?.();
      } catch (err) {
        this.deps.logger?.warn?.(
          { workBeadId: candidate.workBeadId, error: errMessage(err) },
          'scheduler: onRunSettled observer failed',
        );
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
