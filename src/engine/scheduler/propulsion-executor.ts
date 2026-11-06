/**
 * Propulsion + self-completion executor (vibesync-63zx.4).
 *
 * This is the executor half of the scheduler burn-down loop (63zx.3). It
 * implements that loop's injected `DispatchExecutor` seam, so it drops
 * straight into `SchedulerLoop` without any change there.
 *
 * PROPULSION (propulsion.md): when the scheduler dispatches, the agent is
 * spawned WITH the work bead on its hook — the formula input IS the hook — and
 * runs IMMEDIATELY. There is no "survey the backlog" turn; the existing
 * dispatch path already prompts the agent with its work, so propulsion is
 * realized by REUSING that path (FormulaDispatcher.run), not by adding a
 * pre-flight survey. We do not duplicate the dispatch machinery.
 *
 * SELF-COMPLETION (self-completion.md): the agent self-manages its lifecycle —
 * push branch, open PR, close/comment the bead, clear its hook. The daemon-side
 * job of THIS executor is the last, load-bearing step: once the run returns, it
 *   1. classifies the outcome (completed | blocked | failed),
 *   2. hands completion artifacts (PR/branch) to a SelfCompletionSink, OR drops
 *      a NEEDS-MERIDIAN-DECISION escalation on block,
 *   3. ALWAYS frees the pool slot (pool.onComplete) so the scheduler dispatches
 *      the next ready bead — the `bd close --continue` equivalent.
 * The witness is NOT in this critical path (self-managed completion).
 *
 * Slot-freeing is the invariant that keeps the engine turning: success, block,
 * or failure, the slot is released so capacity returns. On a hard failure the
 * error is rethrown AFTER freeing, so the loop's circuit breaker still counts
 * it.
 *
 * Scope: ONLY the propulsion/self-completion executor. Escalation severity
 * routing (63zx.5), refinery merge (63zx.6), and witness (63zx.7) are separate
 * downstream slices; here we only DROP the marker and free the slot.
 */

import type { DispatchCandidate } from './plan-dispatch.js';
import { EscalatedRunError, type DispatchExecutor, type DispatchRunHandle } from './scheduler-loop.js';

/** How a dispatched run ended. */
export type PropulsionOutcome = 'completed' | 'blocked' | 'failed';

/** Marker an agent emits (in its final output) to request a human decision. */
export const NEEDS_MERIDIAN_MARKER = 'NEEDS-MERIDIAN-DECISION';

/** Artifacts parsed from a completed run's output (self-completion evidence). */
export interface CompletionArtifacts {
  readonly prUrl?: string;
  readonly branch?: string;
  readonly commitSha?: string;
}

/** The result of the underlying (reused) dispatch path, normalized. */
export interface DispatchRunResult {
  /** The molecule/run id. */
  readonly runId: string;
  /** Concatenated/last agent output used for artifact + marker detection. */
  readonly output: string;
  /** Did the underlying run reach a successful terminal state? */
  readonly ok: boolean;
  /** Error message when ok === false. */
  readonly error?: string;
  /**
   * vibesync-9lzk.43: the run stopped on purpose to wait for a person (a step
   * blocked, a verdict failed closed, the review loop ran out of rounds). Not
   * retryable: the scheduler records it and leaves the bead alone.
   */
  readonly escalated?: boolean;
}


/**
 * Runs the actual dispatch by REUSING the existing path. Production wires this
 * to FormulaDispatcher.run (which runs the work on the role agent over the
 * Iroh provider immediately). Injected so the executor
 * stays pure and testable and does not import the dispatcher directly.
 */
export interface DispatchRunner {
  /** Run to completion (resolves when the formula FINISHES). */
  run(candidate: DispatchCandidate): Promise<DispatchRunResult>;
  /**
   * Two-phase variant for the async scheduler (vibesync-q50w). Resolves once
   * the run has STARTED, with `done` settling when it finishes. Rejects (or
   * throws) only when the run could not be started. `done` must not reject:
   * run failures are reported as `{ ok: false }`.
   */
  start?(candidate: DispatchCandidate): Promise<{ readonly done: Promise<DispatchRunResult> }>;
}

/** The pool free-slot signal (63zx.2 AgentPool.onComplete). */
export interface SlotReleaser {
  /** Free the slot allocated for this work bead's dispatch. Idempotent. */
  onComplete(slotId: string): boolean;
}

/**
 * Records a successful self-completion: the branch/PR/bead-close evidence.
 * Production appends a note to the work bead and/or feeds the refinery
 * (63zx.6). Here we only capture the artifacts; we never mutate the work bead
 * from the scheduler side beyond what self-completion already did.
 */
export interface SelfCompletionSink {
  onCompleted(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly artifacts: CompletionArtifacts;
  }): Promise<void>;
}

/**
 * Drops a NEEDS-MERIDIAN-DECISION escalation for a blocked run (63zx.5 will
 * formalize severity routing + stale re-escalation; here we just emit the
 * marker). Injected so the executor doesn't couple to the escalation transport.
 */
export interface EscalationSink {
  onBlocked(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly summary: string;
  }): Promise<void>;
}

export interface PropulsionExecutorDeps {
  readonly runner: DispatchRunner;
  readonly pool: SlotReleaser;
  readonly completion: SelfCompletionSink;
  readonly escalation: EscalationSink;
  /**
   * Maps a work bead id → the pool slot id allocated for it, so onComplete can
   * free the right slot. Supplied by the loop/allocation layer that claimed
   * the slot. Returns null if no slot is tracked (executor then skips the free,
   * safely).
   */
  readonly slotIdFor: (workBeadId: string) => string | null;
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

/** Classify a run result into the propulsion outcome. */
export function classifyOutcome(result: DispatchRunResult): PropulsionOutcome {
  if (!result.ok) return 'failed';
  if (result.output.includes(NEEDS_MERIDIAN_MARKER)) return 'blocked';
  return 'completed';
}

/** Parse PR/branch/commit artifacts from run output (reuse of the lcp-40ru
 *  extraction shape; kept local so this module has no route dependency). */
export function extractArtifacts(output: string): CompletionArtifacts {
  const artifacts: CompletionArtifacts = {};
  const prMatch = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.exec(output);
  const branchMatch = /(?:branch|on branch)[:\s]+([a-zA-Z0-9._/-]+)/i.exec(output);
  const shaMatch = /\b([0-9a-f]{40})\b/i.exec(output);
  return {
    ...(prMatch?.[0] ? { prUrl: prMatch[0] } : {}),
    ...(branchMatch?.[1] ? { branch: branchMatch[1] } : {}),
    ...(shaMatch?.[1] ? { commitSha: shaMatch[1] } : {}),
    ...artifacts,
  };
}

/** First line of the output around the marker, for the escalation summary. */
function blockedSummary(output: string): string {
  const idx = output.indexOf(NEEDS_MERIDIAN_MARKER);
  if (idx < 0) return output.slice(0, 200);
  const from = output.slice(idx);
  const nl = from.indexOf('\n');
  return (nl < 0 ? from : from.slice(0, nl)).trim().slice(0, 300);
}

/**
 * The propulsion + self-completion executor. Implements the scheduler loop's
 * DispatchExecutor so it can be injected directly into SchedulerLoop.
 */
export class PropulsionExecutor implements DispatchExecutor {
  private readonly deps: PropulsionExecutorDeps;

  constructor(deps: PropulsionExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Dispatch one candidate: run it (propulsion — spawned with work on hook, no
   * survey), then self-complete or escalate, ALWAYS freeing the slot.
   *
   * Contract with the loop (63zx.3):
   *   - resolves on completed OR blocked (both are "handled"; the slot is freed
   *     and the loop closes the context as dispatched). A blocked run is not a
   *     dispatch failure — the dispatch succeeded; the agent then asked for a
   *     decision. It is escalated, not retried.
   *   - rejects on failed, AFTER freeing the slot, so the loop's circuit
   *     breaker counts the failure and may retry / circuit-break.
   */
  async execute(candidate: DispatchCandidate): Promise<void> {
    let result: DispatchRunResult;
    try {
      // Propulsion: reuse the existing dispatch path — the agent is spawned
      // with the bead on its hook and runs immediately.
      result = await this.deps.runner.run(candidate);
    } catch (err) {
      // The underlying dispatch threw before returning a result. Free the slot
      // and surface as a failure to the loop (circuit breaker will count it).
      this.freeSlot(candidate.workBeadId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    await this.settle(candidate, result);
  }

  /**
   * Start a dispatch WITHOUT waiting for the run to finish (vibesync-q50w).
   * Resolves with a handle as soon as the run has started; the handle's
   * `settled` promise performs the same classify / self-complete / escalate /
   * free-slot work as {@link execute} when the run ends, and rejects on a
   * failed run (after freeing the slot). A start failure frees the slot and
   * rejects here, so the loop counts it as a tick-time dispatch failure.
   * Requires `runner.start`.
   */
  async start(candidate: DispatchCandidate): Promise<DispatchRunHandle> {
    const start = this.deps.runner.start;
    if (!start) throw new Error('PropulsionExecutor.start requires DispatchRunner.start');
    let done: Promise<DispatchRunResult>;
    try {
      ({ done } = await start.call(this.deps.runner, candidate));
    } catch (err) {
      this.freeSlot(candidate.workBeadId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    const settled = done.then(
      (result) => this.settle(candidate, result),
      (err: unknown) => {
        // `done` should not reject, but a runner that does must not leak the slot.
        this.freeSlot(candidate.workBeadId);
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    return { settled };
  }

  /** Classify a finished run, self-complete or escalate, ALWAYS free the slot. */
  private async settle(candidate: DispatchCandidate, result: DispatchRunResult): Promise<void> {
    const outcome = classifyOutcome(result);
    try {
      if (outcome === 'completed') {
        await this.deps.completion.onCompleted({
          workBeadId: candidate.workBeadId,
          runId: result.runId,
          artifacts: extractArtifacts(result.output),
        });
        this.deps.logger?.info?.(
          { workBeadId: candidate.workBeadId, runId: result.runId },
          'propulsion: self-completed',
        );
      } else if (outcome === 'blocked') {
        // On BLOCK: drop the NEEDS-MERIDIAN-DECISION escalation and free the
        // slot rather than idling. Not a dispatch failure.
        await this.deps.escalation.onBlocked({
          workBeadId: candidate.workBeadId,
          runId: result.runId,
          summary: blockedSummary(result.output),
        });
        this.deps.logger?.warn?.(
          { workBeadId: candidate.workBeadId, runId: result.runId },
          'propulsion: blocked → escalated to Meridian, slot freed',
        );
      }
    } finally {
      // Self-completion invariant: free the slot no matter what so the
      // scheduler dispatches the next ready bead.
      this.freeSlot(candidate.workBeadId);
    }

    if (outcome === 'failed') {
      // Slot already freed above. Reject so the loop counts the failure; an
      // escalation is its own error so the loop does not retry it.
      const message = result.error ?? `dispatch failed for ${candidate.workBeadId}`;
      throw result.escalated ? new EscalatedRunError(message) : new Error(message);
    }
  }

  private freeSlot(workBeadId: string): void {
    const slotId = this.deps.slotIdFor(workBeadId);
    if (slotId) this.deps.pool.onComplete(slotId);
  }
}
