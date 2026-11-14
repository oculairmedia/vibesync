/**
 * Characterisation tests for restart recovery (vibesync-ji3w), written BEFORE
 * refactoring src/engine/molecule/recovery.ts (blockersFirst cc 11, two complex
 * conditionals). The existing tests cover a straight chain and a failed close;
 * these pin the ordering rules on other shapes (a step waiting on two others,
 * a blocker outside the molecule, a cycle) and the edges of what is reported.
 */
import { describe, expect, it } from 'vitest';

import { INTERRUPTED_EVENT, MoleculeWalker, recoverInterruptedMolecules } from '../../../../src/engine/molecule/index.js';
import type { StepSpec } from '../../../../src/engine/molecule/index.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

void INTERRUPTED_EVENT;

async function molecule(store: InMemoryDoltClient, steps: StepSpec[], motivatingBeadId?: string) {
  const walker = new MoleculeWalker(store as never);
  const view = await walker.dispatch({ prefix: 'mol', formulaName: 'f', title: 't', steps, ...(motivatingBeadId ? { motivatingBeadId } : {}) });
  return { rootId: view.rootId, id: (name: string) => `${view.rootId}-${name}` };
}

/** Records the order steps are closed in, and refuses to close a step whose blocker is still open (as bd does). */
function bdLike(store: InMemoryDoltClient, closed: string[]) {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'markStepFailed') {
        return async (stepId: string, ...rest: unknown[]) => {
          for (const e of await target.getBeadDependencies(stepId)) {
            if (e.type !== 'blocks' || e.issue_id !== stepId) continue;
            const blocker = await target.getBead(e.depends_on_id);
            if (blocker && blocker.status !== 'closed') throw new Error(`cannot close blocked issue: ${stepId} is blocked by [${e.depends_on_id}]`);
          }
          closed.push(stepId);
          return (target.markStepFailed as (...x: unknown[]) => Promise<void>).call(target, stepId, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('closing order', () => {
  it('a step waiting on two others closes after both, and two independent steps both close first', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [
      { name: 'a', role: 'r', promptTemplate: 'p' },
      { name: 'b', role: 'r', promptTemplate: 'p' },
      { name: 'join', role: 'r', promptTemplate: 'p', dependsOn: ['a', 'b'] },
    ]);
    const closed: string[] = [];
    const report = await recoverInterruptedMolecules(bdLike(store, closed) as never, () => undefined);
    expect(report.failed).toEqual([]);
    expect(closed).toHaveLength(3);
    expect(closed.at(-1)).toBe(m.id('join'));
    expect(new Set(closed.slice(0, 2))).toEqual(new Set([m.id('a'), m.id('b')]));
  });

  it('a blocker outside the molecule does not hold a step back (only steps of this molecule are ordered)', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'only', role: 'r', promptTemplate: 'p' }]);
    store.dependencies.push({ issue_id: m.id('only'), depends_on_id: 'elsewhere-1', type: 'blocks' });
    const report = await recoverInterruptedMolecules(store as never, () => undefined);
    expect(report.failed).toEqual([]);
    expect(await store.getBead(m.id('only'))).toMatchObject({ status: 'closed' });
  });

  it('only blocks edges order steps: a related edge against a blocks edge is not a cycle', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'x', role: 'r', promptTemplate: 'p' }, { name: 'y', role: 'r', promptTemplate: 'p', dependsOn: ['x'] }]);
    store.dependencies.push({ issue_id: m.id('x'), depends_on_id: m.id('y'), type: 'related' });
    const closed: string[] = [];
    const report = await recoverInterruptedMolecules(bdLike(store, closed) as never, () => undefined);
    expect(report.failed).toEqual([]);
    expect(closed).toEqual([m.id('x'), m.id('y')]);
  });

  it('a dependency cycle is refused for that molecule only: nothing of it is closed, the others still are', async () => {
    const store = new InMemoryDoltClient();
    const loop = await molecule(store, [{ name: 'p', role: 'r', promptTemplate: 'p' }, { name: 'q', role: 'r', promptTemplate: 'p', dependsOn: ['p'] }]);
    store.dependencies.push({ issue_id: loop.id('p'), depends_on_id: loop.id('q'), type: 'blocks' });
    const fine = await molecule(store, [{ name: 'solo', role: 'r', promptTemplate: 'p' }]);
    const closed: string[] = [];
    const report = await recoverInterruptedMolecules(bdLike(store, closed) as never, () => undefined);
    expect(report.failed).toEqual([{ moleculeId: loop.rootId, error: 'step dependency cycle; cannot order closes' }]);
    expect(report.interrupted).toEqual([fine.rootId]);
    expect(closed).toEqual([fine.id('solo')]);
    expect(await store.getBead(loop.rootId)).toMatchObject({ status: 'open' });
  });
});

describe('what is recovered', () => {
  it('a root that is in progress, not just open, is recovered', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }]);
    const root = store.beads.get(m.rootId)!;
    store.beads.set(m.rootId, { ...root, status: 'in_progress' });
    const report = await recoverInterruptedMolecules(store as never, () => undefined);
    expect(report.interrupted).toEqual([m.rootId]);
    expect(await store.getBead(m.rootId)).toMatchObject({ status: 'closed' });
  });

  it('a child of the root that is not a step, and a bead joined to the root by a blocks edge, are not closed', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }]);
    const base = store.beads.get(m.id('a'))!;
    store.beads.set('note-1', { ...base, id: 'note-1', issue_type: 'task', status: 'open', metadata: {} });
    store.dependencies.push({ issue_id: 'note-1', depends_on_id: m.rootId, type: 'parent-child' });
    store.beads.set('other-step', { ...base, id: 'other-step', status: 'open' });
    store.dependencies.push({ issue_id: 'other-step', depends_on_id: m.rootId, type: 'blocks' });
    const emitted: Record<string, unknown>[] = [];
    await recoverInterruptedMolecules(store as never, (_id, payload) => { emitted.push({ ...payload }); });
    expect(emitted[0]?.['interruptedSteps']).toEqual([m.id('a')]);
    expect(await store.getBead('note-1')).toMatchObject({ status: 'open' });
    expect(await store.getBead('other-step')).toMatchObject({ status: 'open' });
  });
});

describe('what is reported', () => {
  it('the event names the run, the trace and every step it closed, and the motivating bead only when there is one', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }], 'work-7');
    const n = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }]);
    const emitted = new Map<string, Record<string, unknown>>();
    await recoverInterruptedMolecules(store as never, (id, payload) => { emitted.set(id, { ...payload }); });
    expect(emitted.get(m.rootId)).toEqual({
      moleculeId: m.rootId,
      error: 'interrupted: vibesync restarted while this step was pending; the work bead is re-run',
      interruptedSteps: [m.id('a')],
      motivating_bead: 'work-7',
    });
    expect(emitted.get(n.rootId)).not.toHaveProperty('motivating_bead');
  });

  it('an empty motivating bead is treated as none', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }]);
    const root = store.beads.get(m.rootId)!;
    store.beads.set(m.rootId, { ...root, metadata: { ...root.metadata, exec: { ...(root.metadata.exec as object), motivating_bead: '' } } });
    const emitted: Record<string, unknown>[] = [];
    await recoverInterruptedMolecules(store as never, (_id, payload) => { emitted.push({ ...payload }); });
    expect(emitted[0]).not.toHaveProperty('motivating_bead');
  });

  it('a close that throws something other than an Error is reported by its text', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'a', role: 'r', promptTemplate: 'p' }]);
    const odd = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'markMoleculeRootStatus') return async () => { throw 'plain text failure'; };
        return Reflect.get(target, prop, receiver);
      },
    });
    const report = await recoverInterruptedMolecules(odd as never, () => undefined);
    expect(report.failed).toEqual([{ moleculeId: m.rootId, error: 'plain text failure' }]);
  });

  it('closed steps are left as they are and only unfinished ones are listed', async () => {
    const store = new InMemoryDoltClient();
    const m = await molecule(store, [{ name: 'done', role: 'r', promptTemplate: 'p' }, { name: 'open', role: 'r', promptTemplate: 'p' }]);
    await store.markStepDone(m.id('done'), 'ok');
    const emitted: Record<string, unknown>[] = [];
    await recoverInterruptedMolecules(store as never, (_id, payload) => { emitted.push({ ...payload }); });
    expect(emitted[0]?.['interruptedSteps']).toEqual([m.id('open')]);
  });
});
