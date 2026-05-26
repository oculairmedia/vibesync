import { describe, expect, it } from 'vitest';

import { MoleculeWalker, newMoleculeStepId } from '../../../../src/orchestration/molecule/molecule.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import type { BeadRow } from '../../../../src/orchestration/store/index.js';

describe('MoleculeWalker', () => {
  it('dispatch creates a molecule root with step beads and dependency edges', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);

    const view = await walker.dispatch({
      prefix: 'vibesync',
      formulaName: 'code-review',
      title: 'Run code review',
      motivatingBeadId: 'vibesync-123',
      steps: [
        { name: 'reviewer', role: 'reviewer' },
        { name: 'coder', role: 'coder', dependsOn: ['reviewer'] },
        { name: 'tester', role: 'tester', dependsOn: ['coder'] },
      ],
    });

    expect(view.root.issue_type).toBe('molecule_root');
    expect(view.root.metadata).toMatchObject({ exec: { formula: 'code-review', motivating_bead: 'vibesync-123' } });
    expect(view.steps.map((step) => step.metadata.exec)).toEqual([
      { step: 'reviewer', molecule: view.rootId, input_payload: undefined },
      { step: 'coder', molecule: view.rootId, input_payload: undefined },
      { step: 'tester', molecule: view.rootId, input_payload: undefined },
    ]);
    expect(view.edges.filter((edge) => edge.type === 'parent-child')).toHaveLength(3);
    expect(view.edges.filter((edge) => edge.type === 'blocks')).toEqual([
      {
        issue_id: newMoleculeStepId(view.rootId, 'coder'),
        depends_on_id: newMoleculeStepId(view.rootId, 'reviewer'),
        type: 'blocks',
      },
      {
        issue_id: newMoleculeStepId(view.rootId, 'tester'),
        depends_on_id: newMoleculeStepId(view.rootId, 'coder'),
        type: 'blocks',
      },
    ]);
  });

  it('loads null for a missing or non-root bead', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'vibesync',
      formulaName: 'one-step',
      title: 'One step',
      steps: [{ name: 'first', role: 'worker' }],
    });

    expect(await walker.load('missing')).toBeNull();
    expect(await walker.load(newMoleculeStepId(view.rootId, 'first'))).toBeNull();
  });

  it('findReady returns dependency roots first and unblocks dependents after finish', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'vibesync',
      formulaName: 'chain',
      title: 'Chain',
      steps: [
        { name: 'a', role: 'worker' },
        { name: 'b', role: 'worker', dependsOn: ['a'] },
        { name: 'c', role: 'worker', dependsOn: ['b'] },
      ],
    });

    await expectReadyStepNames(walker, view.rootId, ['a']);
    await walker.finishStep(newMoleculeStepId(view.rootId, 'a'), { ok: true });
    await expectReadyStepNames(walker, view.rootId, ['b']);
    await walker.finishStep(newMoleculeStepId(view.rootId, 'b'), { ok: true });
    await expectReadyStepNames(walker, view.rootId, ['c']);
  });

  it('treats independent open steps as ready together', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await walker.dispatch({
      prefix: 'vibesync',
      formulaName: 'fan-out',
      title: 'Fan out',
      steps: [
        { name: 'a', role: 'worker' },
        { name: 'b', role: 'worker' },
      ],
    });

    await expectReadyStepNames(walker, view.rootId, ['a', 'b']);
  });

  it('throws when a step depends on a forward reference', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());

    await expect(
      walker.dispatch({
        prefix: 'vibesync',
        formulaName: 'broken',
        title: 'Broken',
        steps: [
          { name: 'a', role: 'worker', dependsOn: ['b'] },
          { name: 'b', role: 'worker' },
        ],
      }),
    ).rejects.toThrow(/depends_on "b" which is not defined before it/);
  });

  it('startStep marks a step in progress', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await dispatchSingleStep(walker);
    const stepId = newMoleculeStepId(view.rootId, 'worker');

    await walker.startStep(stepId);

    await expectStepStatus(store, stepId, 'in_progress');
  });

  it('finishStep closes a step and records output payload', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await dispatchSingleStep(walker);
    const stepId = newMoleculeStepId(view.rootId, 'worker');

    await walker.finishStep(stepId, { result: 'done' });

    await expectStepStatus(store, stepId, 'closed');
    expect((await store.getBead(stepId))?.metadata).toMatchObject({ exec: { output_payload: { result: 'done' } } });
    expect(await walker.isComplete(view.rootId)).toBe(true);
  });

  it('failStep closes a step and records error trace', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await dispatchSingleStep(walker);
    const stepId = newMoleculeStepId(view.rootId, 'worker');

    await walker.failStep(stepId, 'boom');

    await expectStepStatus(store, stepId, 'closed');
    expect((await store.getBead(stepId))?.metadata).toMatchObject({ exec: { error_trace: 'boom' } });
    expect(await walker.isComplete(view.rootId)).toBe(true);
  });

  it('isComplete is false while any step remains open', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await walker.dispatch({
      prefix: 'vibesync',
      formulaName: 'chain',
      title: 'Chain',
      steps: [
        { name: 'a', role: 'worker' },
        { name: 'b', role: 'worker', dependsOn: ['a'] },
      ],
    });

    await walker.finishStep(newMoleculeStepId(view.rootId, 'a'), { ok: true });

    expect(await walker.isComplete(view.rootId)).toBe(false);
  });
});

async function dispatchSingleStep(walker: MoleculeWalker) {
  return walker.dispatch({
    prefix: 'vibesync',
    formulaName: 'one-step',
    title: 'One step',
    steps: [{ name: 'worker', role: 'worker' }],
  });
}

async function expectReadyStepNames(walker: MoleculeWalker, rootId: string, names: readonly string[]): Promise<void> {
  const ready = await walker.findReady(rootId);
  expect(ready.map(stepName)).toEqual(names);
}

async function expectStepStatus(store: InMemoryDoltClient, stepId: string, status: string): Promise<void> {
  expect((await store.getBead(stepId))?.status).toBe(status);
}

function stepName(row: BeadRow): string | undefined {
  const exec = row.metadata.exec;
  if (!exec || typeof exec !== 'object' || !('step' in exec)) return undefined;
  const step = exec.step;
  return typeof step === 'string' ? step : undefined;
}
