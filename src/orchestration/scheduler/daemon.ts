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
import { isRepoAllowed } from './repo-allowlist.js';
import { Witness, type RunLivenessProbe, type WitnessEscalation } from './witness.js';

/**
 * Why a tick ran (vibesync-p489). `interval` is the fallback timer; the other
 * three are event triggers funnelled through `SchedulerDaemon.requestTick`.
 * `webhook` is reserved for vibesync-xgnf, which calls the same entry point.
 */
export type TickReason = 'interval' | 'webhook' | 'bead-status' | 'run-finished';

/**
 * Outcome of `requestTick`:
 *  - `started`   — a tick was started now (leading edge).
 *  - `debounced` — inside the debounce window; coalesced into the single trailing tick.
 *  - `locked`    — a tick is already running; the request is skipped, NOT queued.
 *  - `inactive`  — the daemon is not running (never started, or stopped); no-op.
 */
export type TickRequestOutcome = 'started' | 'debounced' | 'locked' | 'inactive';

/** Default minimum spacing between event-triggered ticks (ms). */
export const DEFAULT_EVENT_DEBOUNCE_MS = 5_000;

/**
 * Default wall-clock budget for a started formula run (vibesync-izn3). A run
 * owns its pool slot until it settles (q50w/nic6), so a run that never settles
 * would hold the slot forever; past this budget the daemon cancels it. 0 = no
 * deadline.
 */
export const DEFAULT_RUN_DEADLINE_MS = 3_600_000;

/**
 * How long an expired run waits for `dispatcher.cancel()` before its slot is
 * freed anyway (vibesync-izn3). cancel() stops provider sessions, which can
 * hang for the very same reason the run did; the slot must not depend on it.
 */
export const RUN_CANCEL_GRACE_MS = 30_000;

/** Largest delay setTimeout honours (2^31 - 1 ms); larger values fire after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  /** What caused this tick (vibesync-p489). */
  readonly reason: TickReason;
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
  /**
   * owner/repo allowlist for PRs parsed out of (untrusted) run output
   * (vibesync-5c8y). A PR url for any other repo is ignored with a WARN.
   * Empty = nothing is ever enqueued.
   */
  readonly allowedRepos: readonly string[];
  readonly requiredCheckNames: (repo: string) => readonly string[];
  readonly livenessProbe: RunLivenessProbe;
  readonly escalation: RefineryEscalationSink & WitnessEscalation & {
    /** Blocked-run escalation from the propulsion executor. */
    onBlocked(input: { readonly workBeadId: string; readonly runId: string; readonly summary: string }): Promise<void>;
  };
  readonly config: () => SchedulerConfig;
  readonly now?: () => Date;
  readonly logger?: DaemonLogger;
  /**
   * Minimum spacing between EVENT-triggered ticks (vibesync-p489). Default
   * {@link DEFAULT_EVENT_DEBOUNCE_MS}. Does not affect the interval timer.
   */
  readonly eventDebounceMs?: number;
  /**
   * Wall-clock deadline (ms) for every started run (vibesync-izn3). Default
   * {@link DEFAULT_RUN_DEADLINE_MS}; 0 disables the deadline.
   */
  readonly runDeadlineMs?: number;
  /**
   * Per-bead deadline override seam (vibesync-bw97 will implement the budget
   * behind it). Return `undefined` to fall back to `runDeadlineMs`. Not wired
   * by anything yet.
   */
  readonly runDeadlineFor?: (workBeadId: string) => number | undefined;
  /** Called after every tick (interval- or event-driven) completes. Must not throw completes. Must not throw (errors are logged and swallowed). */
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
  /** The currently running tick (any reason), so stop() can await it and no two ticks overlap. */
  private inFlight: Promise<void> | null = null;
  private readonly eventDebounceMs: number;
  /** Live deadline/cancel-grace timers, one watch per in-flight run (vibesync-izn3). */
  private readonly runWatches = new Set<RunWatch>();
  /** Wall-clock start of the last EVENT-triggered tick (window anchor). Interval ticks do not move it. */
  private lastEventTickAt: number | null = null;
  /** Pending trailing tick for requests coalesced inside the debounce window. */
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingReason: TickReason | null = null;
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
    this.eventDebounceMs = deps.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS;
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
      // Trigger (c): a settled run frees capacity — ask for a prompt tick.
      onRunSettled: () => { this.requestTick('run-finished'); },
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

    // The molecule id is known only once the dispatcher has created the molecule
    // — long before `run()` resolves. Capture it early so a hung run can still
    // be cancelled at its deadline (vibesync-izn3).
    let moleculeId: string | undefined;
    const run = this.deps.dispatcher.run({
      formula: resolved.formula,
      pack: resolved.pack,
      input: resolved.input,
      motivatingBeadId: candidate.workBeadId,
      projectIdentifier: resolved.projectIdentifier,
      onStarted: (id) => { moleculeId = id; },
    });

    // `done` settles EXACTLY ONCE, from whichever happens first: the run
    // settling, or the deadline expiring. Everything downstream (executor
    // settle -> slot free; loop onRunSettled -> failure count, in-flight delete,
    // requestTick('run-finished')) hangs off this one promise, so slot-free and
    // failure-count are once-only by construction.
    const watch: RunWatch = { timer: null, graceTimer: null };
    const startedAtMs = Date.now();
    let finished = false;
    let expired = false;
    let resolveDone!: (r: DispatchRunResult) => void;
    const done = new Promise<DispatchRunResult>((resolve) => { resolveDone = resolve; });
    const finish = (result: DispatchRunResult): void => {
      if (finished) return;
      finished = true;
      this.disposeWatch(watch);
      resolveDone(result);
    };

    const settledByDispatcher = (result: DispatchRunResult, enqueueFrom?: { moleculeId: string; output: string }): void => {
      if (expired) {
        // The deadline already owns this run's outcome; a late settlement
        // (the cancel unwinding it, or it limping home) must not count twice.
        this.deps.logger?.info?.(
          { workBeadId: candidate.workBeadId, moleculeId: moleculeId ?? null, ok: result.ok },
          'daemon: run settled after its deadline expired — ignored',
        );
        return;
      }
      if (enqueueFrom) {
        // A throw while enqueueing must never skip finish(): with no deadline
        // armed nothing else would free the slot (CodeRabbit on #51).
        try {
          this.maybeEnqueuePr(candidate.workBeadId, enqueueFrom.moleculeId, enqueueFrom.output);
        } catch (err) {
          this.deps.logger?.warn?.(
            { workBeadId: candidate.workBeadId, moleculeId: enqueueFrom.moleculeId, error: msg(err) },
            'daemon: PR enqueue failed; run still settled',
          );
        }
      }
      finish(result);
    };

    Promise.resolve(run).then(
      (result) => {
        const output = Object.values(result.outputs).join('\n');
        settledByDispatcher({ runId: result.moleculeId, output, ok: true }, { moleculeId: result.moleculeId, output });
      },
      (err: unknown) => {
        if (!expired) {
          this.deps.logger?.warn?.(
            { workBeadId: candidate.workBeadId, error: msg(err) },
            'daemon: run failed',
          );
        }
        settledByDispatcher({ runId: '', output: '', ok: false, error: msg(err) });
      },
    );

    const deadlineMs = this.runDeadlineFor(candidate.workBeadId);
    if (deadlineMs > 0 && !this.stopping) {
      this.runWatches.add(watch);
      watch.timer = setTimeout(() => {
        watch.timer = null;
        if (finished) return;
        expired = true;
        void this.expireRun({
          watch, workBeadId: candidate.workBeadId, moleculeId, deadlineMs,
          elapsedMs: Date.now() - startedAtMs,
          finish,
        });
      }, deadlineMs);
      watch.timer.unref?.();
    }
    return { done };
  }

  /** Effective deadline for one run: per-bead override seam, else the daemon-wide budget. */
  private runDeadlineFor(workBeadId: string): number {
    const override = this.deps.runDeadlineFor?.(workBeadId);
    const ms = override ?? this.deps.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    // setTimeout treats delays above 2^31-1 ms as 1 ms; clamp so an oversized
    // budget means "about 24.8 days", not "cancel immediately" (CodeRabbit on #51).
    return Math.min(ms, MAX_TIMER_DELAY_MS);
  }

  private disposeWatch(watch: RunWatch): void {
    if (watch.timer) clearTimeout(watch.timer);
    if (watch.graceTimer) clearTimeout(watch.graceTimer);
    watch.timer = null;
    watch.graceTimer = null;
    this.runWatches.delete(watch);
  }

  /**
   * A run outlived its deadline: cancel its molecule (best effort — a cancel
   * that throws, e.g. FormulaCancellationConflictError because no step is
   * running yet, or that hangs past {@link RUN_CANCEL_GRACE_MS}, must not keep
   * the slot) and then settle the run as FAILED through `finish`, which frees
   * the slot and counts the failure on the sling context via the normal
   * settlement path. Never rejects.
   */
  private async expireRun(args: {
    readonly watch: RunWatch;
    readonly workBeadId: string;
    readonly moleculeId: string | undefined;
    readonly deadlineMs: number;
    readonly elapsedMs: number;
    readonly finish: (r: DispatchRunResult) => void;
  }): Promise<void> {
    const { watch, workBeadId, moleculeId, deadlineMs, elapsedMs, finish } = args;
    try {
      this.deps.logger?.warn?.(
        { workBeadId, moleculeId: moleculeId ?? null, elapsedMs, deadlineMs },
        'daemon: run exceeded its deadline — cancelling',
      );
      if (moleculeId) {
        const cancelled = Promise.resolve()
          .then(() => this.deps.dispatcher.cancel(moleculeId))
          .then(
            () => { /* cancelled */ },
            (err: unknown) => {
              this.deps.logger?.warn?.(
                { workBeadId, moleculeId, error: msg(err) },
                'daemon: cancel of expired run failed — freeing the slot anyway',
              );
            },
          );
        const grace = new Promise<void>((resolve) => {
          watch.graceTimer = setTimeout(() => {
            watch.graceTimer = null;
            this.deps.logger?.warn?.(
              { workBeadId, moleculeId, graceMs: RUN_CANCEL_GRACE_MS },
              'daemon: cancel of expired run still pending — freeing the slot anyway',
            );
            resolve();
          }, RUN_CANCEL_GRACE_MS);
          watch.graceTimer.unref?.();
        });
        await Promise.race([cancelled, grace]);
      } else {
        this.deps.logger?.warn?.(
          { workBeadId, elapsedMs },
          'daemon: expired run never reported a molecule id — nothing to cancel',
        );
      }
    } catch (err) {
      this.deps.logger?.warn?.({ workBeadId, error: msg(err) }, 'daemon: run deadline handling failed');
    } finally {
      finish({
        runId: moleculeId ?? '',
        output: '',
        ok: false,
        error: `run exceeded its deadline of ${deadlineMs}ms (cancelled after ${elapsedMs}ms)`,
      });
    }
  }

  /**
   * Parse PR urls from the run output; enqueue those whose repo is in
   * `allowedRepos` (vibesync-5c8y). Output is untrusted, so EVERY url is
   * considered: allowed ones are enqueued, each other one is WARN-logged and
   * dropped (one rejected url never suppresses an allowed one).
   */
  private maybeEnqueuePr(workBeadId: string, runId: string, output: string): void {
    const re = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/gi;
    for (const m of output.matchAll(re)) {
      const repo = m[1]!.replace(/\.git$/i, '');
      const prNumber = Number(m[2]);
      if (!isRepoAllowed(repo, this.deps.allowedRepos)) {
        this.deps.logger?.warn?.({ workBeadId, runId, repo, prNumber }, 'daemon: PR url for non-allowed repo ignored');
        continue;
      }
      const mr: MergeRequest = {
        id: `mr-${repo.toLowerCase()}#${prNumber}`,
        repo,
        prNumber,
        workBeadId,
        enqueuedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      };
      this.refinery.enqueue(mr);
      this.deps.logger?.info?.({ workBeadId, prNumber, runId }, 'daemon: PR queued for refinery');
    }
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
      this.startTick('interval');
    }, intervalMs);
    this.deps.logger?.info?.(
      { intervalMs, eventDebounceMs: this.eventDebounceMs, poolSize: this.deps.poolMembers.length },
      'daemon: started',
    );
  }

  /**
   * The SINGLE entry point for event-driven ticks (vibesync-p489): bead status
   * changes, finished runs and (later, vibesync-xgnf) webhooks all call this.
   * The interval timer stays as the fallback; nothing here self-reschedules.
   *
   * Debounce = leading edge + one trailing tick, at most one event-triggered
   * tick per `eventDebounceMs`:
   *   - first request after a quiet window ticks immediately;
   *   - requests inside the window collapse into ONE trailing tick fired at the
   *     window's end (so a burst is never lost, never multiplied);
   *   - a request while a tick is running (interval or event) is skipped as
   *     'locked' — never queued, never a second concurrent tick.
   * No-op ('inactive') unless the loop is running, and after stop().
   */
  requestTick(reason: TickReason): TickRequestOutcome {
    if (!this.timer || this.stopping) return 'inactive';
    if (this.inFlight) {
      this.logLockedSkip(reason);
      return 'locked';
    }
    const now = Date.now();
    if (this.lastEventTickAt !== null) {
      const remaining = this.lastEventTickAt + this.eventDebounceMs - now;
      if (remaining > 0) {
        this.trailingReason = reason; // latest wins; the tick is one regardless of how many were coalesced
        if (!this.trailingTimer) {
          this.trailingTimer = setTimeout(() => this.fireTrailing(), remaining);
        }
        return 'debounced';
      }
    }
    this.lastEventTickAt = now;
    this.startTick(reason);
    return 'started';
  }

  private fireTrailing(): void {
    const reason = this.trailingReason ?? 'bead-status';
    this.trailingTimer = null;
    this.trailingReason = null;
    if (!this.timer || this.stopping) return;
    if (this.inFlight) {
      this.logLockedSkip(reason); // dropped, not re-queued
      return;
    }
    this.lastEventTickAt = Date.now();
    this.startTick(reason);
  }

  private logLockedSkip(reason: TickReason): void {
    this.deps.logger?.info?.(
      { reason, skippedReason: 'locked' },
      'SchedulerDaemon tick request skipped — locked (a tick is already running)',
    );
  }

  /** Shared tick runner for the interval and event triggers: they can never overlap. */
  private startTick(reason: TickReason): void {
    this.inFlight = this.runObservedTick(reason).finally(() => {
      this.inFlight = null;
    });
  }

  /** One tick plus its observation report. Never rejects. */
  private async runObservedTick(reason: TickReason): Promise<void> {
    const seq = ++this.tickSeq;
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let result: DaemonTickResult;
    try {
      result = await this.tick();
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err), seq, reason }, 'daemon: tick error');
      return;
    }
    try {
      this.deps.onTick?.({ seq, reason, startedAt, durationMs: Date.now() - started, result });
    } catch (err) {
      this.deps.logger?.warn?.({ error: msg(err), seq, reason }, 'daemon: onTick observer failed');
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
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.trailingReason = null;
    this.lastEventTickAt = null;
    const pending = this.inFlight;
    if (pending) await pending;
    // Runs are not awaited, so their deadlines must not outlive the daemon.
    // Cleared AFTER the in-flight tick so a run that tick just started is covered.
    for (const watch of [...this.runWatches]) this.disposeWatch(watch);
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

/** Deadline + cancel-grace timers of one in-flight run (vibesync-izn3). */
interface RunWatch {
  timer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
