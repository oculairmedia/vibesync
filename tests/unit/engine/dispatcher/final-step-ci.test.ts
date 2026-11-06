/**
 * vibesync-9lzk.46: the final step's CI verdict comes from the delivered PR's
 * real fast checks, not from the tester's wording. The Jev answers below are
 * the real ones from today's backlog run (events.jsonl, 2026-11-06).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FormulaEscalationError, type StepReplyJudge } from '../../../../src/engine/dispatcher/index.js';
import { createGhPrChecksReader, settleCi, type CheckState, type PrChecksReader } from '../../../../src/engine/verdict/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const PR = 'https://github.com/oculairmedia/vibesync/pull/114';
const FAST = ['typecheck', 'test (20.x)', 'boot'];

/** Real tester verdicts from the backlog run. */
const REAL = {
  // devj 18:20Z: "INCONCLUSIVE ... required test (20.x) is still pending" -> wrongly escalated.
  devjPending: { asks_change: 0.96, blocks_only_on_pending_ci: 0.84, reports_all_gates_passed: 0.02, reports_unverified_check: 0.83 },
  // yhs0 17:05Z: "PASS" while test (20.x) was still running -> wrongly approved.
  yhs0PassWhilePending: { asks_change: 0.24, blocks_only_on_pending_ci: 0.76, reports_all_gates_passed: 0.1, reports_unverified_check: 0.6 },
  // m9lo 18:54Z: "PASS ... integration-bd is pending" (a non-step check) -> wrongly escalated.
  m9loPassIntegrationPending: { asks_change: 0.3, blocks_only_on_pending_ci: 0.75, reports_all_gates_passed: 0.14, reports_unverified_check: 0.57 },
  // v16a 17:24Z: clean PASS, all checks done.
  v16aCleanPass: { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.5, reports_unverified_check: 0.04 },
  // t6d3 fixture: PASS but the local typecheck was blocked (a check CI does not cover) -> must still fail closed.
  t6d3TypecheckBlocked: { asks_change: 0.61, blocks_only_on_pending_ci: 0.02, reports_all_gates_passed: 0.04, reports_unverified_check: 0.98 },
};

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}
function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-final-ci-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), '${input}\n${prior_outputs}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'tester'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}
const formula: Formula = {
  name: 'f', description: 'd', whenToUse: '',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'] },
  ],
};

/** A reader whose states change over successive reads (pending, then settled). */
function scriptedReader(sequence: ReadonlyArray<Record<string, CheckState>>): PrChecksReader & { reads: number } {
  const r = {
    reads: 0,
    async read(_url: string, names: readonly string[]) {
      const states = sequence[Math.min(r.reads, sequence.length - 1)]!;
      r.reads++;
      return Object.fromEntries(names.map((n) => [n, states[n] ?? 'pending']));
    },
  };
  return r;
}
const all = (s: CheckState): Record<string, CheckState> => Object.fromEntries(FAST.map((n) => [n, s]));

function harness(testerAnswers: Record<string, number>, reader: PrChecksReader | null, coderText = `opened ${PR}`) {
  const store = new InMemoryDoltClient();
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const judge: StepReplyJudge = { async judge() { return { answers: testerAnswers as never, model: 'jev-1.14.0', inputTokens: 300 }; } };
  const provider = newFakeProvider({ kind: 'fake', script: (spec: SessionSpec) => reply(spec.role === 'coder' ? coderText : 'tester report') });
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus, stepJudge: judge,
    ...(reader ? { prChecks: { reader, names: FAST, pollMs: 1, maxWaitMs: 50 } } : {}),
  });
  return { dispatcher, events };
}
const run = (h: ReturnType<typeof harness>) => h.dispatcher.run({ formula, pack: pack(), input: 'go', motivatingBeadId: 'work-1' });

describe('final step CI from the PR checks (vibesync-9lzk.46)', () => {
  it('REGRESSION (devj): "INCONCLUSIVE, test (20.x) still pending" waits for the checks and completes when they go green', async () => {
    const reader = scriptedReader([all('pending'), all('pending'), all('pass')]);
    const h = harness(REAL.devjPending, reader);
    await expect(run(h)).resolves.toBeDefined();
    expect(reader.reads).toBe(3);
    expect(h.events.find((e) => e.kind === 'dispatcher/step.ci_checks')?.payload).toMatchObject({ outcome: 'green', prUrl: PR, checks: FAST });
  });

  it('REGRESSION (yhs0): a PASS written while a check is pending does NOT complete until the check passes', async () => {
    const reader = scriptedReader([{ typecheck: 'pass', boot: 'pass', 'test (20.x)': 'pending' }, all('pass')]);
    const h = harness(REAL.yhs0PassWhilePending, reader);
    await expect(run(h)).resolves.toBeDefined();
    expect(reader.reads).toBe(2);
  });

  it('REGRESSION (m9lo): integration-bd pending is not a step check; the fast checks decide', async () => {
    // The reader is only ever asked about the three fast checks; integration-bd is not among them.
    const asked: string[][] = [];
    const reader: PrChecksReader = { async read(_u, names) { asked.push([...names]); return Object.fromEntries(names.map((n) => [n, 'pass' as const])); } };
    const h = harness(REAL.m9loPassIntegrationPending, reader);
    await expect(run(h)).resolves.toBeDefined();
    expect(asked.flat()).not.toContain('integration-bd');
  });

  it('a check that FAILS is a change request, never an approval', async () => {
    const reader = scriptedReader([{ typecheck: 'pass', boot: 'pass', 'test (20.x)': 'fail' }]);
    const h = harness(REAL.devjPending, reader);
    const thrown = await run(h).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaEscalationError);
    expect(String((thrown as Error).message)).toContain('test (20.x)');
  });

  it('checks still pending at the wait cap fail closed (escalate), never pass', async () => {
    const h = harness(REAL.devjPending, scriptedReader([all('pending')]));
    const thrown = await run(h).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaEscalationError);
    expect(String((thrown as Error).message)).toContain('still pending');
  });

  it('a clean PASS is confirmed against the checks (green -> completes)', async () => {
    const reader = scriptedReader([all('pass')]);
    await expect(run(harness(REAL.v16aCleanPass, reader))).resolves.toBeDefined();
    expect(reader.reads).toBe(1);
  });

  it('a PASS whose LOCAL check never ran (t6d3) still fails closed: CI cannot vouch for it', async () => {
    const reader = scriptedReader([all('pass')]);
    const thrown = await run(harness(REAL.t6d3TypecheckBlocked, reader)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaEscalationError);
    expect(reader.reads).toBe(0);
  });

  it('a reply that waits on CI with no PR to read fails closed; an approval with no PR stays approved', async () => {
    const thrown = await run(harness(REAL.devjPending, scriptedReader([all('pass')]), 'no pr here')).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaEscalationError);
    await expect(run(harness(REAL.v16aCleanPass, scriptedReader([all('pass')]), 'no pr here'))).resolves.toBeDefined();
  });
});

describe('gh PR checks reader', () => {
  it('maps gh buckets to pass/fail/pending, treats an unreported check as pending, and reads JSON from a non-zero exit', async () => {
    const out = JSON.stringify([
      { name: 'typecheck', bucket: 'pass' }, { name: 'test (20.x)', bucket: 'pending' },
      { name: 'boot', bucket: 'fail' }, { name: 'integration-bd', bucket: 'pending' },
    ]);
    const ok = createGhPrChecksReader(async () => out);
    expect(await ok.read(PR, [...FAST, 'missing'])).toEqual({ typecheck: 'pass', 'test (20.x)': 'pending', boot: 'fail', missing: 'pending' });
    const nonZero = createGhPrChecksReader(async () => { throw new Error(`gh pr checks failed: ${out}`); });
    expect((await nonZero.read(PR, FAST))['boot']).toBe('fail');
    const broken = createGhPrChecksReader(async () => { throw new Error('gh: HTTP 500'); });
    await expect(broken.read(PR, FAST)).rejects.toThrow('HTTP 500');
  });

  it('settleCi stops at the first failure and reports what is still pending at the cap', async () => {
    let t = 0;
    const opts = { names: FAST, pollMs: 10, maxWaitMs: 25, sleep: async (ms: number) => { t += ms; }, now: () => t };
    expect(await settleCi(scriptedReader([{ typecheck: 'fail' }]), PR, opts)).toEqual({ kind: 'failed', failed: ['typecheck'] });
    expect(await settleCi(scriptedReader([all('pending')]), PR, opts)).toMatchObject({ kind: 'still_pending' });
  });
});
