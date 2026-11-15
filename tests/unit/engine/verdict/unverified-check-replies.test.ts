/**
 * vibesync-9lzk.61. Real tester replies, the scores Jev returned for them, and
 * the verdict the decision table must reach on a final step.
 *
 * Soak run 3 failed a run that had met every gate: the tester wrote "PR checks
 * were not verified here", one question ("a required check was left
 * unverified") scored it 0.89, and the step failed closed. That question
 * covered two things the engine treats differently: a LOCAL check only the role
 * can vouch for, and the pull request's checks, which the dispatcher reads
 * itself. The question now asks about local checks only, and its rule comes
 * first in the decision table.
 *
 * Jev is not deterministic (the same request scored 0.66 to 0.90 on one
 * reply), so every reply carries 5 samples and must get its verdict on each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decideStepVerdict, type StepReplyAnswers } from '../../../../src/engine/verdict/decide.js';
import { NO_THRESHOLD, YES_THRESHOLD, STEP_REPLY_QUESTIONS } from '../../../../src/engine/verdict/questions.js';

interface Case {
  readonly name: string;
  readonly reply: string;
  readonly unverifiedLocalCheck: boolean;
  readonly finalStepVerdict: 'check_ci' | 'unsettled';
  /** Verdicts some samples also reach, for a reply Jev scores on a threshold. */
  readonly alsoAllowed?: readonly string[];
  readonly samples: readonly StepReplyAnswers[];
  readonly previousSingleQuestionSamples: readonly number[];
}
const { cases } = JSON.parse(readFileSync(join(process.cwd(), 'tests/_fixtures/verdict/unverified-check-replies.json'), 'utf8')) as { cases: Case[] };
const read = (p: number) => (p > YES_THRESHOLD ? true : p < NO_THRESHOLD ? false : null);
const finalKind = (sample: StepReplyAnswers) => decideStepVerdict(sample, 'summary', { finalStep: true }).kind;

describe('unverified-check replies (vibesync-9lzk.61)', () => {
  it('the fixture answers every question the engine asks, 5 times per reply', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) {
      expect(c.samples, c.name).toHaveLength(5);
      for (const sample of c.samples) expect(Object.keys(sample).sort(), c.name).toEqual(Object.keys(STEP_REPLY_QUESTIONS).sort());
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: the final-step verdict on every sample', (_name, c) => {
    const allowed = [c.finalStepVerdict, ...(c.alsoAllowed ?? [])];
    for (const sample of c.samples) expect(allowed, JSON.stringify(sample)).toContain(finalKind(sample));
    // The expected verdict is reached on at least one sample; an exception is never the only outcome.
    expect(c.samples.map(finalKind)).toContain(c.finalStepVerdict);
  });

  it('exactly one reply is known to be unstable, and it only ever fails closed', () => {
    const unstable = cases.filter((c) => c.alsoAllowed !== undefined);
    expect(unstable.map((c) => c.name)).toEqual(['m9lo PASS, integration-bd pending']);
    expect(unstable[0]!.alsoAllowed).toEqual(['unsettled']);
  });

  it('the local-check question reads an unrun local check, and nothing else, on every sample', () => {
    for (const c of cases) {
      for (const sample of c.samples) expect(read(sample.reports_unverified_local_check), `${c.name} ${JSON.stringify(sample)}`).toBe(c.unverifiedLocalCheck);
    }
  });

  it('an unrun local check is never handed to CI, whatever the reply says about CI', () => {
    const local = cases.filter((c) => c.unverifiedLocalCheck);
    expect(local.length).toBeGreaterThanOrEqual(6);
    for (const c of local) for (const sample of c.samples) expect(finalKind(sample), c.name).toBe('unsettled');
    // Soak run 2 is the reply that needs the local rule FIRST: its suite hung AND CI was pending.
    const soak2 = cases.find((c) => c.name.startsWith('soak2'))!;
    for (const sample of soak2.samples) expect(read(sample.blocks_only_on_pending_ci), 'soak2 also waits on CI').toBe(true);
  });

  it('a reply that passed every local gate and only left the PR checks unverified goes to the checks (soak run 3)', () => {
    const soak3 = cases.find((c) => c.name.startsWith('soak3'))!;
    for (const sample of soak3.samples) expect(finalKind(sample)).toBe('check_ci');
    const sameShape = cases.filter((c) => c.name.startsWith('variant:') && !c.unverifiedLocalCheck);
    expect(sameShape.length).toBe(3);
    for (const c of sameShape) for (const sample of c.samples) expect(finalKind(sample), c.name).toBe('check_ci');
  });

  it('the question this one replaced could not tell the two cases apart', () => {
    // It scored "yes" for an unrun local check AND for "PR checks were not verified here".
    const yes = (c: Case) => c.previousSingleQuestionSamples.every((p) => p > YES_THRESHOLD);
    expect(yes(cases.find((c) => c.name.startsWith('t6d3'))!)).toBe(true); // local typecheck blocked
    expect(yes(cases.find((c) => c.name.startsWith('soak3'))!)).toBe(true); // only PR checks not verified
  });
});
