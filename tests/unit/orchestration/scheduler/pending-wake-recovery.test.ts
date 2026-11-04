import { expect, it, vi } from 'vitest';
import { PmWaker } from '../../../../src/orchestration/scheduler/pm-waker.js';
import type { PendingWakeRecord, PendingWakeStore } from '../../../../src/orchestration/scheduler/bd-pending-wake-store.js';

function record(id: string): PendingWakeRecord {
  return { id, status: 'open', payload: { projectIdentifier: 'project', agentId: 'pm', msgId: id, reason: 'event', detail: id, body: id, createdAt: new Date(0).toISOString() } };
}

function harness(pending: PendingWakeStore) {
  return new PmWaker({
    projectIdentifier: 'project', lookupAgentId: () => 'pm', sink: { wake: async () => ({ ok: true }) },
    pendingWakeStore: pending,
    store: { load: () => ({ firstSeenAt: new Date(0).toISOString(), lastWokenAt: null, lastByReason: {} }), save: () => {} },
    backlog: () => null, emit: () => {}, minIntervalMs: 0, backstopMs: 1000, now: () => 10_000,
  });
}

it('failed recovery never creates a replacement wake before existing pending records are known', async () => {
  const enqueue = vi.fn(async () => record('replacement'));
  const waker = harness({
    listPending: async () => { throw new Error('store unavailable'); }, enqueue,
    claim: async () => ({ authorized: false, record: null }),
    sendClaimed: async () => ({ authorized: false, record: null }),
  });
  await waker.idle();
  waker.onTick({ result: { scheduler: { dispatched: [] } } });
  await waker.idle();
  expect(enqueue).not.toHaveBeenCalled();
  waker.dispose();
});

it('recovers every persisted message even when two share the same wake reason', async () => {
  const a = record('first'); const b = record('second');
  const sent: string[] = [];
  const waker = harness({
    listPending: async () => [a, b], enqueue: async () => { throw new Error('unexpected new wake'); },
    claim: async id => ({ authorized: true, record: id === a.id ? a : b }),
    sendClaimed: async r => {
      sent.push(r.id);
      return { authorized: true, record: r, outcome: { ok: true, accepted: true, applicationDelivered: true }, receipt: { msgId: r.payload.msgId, accepted: true, applicationDelivered: true, observedAt: new Date(10_000).toISOString() } };
    },
  });
  await waker.idle();
  for (let i = 0; i < 2; i++) {
    waker.onTick({ result: { scheduler: { dispatched: [] } } });
    await waker.idle();
  }
  expect(sent).toEqual(['first', 'second']);
  waker.dispose();
});
