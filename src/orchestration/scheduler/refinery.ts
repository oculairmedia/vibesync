/**
 * Refinery — the PR merge-queue processor (vibesync-63zx.6).
 *
 * Gas Town's Refinery (see .gastown-reference/self-completion.md and
 * integration-branches.md) batches completed agents' merge requests, runs
 * verification gates, and lands them serially — a Bors-style queue. This
 * module maps that design onto OUR reality: GitHub PRs, `gh`, and required CI
 * checks. It removes the human (Meridian) from the merge critical path while
 * ENCODING the merge-safety SOP as machine-checked gates.
 *
 * MERGE-SAFETY GATES (the SOP, encoded — every gate must pass):
 *   1. requiredChecksGreen — the repo's REQUIRED check names, individually
 *      SUCCESS (never trust a rollup; advisory checks are ignored).
 *   2. mergeableClean     — GitHub mergeable state is MERGEABLE (a CONFLICTING
 *      or unknown PR is never merged; it is sent back for rebase).
 *   3. noDeletedFiles     — an agent slice PR must be additive: zero
 *      `deleted file` entries in the diff (a stale branch silently reverting
 *      merged work is the classic disaster; deletions require a human).
 *   4. notBehindBase      — a PR that is BEHIND base with deletions is a
 *      stale-branch revert risk. BEHIND alone routes to update-then-retry.
 *
 * SERIALIZATION (Bors property): merge-requests are processed ONE at a time in
 * FIFO-by-enqueue order. After each merge the next candidate is re-verified
 * against the NEW base (its checks may need to re-run) — never batch-merge on
 * stale verification.
 *
 * FAILURE ISOLATION: a gate failure isolates THAT merge-request (state
 * `isolated`, with the failed gate + detail) and the queue moves on — one bad
 * PR never blocks the rest. Isolated MRs are escalated (Meridian decides:
 * rebase, fix, or close) via the injected escalation sink.
 *
 * Everything I/O-ful is injected (GitHubPort, escalation), so the queue logic
 * is pure and headless-testable, consistent with the other 63zx slices.
 */

/** A merge request enqueued by a completed agent run (from SelfCompletionSink). */
export interface MergeRequest {
  readonly id: string;
  readonly repo: string; // owner/name
  readonly prNumber: number;
  readonly workBeadId: string;
  readonly enqueuedAt: string; // RFC3339
}

export type MergeRequestState = 'queued' | 'merged' | 'isolated';

export type GateName =
  | 'required-checks-green'
  | 'mergeable-clean'
  | 'no-deleted-files'
  | 'not-behind-with-deletions';

export interface GateFailure {
  readonly gate: GateName;
  readonly detail: string;
}

export interface ProcessedMergeRequest {
  readonly request: MergeRequest;
  readonly state: MergeRequestState;
  readonly failure?: GateFailure;
  readonly mergeCommit?: string;
}

/** A snapshot of the PR facts the gates evaluate. All fetched fresh per attempt. */
export interface PrFacts {
  /** Required check name -> conclusion (SUCCESS/FAILURE/PENDING/absent). */
  readonly requiredChecks: Readonly<Record<string, string>>;
  /** GitHub mergeable state: MERGEABLE | CONFLICTING | UNKNOWN. */
  readonly mergeable: string;
  /** Count of `deleted file` entries in the PR diff. */
  readonly deletedFiles: number;
  /** Is the branch behind its base? */
  readonly behindBase: boolean;
}

/** The injected GitHub adapter — the only I/O. Production wires this to `gh`. */
export interface GitHubPort {
  /** Fetch fresh PR facts (never cached across merges — Bors re-verification). */
  fetchFacts(repo: string, prNumber: number, requiredCheckNames: readonly string[]): Promise<PrFacts>;
  /** Squash-merge the PR, delete the branch. Returns the merge commit SHA. */
  merge(repo: string, prNumber: number): Promise<string>;
}

/** Escalation for isolated MRs (63zx.5 severity routing handles transport). */
export interface RefineryEscalationSink {
  onIsolated(input: {
    readonly workBeadId: string;
    readonly prNumber: number;
    readonly repo: string;
    readonly failure: GateFailure;
  }): Promise<void>;
}

export interface RefineryDeps {
  readonly github: GitHubPort;
  readonly escalation: RefineryEscalationSink;
  /** Required check names per repo (the SOP: verify individually, no rollups). */
  readonly requiredCheckNames: (repo: string) => readonly string[];
  readonly logger?: { info?(o: unknown, m: string): void; warn?(o: unknown, m: string): void };
}

/** Pure gate evaluation over fresh PR facts. Exported for direct testing. */
export function evaluateGates(
  facts: PrFacts,
  requiredNames: readonly string[],
): GateFailure | null {
  const notGreen = requiredNames.filter((n) => facts.requiredChecks[n] !== 'SUCCESS');
  if (notGreen.length > 0) {
    return { gate: 'required-checks-green', detail: `not SUCCESS: ${notGreen.join(', ')}` };
  }
  if (facts.mergeable !== 'MERGEABLE') {
    return { gate: 'mergeable-clean', detail: `mergeable=${facts.mergeable}` };
  }
  // Stale-branch-revert guard (SOP): a PR that is BEHIND its base can silently
  // fast-forward a state that reverts sibling work already merged into the base
  // — the diff-vs-head may not even show it as a deletion. So "behind base" is
  // its OWN hard gate, evaluated BEFORE the deleted-files gate. (Previously this
  // was `behindBase && deletedFiles > 0`, which was DEAD CODE — the deleted-files
  // gate above already returned on deletedFiles > 0, so this could never fire.)
  if (facts.behindBase) {
    return {
      gate: 'not-behind-with-deletions',
      detail: 'branch is behind base — rebase required (stale-branch revert risk)',
    };
  }
  if (facts.deletedFiles > 0) {
    return { gate: 'no-deleted-files', detail: `${facts.deletedFiles} deleted file(s) — needs human review` };
  }
  return null;
}

/**
 * The refinery queue. Serial (Bors), fresh-verified per merge, failure-isolating.
 */
export class Refinery {
  private readonly deps: RefineryDeps;
  private readonly queue: MergeRequest[] = [];
  private processing = false;

  constructor(deps: RefineryDeps) {
    this.deps = deps;
  }

  /** Enqueue a merge request (FIFO by call order; caller supplies enqueuedAt). */
  enqueue(request: MergeRequest): void {
    // Idempotent by id: re-enqueueing the same MR is a no-op.
    if (this.queue.some((q) => q.id === request.id)) return;
    this.queue.push(request);
  }

  /** Number of queued (unprocessed) merge requests. */
  pending(): number {
    return this.queue.length;
  }

  /**
   * Process the queue serially: for each MR (FIFO), fetch FRESH facts, run the
   * gates, merge on pass, isolate + escalate on fail. One bad MR never blocks
   * the rest. Re-entrant calls are serialized (single processor).
   */
  async processQueue(): Promise<ProcessedMergeRequest[]> {
    if (this.processing) return [];
    this.processing = true;
    const results: ProcessedMergeRequest[] = [];
    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift() as MergeRequest;
        const requiredNames = this.deps.requiredCheckNames(request.repo);
        let facts: PrFacts;
        try {
          facts = await this.deps.github.fetchFacts(request.repo, request.prNumber, requiredNames);
        } catch (err) {
          const failure: GateFailure = {
            gate: 'mergeable-clean',
            detail: `facts fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          results.push({ request, state: 'isolated', failure });
          await this.safeEscalate(request, failure);
          continue;
        }

        const failure = evaluateGates(facts, requiredNames);
        if (failure) {
          results.push({ request, state: 'isolated', failure });
          this.deps.logger?.warn?.(
            { pr: request.prNumber, repo: request.repo, gate: failure.gate, detail: failure.detail },
            'refinery: merge-request isolated (gate failed)',
          );
          await this.safeEscalate(request, failure);
          continue;
        }

        try {
          const mergeCommit = await this.deps.github.merge(request.repo, request.prNumber);
          results.push({ request, state: 'merged', mergeCommit });
          this.deps.logger?.info?.(
            { pr: request.prNumber, repo: request.repo, mergeCommit },
            'refinery: merged',
          );
        } catch (err) {
          const failure: GateFailure = {
            gate: 'mergeable-clean',
            detail: `merge failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          results.push({ request, state: 'isolated', failure });
          await this.safeEscalate(request, failure);
        }
      }
    } finally {
      this.processing = false;
    }
    return results;
  }

  private async safeEscalate(request: MergeRequest, failure: GateFailure): Promise<void> {
    try {
      await this.deps.escalation.onIsolated({
        workBeadId: request.workBeadId,
        prNumber: request.prNumber,
        repo: request.repo,
        failure,
      });
    } catch {
      // Escalation transport failure must never kill the queue.
      this.deps.logger?.warn?.(
        { pr: request.prNumber, repo: request.repo },
        'refinery: escalation sink failed (queue continues)',
      );
    }
  }
}
