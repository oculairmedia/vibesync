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

function read(p: number): 'yes' | 'no' | 'unsettled' {
  if (p > YES_THRESHOLD) return 'yes';
  if (p < NO_THRESHOLD) return 'no';
  return 'unsettled';
}

export function decideStepVerdict(answers: StepReplyAnswers, summary: string): StepVerdict {
  const asks = read(answers.asks_change);
  if (asks === 'unsettled') {
    return { kind: 'unsettled', reason: `the reply does not settle whether a change is needed (asks_change=${answers.asks_change.toFixed(2)}): ${summary}` };
  }
  if (asks === 'no') return { kind: 'approve' };
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
export function reconcileWithMarker(verdict: StepVerdict, markerReason: string | null): StepVerdict {
  if (markerReason === null) return verdict;
  if (verdict.kind === 'changes_requested' || verdict.kind === 'await_ci' || verdict.kind === 'unsettled') return verdict;
  return { kind: 'unsettled', reason: `the reply ends with the BLOCKED line ("${markerReason}") but reads as an approval` };
}
