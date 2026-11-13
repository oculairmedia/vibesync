/**
 * Characterisation tests for the durable-wait watcher (vibesync-9lzk.59), written
 * BEFORE refactoring it (deliver cc 18, pass cc 14). The real-bd waits suite
 * covers its main paths; these pin the branches it never takes, against an
 * in-memory store and sink.
 */
import { describe, expect, it } from 'vitest';

import type { WaitRecord, WaitStore, WakeRequest } from '../../../../src/engine/waits/types.js';
import { WaitWatcher } from '../../../../src/engine/waits/watcher.js';

const NOW = new Date('2026-11-13T12:00:00Z');

function wait(over: Partial<WaitRecord> = {}): WaitRecord {
  return { id: 'w-1', mode: 'any', on: ['b-1'], waiter: { kind: 'bead', id: 'x-1' }, state: 'pending', wakeAttempts: 0, beadStatus: 'open', ...over } as WaitRecord;
}

/** An in-memory store: `get` can return a different record than `listActive` (a change between the two reads). */
function memoryStore(active: WaitRecord[], opts: { statuses?: Record<string, string>; getOverride?: (id: string) => WaitRecord | null } = {}) {
  const records = new Map(active.map((w) => [w.id, w]));
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const closes: { id: string; reason: string }[] = [];
  const store: WaitStore = {
    create: async () => 'w-new',
    listActive: async () => [...records.values()],
    get: async (id) => (opts.getOverride ? opts.getOverride(id) : records.get(id) ?? null),
    beadStatuses: async (ids) => new Map(ids.map((id) => [id, opts.statuses?.[id] ?? 'open'] as [string, string]).filter(([id]) => opts.statuses?.[id] !== '__missing')),
    patch: async (id, patch) => { patches.push({ id, patch: { ...patch } }); const r = records.get(id); if (r) records.set(id, { ...r, ...(patch as Partial<WaitRecord>) }); },
    close: async (id, reason) => { closes.push({ id, reason }); records.delete(id); },
    blockWaiter: async () => undefined,
  };
  return { store, patches, closes };
}

const sinkOk = () => { const woken: WakeRequest[] = []; return { woken, sink: { wake: (r: WakeRequest) => { woken.push(r); } } }; };

describe('one pass over the active waits', () => {
  it('a wait canceled between the listing and the re-read is left alone and not counted as open', async () => {
    const { store, patches } = memoryStore([wait()], { statuses: { 'b-1': 'closed' }, getOverride: () => wait({ state: 'canceled' }) });
    const report = await new WaitWatcher({ store, sink: sinkOk().sink, now: () => NOW }).reconcile();
    expect(patches).toEqual([]);
    expect(report.stillOpen).toBe(0);
  });

  it('a wait already moved on (not pending, not canceled) at the re-read counts as still open', async () => {
    const { store } = memoryStore([wait()], { statuses: { 'b-1': 'closed' }, getOverride: () => wait({ state: 'ready' }) });
    expect((await new WaitWatcher({ store, sink: sinkOk().sink, now: () => NOW }).reconcile()).stillOpen).toBe(1);
  });

  it('a wait that vanished at the re-read is skipped', async () => {
    const { store } = memoryStore([wait()], { statuses: { 'b-1': 'closed' }, getOverride: () => null });
    expect((await new WaitWatcher({ store, sink: sinkOk().sink, now: () => NOW }).reconcile()).stillOpen).toBe(0);
  });

  it('a canceled wait is closed with its reason, or "canceled" when it has none', async () => {
    const { store, closes } = memoryStore([wait({ id: 'w-a', state: 'canceled', reason: 'user stopped it' }), wait({ id: 'w-b', state: 'canceled' })]);
    await new WaitWatcher({ store, sink: sinkOk().sink, now: () => NOW }).reconcile();
    expect(closes).toEqual([{ id: 'w-a', reason: 'user stopped it' }, { id: 'w-b', reason: 'canceled' }]);
  });

  it('a wait already marked closed is closed, not woken again', async () => {
    const { store, closes } = memoryStore([wait({ state: 'closed' })]);
    const { woken, sink } = sinkOk();
    await new WaitWatcher({ store, sink, now: () => NOW }).reconcile();
    expect(woken).toEqual([]);
    expect(closes).toEqual([{ id: 'w-1', reason: 'condition met; waiter woken' }]);
  });

  it('an expired or failed wait is delivered with its outcome, and closed as "<outcome>; waiter notified"', async () => {
    const { store, closes, patches } = memoryStore([wait({ id: 'w-e', state: 'expired' }), wait({ id: 'w-f', state: 'failed', reason: 'gone' })]);
    const { woken, sink } = sinkOk();
    const report = await new WaitWatcher({ store, sink, now: () => NOW }).reconcile();
    expect(woken.map((r) => [r.waitId, r.outcome])).toEqual([['w-e', 'expired'], ['w-f', 'failed']]);
    expect(woken[1]!.reason).toBe('gone');
    expect(woken[0]!.reason).toMatch(/expired$/);
    expect(closes).toEqual([{ id: 'w-e', reason: 'expired; waiter notified' }, { id: 'w-f', reason: 'failed; waiter notified' }]);
    // Only a ready wait is re-marked closed; expired and failed keep their state.
    expect(patches.every((p) => !('state' in p.patch))).toBe(true);
    expect(report.woken).toEqual(['w-e', 'w-f']);
  });

  it('a rejected wake counts an attempt; at the limit the wait is marked failed and closed', async () => {
    const { store, patches, closes } = memoryStore([wait({ state: 'ready', wakeAttempts: 1 })]);
    const sink = { wake: () => { throw new Error('sink down'); } };
    const watcher = new WaitWatcher({ store, sink, now: () => NOW, maxWakeAttempts: 3 });
    await watcher.reconcile();
    expect(patches).toEqual([{ id: 'w-1', patch: { wakeAttempts: 2 } }]);
    expect(closes).toEqual([]);
    await watcher.reconcile();
    expect(patches.at(-1)).toEqual({ id: 'w-1', patch: { state: 'failed', wakeAttempts: 3, reason: 'wake undeliverable after 3 attempts: sink down' } });
    expect(closes).toEqual([{ id: 'w-1', reason: 'wake undeliverable' }]);
  });

  it('an error that is not an Error is reported by its string form, and the wait counts as still open', async () => {
    const { store } = memoryStore([wait({ state: 'ready' })]);
    store.close = async () => { throw 'disk full'; };
    const report = await new WaitWatcher({ store, sink: sinkOk().sink, now: () => NOW }).reconcile();
    expect(report.errors).toEqual(['w-1: disk full']);
    expect(report.stillOpen).toBe(1);
  });
});

describe('starting and stopping', () => {
  it('start twice subscribes and arms its timer once', async () => {
    let subscriptions = 0;
    const bus = { emit: () => undefined, subscribe: () => { subscriptions += 1; return () => undefined; } };
    const { store } = memoryStore([]);
    const watcher = new WaitWatcher({ store, sink: sinkOk().sink, bus: bus as never, reconcileIntervalMs: 60_000 });
    watcher.start();
    watcher.start();
    expect(subscriptions).toBe(1);
    await watcher.stop();
  });

  it('a stopped watcher ignores reconcile requests', async () => {
    let listed = 0;
    const { store } = memoryStore([]);
    const counted = { ...store, listActive: async () => { listed += 1; return []; } };
    const watcher = new WaitWatcher({ store: counted, sink: sinkOk().sink, reconcileIntervalMs: 0 });
    await watcher.stop();
    watcher.requestReconcile();
    await new Promise((r) => setTimeout(r, 10));
    expect(listed).toBe(0);
  });

  it('with no interval configured it still reconciles once at start, and arms no timer', async () => {
    let listed = 0;
    const { store } = memoryStore([]);
    const counted = { ...store, listActive: async () => { listed += 1; return []; } };
    const watcher = new WaitWatcher({ store: counted, sink: sinkOk().sink, reconcileIntervalMs: 0 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(listed).toBe(1);
    await watcher.stop();
  });
});
