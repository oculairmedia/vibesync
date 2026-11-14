/**
 * Characterisation tests for the PM waker's durable path and tick evaluation
 * (vibesync-ji3w), written BEFORE refactoring src/engine/pm-wake/waker.ts
 * (retryDurablePending cc 11, sendDurable 9, evaluate 9). A probe round left 9
 * of 15 rules unguarded although the file shows 85% branch coverage: the tests
 * drove these lines but checked none of these outcomes.
 *
 * The durable path saves a wake, CLAIMS it (another process may hold it), then
 * sends it; the store answers each step with `authorized`. These tests fake that
 * store so every answer is controlled.
 */
import { expect, it, vi } from 'vitest';

import { PmWaker } from '../../../../src/engine/pm-wake/waker.js';
import type { PendingWakeRecord, PendingWakeSendResult, PendingWakeStore } from '../../../../src/engine/pm-wake/pending-store.js';
import { PM_WAKE_RETRY_BACKOFF_MS, PM_WAKE_SKIPPED_EVENT, PM_WOKEN_EVENT } from '../../../../src/engine/pm-wake/contract.js';

function record(id: string, over: Partial<PendingWakeRecord> = {}): PendingWakeRecord {
  return {
    id, status: 'open',
    payload: { projectIdentifier: 'project', agentId: 'pm', msgId: id, reason: 'backstop', detail: id, body: id, createdAt: new Date(0).toISOString() },
    ...over,
  } as PendingWakeRecord;
}

const delivered = (r: PendingWakeRecord): PendingWakeSendResult => ({
  authorized: true, record: r,
  outcome: { ok: true, accepted: true, applicationDelivered: true },
  receipt: { msgId: r.payload.msgId, accepted: true, applicationDelivered: true, observedAt: new Date(0).toISOString() },
});

/** A waker with a durable store; `now` and the agent lookup are controllable. */
function harness(pending: Partial<PendingWakeStore>, opts: { lookup?: () => string | null; clock?: { t: number } } = {}) {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const warns: Array<{ o: unknown; m: string }> = [];
  const clock = opts.clock ?? { t: 10_000 };
  const store: PendingWakeStore = {
    listPending: async () => [],
    enqueue: async () => record('new'),
    claim: async () => ({ authorized: false, record: null }),
    sendClaimed: async () => ({ authorized: false, record: null }),
    ...pending,
  } as PendingWakeStore;
  const waker = new PmWaker({
    projectIdentifier: 'project', lookupAgentId: opts.lookup ?? (() => 'pm'), sink: { wake: async () => ({ ok: true }) },
    pendingWakeStore: store,
    store: { load: () => ({ firstSeenAt: new Date(0).toISOString(), lastWokenAt: null, lastByReason: {} }), save: () => {} },
    backlog: () => null,
    emit: (kind, payload) => { events.push({ kind, payload: payload as Record<string, unknown> }); },
    minIntervalMs: 0, backstopMs: 1000, now: () => clock.t,
    logger: { warn: (o: unknown, m: string) => { warns.push({ o, m }); }, info: () => undefined },
  });
  const tick = async (dispatched: string[] = []) => {
    waker.onTick({ result: { scheduler: { dispatched } } } as never);
    await waker.idle();
  };
  return { waker, events, warns, tick, clock };
}

it('a fresh wake whose claim is not authorized is not sent', async () => {
  const sendClaimed = vi.fn<PendingWakeStore['sendClaimed']>(async (r) => delivered(r));
  const h = harness({ enqueue: async () => record('w1'), claim: async () => ({ authorized: false, record: record('w1') }), sendClaimed });
  await h.waker.idle();
  await h.tick();
  expect(sendClaimed).not.toHaveBeenCalled();
  h.waker.dispose();
});

it('a fresh wake whose saved record is already closed is dropped, not sent', async () => {
  const sendClaimed = vi.fn<PendingWakeStore['sendClaimed']>(async (r) => delivered(r));
  const enqueue = vi.fn(async () => record('w1'));
  const h = harness({ enqueue, claim: async () => ({ authorized: true, record: record('w1', { status: 'closed' }) }), sendClaimed });
  await h.waker.idle();
  await h.tick();
  expect(sendClaimed).not.toHaveBeenCalled();
  await h.tick();
  expect(enqueue).toHaveBeenCalledTimes(2); // dropped: nothing left pending to block the next wake
  h.waker.dispose();
});

it('a send the store does not authorize is not counted as delivered: the wake stays pending and is retried', async () => {
  const claims: string[] = [];
  const enqueue = vi.fn(async () => record('w1'));
  const h = harness({
    enqueue,
    claim: async (id) => { claims.push(id); return { authorized: true, record: record('w1') }; },
    sendClaimed: async (r) => ({ authorized: false, record: r, outcome: { ok: true, accepted: true, applicationDelivered: true } }),
  });
  await h.waker.idle();
  await h.tick();
  expect(h.events.filter((e) => e.kind === PM_WOKEN_EVENT)).toEqual([]); // not reported as a wake
  await h.tick();
  expect(enqueue).toHaveBeenCalledTimes(1); // still pending: retried, not replaced
  expect(claims).toEqual(['w1', 'w1']);
  h.waker.dispose();
});

it('a recovered wake whose claim is not authorized is not sent', async () => {
  const sendClaimed = vi.fn<PendingWakeStore['sendClaimed']>(async (r) => delivered(r));
  const pendingRecord = record('old');
  const h = harness({ listPending: async () => [pendingRecord], claim: async () => ({ authorized: false, record: pendingRecord }), sendClaimed });
  await h.waker.idle();
  await h.tick();
  expect(sendClaimed).not.toHaveBeenCalled();
  h.waker.dispose();
});

it('a recovered wake whose send is not authorized stays pending and is tried again', async () => {
  const pendingRecord = record('old');
  const claims: string[] = [];
  const enqueue = vi.fn(async () => record('new'));
  const h = harness({
    listPending: async () => [pendingRecord], enqueue,
    claim: async (id) => { claims.push(id); return { authorized: true, record: pendingRecord }; },
    sendClaimed: async (r) => ({ authorized: false, record: r, outcome: { ok: true, accepted: true, applicationDelivered: true } }),
  });
  await h.waker.idle();
  await h.tick();
  expect(h.events.filter((e) => e.kind === PM_WOKEN_EVENT)).toEqual([]); // not reported as a wake
  await h.tick();
  expect(claims).toEqual(['old', 'old']);
  expect(enqueue).not.toHaveBeenCalled();
  h.waker.dispose();
});

it('a durable send that throws fails closed and backs off: no new wake inside the back-off window', async () => {
  const clock = { t: 10_000 };
  const enqueue = vi.fn(async () => { throw new Error('store down'); });
  const h = harness({ enqueue }, { clock });
  await h.waker.idle();
  await h.tick();
  expect(h.warns.find((w) => w.m === 'pm-wake: durable send failed closed')?.o).toMatchObject({ project: 'project', error: 'store down' });
  clock.t += PM_WAKE_RETRY_BACKOFF_MS - 1;
  await h.tick();
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(h.events.some((e) => e.kind === PM_WAKE_SKIPPED_EVENT && e.payload['why'] === 'retry-backoff')).toBe(true);
  h.waker.dispose();
});

it('no agent to wake: one warning, one skipped event, and the warning returns after an agent comes and goes', async () => {
  let agent: string | null = null;
  const h = harness({ enqueue: async () => record('w') }, { lookup: () => agent });
  await h.waker.idle();
  await h.tick();
  await h.tick();
  expect(h.warns.filter((w) => w.m.includes('has no agent to wake'))).toHaveLength(1);
  expect(h.events.filter((e) => e.kind === PM_WAKE_SKIPPED_EVENT && e.payload['why'] === 'no-agent')).toHaveLength(1);
  agent = 'pm';
  await h.tick();
  agent = null;
  await h.tick();
  expect(h.warns.filter((w) => w.m.includes('has no agent to wake'))).toHaveLength(2);
  h.waker.dispose();
});

it('ready work wakes nobody on a tick that just dispatched; the same backlog wakes on an idle tick', async () => {
  const enqueue = vi.fn(async (input: { reason: string }) => record(`w-${input.reason}`));
  const store: PendingWakeStore = {
    listPending: async () => [], enqueue: enqueue as never,
    claim: async () => ({ authorized: false, record: null }), sendClaimed: async () => ({ authorized: false, record: null }),
  } as PendingWakeStore;
  const waker = new PmWaker({
    projectIdentifier: 'project', lookupAgentId: () => 'pm', sink: { wake: async () => ({ ok: true }) },
    pendingWakeStore: store,
    store: { load: () => ({ firstSeenAt: new Date(0).toISOString(), lastWokenAt: new Date(10_000).toISOString(), lastByReason: {} }), save: () => {} },
    backlog: () => ({ readyCount: 3, freeCapacity: 1 }) as never,
    emit: () => {}, minIntervalMs: 0, backstopMs: 1e12, now: () => 10_000,
  });
  await waker.idle();
  waker.onTick({ result: { scheduler: { dispatched: ['w1'] } } } as never);
  await waker.idle();
  expect(enqueue.mock.calls.map((c) => c[0].reason)).not.toContain('ready');
  waker.onTick({ result: { scheduler: { dispatched: [] } } } as never);
  await waker.idle();
  expect(enqueue.mock.calls.map((c) => c[0].reason)).toContain('ready');
  waker.dispose();
});
