import { describe, expect, it, vi } from 'vitest';

import { createBdProjectBeadStore } from '../../../../src/engine/beads/project-bead-store.js';
import { installWritebackHook } from '../../../../src/engine/dispatcher/writeback-hook.js';
import { EventBus } from '../../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { BeadRow } from '../../../../src/engine/store/index.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const ROOT = 'vibesync-mol-xproj';
const WORK_BEAD = 'other-abc1';
const SETTLE = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeBd(beads: Record<string, { notes?: string }>, calls: string[], failWith?: string) {
  return async (args: readonly string[]): Promise<string> => {
    calls.push(`bd:${args[0]}`);
    if (failWith) throw new Error(failWith);
    const [command, id] = args;
    if (command === 'show') {
      const bead = beads[id!];
      if (!bead) throw new Error(`bd show ${id} --json failed: Issue ${id} not found`);
      return JSON.stringify([{ id, title: 'Foreign work', status: 'open', notes: bead.notes ?? '' }]);
    }
    if (command === 'update') {
      const index = args.indexOf('--append-notes');
      beads[id!] = { notes: `${beads[id!]!.notes ?? ''}${args[index + 1]}` };
      return '';
    }
    throw new Error(`unexpected bd command ${command}`);
  };
}

async function cook(store: InMemoryDoltClient, projectIdentifier?: string): Promise<void> {
  await store.insertMoleculeRoot({
    id: ROOT, formulaName: 'implement-fix', title: '[implement-fix] root',
    motivatingBeadId: WORK_BEAD, ...(projectIdentifier ? { projectIdentifier } : {}),
  });
  await store.insertMoleculeStep({
    id: `${ROOT}-coder`, parentRootId: ROOT, stepName: 'coder', title: 'coder',
    dependsOnStepIds: [], inputPayload: { input: 'go' },
  });
  await store.markStepDone(`${ROOT}-coder`, { output: 'opened project pull request' });
}

function complete(bus: EventBus): void {
  bus.emit({ layer: 'dispatcher', kind: 'dispatcher/formula.completed', molecule_id: ROOT, payload: { moleculeId: ROOT } });
}

function row(id: string): BeadRow {
  return { id, title: 'Work', description: '', status: 'open', priority: 2, issue_type: 'task', created_at: new Date(), updated_at: new Date(), closed_at: null, metadata: {} };
}

describe('cross-project writeback', () => {
  it('records the run project on the molecule root', async () => {
    const store = new InMemoryDoltClient();
    await cook(store, 'other');
    const exec = (await store.getBead(ROOT))!.metadata.exec as Record<string, unknown>;
    expect(exec['projectIdentifier']).toBe('other');
  });

  it('writes to the project bd before stamping the engine root', async () => {
    const store = new InMemoryDoltClient();
    await cook(store, 'other');
    const beads = { [WORK_BEAD]: {} as { notes?: string } };
    const order: string[] = [];
    const bd = fakeBd(beads, order);
    const bus = new EventBus({ noPersist: true });
    const rootStore = {
      getBead: async (id: string) => store.getBead(id),
      appendNoteToBead: async (id: string, note: string) => { order.push('home:append'); await store.appendNoteToBead(id, note); },
      recordMoleculeWriteback: async (id: string, status: 'completed' | 'failed' | 'interrupted') => {
        order.push('home:stamp'); return store.recordMoleculeWriteback(id, status);
      },
    };
    installWritebackHook({
      bus, walker: new MoleculeWalker(store), store: rootStore,
      projectBindings: (project) => ({ workBeads: project === 'other' ? createBdProjectBeadStore(bd) : null } as never),
    });
    complete(bus);
    await SETTLE(); await SETTLE();
    expect(beads[WORK_BEAD]!.notes).toContain('formula implement-fix completed');
    expect(order.indexOf('bd:update')).toBeLessThan(order.indexOf('home:stamp'));
    expect(order).not.toContain('home:append');
    expect((await store.getBead(ROOT))!.metadata.exec).toMatchObject({ writeback_status: 'completed' });
  });

  it('leaves the root unstamped when the project tracker is unreachable', async () => {
    const store = new InMemoryDoltClient();
    await cook(store, 'other');
    const bus = new EventBus({ noPersist: true });
    const logger = { warn: vi.fn(), info: vi.fn() };
    installWritebackHook({
      bus, walker: new MoleculeWalker(store), store, logger,
      projectBindings: () => ({ workBeads: createBdProjectBeadStore(fakeBd({ [WORK_BEAD]: {} }, [], 'database is locked')) } as never),
    });
    complete(bus);
    await SETTLE(); await SETTLE();
    expect(logger.warn).toHaveBeenCalled();
    expect(((await store.getBead(ROOT))!.metadata.exec as Record<string, unknown>)['writeback_status']).toBeUndefined();
  });

  it('treats only bd exact bead-not-found output as a missing bead', async () => {
    expect(await createBdProjectBeadStore(fakeBd({}, [])).getBead(WORK_BEAD)).toBeNull();
    await expect(createBdProjectBeadStore(fakeBd({}, [], 'database not found')).getBead(WORK_BEAD)).rejects.toThrow('database not found');
    await expect(createBdProjectBeadStore(async () => '[]').getBead(WORK_BEAD)).rejects.toThrow('invalid bead response');
    await expect(createBdProjectBeadStore(async () => '[{"id":"different-id"}]').getBead(WORK_BEAD)).rejects.toThrow('mismatched bead id');
    await expect(createBdProjectBeadStore(async () => '[{"title":"missing id"}]').getBead(WORK_BEAD)).rejects.toThrow('mismatched bead id');
  });

  it('uses the engine store for runs without a project and for the home project', async () => {
    for (const project of [undefined, 'home']) {
      const store = new InMemoryDoltClient();
      store.beads.set(WORK_BEAD, row(WORK_BEAD));
      await cook(store, project);
      const resolver = vi.fn(() => ({ workBeads: null } as never));
      const bus = new EventBus({ noPersist: true });
      installWritebackHook({ bus, walker: new MoleculeWalker(store), store, projectBindings: resolver });
      complete(bus);
      await SETTLE(); await SETTLE();
      expect(resolver).toHaveBeenCalledWith(project);
      expect(store.notes.map((note) => note.beadId)).toEqual([WORK_BEAD]);
    }
  });

  it('does not fall back to home when the project binding is unknown', async () => {
    const store = new InMemoryDoltClient();
    store.beads.set(WORK_BEAD, row(WORK_BEAD));
    await cook(store, 'ghost');
    const bus = new EventBus({ noPersist: true });
    const logger = { warn: vi.fn(), info: vi.fn() };
    installWritebackHook({ bus, walker: new MoleculeWalker(store), store, logger, projectBindings: () => { throw new Error('unknown project ghost'); } });
    complete(bus);
    await SETTLE(); await SETTLE();
    expect(logger.warn).toHaveBeenCalled();
    expect(store.notes).toEqual([]);
    expect(((await store.getBead(ROOT))!.metadata.exec as Record<string, unknown>)['writeback_status']).toBeUndefined();
  });
});
