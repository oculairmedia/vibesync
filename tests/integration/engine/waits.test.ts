/**
 * vibesync-9g24 — durable wait-on-beads against a REAL, isolated bd repo.
 *
 * Opt-in (like the other isolated-bd suites):
 *   VIBESYNC_TEST_BD_WAITS=/absolute/path/to/bd(>=1.3.2) npx vitest run tests/integration/engine/waits.test.ts
 *
 * No fake store anywhere in this file: every state transition goes through the
 * real BdWaitStore -> bd CLI -> a disposable Dolt database. The false pass this
 * suite guards against is a wait implemented as a timer, so:
 *   - waits are satisfied by closing beads, never by time passing, and
 *   - one test lets real time pass with the beads open and asserts NO wake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventBus } from '../../../src/engine/events/index.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../../../src/engine/scheduler/index.js';
import {
  BdWaitStore,
  WAIT_READY_EVENT,
  WaitService,
  WaitWatcher,
  type WaitWakeSink,
  type WakeRequest,
} from '../../../src/engine/waits/index.js';
import { RUN_ISOLATED_WAITS, provisionIsolatedWaitRepo, type IsolatedWaitRepo } from './isolated-bd-waits.js';

function recordingSink(opts: { failTimes?: number } = {}) {
  const wakes: WakeRequest[] = [];
  let failures = opts.failTimes ?? 0;
  const sink: WaitWakeSink = {
    wake(request) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('sink down');
      }
      wakes.push(request);
    },
  };
  return { sink, wakes };
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!RUN_ISOLATED_WAITS)('durable waits on a real isolated bd repo (vibesync-9g24)', () => {
  let repo: IsolatedWaitRepo;

  beforeAll(async () => {
    repo = await provisionIsolatedWaitRepo();
  }, 120_000);

  afterAll(async () => {
    await repo?.teardown();
  }, 60_000);

  const services = () => {
    const store = new BdWaitStore(repo.runner);
    return { store, service: new WaitService({ store }) };
  };
  const watcherFor = (sink: WaitWakeSink, extra: Partial<ConstructorParameters<typeof WaitWatcher>[0]> = {}) =>
    new WaitWatcher({ store: new BdWaitStore(repo.runner), sink, reconcileIntervalMs: 0, ...extra });

  it('1. all: ready only after BOTH named beads close', async () => {
    const a = await repo.create('all-a');
    const b = await repo.create('all-b');
    const { service } = services();
    const waitId = await service.create({ on: [a, b], mode: 'all', note: 'both done', waiter: { kind: 'agent', id: 'agent-1' } });
    const { sink, wakes } = recordingSink();
    const watcher = watcherFor(sink);

    expect((await watcher.reconcile()).woken).toEqual([]);
    await repo.close(a);
    expect((await watcher.reconcile()).woken).toEqual([]);
    expect(wakes).toHaveLength(0);
    expect((await service.get(waitId))?.state).toBe('pending');

    await repo.close(b);
    const report = await watcher.reconcile();
    expect(report.woken).toEqual([waitId]);
    expect(wakes).toHaveLength(1);
    const after = await service.get(waitId);
    expect(after?.state).toBe('closed');
    expect(after?.beadStatus).toBe('closed');
  }, 120_000);

  it('2. any: ready after the FIRST named bead closes', async () => {
    const a = await repo.create('any-a');
    const b = await repo.create('any-b');
    const { service } = services();
    const waitId = await service.create({ on: [a, b], mode: 'any', waiter: { kind: 'agent', id: 'agent-2' } });
    const { sink, wakes } = recordingSink();
    const watcher = watcherFor(sink);

    await watcher.reconcile();
    expect(wakes).toHaveLength(0);
    await repo.close(b);
    await watcher.reconcile();
    expect(wakes.map((w) => w.waitId)).toEqual([waitId]);
    // The second bead closing later must not wake again.
    await repo.close(a);
    await watcher.reconcile();
    expect(wakes).toHaveLength(1);
  }, 120_000);

  it('3. restart mid-wait: a FRESH watcher + store continues; exactly one wake, none lost, none duplicated', async () => {
    const a = await repo.create('restart-a');
    const b = await repo.create('restart-b');
    const first = services();
    const waitId = await first.service.create({ on: [a, b], mode: 'all', note: 'resume me', waiter: { kind: 'agent', id: 'agent-3' } });

    const sinkBefore = recordingSink();
    const watcherBefore = watcherFor(sinkBefore.sink);
    await repo.close(a);
    await watcherBefore.reconcile();
    expect(sinkBefore.wakes).toHaveLength(0);
    await watcherBefore.stop();
    // "Process dies": nothing from watcherBefore / first.* is reused below.

    await repo.close(b);
    const sinkAfter = recordingSink();
    const watcherAfter = watcherFor(sinkAfter.sink, { store: new BdWaitStore(repo.runner) });
    await watcherAfter.reconcile();
    expect(sinkAfter.wakes.map((w) => w.waitId)).toEqual([waitId]);

    // A second reconcile, and a third process, must not wake again.
    await watcherAfter.reconcile();
    const sinkThird = recordingSink();
    await watcherFor(sinkThird.sink).reconcile();
    expect(sinkAfter.wakes).toHaveLength(1);
    expect(sinkThird.wakes).toHaveLength(0);
    expect(sinkBefore.wakes).toHaveLength(0);
  }, 180_000);

  it('3b. a wake the sink rejects is retried by the next pass (not lost), then delivered once', async () => {
    const a = await repo.create('retry-a');
    const { service } = services();
    const waitId = await service.create({ on: [a], note: 'retry me', waiter: { kind: 'agent', id: 'agent-3b' } });
    await repo.close(a);
    const { sink, wakes } = recordingSink({ failTimes: 1 });
    const watcher = watcherFor(sink);

    const first = await watcher.reconcile();
    expect(first.woken).toEqual([]);
    expect(wakes).toHaveLength(0);
    expect((await service.get(waitId))?.state).toBe('ready'); // resolved, wake still owed

    const second = await watcher.reconcile();
    expect(second.woken).toEqual([waitId]);
    expect(wakes).toHaveLength(1);
    await watcher.reconcile();
    expect(wakes).toHaveLength(1);
  }, 120_000);

  it('3c. a crash between "sink accepted" and "bead closed" re-delivers ONCE on restart (at-least-once, same waitId)', async () => {
    const a = await repo.create('crash-a');
    const { service } = services();
    const waitId = await service.create({ on: [a], note: 'crashy', waiter: { kind: 'agent', id: 'agent-3c' } });
    await repo.close(a);

    const real = new BdWaitStore(repo.runner);
    let crashed = false;
    const crashingStore = Object.create(real) as BdWaitStore;
    crashingStore.close = async (id, reason) => {
      if (id === waitId && !crashed) {
        crashed = true;
        throw new Error('process died before close');
      }
      return real.close(id, reason);
    };
    const s1 = recordingSink();
    await new WaitWatcher({ store: crashingStore, sink: s1.sink, reconcileIntervalMs: 0 }).reconcile();
    expect(s1.wakes).toHaveLength(1);

    const s2 = recordingSink();
    await watcherFor(s2.sink).reconcile();
    expect(s2.wakes.map((w) => w.waitId)).toEqual([waitId]); // documented residual window
    const s3 = recordingSink();
    await watcherFor(s3.sink).reconcile();
    expect(s3.wakes).toHaveLength(0);
  }, 120_000);

  it('4. the note reaches the sink as the wake reason; a missing note gets a generated sentence', async () => {
    const a = await repo.create('note-a');
    const b = await repo.create('note-b');
    const { service } = services();
    const noted = await service.create({ on: [a], note: 'review comments are in; resume the loop', waiter: { kind: 'session', id: 'sess-1' } });
    const bare = await service.create({ on: [b], waiter: { kind: 'session', id: 'sess-2' } });
    await repo.close(a);
    await repo.close(b);
    const { sink, wakes } = recordingSink();
    await watcherFor(sink).reconcile();

    const w1 = wakes.find((w) => w.waitId === noted)!;
    expect(w1.reason).toBe('review comments are in; resume the loop');
    expect(w1.note).toBe('review comments are in; resume the loop');
    expect(w1.waiter).toEqual({ kind: 'session', id: 'sess-1' });
    expect(w1.outcome).toBe('ready');
    const w2 = wakes.find((w) => w.waitId === bare)!;
    expect(w2.note).toBeUndefined();
    expect(w2.reason).toContain(bare);
  }, 120_000);

  it('5a. canceled: no wake, the wait bead is closed, and a later close of the named beads stays silent', async () => {
    const a = await repo.create('cancel-a');
    const { service } = services();
    const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-5' } });
    expect(await service.cancel(waitId, 'no longer needed')).toBe(true);
    expect(await service.cancel(waitId)).toBe(true); // idempotent
    const rec = await service.get(waitId);
    expect(rec?.state).toBe('canceled');
    expect(rec?.beadStatus).toBe('closed');

    await repo.close(a);
    const { sink, wakes } = recordingSink();
    await watcherFor(sink).reconcile();
    expect(wakes).toHaveLength(0);
  }, 120_000);

  it('5b. a wait that already resolved (ready, wake owed) is not cancelable', async () => {
    const a = await repo.create('cancel-late-a');
    const { service } = services();
    const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-5b' } });
    await repo.close(a);
    const { sink, wakes } = recordingSink({ failTimes: 1 });
    await watcherFor(sink).reconcile(); // resolves to ready, sink rejects once
    expect(await service.cancel(waitId)).toBe(false);
    await watcherFor(sink).reconcile();
    expect(wakes.map((w) => w.waitId)).toEqual([waitId]);
  }, 120_000);

  it('5c. expired: past timeoutMs with the beads still open -> expired wake; beads closing later stay silent', async () => {
    const a = await repo.create('expire-a');
    let nowMs = Date.now();
    const store = new BdWaitStore(repo.runner);
    const service = new WaitService({ store, now: () => new Date(nowMs) });
    const waitId = await service.create({ on: [a], note: 'give up', timeoutMs: 60_000, waiter: { kind: 'agent', id: 'agent-5c' } });
    const { sink, wakes } = recordingSink();
    const watcher = new WaitWatcher({ store, sink, reconcileIntervalMs: 0, now: () => new Date(nowMs) });

    await watcher.reconcile();
    expect(wakes).toHaveLength(0);
    nowMs += 61_000;
    await watcher.reconcile();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ waitId, outcome: 'expired' });
    expect(wakes[0]!.reason).toContain('expired');
    expect(wakes[0]!.reason).toContain('give up');
    const rec = await service.get(waitId);
    expect(rec?.state).toBe('expired');
    expect(rec?.beadStatus).toBe('closed');

    await repo.close(a);
    await watcher.reconcile();
    expect(wakes).toHaveLength(1);
  }, 120_000);

  it('5d. the deadline can only expire a wait: satisfied beats expired, and time alone never makes a wait ready', async () => {
    const a = await repo.create('sat-a');
    let nowMs = Date.now();
    const store = new BdWaitStore(repo.runner);
    const service = new WaitService({ store, now: () => new Date(nowMs) });
    const waitId = await service.create({ on: [a], timeoutMs: 1_000, waiter: { kind: 'agent', id: 'agent-5d' } });
    await repo.close(a);
    nowMs += 5_000;
    const { sink, wakes } = recordingSink();
    await new WaitWatcher({ store, sink, reconcileIntervalMs: 0, now: () => new Date(nowMs) }).reconcile();
    expect(wakes.map((w) => [w.waitId, w.outcome])).toEqual([[waitId, 'ready']]);
  }, 120_000);

  it('5e. a sink that never accepts: after maxWakeAttempts the wait closes failed (no endless retry)', async () => {
    const a = await repo.create('fail-a');
    const { service } = services();
    const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-5e' } });
    await repo.close(a);
    const { sink } = recordingSink({ failTimes: 99 });
    const watcher = watcherFor(sink, { maxWakeAttempts: 2 });
    await watcher.reconcile();
    await watcher.reconcile();
    const rec = await service.get(waitId);
    expect(rec?.state).toBe('failed');
    expect(rec?.beadStatus).toBe('closed');
    const again = await watcher.reconcile();
    expect(again.woken).toEqual([]);
  }, 120_000);

  it('6. FALSE-PASS guard: with the beads open, real time passing never wakes (no timer-driven wake)', async () => {
    const a = await repo.create('timer-a');
    const { service, store } = services();
    const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-6' } });
    const { sink, wakes } = recordingSink();
    const watcher = new WaitWatcher({ store, sink, reconcileIntervalMs: 40 });
    watcher.start();
    await sleepMs(1_200); // many interval passes
    expect(wakes).toHaveLength(0);
    expect((await service.get(waitId))?.state).toBe('pending');
    await repo.close(a);
    const deadline = Date.now() + 15_000;
    while (wakes.length === 0 && Date.now() < deadline) await sleepMs(50);
    await watcher.stop();
    expect(wakes.map((w) => w.waitId)).toEqual([waitId]);
  }, 120_000);

  it('7. bus hint: beads/issue.status_changed(to=closed) triggers a reconcile with the interval disabled; other transitions do not', async () => {
    const a = await repo.create('bus-a');
    const { service, store } = services();
    const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-7' } });
    const bus = new EventBus({ noPersist: true });
    const emitted: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === WAIT_READY_EVENT) emitted.push(String(e.payload?.['waitId']));
    });
    const { sink, wakes } = recordingSink();
    const watcher = new WaitWatcher({ store, sink, bus, reconcileIntervalMs: 0 });
    watcher.start();
    await watcher.reconcile(); // let the boot pass finish
    await repo.close(a);
    bus.emit({ layer: 'daemon', kind: BEADS_ISSUE_STATUS_CHANGED_EVENT, payload: { issueId: a, from: 'open', to: 'in_progress' } });
    await sleepMs(500);
    expect(wakes).toHaveLength(0); // in_progress is not a hint; interval is off
    bus.emit({ layer: 'daemon', kind: BEADS_ISSUE_STATUS_CHANGED_EVENT, payload: { issueId: a, from: 'open', to: 'closed' } });
    const deadline = Date.now() + 15_000;
    while (wakes.length === 0 && Date.now() < deadline) await sleepMs(50);
    await watcher.stop();
    expect(wakes.map((w) => w.waitId)).toEqual([waitId]);
    expect(emitted).toEqual([waitId]);
  }, 120_000);

  it('8. a bead waiter sleeps (out of bd ready) until the wait closes, then is ready again', async () => {
    const dep = await repo.create('sleep-dep');
    const waiter = await repo.create('sleep-waiter');
    const { service } = services();
    const waitId = await service.create({ on: [dep], waiter: { kind: 'bead', id: waiter } });
    expect(await repo.readyIds()).not.toContain(waiter);
    await repo.close(dep);
    expect(await repo.readyIds()).not.toContain(waiter); // wait bead still open: waiter keeps sleeping
    const { sink, wakes } = recordingSink();
    await watcherFor(sink).reconcile();
    expect(wakes.map((w) => w.waitId)).toEqual([waitId]);
    expect(await repo.readyIds()).toContain(waiter);
  }, 120_000);

  it('9. create rejects bad input before anything durable exists', async () => {
    const { service, store } = services();
    const before = (await store.listActive()).length;
    await expect(service.create({ on: [], waiter: { kind: 'agent', id: 'x' } })).rejects.toThrow(/at least one/);
    await expect(service.create({ on: ['wt-does-not-exist'], waiter: { kind: 'agent', id: 'x' } })).rejects.toThrow(/unknown bead/);
    await expect(service.create({ on: ['--flag'], waiter: { kind: 'agent', id: 'x' } })).rejects.toThrow(/not a valid bead id/);
    expect((await store.listActive()).length).toBe(before);
  }, 120_000);

  // Executable evidence for the PR's gap table (what bd's native gate does / does not do).
  describe('bd native gate evidence (why a bead of our own)', () => {
    const json = async (args: string[]) => {
      const out = await repo.runner(args);
      return JSON.parse(out.slice(out.search(/[[{]/))) as Record<string, unknown>;
    };

    it('G1. `bd gate check` never closes a wait bead (no await_id/type), so bd cannot sweep our state away', async () => {
      const a = await repo.create('g1-a');
      const { service } = services();
      const waitId = await service.create({ on: [a], waiter: { kind: 'agent', id: 'agent-g1' } });
      await repo.close(a);
      await repo.runner(['gate', 'check', '--type=all']);
      const rec = await service.get(waitId);
      expect(rec?.beadStatus).toBe('open');
      expect(rec?.state).toBe('pending');
    }, 120_000);

    it('G2. native bead gate: ONE await_id per gate; `all` over two beads = two gates; `any` is not expressible (waiter stays blocked after the first closes)', async () => {
      const x = await repo.create('g2-x');
      const y = await repo.create('g2-y');
      const waiter = await repo.create('g2-waiter');
      const gx = String((await json(['gate', 'create', '--blocks', waiter, '--type', 'bead', '--await-id', x, '--json']))['id']);
      const gy = String((await json(['gate', 'create', '--blocks', waiter, '--type', 'bead', '--await-id', y, '--json']))['id']);
      expect(gx).not.toBe(gy);
      await repo.close(x);
      await repo.runner(['gate', 'check', '--type=bead']);
      expect(await repo.readyIds()).not.toContain(waiter); // "any" would be ready here; native gates give "all" only
      await repo.close(y);
      await repo.runner(['gate', 'check', '--type=bead']);
      expect(await repo.readyIds()).toContain(waiter);
    }, 120_000);

    it('G3. native gate has no machine-readable note: --reason is flattened into the description text, and a gate carries no waiter/mode fields', async () => {
      const t = await repo.create('g3-t');
      const w = await repo.create('g3-w');
      const g = await json(['gate', 'create', '--blocks', w, '--type', 'bead', '--await-id', t, '--reason', 'wake because X', '--json']);
      const shown = (await json(['show', String(g['id']), '--json'])) as unknown as Array<Record<string, unknown>>;
      const row = shown[0]!;
      expect(String(row['description'])).toContain('Reason: wake because X');
      expect(row['metadata']).toBeUndefined();
      expect(row['mode']).toBeUndefined();
    }, 120_000);

    it('G4. native gate sweeper: a gate on a missing bead stays pending forever (no failed state); only timer gates expire', async () => {
      const w = await repo.create('g4-w');
      const g = String((await json(['gate', 'create', '--blocks', w, '--type', 'bead', '--await-id', 'wt-nope-g4', '--json']))['id']);
      const check = await json(['gate', 'check', '--type=bead', '--json']);
      expect(check['escalated']).toBe(0);
      const rows = (await json(['show', g, '--json'])) as unknown as Array<Record<string, unknown>>;
      expect(rows[0]!['status']).toBe('open');
    }, 120_000);
  });
});
