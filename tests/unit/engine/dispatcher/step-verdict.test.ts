/**
 * vibesync-9lzk.39: step verdicts from the decision model. The judge is a fake
 * that replays Jev's real probabilities (probe 2026-11-06) for real replies.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BLOCKED_MARKER } from '../../../../src/engine/dispatcher/step-outcome.js';
import { FormulaDispatchError, createTypeSafeJudge, TypeSafeRequestError, type StepReplyJudge } from '../../../../src/engine/dispatcher/index.js';
import { decideStepVerdict, reconcileWithMarker, summarizeReplyForReason } from '../../../../src/engine/verdict/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

/** Round 10's real reviewer reply: CHANGES-REQUESTED, no marker line. */
const ROUND10_REVIEW = readFileSync(join(process.cwd(), 'tests/_fixtures/round10-reviewer-reply.txt'), 'utf8');
/** Round 4's real reviewer reply: LGTM-with-nits, one [suggest]. */
const ROUND4_NIT_REVIEW = readFileSync(join(process.cwd(), 'tests/_fixtures/round4-reviewer-nit-reply.txt'), 'utf8');
const T6D3_BLOCKED_TESTER = readFileSync(join(process.cwd(), 'tests/_fixtures/t6d3-tester-pass-but-typecheck-blocked.txt'), 'utf8');
const LONG_T6D3_BLOCKED_TESTER = `${T6D3_BLOCKED_TESTER.replace(/\*\*TypeScript check:[\s\S]*$/, '')}${'Passing test output: all assertions passed.\n'.repeat(300)}${T6D3_BLOCKED_TESTER.match(/\*\*TypeScript check:[\s\S]*$/)?.[0] ?? ''}`;
const ROUND3_UNRERUN_TESTER = readFileSync(join(process.cwd(), 'tests/_fixtures/round3-tester-pass-mutation-not-rerun.txt'), 'utf8');
const ROUND8_REVIEWER = readFileSync(join(process.cwd(), 'tests/_fixtures/round8-reviewer-lgtm-gates-left-to-tester.txt'), 'utf8');
const ROUND10_CLEAN_TESTER = readFileSync(join(process.cwd(), 'tests/_fixtures/round10-tester-clean-pass.txt'), 'utf8');

/** Jev's actual answers for those replies (probe 2026-11-06, tuned criteria). */
type ScriptedAnswers = { asks_change: number; blocks_only_on_pending_ci: number; reports_all_gates_passed: number; reports_unverified_check: number };
const clean: ScriptedAnswers = { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.9, reports_unverified_check: 0.02 };
const JEV: Record<string, ScriptedAnswers> = {
  [ROUND10_REVIEW]: { asks_change: 0.98, blocks_only_on_pending_ci: 0.01, reports_all_gates_passed: 0.55, reports_unverified_check: 0.02 },
  [ROUND4_NIT_REVIEW]: { asks_change: 0.05, blocks_only_on_pending_ci: 0.01, reports_all_gates_passed: 0.72, reports_unverified_check: 0.02 },
  'PASS: all gates green': clean,
  [ROUND10_CLEAN_TESTER]: clean,
  [ROUND8_REVIEWER]: { asks_change: 0.02, blocks_only_on_pending_ci: 0.01, reports_all_gates_passed: 0.9, reports_unverified_check: 0.86 },
  [T6D3_BLOCKED_TESTER]: { asks_change: 0.02, blocks_only_on_pending_ci: 0.02, reports_all_gates_passed: 0.04, reports_unverified_check: 0.98 },
  [ROUND3_UNRERUN_TESTER]: { asks_change: 0.02, blocks_only_on_pending_ci: 0.01, reports_all_gates_passed: 0.04, reports_unverified_check: 0.94 },
  'CHANGES-REQUESTED: test (20.x) is still pending; nothing failed': { asks_change: 0.94, blocks_only_on_pending_ci: 0.97, reports_all_gates_passed: 0.1, reports_unverified_check: 0.02 },
  'Result: PASS but the typecheck was blocked by a missing module': { asks_change: 0.61, blocks_only_on_pending_ci: 0.02, reports_all_gates_passed: 0.04, reports_unverified_check: 0.98 },
};
const fakeJudge: StepReplyJudge = {
  async judge({ reply }) {
    const answers = JEV[reply];
    if (!answers) throw new Error(`fake judge: no scripted answers for reply ${JSON.stringify(reply.slice(0, 60))}`);
    return { answers, model: 'jev-1.14.0', inputTokens: 300 };
  },
};

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}
function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-verdict-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), '${input}\n${prior_outputs}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'reviewer', 'tester'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}
const looping: Formula = {
  name: 'f', description: 'd', whenToUse: '',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/p.md', dependsOn: ['coder'], loopsBackTo: 'coder', maxRounds: 3 },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['reviewer'] },
  ],
};
function harness(reviews: string[], tester = 'PASS: all gates green', judge: StepReplyJudge | null = fakeJudge) {
  const store = new InMemoryDoltClient();
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  let reviewN = 0;
  const provider = newFakeProvider({ kind: 'fake', script: (spec: SessionSpec) => reply(spec.role === 'reviewer' ? reviews[Math.min(reviewN++, reviews.length - 1)]! : spec.role === 'tester' ? tester : 'coded') });
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus, ...(judge ? { stepJudge: judge } : {}) });
  return { dispatcher, events, provider, store };
}

describe('step verdicts from the decision model (vibesync-9lzk.39)', () => {
  it('REGRESSION (round 10): a CHANGES-REQUESTED reply with NO marker line loops back to the coder', async () => {
    const h = harness([ROUND10_REVIEW, ROUND4_NIT_REVIEW]);
    await expect(h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' })).resolves.toBeDefined();
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatcher/step.loop_back');
    expect(h.events.find((e) => e.kind === 'dispatcher/step.verdict')?.payload).toMatchObject({ stepName: 'reviewer', verdict: 'changes_requested', marker: false, model: 'jev-1.14.0' });
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['coder', 'reviewer', 'coder', 'reviewer', 'tester']);
  });

  it('an LGTM-with-nits reply with one optional [suggest] approves (no loop)', async () => {
    const h = harness([ROUND4_NIT_REVIEW]);
    await expect(h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' })).resolves.toBeDefined();
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['coder', 'reviewer', 'tester']);
  });

  it('a reply whose only concern is pending CI is not a block: it is reported as await_ci', async () => {
    const h = harness(['CHANGES-REQUESTED: test (20.x) is still pending; nothing failed']);
    const thrown = await h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' }).catch((e: unknown) => e);
    // Round 1 loops (await_ci still sends it back with the wait instruction); the fake reviewer repeats, so it exhausts.
    expect(h.events.find((e) => e.kind === 'dispatcher/step.verdict')?.payload).toMatchObject({ verdict: 'await_ci' });
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
  });

  it('an unsettled reading (the t6d3 case: PASS but a required check never ran) FAILS CLOSED, never completes', async () => {
    const h = harness([ROUND4_NIT_REVIEW], T6D3_BLOCKED_TESTER);
    const thrown = await h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(h.events.find((e) => e.kind === 'dispatcher/step.verdict' && e.payload?.['stepName'] === 'tester')?.payload).toMatchObject({ verdict: 'unsettled' });
    const tester = await h.store.getBead(`${(thrown as FormulaDispatchError).moleculeId}-tester`);
    const failureReason = String((tester?.metadata?.['exec'] as Record<string, unknown>)['error_trace']);
    expect(failureReason).toContain('verdict unsettled (fail closed)');
    expect(failureReason).toContain('TypeScript check');
  });

  it('caps a long verdict reason but retains an unrun check from late in the reply', async () => {
    const summary = summarizeReplyForReason(LONG_T6D3_BLOCKED_TESTER);
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary).toContain('was blocked by the missing `@number0/iroh` module');
    expect(summary).toContain('[... reply truncated ...]');

    const h = harness([ROUND4_NIT_REVIEW], LONG_T6D3_BLOCKED_TESTER, {
      async judge() { return { answers: { ...clean, reports_unverified_check: 0.98 }, model: 'fake', inputTokens: 1 }; },
    });
    const thrown = await h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    const tester = await h.store.getBead(`${(thrown as FormulaDispatchError).moleculeId}-tester`);
    const failureReason = String((tester?.metadata?.['exec'] as Record<string, unknown>)['error_trace']);
    expect(failureReason).toContain('was blocked by the missing `@number0/iroh` module');
    expect(failureReason.length).toBeLessThanOrEqual(4500);
  });

  it('final tester reports of unrun required checks fail closed; reviewer mentions are ignored', async () => {
    for (const tester of [T6D3_BLOCKED_TESTER, ROUND3_UNRERUN_TESTER]) {
      const h = harness([ROUND4_NIT_REVIEW], tester);
      const thrown = await h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' }).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(FormulaDispatchError);
      expect(h.events.find((e) => e.kind === 'dispatcher/step.verdict' && e.payload?.['stepName'] === 'tester')?.payload).toMatchObject({ verdict: 'unsettled' });
      if (tester === ROUND3_UNRERUN_TESTER) {
        const failedTester = await h.store.getBead(`${(thrown as FormulaDispatchError).moleculeId}-tester`);
        const failureReason = String((failedTester?.metadata?.['exec'] as Record<string, unknown>)['error_trace']);
        expect(failureReason).toContain('mutation');
      }
    }
    const reviewer = harness([ROUND8_REVIEWER, ROUND4_NIT_REVIEW]);
    await expect(reviewer.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' })).resolves.toBeDefined();
    expect(reviewer.events.find((e) => e.kind === 'dispatcher/step.verdict')?.payload).toMatchObject({ stepName: 'reviewer', verdict: 'approve' });
  });

  it('the clean final tester reply approves despite mentioning completed checks', async () => {
    const h = harness([ROUND4_NIT_REVIEW], ROUND10_CLEAN_TESTER);
    await expect(h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' })).resolves.toBeDefined();
    expect(h.events.find((e) => e.kind === 'dispatcher/step.verdict' && e.payload?.['stepName'] === 'tester')?.payload).toMatchObject({ verdict: 'approve' });
  });

  it('a judge failure is an error that fails the step, never a silent approval', async () => {
    const failing: StepReplyJudge = { async judge() { throw new TypeSafeRequestError('TypeSafe HTTP 500'); } };
    const h = harness([ROUND4_NIT_REVIEW], 'PASS: all gates green', failing);
    const thrown = await h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' }).catch((e: unknown) => e);
    // The judge error surfaces as the run's failure (via the step failure), with its message intact.
    const chain: string[] = [];
    for (let e: unknown = thrown; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.some((m) => m.includes('TypeSafe HTTP 500'))).toBe(true);
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it('without a judge the marker line is the only signal (pre-Jev behaviour unchanged)', async () => {
    const h = harness([ROUND10_REVIEW], 'PASS: all gates green', null);
    await expect(h.dispatcher.run({ formula: looping, pack: pack(), input: 'go', motivatingBeadId: 'w' })).resolves.toBeDefined();
    expect(h.events.some((e) => e.kind === 'dispatcher/step.loop_back')).toBe(false); // the round-10 drift, reproduced
  });
});

describe('decision table', () => {
  it('leaves short replies unchanged', () => {
    for (const fixture of [T6D3_BLOCKED_TESTER, ROUND3_UNRERUN_TESTER, ROUND8_REVIEWER, ROUND10_CLEAN_TESTER]) {
      expect(summarizeReplyForReason(fixture)).toBe(fixture);
    }
  });
  it('respects small limits and retains late check lines in order when possible', () => {
    const marker = '[... reply truncated ...]';
    expect(summarizeReplyForReason('a'.repeat(20), 10)).toHaveLength(10);
    expect(summarizeReplyForReason('a'.repeat(20), 0)).toBe('');
    expect(summarizeReplyForReason('a'.repeat(20), 1)).toHaveLength(1);

    const first = 'Typecheck was blocked.\n';
    const second = 'Mutation test was not rerun.\n';
    const reply = `${'opening line\n'.repeat(200)}${first}${'x'.repeat(200)}\n${second}`;
    const summary = summarizeReplyForReason(reply, 100);
    expect(summary.length).toBeLessThanOrEqual(100);
    expect(summary.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(summary.indexOf(second)).toBeGreaterThan(summary.indexOf(first));
    expect(summary).toContain(marker);

    const longFirst = 'Typecheck was blocked: details.\n';
    const longSecond = 'Mutation test was not rerun: details.\n';
    const checksOverBudget = summarizeReplyForReason(`${longFirst}${longSecond}`, 60);
    expect(checksOverBudget.length).toBeLessThanOrEqual(60);
    expect(checksOverBudget).toContain(longFirst);
    expect(checksOverBudget).not.toContain(longSecond);
    expect(checksOverBudget).toContain(marker);

    const oversizedOpening = summarizeReplyForReason(`${'z'.repeat(200)}\n${first}`, 60);
    expect(oversizedOpening.length).toBeLessThanOrEqual(60);
    expect(oversizedOpening).toContain(first);
    expect(oversizedOpening).toContain(marker);
  });
  it('places the truncation marker on a separate line when a retained check has no newline', () => {
    const summary = summarizeReplyForReason(`${'opening\n'.repeat(800)}Typecheck blocked`, 80);
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary).toContain('\nTypecheck blocked\n[... reply truncated ...]\n');
  });
  it('keeps retained check lines intact at exact marker budgets', () => {
    const checkLine = 'Typecheck blocked';
    const reply = `${'x'.repeat(100)}\n${checkLine}`;
    for (const budget of [42, 43, 44]) {
      const summary = summarizeReplyForReason(reply, budget);
      expect(summary.length).toBeLessThanOrEqual(budget);
      expect(summary).toContain('[... reply truncated ...]');
      expect(summary).toMatch(/(?:^|\n)\[\.\.\. reply truncated \.\.\.\]\n?$/);
      if (budget === 42) {
        expect(summary).not.toContain('Typecheck');
      } else {
        expect(summary).toContain(checkLine);
        expect(summary).toMatch(new RegExp(`(?:^|\\n)${checkLine}\\n\\[\\.\\.\\. reply truncated \.\.\.\\]`));
      }
    }

    const terminated = summarizeReplyForReason(`${reply}\n`, 43);
    expect(terminated.length).toBeLessThanOrEqual(43);
    expect(terminated).toContain(checkLine);
    expect(terminated).toMatch(new RegExp(`(?:^|\\n)${checkLine}\\n\\[\\.\\.\\. reply truncated \.\.\.\\]`));
  });
  it('maps the probability bands to verdicts, with the band between failing closed', () => {
    expect(decideStepVerdict({ ...clean, asks_change: 0.98, reports_all_gates_passed: 0.5 }, 's', { finalStep: false }).kind).toBe('changes_requested');
    expect(decideStepVerdict(clean, 's', { finalStep: true }).kind).toBe('approve');
    expect(decideStepVerdict({ ...clean, asks_change: 0.94, blocks_only_on_pending_ci: 0.97, reports_all_gates_passed: 0.1 }, 's', { finalStep: false }).kind).toBe('await_ci');
    expect(decideStepVerdict({ ...clean, asks_change: 0.61, blocks_only_on_pending_ci: 0.02, reports_all_gates_passed: 0.04 }, 's', { finalStep: false }).kind).toBe('unsettled');
    expect(decideStepVerdict({ ...clean, asks_change: 0.3 }, 's', { finalStep: false }).kind).toBe('unsettled');
    expect(decideStepVerdict({ ...clean, reports_unverified_check: 0.98 }, 'typecheck blocked', { finalStep: true })).toMatchObject({ kind: 'unsettled', reason: expect.stringContaining('typecheck blocked') });
    expect(decideStepVerdict({ ...clean, reports_unverified_check: 0.98 }, 'reviewer', { finalStep: false }).kind).toBe('approve');
  });
  it('a marker line that contradicts an approval is unsettled, never an override either way', () => {
    expect(reconcileWithMarker({ kind: 'approve' }, 'the test cannot fail').kind).toBe('unsettled');
    expect(reconcileWithMarker({ kind: 'changes_requested', reason: 'r' }, 'r').kind).toBe('changes_requested');
    expect(reconcileWithMarker({ kind: 'approve' }, null).kind).toBe('approve');
  });
});

describe('TypeSafe client', () => {
  it('sends the questions with the state and reads noul answers; a non-OK response is an error', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ok = createTypeSafeJudge({ apiKey: 'k', fetch: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { asks_change: { noul: 0.9 }, blocks_only_on_pending_ci: { noul: 0.1 }, reports_all_gates_passed: { noul: 0.2 }, reports_unverified_check: { noul: 0.3 } }, usage: { input_tokens: 123 } }), { status: 200 }); }) as typeof fetch });
    const r = await ok.judge({ role: 'reviewer', reply: 'x' });
    expect(r).toEqual({ answers: { asks_change: 0.9, blocks_only_on_pending_ci: 0.1, reports_all_gates_passed: 0.2, reports_unverified_check: 0.3 }, model: 'jev-1.14.0', inputTokens: 123 });
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((calls[0]?.body as { state: unknown }).state).toEqual({ role: 'reviewer', reply: 'x' });
    const bad = createTypeSafeJudge({ apiKey: 'k', fetch: (async () => new Response('nope', { status: 401 })) as typeof fetch });
    await expect(bad.judge({ role: 'reviewer', reply: 'x' })).rejects.toThrow('TypeSafe HTTP 401');
    expect(() => createTypeSafeJudge({ apiKey: '' })).toThrow('TYPESAFE_API_KEY');
  });
});
