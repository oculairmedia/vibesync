/**
 * vibesync-9lzk.24: bounded review loop. A reviewing step that ends BLOCKED
 * sends the work back to the coder for another round instead of failing the
 * run; after max_rounds blocked rounds the run fails with an escalation.
 * Engine round 9: Sol's correct block ended the run and the PM had to relaunch
 * by hand with the review pasted into the brief.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BLOCKED_MARKER } from '../../../../src/engine/dispatcher/step-outcome.js';
import { FormulaDispatchError } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import { loadFormulasFromFile, parseFormulasFromToml, type Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

const blocked = (why: string) => `**Verdict:** CHANGES-REQUESTED\n${BLOCKED_MARKER} - ${why}`;

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-review-loop-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Task: ${input}\n\n${prior_outputs}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['mayor', 'coder', 'reviewer', 'tester'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const looping = (maxRounds = 3): Formula => ({
  name: 'onboard', description: 'd', whenToUse: '',
  steps: [
    { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md' },
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['mayor'] },
    { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/p.md', dependsOn: ['coder'], loopsBackTo: 'coder', maxRounds },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['reviewer'] },
  ],
});

/** Scripts the reviewer by round: blocks for the first `blocks` rounds, then LGTM. */
function harness(blocks: number) {
  const store = new InMemoryDoltClient();
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const seen = { coder: 0, reviewer: 0, tester: 0, mayor: 0 };
  const provider = newFakeProvider({
    kind: 'fake',
    script: (spec: SessionSpec) => {
      seen[spec.role as keyof typeof seen]++;
      if (spec.role === 'reviewer') return reply(seen.reviewer <= blocks ? blocked(`round ${seen.reviewer}: the test cannot fail`) : '**Verdict:** LGTM');
      if (spec.role === 'coder') return reply(`coder round ${seen.coder}: pushed fix-${seen.coder} to PR #7`);
      return reply(spec.role === 'mayor' ? 'plan' : 'PASS');
    },
  });
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus });
  return { store, events, provider, dispatcher, seen };
}

const promptText = (p: { readonly content: readonly { type: string; text?: string }[] }) => p.content.map((c) => c.text ?? '').join('');
/** The fake provider's handle id is `fake:<role>-<n>`. */
const roleOf = (p: { readonly handle: { readonly id: string } }) => p.handle.id.slice('fake:'.length).replace(/-\d+$/, '');

describe('bounded review loop (vibesync-9lzk.24)', () => {
  it('REGRESSION (round 9): a blocking review sends the coder back; the next coder prompt carries the review; a later LGTM completes the run', async () => {
    const h = harness(1);
    const result = await h.dispatcher.run({ formula: looping(), pack: pack(), input: 'go', motivatingBeadId: 'work-1' });
    expect(h.seen).toEqual({ mayor: 1, coder: 2, reviewer: 2, tester: 1 });
    const coderPrompts = h.provider.recorder.prompts.filter((p) => roleOf(p) === 'coder').map(promptText);
    expect(coderPrompts[0]).not.toContain('requested changes');
    expect(coderPrompts[1]).toContain('Round 1 review (reviewer) requested changes: round 1: the test cannot fail');
    expect(coderPrompts[1]).toContain('## review');
    const root = await h.store.getBead(result.moleculeId);
    expect(root?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
    const coder = await h.store.getBead(newMoleculeStepId(result.moleculeId, 'coder'));
    expect(coder?.metadata).toMatchObject({ 'gc.review_round': 2 });
    expect(h.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['dispatcher/step.review_blocked', 'dispatcher/step.loop_back', 'dispatcher/formula.completed']));
    expect(h.events.find((e) => e.kind === 'dispatcher/step.loop_back')?.payload).toMatchObject({ loopsBackTo: 'coder', round: 2, maxRounds: 3, reopened: ['coder', 'reviewer'] });
  });

  it('the tester runs only after the reviewer finally approves, and sees the final coder output', async () => {
    const h = harness(2);
    await h.dispatcher.run({ formula: looping(), pack: pack(), input: 'go', motivatingBeadId: 'work-1' });
    expect(h.seen).toEqual({ mayor: 1, coder: 3, reviewer: 3, tester: 1 });
    const testerPrompt = promptText(h.provider.recorder.prompts.find((p) => roleOf(p) === 'tester')!);
    expect(testerPrompt).toContain('coder round 3');
    expect(testerPrompt).not.toContain('coder round 2:');
  });

  it('after max_rounds blocked rounds the run FAILS with an escalation instead of looping forever', async () => {
    const h = harness(99);
    const thrown = await h.dispatcher.run({ formula: looping(3), pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(h.seen).toEqual({ mayor: 1, coder: 3, reviewer: 3, tester: 0 });
    const exhausted = h.events.find((e) => e.kind === 'dispatcher/formula.review_exhausted');
    expect(exhausted?.payload).toMatchObject({ loopsBackTo: 'coder', rounds: 3, maxRounds: 3 });
    const reviewer = await h.store.getBead(newMoleculeStepId((thrown as FormulaDispatchError).moleculeId, 'reviewer'));
    expect(String((reviewer?.metadata?.['exec'] as Record<string, unknown>)['error_trace'])).toContain('review loop exhausted after 3 rounds; escalated');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed')).toBe(true);
  });

  it('a formula without loops_back_to still fails on the first block (unchanged)', async () => {
    const h = harness(1);
    const noLoop: Formula = { ...looping(), steps: looping().steps.map((s) => { const { loopsBackTo: _l, maxRounds: _m, ...rest } = s; return rest; }) };
    const thrown = await h.dispatcher.run({ formula: noLoop, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(h.seen).toEqual({ mayor: 1, coder: 1, reviewer: 1, tester: 0 });
  });
});

describe('loops_back_to in formulas', () => {
  const base = '[formula.f]\ndescription = "d"\n[[formula.f.steps]]\nrole = "coder"\n[[formula.f.steps]]\nrole = "reviewer"\ndepends_on = "coder"\n';
  it('parses loops_back_to with a default max_rounds of 3', () => {
    const f = parseFormulasFromToml(base + 'loops_back_to = "coder"\n')[0]!;
    expect(f.steps[1]).toMatchObject({ loopsBackTo: 'coder', maxRounds: 3 });
    expect(parseFormulasFromToml(base + 'loops_back_to = "coder"\nmax_rounds = 2\n')[0]!.steps[1]?.maxRounds).toBe(2);
  });
  it('rejects a target that is not an earlier step, and max_rounds without a target or below 1', () => {
    expect(() => parseFormulasFromToml(base + 'loops_back_to = "tester"\n')).toThrow('not an earlier step');
    expect(() => parseFormulasFromToml(base + 'max_rounds = 2\n')).toThrow('needs loops_back_to');
    expect(() => parseFormulasFromToml(base + 'loops_back_to = "coder"\nmax_rounds = 0\n')).toThrow('must be >= 1');
  });
  it('the shipped onboard-feature reviewer loops back to the coder, capped at 3', () => {
    const f = loadFormulasFromFile(join(process.cwd(), 'packs/gastown/formulas/onboard-feature.toml'))[0]!;
    expect(f.steps.find((s) => s.role === 'reviewer')).toMatchObject({ loopsBackTo: 'coder', maxRounds: 3 });
  });
});
