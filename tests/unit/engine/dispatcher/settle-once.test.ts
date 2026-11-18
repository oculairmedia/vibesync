/**
 * When a run may be settled (its run() caller told, its root closed).
 *
 * MoleculeSettler.settleMolecule settles a run only when none of its turns is
 * in flight. That rule predates vibesync-6zos.3 and had no test: removing it
 * left the whole unit suite green (found by mutation while restructuring the
 * condition). These pin it by what goes wrong without it.
 *
 * NOT pinned here, on purpose: the `finalized` checks in settlement.ts ("has
 * this run settled already?"). No sequence through the dispatcher reaches them.
 * A turn settles its run only when it is the last one in flight, so two
 * settlements are never inside the tracker read together (measured: with two
 * steps finishing in the same tick, "is every step closed?" is asked once), and
 * a turn that returns after cancel() gave up waiting is covered by the in-flight
 * rule. They are a second line of defence; removing them leaves every test
 * green, and that is a statement about reachability, not about coverage.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const formula = (names: readonly string[]): Formula => ({
  name: 'settle-once', description: 'Settle once', whenToUse: '',
  steps: names.map((name) => ({ name, role: name, promptTemplate: 'prompts/worker.md', waitFor: 'completion' as const })),
});

function pack(names: readonly string[]): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-settle-once-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts/worker.md'), 'Run ${input}');
  return {
    manifest: { name: 'test-pack', version: '1.0.0' }, root, scope: 'project',
    roles: names.map((name) => ({ name, memoryBlocks: [{ label: 'persona', value: `${name} persona`, limit: 1000 }] })),
    formulas: [],
  };
}

async function until(predicate: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`condition was not met: ${what}`);
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** Two steps side by side: `left` fails as soon as it is released, `right` replies when it is released. */
function harness(cancelUnwindMs?: number, stopNeverSettles = false) {
  const store = new InMemoryDoltClient();
  const gates = { left: () => {}, right: () => {} };
  const waits = {
    left: new Promise<void>((resolve) => { gates.left = resolve; }),
    right: new Promise<void>((resolve) => { gates.right = resolve; }),
  };
  const provider = newFakeProvider({
    kind: 'fake-runtime',
    script: (spec) => (async function* (): AsyncIterable<SessionEvent> {
      const ts = new Date().toISOString();
      yield { kind: 'started', ts };
      await waits[spec.role as 'left' | 'right'];
      if (spec.role === 'left') yield { kind: 'error', ts, code: 'fake-error', message: 'left failed' };
      else yield { kind: 'message-delta', ts, text: 'right done' };
      yield { kind: 'turn-done', ts };
    })(),
  });
  if (stopNeverSettles) provider.stop = () => new Promise<void>(() => undefined);
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((event) => events.push(event));
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus, maxParallelSteps: 2,
    ...(cancelUnwindMs !== undefined ? { cancelUnwindMs } : {}),
  });
  return { store, provider, events, dispatcher, gates };
}

describe('a run settles once, and only when none of its turns is in flight', () => {
  it('a failed step does not end the run while a sibling turn is still in flight: the caller is told after that turn returns', async () => {
    const h = harness();
    let moleculeId = '';
    let told: 'pending' | 'rejected' | 'resolved' = 'pending';
    const pending = h.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const watched = pending.then(() => { told = 'resolved'; }, () => { told = 'rejected'; });
    await until(() => h.provider.recorder.starts.length === 2, 'both turns started');
    const left = newMoleculeStepId(moleculeId, 'left');
    const right = newMoleculeStepId(moleculeId, 'right');

    h.gates.left(); // `left` fails
    await until(async () => (await h.store.getBead(left))?.status === 'closed', 'left recorded as failed');
    await settle();

    // `right` is still running: the run is not over.
    expect(told).toBe('pending');
    expect((await h.store.getBead(moleculeId))?.status, 'the root stays open while a turn is in flight').not.toBe('closed');
    expect((await h.store.getBead(right))?.status).toBe('in_progress');
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.failed')).toEqual([]);

    h.gates.right(); // `right` finishes
    await watched;
    await settle();

    expect(told).toBe('rejected');
    const root = await h.store.getBead(moleculeId);
    expect(root?.status).toBe('closed');
    expect((root?.metadata['exec'] as Record<string, unknown>)['outcome']).toBe('failed');
    // The sibling's result was written before the run closed: it is not lost and not overwritten.
    const rightBead = await h.store.getBead(right);
    expect(rightBead?.status).toBe('closed');
    expect((rightBead?.metadata['exec'] as Record<string, unknown>)['output_payload']).toBeDefined();
    expect((rightBead?.metadata['close_reason'] as string | undefined) ?? '').not.toBe('run failed');
  });

  it('a run is settled exactly once: one terminal event, one root close, however many turns return after it', async () => {
    const h = harness();
    const closes: string[] = [];
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => { closes.push(outcome); return markRoot(rootId, status, outcome); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => h.provider.recorder.starts.length === 2, 'both turns started');

    // Both turns return in the same tick: each one's return calls settleMolecule.
    h.gates.left();
    h.gates.right();
    await pending.catch(() => undefined);
    await settle();

    expect(closes).toEqual(['failed']);
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.failed')).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.completed')).toEqual([]);
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
  });

  it('a turn that returns after the run has already settled does not settle it again', async () => {
    // The one way a run reaches settleMolecule after it settled: cancel()'s wait runs out with a turn
    // still out, the run settles, and the turn (which holds its run for the whole turn) returns later.
    const h = harness(150, true);
    const closes: string[] = [];
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => { closes.push(outcome); return markRoot(rootId, status, outcome); };
    let moleculeId = '';
    let told = 0;
    const pending = h.dispatcher.run({ formula: formula(['right']), pack: pack(['right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.then(() => { told++; }, () => { told++; });
    const right = () => newMoleculeStepId(moleculeId, 'right');
    await until(async () => moleculeId !== '' && (await h.store.getBead(right()))?.status === 'in_progress', 'right in progress');

    await h.dispatcher.cancel(moleculeId); // gives up waiting after 150 ms, records the step, closes the root
    await settle();
    expect(closes).toEqual(['cancelled']);
    expect(h.events.filter((event) => event.kind === 'dispatcher/cancel.unwind_timeout')).toHaveLength(1);
    // A turn outlived the wait: the caller is told when that turn is back, not before.
    expect(told).toBe(0);
    expect(h.dispatcher.liveMoleculeIds()).toContain(moleculeId);

    h.gates.right(); // the turn comes back
    await pending.catch(() => undefined);
    await settle();

    expect(told).toBe(1);
    expect(closes).toEqual(['cancelled']); // the root was not closed a second time
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
    expect(h.events.filter((event) => /^dispatcher\/formula\.(failed|completed|cancelled)$/.test(event.kind)).map((event) => event.kind)).toEqual(['dispatcher/formula.cancelled']);
    expect((await h.store.getBead(right()))?.status).toBe('closed');
  });

});
