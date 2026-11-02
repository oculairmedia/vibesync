/**
 * SchedulerDaemon — the runnable engine (vibesync-63zx, integration slice).
 *
 * Composes the seven verified scheduler components into ONE cheap, non-LLM
 * patrol loop that actually burns down the backlog:
 *
 *   tick():
 *     1. scheduler.runTick()   — START ready beads' runs under the pool cap (runs settle off the tick)
 *     2. refinery.processQueue() — auto-merge self-completed PRs (safety-gated)
 *     3. witness.patrol()      — recover crashed/zombie slots (causal, not time)
 *
 * The loop itself spends ZERO LLM tokens — selection/merge/patrol are pure logic.
 * Only dispatched agents (inside the DispatchRunner → FormulaDispatcher) cost
 * tokens. This is the token-efficiency invariant made real.
 *
 * This module WIRES the real adapters (FormulaDispatcher, BeadsAdapter, the
 * AgentPool, gh) to the injected seams the components expose, and owns the ONE
 * cross-component concern the individual slices deliberately left out: the pool
 * SLOT LIFECYCLE — allocate a slot when the scheduler dispatches, free it when
 * the propulsion run self-completes (or the witness reaps it).
 */

import type { FormulaDispatcher, DispatchInput } from '../dispatcher/dispatcher.js';
import { AgentPool, type PoolMemberIdentity } from './agent-pool.js';
import { SchedulerLoop, type SchedulerConfig, type TickResult } from './scheduler-loop.js';
import { SlingContextManager, type SlingContextStore } from './sling-context.js';
import { PropulsionExecutor, type DispatchRunner, type DispatchRunResult } from './propulsion-executor.js';
import type { DispatchCandidate } from './plan-dispatch.js';
import { Refinery, type GitHubPort, type RefineryEscalationSink, type MergeRequest } from './refinery.js';
import { Witness, type RunLivenessProbe, type WitnessEscalation } from './witness.js';

export interface DaemonLogger {
  info?(o: unknown, m: string): void;
  warn?(o: unknown, m: string): void;
}

/** Resolves the (formula, pack, project) a ready work bead should dispatch as. */
export interface FormulaResolver {
  resolve(workBeadId: string): Promise<{
    readonly formula: DispatchInput['formula'];
    readonly pack: DispatchInput['pack'];
    readonly projectIdentifier: string;
    readonly input: string;
  } | null>;
}

/** Source of ready work + candidate metadata, backed by BeadsAdapter. */
export interface ReadyBeadSource {
  /** Work bead ids that are dependency-unblocked (bd ready). */
  readyWorkBeadIds(): Promise<Set<string>>;
  /** Priority (0=P0…), downstream unblock count, and touched files for a bead. */
  metadataFor(workBeadId: string): Promise<{
    readonly priority: number;
    readonly unblockCount: number;
    readonly files: readonly string[];
  }>;
}

/**
 * Per-tick observation record handed to `SchedulerDaemonDeps.onTick` after every
 * interval-driven tick (vibesync-z2ws). The boot composition turns it into a log
 * line AND an EventBus event (layering invariant 3) — the daemon itself stays
 * free of any bus import and just reports through this callback.
 */
export interface DaemonTickReport {
  /** 1-based sequence number of this tick since `run()` started. */
  readonly seq: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly result: DaemonTickResult;
}

export interface SchedulerDaemonDeps {
  readonly dispatcher: FormulaDispatcher;
  readonly formulaResolver: FormulaResolver;
  readonly readyBeads: ReadyBeadSource;
  readonly contextStore: SlingContextStore;
  readonly poolMembers: readonly PoolMemberIdentity[];
  readonly github: GitHubPort;
  readonly requiredCheckNames: (repo: string) => readonly string[];
  readonly livenessProbe: RunLivenessProbe;
  readonly escalation: RefineryEscalationSink & WitnessEscalation & {
    /** Blocked-run escalation from the propulsion executor. */
    onBlocked(input: { readonly workBeadId: string; readonly runId: string; readonly summary: string }): Promise<void>;
  };
  readonly config: () => SchedulerConfig;
  readonly now?: () => Date;
  readonly logger?: DaemonLogger;
  /** Called after every interval-driven tick completes. Must not throw (errors are logged and swallowed). */
  readonly onTick?: (report: DaemonTickReport) => void;
}

export interface DaemonTickResult {
  readonly scheduler: TickResult;
  readonly merged: readonly number[];
  readonly recovered: readonly string[];
}

/**
 * The runnable daemon. Construct once with the real adapters, then call
 * `tick()` from an interval (cheap, non-LLM) or `run(intervalMs)` to loop.
 */
export class SchedulerDaemon {
  private readonly deps: SchedulerDaemonDeps;
  private readonly pool: AgentPool;
  private readonly sling: SlingContextManager;
  private readonly scheduler: SchedulerLoop;
  private readonly refinery: Refinery;
  private readonly witness: Witness;
  /** work_bead_id → slot_id, so self-completion frees the right slot. */
  private readonly slotForBead = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The currently running interval-driven tick, so stop() can await it. */
  private inFlight: Promise<void> | null = null;
  /** Set by stop(); in-flight ticks skip their remaining (writing) phases. */
  private stopping = false;
  private tickSeq = 0;
  /**
   * In-process dispatch-failure counts per sling context. The SlingContextStore
   * has no update seam for `dispatch_failures`, so without this the circuit
   * breaker would never trip (count always 1) and a permanently failing bead
   * would be re-dispatched — an LLM run — on every tick.
   */
  private readonly failureCounts = new Map<string, number>();

  constructor(deps: SchedulerDaemonDeps) {
    this.deps = deps;
    const now = deps.now ?? (() => new Date());

    this.pool = new AgentPool({ members: deps.poolMembers, now });
    this.sling = new SlingContextManager({ store: deps.contextStore, now });

    // The propulsion executor: runs the real dispatch, self-completes, and
    // frees the slot (via slotForBead) so the scheduler continues.
    // The scheduler uses the two-phase `start` so a tick only STARTS runs; the
    // run settles (classify, slot free, escalate) off the tick (vibesync-q50w).
    const runner: DispatchRunner = {
      start: (c) => this.startRun(c),
      run: async (c) => (await this.startRun(c)).done,
    };
    const executor = new PropulsionExecutor({
      runner,
      pool: { onComplete: (slotId) => this.pool.onComplete(slotId) },
      completion: { onCompleted: async () => { /* refinery enqueue happens in dispatchRun */ } },
      escalation: { onBlocked: (i) => deps.escalation.onBlocked(i) },
      // Take-and-clear: a stale mapping must never free a slot that was since
      // re-allocated to another bead.
      slotIdFor: (workBeadId) => {
        const slotId = this.slotForBead.get(workBeadId) ?? null;
        this.slotForBead.delete(workBeadId);
        return slotId;
      },
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    // Live capacity source: activeCount = WORKING slots, read fresh each tick.
    const pool = this.pool;
    const capacitySource = {
      get activeCount(): number {
        return pool.view().filter((slot) => slot.state === 'working').length;
      },
    };

    this.scheduler = new SchedulerLoop({
      config: deps.config,
      capacity: capacitySource,
      contextStore: {
        queryPending: () => this.sling.queryPending(),
        closeContext: (id, reason) => this.sling.closeContext(id, reason),
        recordDispatchFailure: (id, err) => this.recordFailure(id, err),
      },
      readyWork: { readyWorkBeadIds: () => deps.readyBeads.readyWorkBeadIds() },
      candidateMetadata: { metadataFor: (r) => deps.readyBeads.metadataFor(r.params.work_bead_id) },
      executor: { execute: (c) => executor.start(c) },
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    this.refinery = new Refinery({
      github: deps.github,
      escalation: { onIsolated: (i) => deps.escalation.onIsolated(i) },
      requiredCheckNames: deps.requiredCheckNames,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    this.witness = new Witness({
      probe: deps.livenessProbe,
      reaper: { onComplete: (slotId) => this.pool.onComplete(slotId) },
      // A run still in flight owns its slot (it frees it on settle); the witness
      // must not reap it just because the agent already closed its bead (nic6).
      isRunInFlight: (workBeadId) => this.scheduler.inFlightWorkBeadIds().includes(workBeadId),
      escalation: { onRepeatedRecovery: (i) => deps.escalation.onRepeatedRecovery(i) },
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
  }

  /**
   * START the real dispatch (does not wait for it to finish): allocate a pool
   * slot, resolve the formula, and kick off the formula run. Rejects only when
   * the run could not be started (no slot / no formula / resolver error) —
   * that is a tick-time dispatch failure. Otherwise returns `done`, which
   * settles when the formula finishes with the normalized DispatchRunResult the
   * propulsion executor classifies; on a PR-producing completion the PR is
   * handed to the refinery. `done` never rejects (a run failure is `ok:false`),
   * so a background run can never surface as an unhandled rejection.
   */
  private async startRun(candidate: DispatchCandidate): Promise<{ readonly done: Promise<DispatchRunResult> }> {
    const alloc = this.pool.allocate({ workBeadId: candidate.workBeadId });
    if (!alloc) {
      // No slot — should not happen (scheduler respects capacity), but fail safe.
      throw new Error('no pool slot available');
    }
    this.slotForBead.set(candidate.workBeadId, alloc.slotId);

    const resolved = await this.deps.formulaResolver.resolve(candidate.workBeadId);
    if (!resolved) {
      throw new Error(`no formula resolved for ${candidate.workBeadId}`);
    }

    const run = this.deps.dispatcher.run({
      formula: resolved.formula,
      pack: resolved.pack,
      input: resolved.input,
      motivatingBeadId: candidate.workBeadId,
      projectIdentifier: resolved.projectIdentifier,
    });
    const done = Promise.resolve(run).then(
      (result): DispatchRunResult => {
        const output = Object.values(result.outputs).join('\n');
        // If the run produced a PR, hand it to the refinery for auto-merge.
        this.maybeEnqueuePr(candidate.workBeadId, result.moleculeId, output);
        return { runId: result.moleculeId, output, ok: true };
      },
      (err: unknown): DispatchRunResult => {
        this.deps.logger?.warn?.(
          { workBeadId: candidate.workBeadId, error: msg(err) },
          'daemon: run failed',
        );
        return { runId: '', output: '', ok: false, error: msg(err) };
      },
    );
    return { done };
  }

  /** Parse a PR url from the run output; enqueue it into the refinery if found. */
  private maybeEnqueuePr(workBeadId: string, runId: string, output: string): void {
    const m = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i.exec(output);
    if (!m) return;
    const mr: MergeRequest = {
      id: `mr-${m[2]}`,
      repo: m[1]!,
      prNumber: Number(m[2]),
      workBeadId,
      enqueuedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    this.refinery.enqueue(mr);
    this.deps.logger?.info?.({ workBeadId, prNumber: mr.prNumber, runId }, 'daemon: PR queued for refinery');
  }

  private async recordFailure(contextId: string, _err: string): Promise<number> {
    // The SchedulerLoop trips the circuit breaker from the returned count. The
    // store cannot persist dispatch_failures, so count in-process (resets on
    // restart) on top of whatever the context already carries.
    const pending = await this.sling.queryPending();
    const ctx = pending.find((c) => c.id === contextId);
    const persisted = ctx?.params.dispatch_failures ?? 0;
    const next = Math.max(this.failureCounts.get(contextId) ?? persisted, persisted) + 1;
    this.failureCounts.set(contextId, next);
    return next;
  }

  /**
   * One daemon cycle (cheap, non-LLM). Runs the three phases in order:
   *   1. dispatch ready work under the pool cap (scheduler)
   *   2. auto-merge self-completed PRs (refinery, safety-gated)
   *   3. recover crashed/zombie slots (witness, causal)
   * Each phase is best-effort isolated — one phase failing does not abort the
   * others, so a transient GitHub error cannot stall dispatching or recovery.
   */
  /**
   * Phase 0: ensure every ready work bead has a sling context (scheduled).
   * The scheduler loop only dispatches already-scheduled contexts, so this is
   * what actually *enqueues* newly-ready beads into the engine. scheduleBead is
   * idempotent (one open context per work bead), so re-running is safe.
   */
  private async scheduleReady(): Promise<void> {
    const ready = await this.deps.readyBeads.readyWorkBeadIds();
    for (const workBeadId of ready) {
      const resolved = await this.deps.formulaResolver.resolve(workBeadId);
      if (!resolved) continue;
      await this.sling.scheduleBead({
        workBeadId,
        targetProject: resolved.projectIdentifier,
        formula: typeof resolved.formula === 'string' ? resolved.formula : (resolved.formula as { name?: string })?.name ?? 'default',
        args: resolved.input,
      });
    }
  }

  /**
   * Wait for every started run to settle. For supervised one-shot rigs and
   * tests only — the interval loop and stop() never wait on runs.
   */
  drainRuns(): Promise<void> {
    return this.scheduler.drainRuns();
  }

  async tick(): Promise<DaemonTickResult> {
    // Phase 0: schedule newly-ready beads (create sling contexts) so the
    // scheduler loop has claimed work to dispatch this tick.
    try {
      await this.scheduleReady();
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err) }, 'daemon: schedule phase failed');
    }

    let scheduler: TickResult;
    if (this.stopping) {
      return { scheduler: { dispatched: [], failed: [], circuitBroken: [], skippedReason: 'paused' }, merged: [], recovered: [] };
    }
    try {
      scheduler = await this.scheduler.runTick();
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err) }, 'daemon: scheduler phase failed');
      scheduler = { dispatched: [], failed: [], circuitBroken: [], skippedReason: 'no-ready' };
    }

    const merged: number[] = [];
    // Once stop() was requested, do not start the externally-visible refinery
    // (merge) or witness phases: shutdown must not be followed by new writes.
    if (this.stopping) return { scheduler, merged, recovered: [] };
    try {
      const processed = await this.refinery.processQueue();
      for (const p of processed) if (p.state === 'merged') merged.push(p.request.prNumber);
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err) }, 'daemon: refinery phase failed');
    }

    const recovered: string[] = [];
    if (this.stopping) return { scheduler, merged, recovered };
    try {
      const patrol = await this.witness.patrol(this.pool.view());
      for (const r of patrol.recovered) {
        recovered.push(r.slotId);
        this.slotForBead.delete(r.workBeadId); // slot freed by the witness
      }
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err) }, 'daemon: witness phase failed');
    }

    return { scheduler, merged, recovered };
  }

  /**
   * Start the daemon loop at the given interval (ms). Idempotent. Ticks never
   * overlap (a slow tick makes the interval skip), and the interval callback
   * never throws: every failure is logged with context.
   */
  run(intervalMs: number): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      if (this.stopping) return;
      if (this.inFlight) {
        this.deps.logger?.info?.({ intervalMs }, 'daemon: previous tick still running — skipping this interval');
        return;
      }
      this.inFlight = this.runObservedTick().finally(() => {
        this.inFlight = null;
      });
    }, intervalMs);
    this.deps.logger?.info?.({ intervalMs, poolSize: this.deps.poolMembers.length }, 'daemon: started');
  }

  /** One interval-driven tick plus its observation report. Never rejects. */
  private async runObservedTick(): Promise<void> {
    const seq = ++this.tickSeq;
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let result: DaemonTickResult;
    try {
      result = await this.tick();
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err), seq }, 'daemon: tick error');
      return;
    }
    try {
      this.deps.onTick?.({ seq, startedAt, durationMs: Date.now() - started, result });
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err), seq }, 'daemon: onTick observer failed');
    }
  }

  /**
   * Stop the daemon loop and wait for any in-flight TICK to finish (short: a
   * tick only starts runs), so no tick is still writing once the returned
   * promise resolves. Formula runs are not awaited. Idempotent.
   */
  async stop(): Promise<void> {
    const wasRunning = this.timer !== null;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pending = this.inFlight;
    if (pending) await pending;
    if (wasRunning) {
      // Runs are NOT awaited: they outlive the tick (and a short SIGTERM grace).
      // Surface which beads are still mid-run so the operator can see them.
      const inFlightWorkBeadIds = this.scheduler.inFlightWorkBeadIds();
      this.deps.logger?.info?.(
        { ticks: this.tickSeq, inFlightWorkBeadIds },
        inFlightWorkBeadIds.length > 0
          ? 'daemon: stopped — runs still in flight were NOT awaited'
          : 'daemon: stopped',
      );
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
