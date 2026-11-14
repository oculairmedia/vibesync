/**
 * Characterisation tests for MoleculeWalker (vibesync-ji3w), written BEFORE
 * refactoring src/engine/molecule/molecule.ts (load cc 12, listMolecules 9,
 * dispatch 9). The full suite took only 27 of its 48 branch arms (56%): the run
 * list (listMolecules), which feeds the run-list screen, and load's handling of
 * odd children were barely exercised. These run on the in-memory store.
 */
import { describe, expect, it } from 'vitest';

import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/molecule.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import type { BeadRow } from '../../../../src/engine/store/index.js';

const STEPS = [
  { name: 'mayor', role: 'mayor' },
  { name: 'coder', role: 'coder', dependsOn: ['mayor'] },
  { name: 'tester', role: 'tester', dependsOn: ['coder'] },
];

async function molecule(store: InMemoryDoltClient, over: { motivatingBeadId?: string } = {}) {
  const walker = new MoleculeWalker(store);
  const view = await walker.dispatch({ prefix: 'p', formulaName: 'onboard', title: 'Run', steps: STEPS, ...over });
  return { walker, view, step: (name: string) => newMoleculeStepId(view.rootId, name) };
}

describe('load', () => {
  it('skips a child of the root that is not a step, and a step with no name is kept but not indexed by name', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view } = await molecule(store);
    const now = new Date();
    store.beads.set('p-note', { id: 'p-note', title: 'a note', description: '', status: 'open', priority: 2, issue_type: 'task', created_at: now, updated_at: now, closed_at: null, metadata: {} } as BeadRow);
    store.dependencies.push({ issue_id: 'p-note', depends_on_id: view.rootId, type: 'parent-child' });
    store.beads.set('p-anon', { id: 'p-anon', title: 'unnamed', description: '', status: 'open', priority: 2, issue_type: 'molecule_step', created_at: now, updated_at: now, closed_at: null, metadata: { exec: {} } } as BeadRow);
    store.dependencies.push({ issue_id: 'p-anon', depends_on_id: view.rootId, type: 'parent-child' });

    const loaded = (await walker.load(view.rootId))!;
    expect(loaded.steps.map((s) => s.id)).not.toContain('p-note');
    expect(loaded.steps.map((s) => s.id)).toContain('p-anon');
    expect([...loaded.byName.keys()].sort()).toEqual(['coder', 'mayor', 'tester']);
  });

  it('only a parent-child edge makes a bead a step of the root; a blocks edge onto the root does not', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view } = await molecule(store);
    const now = new Date();
    store.beads.set('p-blocker', { id: 'p-blocker', title: 'other run step', description: '', status: 'open', priority: 2, issue_type: 'molecule_step', created_at: now, updated_at: now, closed_at: null, metadata: { exec: { step: 'other' } } } as BeadRow);
    store.dependencies.push({ issue_id: 'p-blocker', depends_on_id: view.rootId, type: 'blocks' });
    const loaded = (await walker.load(view.rootId))!;
    expect(loaded.steps.map((s) => s.id)).not.toContain('p-blocker');
    expect(loaded.byName.has('other')).toBe(false);
  });

  it('includes each step\'s own edges once, though they are read from both ends', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view, step } = await molecule(store);
    const loaded = (await walker.load(view.rootId))!;
    const key = (e: { issue_id: string; depends_on_id: string; type: string }) => `${e.issue_id}>${e.depends_on_id}:${e.type}`;
    const keys = loaded.edges.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`${step('coder')}>${step('mayor')}:blocks`);
    expect(keys).toContain(`${step('tester')}>${step('coder')}:blocks`);
    expect(keys.filter((k) => k.endsWith(`>${view.rootId}:parent-child`))).toHaveLength(3);
  });

  it('is null for a missing bead and for a bead that is not a molecule root', async () => {
    const store = new InMemoryDoltClient();
    const { walker, step } = await molecule(store);
    expect(await walker.load('p-missing')).toBeNull();
    expect(await walker.load(step('mayor'))).toBeNull();
  });
});

describe('listMolecules (the run list)', () => {
  it('summarises a run: formula, motivating bead, step counts, and no current step before anything starts', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view } = await molecule(store, { motivatingBeadId: 'p-42' });
    const [summary] = await walker.listMolecules();
    expect(summary).toMatchObject({
      id: view.rootId, formulaName: 'onboard', motivatingBeadId: 'p-42', title: 'Run',
      stepCounts: { total: 3, done: 0, running: 0 }, currentStep: null, currentStepStatus: null,
    });
  });

  it('the current step is the running one when there is one', async () => {
    const store = new InMemoryDoltClient();
    const { walker, step } = await molecule(store);
    await walker.startStep(step('mayor'));
    await walker.finishStep(step('mayor'), 'plan');
    await walker.startStep(step('coder'));
    const [summary] = await walker.listMolecules();
    expect(summary).toMatchObject({ stepCounts: { total: 3, done: 1, running: 1 }, currentStep: 'coder', currentStepStatus: 'in_progress' });
  });

  it('a running step beats a later step that already finished (independent steps run side by side)', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({ prefix: 'p', formulaName: 'fan', title: 'Fan', steps: [{ name: 'a', role: 'coder' }, { name: 'b', role: 'coder' }] });
    const id = (n: string) => newMoleculeStepId(view.rootId, n);
    await walker.startStep(id('a'));
    await walker.startStep(id('b'));
    await walker.finishStep(id('b'), 'done');
    const [summary] = await walker.listMolecules();
    expect(summary).toMatchObject({ currentStep: 'a', currentStepStatus: 'in_progress', stepCounts: { total: 2, done: 1, running: 1 } });
  });

  it('with nothing running, the current step is the LAST step that is no longer open', async () => {
    const store = new InMemoryDoltClient();
    const { walker, step } = await molecule(store);
    await walker.startStep(step('mayor'));
    await walker.finishStep(step('mayor'), 'plan');
    await walker.startStep(step('coder'));
    await walker.failStep(step('coder'), 'boom');
    const [summary] = await walker.listMolecules();
    expect(summary).toMatchObject({ stepCounts: { total: 3, done: 2, running: 0 }, currentStep: 'coder', currentStepStatus: 'closed' });
  });

  it('a run without a motivating bead says so; the status filter and the limit are passed through', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view } = await molecule(store);
    const second = await walker.dispatch({ prefix: 'p', formulaName: 'onboard', title: 'Run 2', steps: STEPS });
    expect((await walker.listMolecules()).find((m) => m.id === view.rootId)?.motivatingBeadId).toBeNull();
    expect(await walker.listMolecules({ limit: 1 })).toHaveLength(1);
    await walker.markMoleculeRootStatus(second.rootId, 'closed', 'completed');
    expect((await walker.listMolecules({ statuses: ['open'] })).map((m) => m.id)).toEqual([view.rootId]);
  });

  it('a step with no recorded name is reported by its title', async () => {
    const store = new InMemoryDoltClient();
    const { walker, step } = await molecule(store);
    await walker.startStep(step('mayor'));
    const row = store.beads.get(step('mayor'))!;
    store.beads.set(row.id, { ...row, metadata: {} });
    const [summary] = await walker.listMolecules();
    expect(summary?.currentStep).toBe(row.title);
  });
});

describe('isComplete', () => {
  it('is false for an unknown run and while any step is open, true when every step is closed', async () => {
    const store = new InMemoryDoltClient();
    const { walker, view, step } = await molecule(store);
    expect(await walker.isComplete('p-missing')).toBe(false);
    expect(await walker.isComplete(view.rootId)).toBe(false);
    for (const name of ['mayor', 'coder', 'tester']) {
      await walker.startStep(step(name));
      await walker.finishStep(step(name), 'ok');
    }
    expect(await walker.isComplete(view.rootId)).toBe(true);
  });
});
