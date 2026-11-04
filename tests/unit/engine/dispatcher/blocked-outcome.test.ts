/**
 * vibesync-zvcm: a step that reports itself blocked stops the formula.
 *
 * Regression for mol-mol-1wb2yks7zqjc, where the mayor replied "Blocked before
 * dispatch: ..." and the coder, reviewer and tester still ran to "completed".
 * The false pass to avoid: asserting on the blocked step's text without
 * asserting that zero downstream steps started.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BLOCKED_MARKER, parseBlockedOutcome, STEP_OUTCOME_INSTRUCTIONS } from '../../../../src/engine/dispatcher/step-outcome.js';
import { FormulaDispatchError } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { installWritebackHook } from '../../../../src/engine/dispatcher/index.js';
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

const formula: Formula = {
  name: 'onboard',
  description: 'onboard',
  whenToUse: '',
  steps: [
    { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md', waitFor: 'completion' },
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['mayor'], waitFor: 'completion' },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'], waitFor: 'completion' },
  ],
};

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-zvcm-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['mayor', 'coder', 'tester'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

function harness(script: (spec: SessionSpec) => AsyncIterable<SessionEvent>) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake', script });
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const walker = new MoleculeWalker(store);
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker, eventBus: bus });
  return { store, provider, bus, events, walker, dispatcher };
}

describe('blocked step outcome (vibesync-zvcm)', () => {
  it('a blocked mayor starts ZERO downstream steps, fails the molecule, and records the blocker', async () => {
    const h = harness((spec) => reply(spec.role === 'mayor'
      ? `The checkout has uncommitted changes, so I cannot plan safely.\n${BLOCKED_MARKER} - dirty checkout at /opt/stacks/vibesync`
      : 'did the work'));

    const thrown = await h.dispatcher.run({ formula, pack: pack(), input: 'go' }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['mayor']);
    const moleculeId = (thrown as FormulaDispatchError).moleculeId;
    const mayor = await h.store.getBead(newMoleculeStepId(moleculeId, 'mayor'));
    expect(mayor).toMatchObject({ status: 'closed', metadata: { exec: { error_trace: 'step blocked: dirty checkout at /opt/stacks/vibesync' } } });
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'coder')))?.status).toBe('open');
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'tester')))?.status).toBe('open');
    expect(await h.store.getBead(moleculeId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'failed' } } });
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed')).toBe(true);
  });

  it('is terminal: a blocked step is not retried even when the formula declares retries', async () => {
    // A one-step formula with retries declared. Retried -> several starts and
    // retry events; terminal -> exactly one start, a failed molecule, no retry.
    const h = harness(() => reply(`nope\n${BLOCKED_MARKER}: missing input`));
    const retrying: Formula = { ...formula, steps: [{ ...formula.steps[0]!, retry: { maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 } }] };
    const thrown = await h.dispatcher.run({ formula: retrying, pack: pack(), input: 'go' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(h.provider.recorder.starts).toHaveLength(1);
    expect(h.events.some((e) => e.kind === 'dispatcher/step.retry')).toBe(false);
    const failed = h.events.find((e) => e.kind === 'dispatcher/step.failed');
    expect(failed?.payload).toMatchObject({ retryOutcome: 'not_retryable' });
  });

  it('the motivating bead receives the blocker in a FAILED writeback note', async () => {
    const h = harness((spec) => reply(spec.role === 'mayor' ? `${BLOCKED_MARKER} - dirty checkout` : 'x'));
    await h.store.insertMoleculeRoot({ id: 'work-1', formulaName: 'n/a', title: 'motivating bead' });
    installWritebackHook({ bus: h.bus, walker: h.walker, store: h.store });
    await h.dispatcher.run({ formula, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const note = h.store.notes.find((n) => n.beadId === 'work-1')?.note ?? '';
    expect(note).toContain('FAILED');
    expect(note).toContain('dirty checkout');
  });

  it('a completed step whose reply merely mentions the marker mid-text still passes', async () => {
    const h = harness(() => reply(`I checked whether to write "${BLOCKED_MARKER}" and did not need to.\nDone.`));
    await expect(h.dispatcher.run({ formula, pack: pack(), input: 'go' })).resolves.toMatchObject({ moleculeId: expect.any(String) });
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['mayor', 'coder', 'tester']);
  });

  it('a RESUMED step that ends blocked fails the molecule instead of completing it', async () => {
    const h = harness(() => reply(`could not continue\n${BLOCKED_MARKER} - lost the worktree`));
    const view = await h.walker.dispatch({ prefix: 'mol', formulaName: 'one', title: '[formula:one]', steps: [{ name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md' }] });
    const stepId = newMoleculeStepId(view.rootId, 'mayor');
    await h.walker.startStep(stepId);
    await h.walker.recordStepTask(stepId, { taskId: 'task-1', providerKind: 'fake', sessionId: 'fake:mayor-prev' });

    const thrown = await h.dispatcher.resume(view.rootId).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(await h.store.getBead(stepId)).toMatchObject({ status: 'closed', metadata: { 'gc.retry_outcome': 'not_retryable', exec: { error_trace: 'step blocked: lost the worktree' } } });
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it('a step whose blocker closed FAILED is never offered, even before the molecule is marked failed', async () => {
    // Fresh dispatcher with no live failure state: only the bead graph and the
    // dispatcher's readiness guard decide. The bead graph DOES release the
    // coder once the mayor is closed, so the guard is what must hold it back.
    const h = harness(() => reply('should never run'));
    const view = await h.walker.dispatch({ prefix: 'mol', formulaName: 'onboard', title: '[formula:onboard]', steps: formula.steps });
    await h.walker.failStep(newMoleculeStepId(view.rootId, 'mayor'), 'step blocked: dirty checkout', 'not_retryable');
    expect((await h.store.findReadyStepsForMolecule(view.rootId)).map((s) => s.id)).toContain(newMoleculeStepId(view.rootId, 'coder'));
    void h.dispatcher.adopt(view.rootId, { formula, pack: pack(), input: 'go' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await h.dispatcher.steps.tick();
    expect(h.provider.recorder.starts).toHaveLength(0);
  });

  it('a soft-failed blocker still releases its dependents (intended behaviour)', async () => {
    // The harness's step loop offers ready steps on its own; observe what it starts.
    const h = harness(() => reply('ran'));
    const view = await h.walker.dispatch({ prefix: 'mol', formulaName: 'onboard', title: '[formula:onboard]', steps: formula.steps });
    await h.walker.failStep(newMoleculeStepId(view.rootId, 'mayor'), 'optional step gave up', 'soft_failed');
    await h.dispatcher.adopt(view.rootId, { formula, pack: pack(), input: 'go' }).catch(() => undefined);
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['coder', 'tester']);
  });

  it('every rendered step prompt carries the blocked-outcome instruction', async () => {
    const h = harness(() => reply('ok'));
    await h.dispatcher.run({ formula, pack: pack(), input: 'go' });
    for (const p of h.provider.recorder.prompts) {
      const text = p.content.map((c) => ('text' in c ? c.text : '')).join('');
      expect(text).toContain(STEP_OUTCOME_INSTRUCTIONS.trim());
    }
  });
});

describe('parseBlockedOutcome', () => {
  it.each([
    [`work\n${BLOCKED_MARKER} - reason here`, 'reason here'],
    [`${BLOCKED_MARKER}: reason`, 'reason'],
    [`${BLOCKED_MARKER} \u2014 reason`, 'reason'],
    [`step outcome: blocked - lower case`, 'lower case'],
    [`${BLOCKED_MARKER}`, 'no reason given'],
    [`work\n${BLOCKED_MARKER} - trailing\n\n   \n`, 'trailing'],
  ])('final line %j -> %j', (text, reason) => {
    expect(parseBlockedOutcome(text)).toBe(reason);
  });

  it.each([
    'all done',
    `${BLOCKED_MARKER} - quoted early\nbut then I finished`,
    '',
    `result:\n${BLOCKED_MARKER} = false`,
    `${BLOCKED_MARKER}NESS is fine`,
  ])('not blocked: %j', (text) => {
    expect(parseBlockedOutcome(text)).toBeNull();
  });
});
