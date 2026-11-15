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
 * lines): 45 read as expected, 1 genuinely ambiguous reply unsettled. The
 * local-check question was calibrated 2026-11-15 against 20 tester replies
 * (15 real, 5 wording variants), each judged 5 times because Jev is not
 * deterministic; the samples are the fixture
 * tests/_fixtures/verdict/unverified-check-replies.json.
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
  // vibesync-9lzk.61: this was "a required check was left unverified", which
  // also scored yes for "PR checks were not verified here" (0.89, soak run 3)
  // and failed a run that had met every gate. Only a check the role itself was
  // to run needs the role's word: the dispatcher reads the pull request's
  // checks. The false criterion names that case so the question does not
  // absorb it.
  reports_unverified_local_check: {
    type: 'noul',
    instructions: 'Does `reply` say that a check the author had to run on their own machine did not run to a result?',
    criteria: {
      true: 'the reply names a local command or check of its own (a typecheck, a test run or test suite, a lint, a build, a boot check, a mutation or revert probe) that was blocked, failed to start, was skipped, did not complete, or was not rerun',
      false: "every local check the reply mentions ran and gave a result; a statement that the pull request's CI checks, GitHub checks or check runs were not looked at, not verified, still queued or still running is NOT a local check and does not count",
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type StepReplyQuestionId = keyof typeof STEP_REPLY_QUESTIONS;

/** Above = yes, below = no, between = the reply does not settle it. */
export const YES_THRESHOLD = 0.7;
export const NO_THRESHOLD = 0.3;
