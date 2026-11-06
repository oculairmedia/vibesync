/**
 * The decision table (vibesync-9lzk.39). Jev supplies the judgments; this
 * code decides. Every combination of answers has an outcome, including the
 * band where the reply does not settle the question.
 */
import { NO_THRESHOLD, YES_THRESHOLD, type StepReplyQuestionId } from './questions.js';

export type StepReplyAnswers = Readonly<Record<StepReplyQuestionId, number>>;

export type StepVerdict =
  /** The reply approves the work (or reports every gate passed). */
  | { readonly kind: 'approve' }
  /** The reply asks for a change before the work ships. */
  | { readonly kind: 'changes_requested'; readonly reason: string }
  /** The reply withholds approval only because CI has not finished: not a block. */
  | { readonly kind: 'await_ci'; readonly reason: string }
  /** The reply does not settle whether a change is needed: fail closed. */
  | { readonly kind: 'unsettled'; readonly reason: string };

/**
 * vibesync-9lzk.46: on the final step, whether CI is green is read from the
 * PR's checks by the dispatcher, never from the reply's wording. The reply
 * either approves or talks about CI; the checks decide.
 */
export type FinalStepVerdict = StepVerdict | {
  readonly kind: 'check_ci';
  readonly reason: string;
  /**
   * `approve`: the reply approved; confirm the checks when a PR and a reader
   * exist, else keep the approval (formulas that deliver no PR). `pending`: the
   * reply waits on CI; without checks to read this fails closed.
   */
  readonly from: 'approve' | 'pending';
};

function read(p: number): 'yes' | 'no' | 'unsettled' {
  if (p > YES_THRESHOLD) return 'yes';
  if (p < NO_THRESHOLD) return 'no';
  return 'unsettled';
}

export function decideStepVerdict(answers: StepReplyAnswers, summary: string, options: { readonly finalStep: boolean }): FinalStepVerdict {
  // vibesync-9lzk.46: a final step whose only concern is CI (still running, or
  // a check it cannot see finish) is settled from the PR's real checks, before
  // any rule that would read "pending" as a pass or a failure.
  if (options.finalStep && read(answers.blocks_only_on_pending_ci) === 'yes') {
    return { kind: 'check_ci', from: 'pending', reason: `the final-step reply waits on CI (blocks_only_on_pending_ci=${answers.blocks_only_on_pending_ci.toFixed(2)})` };
  }
  if (options.finalStep && read(answers.reports_unverified_check) === 'yes') {
    return { kind: 'unsettled', reason: `the final-step reply reports a required check was not verified (reports_unverified_check=${answers.reports_unverified_check.toFixed(2)}): ${summary}` };
  }
  const asks = read(answers.asks_change);
  if (asks === 'unsettled') {
    return { kind: 'unsettled', reason: `the reply does not settle whether a change is needed (asks_change=${answers.asks_change.toFixed(2)}): ${summary}` };
  }
  if (asks === 'no') return options.finalStep ? { kind: 'check_ci', from: 'approve', reason: 'the final-step reply approves; confirm the PR checks before completing' } : { kind: 'approve' };
  if (read(answers.blocks_only_on_pending_ci) === 'yes') {
    return { kind: 'await_ci', reason: `approval withheld only for pending CI (blocks_only_on_pending_ci=${answers.blocks_only_on_pending_ci.toFixed(2)})` };
  }
  return { kind: 'changes_requested', reason: summary };
}

/**
 * Reconcile the model's reading with the reply's own marker line, when it has
 * one. They agree, or the outcome is unsettled: the marker is a second
 * signal, never an override in either direction.
 */
export function reconcileWithMarker<V extends FinalStepVerdict>(verdict: V, markerReason: string | null): V | StepVerdict {
  if (markerReason === null) return verdict;
  if (verdict.kind === 'changes_requested' || verdict.kind === 'await_ci' || verdict.kind === 'unsettled') return verdict;
  return { kind: 'unsettled', reason: `the reply ends with the BLOCKED line ("${markerReason}") but reads as an approval` };
}
