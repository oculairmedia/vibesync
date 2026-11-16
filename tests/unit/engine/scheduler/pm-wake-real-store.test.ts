/**
 * vibesync-e57f.3 against the REAL BdPendingWakeStore (outside review of the fix: every other test used a stand-in
 * store that authorizes every claim). bd is an in-memory table honouring the parts of its contract the store relies on,
 * and, unlike the store's own characterisation fake, a claim records a lease expiry, so a held wake really is held until
 * the shared clock passes it, and is then reclaimed.
 */
import { expect, it } from 'vitest';

import { PmWaker } from '../../../../src/engine/pm-wake/waker.js';
import { BdPendingWakeStore } from '../../../../src/engine/pm-wake/pending-store.js';
import { createEscalationNotifier } from '../../../../src/engine/scheduler/escalation-notify.js';

type Row = { id: string; status: string; assignee?: string; lease_expires_at?: string; metadata?: Record<string, unknown> };
const LEASE_MS = 60_000;

function leasedBd(clock: { t: number }) {
  const rows: Row[] = [];
  const find = (id: string) => rows.find((r) => r.id === id);
  const run = async (args: readonly string[]): Promise<string> => {
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    switch (args[0]) {
      case 'list': { const id = flag('--id'); return JSON.stringify(id ? rows.filter((r) => r.id === id) : rows); }
      case 'create': {
        const id = `pw-${rows.length + 1}`;
        rows.push({ id, status: 'open', metadata: JSON.parse(flag('--metadata')!) as Record<string, unknown> });
        return `${id}\n`;
      }
      case 'reclaim': {
        const row = find(flag('--id')!)!;
        if (row.status === 'in_progress' && Date.parse(row.lease_expires_at ?? '') > clock.t) throw new Error('reclaim: lease still held');
        row.status = 'open'; row.assignee = ''; delete row.lease_expires_at;
        return '{}';
      }
      case 'heartbeat': return '{}';
      case 'update': {
        const row = find(args[1]!)!;
        if (args.includes('--claim')) {
          if (row.status !== 'open' && row.status !== 'blocked') throw new Error('claim: not claimable');
          row.status = 'in_progress';
          row.assignee = flag('--actor')!;
          row.lease_expires_at = new Date(clock.t + LEASE_MS).toISOString();
          if (flag('--metadata')) row.metadata = JSON.parse(flag('--metadata')!) as Record<string, unknown>;
          return '{}';
        }
        const ifAssignee = flag('--if-assignee'); const ifStatus = flag('--if-status');
        if (ifAssignee !== undefined && row.assignee !== ifAssignee) throw new Error('update: assignee changed');
        if (ifStatus !== undefined && row.status !== ifStatus) throw new Error('update: status changed');
        if (flag('--status')) row.status = flag('--status')!;
        if (flag('--metadata')) row.metadata = JSON.parse(flag('--metadata')!) as Record<string, unknown>;
        return '{}';
      }
      default: throw new Error(`fake bd: unexpected ${args.join(' ')}`);
    }
  };
  return { run, rows };
}

it('real store: a held wake is not re-sent until its lease expires; once confirmed, a stall noted meanwhile gets its own wake and the delivered one is not repeated', async () => {
  const clock = { t: Date.parse('2026-11-16T12:00:00Z') };
  const bd = leasedBd(clock);
  const sent: Array<{ msgId: string; detail: string }> = [];
  let calls = 0;
  const sink = {
    wake: async (input: { wakeId: string; detail: string }) => {
      calls += 1;
      sent.push({ msgId: input.wakeId, detail: input.detail });
      if (calls === 1) return { ok: false, error: 'iroh down' };
      return { ok: true, accepted: true, applicationDelivered: true };
    },
  };
  const waker = new PmWaker({
    projectIdentifier: 'project', lookupAgentId: () => 'pm', sink: sink as never,
    pendingWakeStore: new BdPendingWakeStore(bd.run, { now: () => clock.t }),
    store: { load: () => ({ firstSeenAt: new Date(clock.t).toISOString(), lastWokenAt: null, lastByReason: {} }), save: () => {} },
    backlog: () => null, emit: () => {}, minIntervalMs: 0, backstopMs: 10 ** 12, now: () => clock.t,
    logger: { warn: () => undefined, info: () => undefined },
  });
  const tick = async () => { waker.onTick({ result: { scheduler: { dispatched: [] } } } as never); await waker.idle(); };
  await waker.idle();
  waker.noteStall('wa', 'first');
  await tick(); // saved, claimed (lease set), sent, failed: still held
  expect(sent).toHaveLength(1);
  waker.noteStall('wb', 'second'); // while the wake for wa is held
  clock.t += 1_000;
  await tick(); // the lease is live: not re-sent
  expect(sent, 'nothing re-sent while the lease is live').toHaveLength(1);
  clock.t += LEASE_MS + 600_000; // past the lease and the retry back-off
  await tick(); // reclaimed, re-sent, confirmed
  expect(sent).toHaveLength(2);
  expect(sent[1]!.msgId, 'the same message, retried').toBe(sent[0]!.msgId);
  expect(sent[1]!.detail).toContain('wa');
  expect(sent[1]!.detail).not.toContain('wb');
  clock.t += 60_000;
  await tick(); // wb was never in that message: its own wake
  expect(sent, 'a wake for the stall noted while the first was held').toHaveLength(3);
  expect(sent[2]!.detail).toContain('wb');
  expect(sent[2]!.detail, 'the delivered stall is not repeated').not.toContain('wa');
  waker.dispose();
});

it('real notifier and real store: an escalation noted while the first wake is held reaches the PM after that wake is confirmed', async () => {
  // The bead's acceptance asks for the production path: createEscalationNotifier -> PmWaker.noteStall -> the real
  // BdPendingWakeStore (outside confirmation review). The notifier wires wakePm to noteStall, as the scheduler does.
  const clock = { t: Date.parse('2026-11-16T12:00:00Z') };
  const bd = leasedBd(clock);
  const sent: Array<{ msgId: string; detail: string }> = [];
  let calls = 0;
  const sink = {
    wake: async (input: { wakeId: string; detail: string }) => {
      calls += 1;
      sent.push({ msgId: input.wakeId, detail: input.detail });
      return calls === 1 ? { ok: false, error: 'iroh down' } : { ok: true, accepted: true, applicationDelivered: true };
    },
  };
  const waker = new PmWaker({
    projectIdentifier: 'project', lookupAgentId: () => 'pm', sink: sink as never,
    pendingWakeStore: new BdPendingWakeStore(bd.run, { now: () => clock.t }),
    store: { load: () => ({ firstSeenAt: new Date(clock.t).toISOString(), lastWokenAt: null, lastByReason: {} }), save: () => {} },
    backlog: () => null, emit: () => {}, minIntervalMs: 0, backstopMs: 10 ** 12, now: () => clock.t,
    logger: { warn: () => undefined, info: () => undefined },
  });
  const comments: string[] = [];
  const escalate = createEscalationNotifier({ wakePm: (bead, why) => waker.noteStall(bead, why), commentOnBead: async (bead) => { comments.push(bead); } });
  const tick = async () => { waker.onTick({ result: { scheduler: { dispatched: [] } } } as never); await waker.idle(); };
  await waker.idle();
  await escalate({ workBeadId: 'wa', contextId: 'c1', reason: 'review exhausted' });
  await tick(); // saved, sent, failed: held
  await escalate({ workBeadId: 'wb', contextId: 'c2', reason: 'tester blocked' }); // while the wake for wa is held
  clock.t += 60_000 + 600_000;
  await tick(); // reclaimed, the same message retried and confirmed
  expect(sent[1]!.detail).toContain('wa');
  expect(sent[1]!.detail).not.toContain('wb');
  clock.t += 60_000;
  await tick();
  expect(sent, 'the escalation noted while the first wake was held gets its own wake').toHaveLength(3);
  expect(sent[2]!.detail).toContain('wb');
  expect(sent[2]!.detail).toContain('tester blocked');
  expect(sent[2]!.detail, 'the delivered escalation is not repeated').not.toContain('wa');
  expect(comments).toEqual(['wa', 'wb']);
  waker.dispose();
});

