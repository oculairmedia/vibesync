/**
 * The questions the engine asks about a step's reply (vibesync-9lzk.39).
 *
 * Kept in one place so the wording, criteria and thresholds can be audited
 * and edited together. Each question is ONE judgment a person could make at
 * a glance from the reply alone; the decision (loop, approve, stop) is made
 * in code from the answers (see decide.ts), never by the model.
 *
 * Calibrated 2026-11-06 against 46 real step replies from engine trials 1-10
 * (22 labelled by PM audit, 24 held out and labelled from their own verdict
 * lines): 45 read as expected, 1 genuinely ambiguous reply unsettled.
 */

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

/** The state sent with every request: named fields, nothing a person would not look at. */
export interface StepReplyState {
  readonly role: string;
  readonly reply: string;
}

export const STEP_REPLY_QUESTIONS = {
  asks_change: {
    type: 'noul',
    instructions: 'Does `reply` ask for a change to the work before it can ship?',
    criteria: {
      true: 'the reply names at least one thing that must be changed, fixed or added first, or says the work must not ship as it is (a verdict of CHANGES-REQUESTED, FAIL, INCONCLUSIVE or BLOCKED)',
      false: 'the reply approves the work as it is; a suggestion the reviewer marks as optional (a [suggest] or nit under an LGTM or LGTM-with-nits verdict) is not a change the work needs before it ships',
    },
  },
  blocks_only_on_pending_ci: {
    type: 'noul',
    instructions: 'Is the ONLY reason `reply` withholds approval that a CI check is still running or queued?',
    criteria: {
      true: 'every concern the reply raises is that a CI check has not finished yet; it reports nothing failed and no code problem',
      false: 'the reply raises a code or test problem, reports a failed check, or approves outright',
    },
  },
  reports_all_gates_passed: {
    type: 'noul',
    instructions: 'Does `reply` report that every check it was required to run passed?',
    criteria: {
      true: 'the reply states its required checks all passed, with no check failed, skipped or left unverified',
      false: 'the reply reports a failed check, or says some required check was not run, could not run, or is unverified',
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type StepReplyQuestionId = keyof typeof STEP_REPLY_QUESTIONS;

/** Above = yes, below = no, between = the reply does not settle it. */
export const YES_THRESHOLD = 0.7;
export const NO_THRESHOLD = 0.3;
