/**
 * Characterisation tests for BdPendingWakeStore (vibesync-9lzk.59), written
 * BEFORE refactoring it. They pin today's behaviour on the paths the existing
 * unit tests never reached (62 of 181 branch arms): the record parser's
 * rejections and defaults, claiming against live and expired leases, a claim
 * another process wins, a send whose claim was lost, a failed or thrown
 * delivery, and payload validation on enqueue.
 *
 * The fake bd is an in-memory table that honours the parts of bd's contract the
 * store relies on: `list --id` / `list --label`, `update --claim --actor`
 * (claims only open or blocked beads), `update --status ... --if-assignee
 * --if-status` (a guarded write that fails on a mismatch, as bd does), and
 * `heartbeat` / `reclaim`.
 */
import { describe, expect, it } from 'vitest';

import { BdPendingWakeStore } from '../../../../src/engine/pm-wake/pending-store.js';

type Row = {
  id: string;
  status: string;
  assignee?: string;
  lease_expires_at?: string;
  metadata?: Record<string, unknown>;
};

const NOW = Date.parse('2026-11-12T12:00:00Z');

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectIdentifier: 'project', agentId: 'pm', msgId: 'wake-1', reason: 'event',
    detail: 'detail', body: 'body', createdAt: new Date(0).toISOString(), ...over,
  };
}

function fakeBd(rows: Row[], opts: { failClaim?: boolean; failReclaim?: boolean; failHeartbeat?: boolean; stealOnClaim?: string } = {}) {
  const calls: string[][] = [];
  const find = (id: string) => rows.find((r) => r.id === id);
  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    switch (args[0]) {
      case 'list': {
        const id = flag('--id');
        return JSON.stringify(id ? rows.filter((r) => r.id === id) : rows);
      }
      case 'create': {
        const metadata = JSON.parse(flag('--metadata')!) as Record<string, unknown>;
        const id = `pw-${rows.length + 1}`;
        rows.push({ id, status: 'open', metadata });
        return `${id}\n`;
      }
      case 'reclaim': {
        if (opts.failReclaim) throw new Error('reclaim: lease still held');
        const row = find(flag('--id')!)!;
        row.status = 'open';
        row.assignee = '';
        return '{}';
      }
      case 'heartbeat': {
        if (opts.failHeartbeat) throw new Error('heartbeat: not the assignee');
        return '{}';
      }
      case 'update': {
        const row = find(args[1]!)!;
        if (args.includes('--claim')) {
          if (opts.failClaim) throw new Error('claim: conflict');
          if (row.status !== 'open' && row.status !== 'blocked') throw new Error('claim: not claimable');
          row.status = 'in_progress';
          row.assignee = opts.stealOnClaim ?? flag('--actor')!;
          if (flag('--metadata')) row.metadata = JSON.parse(flag('--metadata')!) as Record<string, unknown>;
          return '{}';
        }
        const ifAssignee = flag('--if-assignee');
        const ifStatus = flag('--if-status');
        if (ifAssignee !== undefined && row.assignee !== ifAssignee) throw new Error('update: assignee changed');
        if (ifStatus !== undefined && row.status !== ifStatus) throw new Error('update: status changed');
        if (flag('--status')) row.status = flag('--status')!;
        if (flag('--metadata')) row.metadata = JSON.parse(flag('--metadata')!) as Record<string, unknown>;
        return '{}';
      }
      default:
        throw new Error(`fake bd: unexpected ${args.join(' ')}`);
    }
  };
  return { run, calls, rows };
}

const store = (bd: ReturnType<typeof fakeBd>) => new BdPendingWakeStore(bd.run, { now: () => NOW });

describe('BdPendingWakeStore: reading records', () => {
  it.each([
    ['no id', { id: '', status: 'open', metadata: { payload: payload() } }],
    ['no metadata', { id: 'pw-1', status: 'open' }],
    ['no payload', { id: 'pw-1', status: 'open', metadata: {} }],
    ['payload without msgId', { id: 'pw-1', status: 'open', metadata: { payload: payload({ msgId: 7 }) } }],
    ['payload without body', { id: 'pw-1', status: 'open', metadata: { payload: payload({ body: undefined }) } }],
    ['correlation that is an array', { id: 'pw-1', status: 'open', metadata: { payload: payload({ correlation: ['x'] }) } }],
  ])('a row with %s is not a pending wake', async (_case, row) => {
    expect(await store(fakeBd([row as Row])).listPending()).toEqual([]);
  });

  it('defaults an unknown reason to backstop, a missing createdAt to empty, and drops a malformed receipt', async () => {
    const row: Row = { id: 'pw-1', status: 'open', metadata: { payload: payload({ reason: 'whatever', createdAt: 5 }), receipt: { accepted: 'yes' } } };
    const [record] = await store(fakeBd([row])).listPending();
    expect(record!.payload.reason).toBe('backstop');
    expect(record!.payload.createdAt).toBe('');
    expect(record!.receipt).toBeUndefined();
  });

  it('reads the lease expiry, claim token and assignee, and keeps a string-valued correlation', async () => {
    const row: Row = {
      id: 'pw-1', status: 'in_progress', assignee: 'holder', lease_expires_at: new Date(NOW + 60_000).toISOString(),
      metadata: { claimToken: 'holder', payload: payload({ correlation: { bead: 'b-1' } }) },
    };
    const [record] = await store(fakeBd([row])).listPending();
    expect(record).toMatchObject({ assignee: 'holder', claimToken: 'holder', leaseExpiresAt: NOW + 60_000 });
    expect(record!.payload.correlation).toEqual({ bead: 'b-1' });
  });

  it('ignores an unparseable lease expiry', async () => {
    const row: Row = { id: 'pw-1', status: 'open', lease_expires_at: 'not a date', metadata: { payload: payload() } };
    const [record] = await store(fakeBd([row])).listPending();
    expect(record!.leaseExpiresAt).toBeUndefined();
  });

  it('listPending leaves out closed wakes; get still returns them', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'closed', metadata: { payload: payload() } }]);
    expect(await store(bd).listPending()).toEqual([]);
    expect((await store(bd).get('pw-1'))!.status).toBe('closed');
  });

  it('rejects an id that is not a bead id', async () => {
    await expect(store(fakeBd([])).get('bad id; rm -rf')).rejects.toThrow(/invalid bead id/);
  });
});

describe('BdPendingWakeStore: claiming', () => {
  it('claims an open wake under a fresh token', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }]);
    const claim = await store(bd).claim('pw-1');
    expect(claim.authorized).toBe(true);
    expect(claim.record!.status).toBe('in_progress');
    expect(claim.record!.claimToken).toBe(claim.record!.assignee);
  });

  it('does not claim a closed wake', async () => {
    const claim = await store(fakeBd([{ id: 'pw-1', status: 'closed', metadata: { payload: payload() } }])).claim('pw-1');
    expect(claim.authorized).toBe(false);
  });

  it('does not steal a wake whose lease is still live, and never asks bd to reclaim it', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'in_progress', assignee: 'other', lease_expires_at: new Date(NOW + 60_000).toISOString(), metadata: { payload: payload() } }]);
    const claim = await store(bd).claim('pw-1');
    expect(claim.authorized).toBe(false);
    expect(bd.calls.some((c) => c[0] === 'reclaim')).toBe(false);
  });

  it('reclaims a wake whose lease expired, then claims it', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'in_progress', assignee: 'other', lease_expires_at: new Date(NOW - 1).toISOString(), metadata: { payload: payload() } }]);
    const claim = await store(bd).claim('pw-1');
    expect(bd.calls.some((c) => c[0] === 'reclaim')).toBe(true);
    expect(claim.authorized).toBe(true);
  });

  it('gives up when bd refuses the reclaim, without attempting a claim', async () => {
    // A refused reclaim means the lease is still held (bd checks it atomically). The
    // store must stop there: it must not go on to try a claim of its own.
    const bd = fakeBd([{ id: 'pw-1', status: 'in_progress', assignee: 'other', lease_expires_at: new Date(NOW - 1).toISOString(), metadata: { payload: payload() } }], { failReclaim: true });
    expect((await store(bd).claim('pw-1')).authorized).toBe(false);
    expect(bd.calls.some((c) => c[0] === 'update' && c.includes('--claim'))).toBe(false);
  });

  it('gives up when the claim write fails', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }], { failClaim: true });
    expect((await store(bd).claim('pw-1')).authorized).toBe(false);
  });

  it('is not authorized when another process won the claim', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }], { stealOnClaim: 'someone-else' });
    const claim = await store(bd).claim('pw-1');
    expect(claim.authorized).toBe(false);
    expect(claim.record!.assignee).toBe('someone-else');
  });
});

describe('BdPendingWakeStore: sending', () => {
  async function claimed(bd: ReturnType<typeof fakeBd>) {
    const claim = await store(bd).claim('pw-1');
    expect(claim.authorized).toBe(true);
    return claim.record!;
  }

  it('records a delivered wake and closes it', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload({ correlation: { bead: 'b-1' } }), attempts: 2 } }]);
    const record = await claimed(bd);
    const woken: unknown[] = [];
    const result = await store(bd).sendClaimed(record, { wake: async (input) => { woken.push(input); return { ok: true, accepted: true, applicationDelivered: true }; } }, NOW);
    expect(result.authorized).toBe(true);
    expect(woken).toEqual([expect.objectContaining({ wakeId: 'wake-1', correlation: { bead: 'b-1' } })]);
    expect(bd.rows[0]!.status).toBe('closed');
    expect(bd.rows[0]!.metadata).toMatchObject({ state: 'delivered', attempts: 3 });
  });

  it('a wake accepted but not delivered stays open as pending, with the attempt counted', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }]);
    const record = await claimed(bd);
    const result = await store(bd).sendClaimed(record, { wake: async () => ({ ok: true, accepted: true, applicationDelivered: false, reason: 'application_input_accepted' }) }, NOW);
    expect(result.receipt).toMatchObject({ accepted: true, applicationDelivered: false, reason: 'application_input_accepted' });
    expect(bd.rows[0]!.status).toBe('in_progress');
    expect(bd.rows[0]!.metadata).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('a sink that throws is recorded as a failed attempt, not thrown', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }]);
    const record = await claimed(bd);
    const result = await store(bd).sendClaimed(record, { wake: async () => { throw new Error('transport down'); } }, NOW);
    expect(result.outcome).toEqual({ ok: false, error: 'transport down' });
    expect(result.receipt).toMatchObject({ accepted: false, applicationDelivered: false, reason: 'transport down' });
    expect(bd.rows[0]!.status).toBe('in_progress');
  });

  it('does not send when the claim was lost before sending', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }]);
    const record = await claimed(bd);
    bd.rows[0]!.assignee = 'someone-else';
    let sent = false;
    const result = await store(bd).sendClaimed(record, { wake: async () => { sent = true; return { ok: true }; } }, NOW);
    expect(result.authorized).toBe(false);
    expect(sent).toBe(false);
  });

  it('does not send when the lease heartbeat is refused', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'open', metadata: { payload: payload() } }]);
    const record = await claimed(bd);
    let sent = false;
    const failing = fakeBd(bd.rows, { failHeartbeat: true });
    const result = await new BdPendingWakeStore(failing.run, { now: () => NOW }).sendClaimed(record, { wake: async () => { sent = true; return { ok: true }; } }, NOW);
    expect(result.authorized).toBe(false);
    expect(sent).toBe(false);
  });

  it('claimAndSend does nothing when the claim is not authorized', async () => {
    const bd = fakeBd([{ id: 'pw-1', status: 'closed', metadata: { payload: payload() } }]);
    let sent = false;
    const result = await store(bd).claimAndSend('pw-1', { wake: async () => { sent = true; return { ok: true }; } });
    expect(result.authorized).toBe(false);
    expect(sent).toBe(false);
  });
});

describe('BdPendingWakeStore: enqueue', () => {
  const input = { projectIdentifier: 'project', agentId: 'pm', wakeId: 'wake-9', reason: 'ready' as const, detail: 'd' };

  it('persists the payload and reads it back unchanged', async () => {
    const record = await store(fakeBd([])).enqueue({ ...input, correlation: { bead: 'b-1', step: 's-1' } }, NOW);
    expect(record.payload).toMatchObject({ msgId: 'wake-9', reason: 'ready', correlation: { bead: 'b-1', step: 's-1' } });
  });

  it('rejects a correlation with an unknown key', async () => {
    await expect(store(fakeBd([])).enqueue({ ...input, correlation: { colour: 'red' } }, NOW)).rejects.toThrow(/unknown key or non-string value/);
  });

  it('fails when bd changed the payload it was given', async () => {
    const bd = fakeBd([]);
    const original = bd.run;
    const tampering = async (args: readonly string[]) => {
      const out = await original(args);
      if (args[0] === 'create') (bd.rows.at(-1)!.metadata!['payload'] as Record<string, unknown>)['detail'] = 'changed';
      return out;
    };
    await expect(new BdPendingWakeStore(tampering, { now: () => NOW }).enqueue(input, NOW)).rejects.toThrow(/changed pending wake payload/);
  });
});
