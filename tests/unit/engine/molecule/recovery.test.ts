import { afterEach, describe, expect, it } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import { INTERRUPTED_EVENT, MoleculeWalker, recoverInterruptedMolecules } from '../../../../src/engine/molecule/index.js';
import type { StepSpec } from '../../../../src/engine/molecule/index.js';
import type { Event } from '../../../../src/engine/events/index.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';

const steps: StepSpec[] = [
  { name: 'mayor', role: 'mayor', promptTemplate: 'p' },
  { name: 'coder', role: 'coder', promptTemplate: 'p', dependsOn: ['mayor'] },
  { name: 'tester', role: 'tester', promptTemplate: 'p', dependsOn: ['coder'] },
];

async function cookRunning(store: InMemoryDoltClient, motivatingBeadId?: string) {
  const walker = new MoleculeWalker(store as never);
  const view = await walker.dispatch({ prefix: 'mol', formulaName: 'onboard', title: '[formula:onboard]', steps, ...(motivatingBeadId ? { motivatingBeadId } : {}) });
  const id = (name: string) => `${view.rootId}-${name}`;
  await store.markStepDone(id('mayor'), { output: 'plan' });
  await store.markStepRunning(id('coder'));
  return { rootId: view.rootId, id };
}

describe('recoverInterruptedMolecules', () => {
  it('closes every open root and its unfinished steps as interrupted; finished steps keep their output', async () => {
    const store = new InMemoryDoltClient();
    const a = await cookRunning(store, 'work-1');
    const b = await cookRunning(store);
    const emitted: Array<{ moleculeId: string; payload: Record<string, unknown> }> = [];

    const report = await recoverInterruptedMolecules(store as never, (moleculeId, payload) => emitted.push({ moleculeId, payload }));

    expect([...report.interrupted].sort()).toEqual([a.rootId, b.rootId].sort());
    expect(report.failed).toEqual([]);
    for (const m of [a, b]) {
      expect(await store.getBead(m.rootId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'interrupted' } } });
      expect(await store.getBead(m.id('mayor'))).toMatchObject({ status: 'closed', metadata: { exec: { output_payload: { output: 'plan' } } } });
      for (const name of ['coder', 'tester']) {
        expect(await store.getBead(m.id(name))).toMatchObject({ status: 'closed', metadata: { 'gc.retry_outcome': 'interrupted' } });
      }
    }
    expect(emitted.find((e) => e.moleculeId === a.rootId)?.payload).toMatchObject({ motivating_bead: 'work-1' });
    expect(emitted.find((e) => e.moleculeId === b.rootId)?.payload).not.toHaveProperty('motivating_bead');
  });

  it('closes blockers before the steps they block, whatever order the store returns them in', async () => {
    const store = new InMemoryDoltClient();
    const m = await cookRunning(store);
    // Mirror real bd exactly: "cannot close blocked issue: B is blocked by [A]"
    // means a step cannot close while a step IT DEPENDS ON is still open.
    const closed: string[] = [];
    const bdLike = new Proxy(store, {
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
        if (prop === 'getBeadDependencies') {
          // Worst case for the old code: children listed dependents-first.
          return async (id: string) => {
            const edges = await target.getBeadDependencies(id);
            return id === m.rootId ? [...edges].sort((a, b) => b.issue_id.localeCompare(a.issue_id)) : edges;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const report = await recoverInterruptedMolecules(bdLike as never, () => undefined);
    expect(report.failed).toEqual([]);
    expect(closed).toEqual([m.id('coder'), m.id('tester')]);
  });

  it('leaves already-closed molecules alone and is a no-op with nothing open', async () => {
    const store = new InMemoryDoltClient();
    const m = await cookRunning(store);
    await store.markMoleculeRootStatus(m.rootId, 'closed', 'completed');
    const report = await recoverInterruptedMolecules(store as never, () => undefined);
    expect(report.interrupted).toEqual([]);
    expect(await store.getBead(m.rootId)).toMatchObject({ metadata: { exec: { outcome: 'completed' } } });
  });

  it('one molecule failing to close does not stop the others', async () => {
    const store = new InMemoryDoltClient();
    const a = await cookRunning(store);
    const b = await cookRunning(store);
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'markMoleculeRootStatus') {
          return async (rootId: string, ...rest: unknown[]) => {
            if (rootId === a.rootId) throw new Error('bd unavailable');
            return (target.markMoleculeRootStatus as (...x: unknown[]) => Promise<void>).call(target, rootId, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const report = await recoverInterruptedMolecules(flaky as never, () => undefined);
    expect(report.interrupted).toEqual([b.rootId]);
    expect(report.failed).toEqual([{ moleculeId: a.rootId, error: 'bd unavailable' }]);
  });
});

describe('boot retires interrupted molecules before anything can dispatch', () => {
  const handles: OrchestrationHandle[] = [];
  afterEach(async () => { for (const h of handles.splice(0)) await h.shutdown(); });

  it('an orphaned running molecule is closed at boot, its steps are never run, and the motivating bead is told', async () => {
    const store = new InMemoryDoltClient();
    await store.insertMoleculeRoot({ id: 'work-1', formulaName: 'n/a', title: 'motivating work bead' });
    const m = await cookRunning(store, 'work-1');
    const provider = newFakeProvider({ kind: 'fake' });
    const events: Event[] = [];

    const handle = await bootOrchestrationPlane({ ...inMemoryBeads(store), provider, persistEvents: false, runDriftAuditOnBoot: false, stepTickIntervalMs: 10 });
    handles.push(handle);
    handle.bus.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 100));

    expect(await store.getBead(m.rootId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'interrupted', writeback_status: 'interrupted' } } });
    const note = store.notes.find((n) => n.beadId === 'work-1')?.note ?? '';
    expect(note).toContain('INTERRUPTED');
    expect(note).toContain('mayor (finished before restart): plan');
    expect(provider.recorder.starts).toHaveLength(0);
    expect(events.some((e) => e.kind === 'dispatcher/step.started')).toBe(false);
  });

  it(`leaves no open molecule root after boot (${INTERRUPTED_EVENT})`, async () => {
    const store = new InMemoryDoltClient();
    await cookRunning(store);
    const provider = newFakeProvider({ kind: 'fake' });
    const handle = await bootOrchestrationPlane({ ...inMemoryBeads(store), provider, persistEvents: false, runDriftAuditOnBoot: false });
    handles.push(handle);
    expect(await store.listMoleculeRoots({ statuses: ['open', 'in_progress'] })).toHaveLength(0);
  });
});
