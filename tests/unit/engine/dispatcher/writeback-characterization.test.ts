/**
 * Characterisation tests for the writeback hook (vibesync-ji3w), written BEFORE
 * refactoring src/engine/dispatcher/writeback-hook.ts (handleEvent cc 15,
 * buildFailedNote bumps 2). They pin the exact note text and the paths the
 * existing writeback tests never take: an interrupted run's note, the event's
 * error used when no step failed, step roles taken from a title, and how a
 * step's output is excerpted.
 */
import { describe, expect, it } from 'vitest';

import { installWritebackHook, type WritebackAction } from '../../../../src/engine/dispatcher/writeback-hook.js';
import { EventBus } from '../../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import { INTERRUPTED_EVENT } from '../../../../src/engine/molecule/recovery.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import type { BeadRow } from '../../../../src/engine/store/index.js';

const WHEN = new Date('2026-05-21T12:34:56Z');
const MOTIVATING = 'p-task';

function bead(id: string, over: Partial<BeadRow> = {}): BeadRow {
  return { id, title: id, description: '', status: 'open', priority: 2, issue_type: 'task', created_at: new Date(0), updated_at: new Date(0), closed_at: null, metadata: {}, ...over } as BeadRow;
}

async function setup(opts: { formulaName?: string | null; motivating?: string | null } = {}) {
  const store = new InMemoryDoltClient();
  store.beads.set(MOTIVATING, bead(MOTIVATING));
  const rootId = 'p-mol-1';
  await store.insertMoleculeRoot({ id: rootId, formulaName: 'onboard', title: 'root', ...(opts.motivating === null ? {} : { motivatingBeadId: opts.motivating ?? MOTIVATING }) });
  if (opts.formulaName === null) {
    const root = store.beads.get(rootId)!;
    const exec = { ...(root.metadata.exec as Record<string, unknown>) };
    delete exec['formula'];
    store.beads.set(rootId, { ...root, metadata: { ...root.metadata, exec } });
  }
  const walker = new MoleculeWalker(store as never);
  const bus = new EventBus({ noPersist: true });
  const actions: WritebackAction[] = [];
  installWritebackHook({ bus, walker, store, now: () => WHEN, logger: { info: (o: { action?: WritebackAction }) => { if (o?.action) actions.push(o.action); }, warn: () => undefined } as never });
  let seq = 0;
  /** A step created at a fixed time so steps sort in insertion order. */
  const step = async (name: string, over: { output?: unknown; error?: string; title?: string; noName?: boolean } = {}) => {
    const id = `${rootId}-${name}`;
    await store.insertMoleculeStep({ id, parentRootId: rootId, stepName: name, title: over.title ?? `[formula:onboard/step:${name}] ${name}`, dependsOnStepIds: [] });
    if (over.error !== undefined) await store.markStepFailed(id, over.error);
    else if (over.output !== undefined) await store.markStepDone(id, over.output);
    const row = store.beads.get(id)!;
    const meta = { ...row.metadata, exec: { ...(row.metadata.exec as Record<string, unknown>) } } as Record<string, unknown> & { exec: Record<string, unknown> };
    if (over.noName) delete meta.exec['step'];
    store.beads.set(id, { ...row, created_at: new Date(1000 + seq++), metadata: meta });
  };
  /** `moleculeId: null` emits an event with no molecule id (a default parameter would turn undefined into rootId). */
  const emit = async (kind: string, payload: Record<string, unknown> = {}, moleculeId: string | null = rootId) => {
    bus.emit({ layer: 'dispatcher', kind, ...(moleculeId ? { molecule_id: moleculeId } : {}), payload: { ...(moleculeId ? { moleculeId } : {}), ...payload } });
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { store, rootId, step, emit, actions };
}

describe('which bead gets the note', () => {
  it('the motivating bead named on the event wins over the one stored on the run', async () => {
    const h = await setup();
    h.store.beads.set('p-from-event', bead('p-from-event'));
    await h.emit('dispatcher/formula.completed', { motivating_bead: 'p-from-event' });
    expect(h.store.notes.map((n) => n.beadId)).toEqual(['p-from-event']);
  });
});

describe('the note text', () => {
  it('completed: the header, the molecule, then each step in creation order with its output', async () => {
    const h = await setup();
    await h.step('mayor', { output: { output: 'plan' } });
    await h.step('coder', { output: 'diff' });
    await h.emit('dispatcher/formula.completed');
    expect(h.store.notes.map((n) => n.note)).toEqual([
      `[vibesync] formula onboard completed at ${WHEN.toISOString()}\nmoleculeId: ${h.rootId}\n- mayor: plan\n- coder: diff`,
    ]);
  });

  it('interrupted: says the run was closed and re-run, and lists only the steps that finished cleanly', async () => {
    const h = await setup();
    await h.step('mayor', { output: 'plan' });
    await h.step('coder', { error: 'killed' });
    await h.step('tester');
    await h.emit(INTERRUPTED_EVENT);
    const note = h.store.notes[0]!.note;
    expect(note).toBe([
      `[vibesync] formula onboard INTERRUPTED at ${WHEN.toISOString()}`,
      `moleculeId: ${h.rootId}`,
      'vibesync restarted while this run was in progress; the molecule is closed and the work is re-run.',
      '- mayor (finished before restart): plan',
    ].join('\n'));
  });

  it('failed with a failing step: names it and its error, then the steps that finished cleanly', async () => {
    const h = await setup();
    await h.step('mayor', { output: 'plan' });
    await h.step('coder', { error: 'tests red' });
    await h.emit('dispatcher/formula.failed', { error: 'ignored when a step failed' });
    expect(h.store.notes[0]!.note).toBe([
      `[vibesync] formula onboard FAILED at ${WHEN.toISOString()}`,
      `moleculeId: ${h.rootId}`,
      'failing step: coder',
      'error: tests red',
      '- mayor: plan',
    ].join('\n'));
  });

  it('failed with no failing step: the error comes from the event', async () => {
    const h = await setup();
    await h.step('mayor', { output: 'plan' });
    await h.emit('dispatcher/formula.failed', { error: 'dispatch refused' });
    expect(h.store.notes[0]!.note).toContain('\nerror: dispatch refused\n');
    expect(h.store.notes[0]!.note).not.toContain('failing step:');
  });

  it('failed with no failing step and no error anywhere: no error line', async () => {
    const h = await setup();
    await h.emit('dispatcher/formula.failed');
    expect(h.store.notes[0]!.note).toBe(`[vibesync] formula onboard FAILED at ${WHEN.toISOString()}\nmoleculeId: ${h.rootId}`);
  });

  it('a formula with no recorded name is reported as "unknown"', async () => {
    const h = await setup({ formulaName: null });
    await h.emit('dispatcher/formula.completed');
    expect(h.store.notes[0]!.note.split('\n')[0]).toBe(`[vibesync] formula unknown completed at ${WHEN.toISOString()}`);
  });
});

describe('step roles and output excerpts', () => {
  it('a step with no recorded name takes its role from the end of its title, else its id', async () => {
    const h = await setup();
    await h.step('a', { output: 'x', noName: true, title: '[formula:onboard/step:a] reviewer' });
    await h.step('b', { output: 'y', noName: true, title: 'no bracket here' });
    await h.emit('dispatcher/formula.completed');
    const lines = h.store.notes[0]!.note.split('\n');
    expect(lines).toContain('- reviewer: x');
    expect(lines).toContain(`- ${h.rootId}-b: y`);
  });

  it('an output is a string, an object\'s "output" field, other objects as JSON, or "(no output)"; whitespace collapses and long text is cut at 400 with an ellipsis', async () => {
    const h = await setup();
    await h.step('a', { output: { output: '  spaced\n\nout  ' } });
    await h.step('b', { output: { score: 3 } });
    await h.step('c', { output: 0 });
    await h.step('d', { output: 'x'.repeat(450) });
    await h.step('e', { output: 7 });
    await h.emit('dispatcher/formula.completed');
    const lines = h.store.notes[0]!.note.split('\n');
    expect(lines).toContain('- a: spaced out');
    expect(lines).toContain('- b: {"score":3}');
    expect(lines).toContain('- c: (no output)');
    expect(lines).toContain(`- d: ${'x'.repeat(400)}…`);
    expect(lines).toContain('- e: 7');
  });

  it('a failing step\'s error is cut at 400 characters', async () => {
    const h = await setup();
    await h.step('coder', { error: 'e'.repeat(450) });
    await h.emit('dispatcher/formula.failed');
    expect(h.store.notes[0]!.note).toContain(`\nerror: ${'e'.repeat(400)}`);
    expect(h.store.notes[0]!.note).not.toContain('e'.repeat(401));
  });
});

describe('what each event does', () => {
  it('an event without a molecule id, and one for a molecule that is gone, write nothing and say why', async () => {
    const h = await setup();
    await h.emit('dispatcher/formula.completed', {}, null);
    await h.emit('dispatcher/formula.completed', {}, 'p-mol-gone');
    expect(h.store.notes).toEqual([]);
    expect(h.actions).toEqual(['skipped-no-molecule-id', 'skipped-molecule-not-found']);
  });

  it('a completed run that was already written as failed still writes its completion (the stamp is per status)', async () => {
    const h = await setup();
    await h.step('mayor', { output: 'plan' });
    await h.emit('dispatcher/formula.failed', { error: 'first' });
    await h.emit('dispatcher/formula.completed');
    expect(h.store.notes).toHaveLength(2);
    expect(h.actions).toEqual(['posted', 'posted']);
  });
});
