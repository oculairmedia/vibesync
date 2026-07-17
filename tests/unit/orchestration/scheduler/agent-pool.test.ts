import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  type PoolMemberIdentity,
} from '../../../../src/orchestration/scheduler/index.js';

function members(n: number): PoolMemberIdentity[] {
  return Array.from({ length: n }, (_, i) => ({
    agentId: `agent-${i}`,
    role: 'coder',
    lettaBaseUrl: 'http://localhost:8291',
  }));
}

describe('AgentPool (vibesync-63zx.2)', () => {
  it('poolSize = member count is the concurrency cap; starts all IDLE', () => {
    const pool = new AgentPool({ members: members(3) });
    expect(pool.poolSize).toBe(3);
    expect(pool.availableCount).toBe(3);
    expect(pool.activeCount).toBe(0);
    expect(pool.view().every((s) => s.state === 'idle')).toBe(true);
  });

  it('rejects empty members and duplicate agentIds', () => {
    expect(() => new AgentPool({ members: [] })).toThrow(/non-empty/);
    const dup = [...members(1), ...members(1)];
    expect(() => new AgentPool({ members: dup })).toThrow(/duplicate/);
  });

  it('allocate up to cap returns distinct slots; each moves IDLE→WORKING', () => {
    const pool = new AgentPool({ members: members(3) });
    const a = pool.allocate({ workBeadId: 'w1' });
    const b = pool.allocate({ workBeadId: 'w2' });
    const c = pool.allocate({ workBeadId: 'w3' });
    expect(a && b && c).toBeTruthy();
    const ids = new Set([a!.slotId, b!.slotId, c!.slotId]);
    expect(ids.size).toBe(3); // distinct slots
    expect(pool.activeCount).toBe(3);
    expect(pool.availableCount).toBe(0);
    expect(a!.session.workBeadId).toBe('w1');
    expect(pool.view().filter((s) => s.state === 'working')).toHaveLength(3);
  });

  it('at cap, allocate returns null (the rate-limit governor)', () => {
    const pool = new AgentPool({ members: members(2) });
    expect(pool.allocate({ workBeadId: 'w1' })).not.toBeNull();
    expect(pool.allocate({ workBeadId: 'w2' })).not.toBeNull();
    // Pool is full — this is the cost ceiling independent of backlog depth.
    expect(pool.allocate({ workBeadId: 'w3' })).toBeNull();
    expect(pool.activeCount).toBe(2);
  });

  it('onComplete frees the slot (WORKING→IDLE) so capacity returns', () => {
    const pool = new AgentPool({ members: members(1) });
    const a = pool.allocate({ workBeadId: 'w1' })!;
    expect(pool.allocate({ workBeadId: 'w2' })).toBeNull(); // at cap
    const freed = pool.onComplete(a.slotId);
    expect(freed).toBe(true);
    expect(pool.activeCount).toBe(0);
    expect(pool.availableCount).toBe(1);
    // Slot reusable for a FRESH session on the same persistent identity.
    const b = pool.allocate({ workBeadId: 'w2' });
    expect(b).not.toBeNull();
    expect(b!.identity.agentId).toBe(a.identity.agentId); // identity persisted
    expect(b!.session.workBeadId).toBe('w2'); // fresh session, not reused
  });

  it('onComplete is safe on unknown / non-working slots (idempotent)', () => {
    const pool = new AgentPool({ members: members(1) });
    expect(pool.onComplete('nope')).toBe(false);
    const a = pool.allocate({ workBeadId: 'w1' })!;
    expect(pool.onComplete(a.slotId)).toBe(true);
    expect(pool.onComplete(a.slotId)).toBe(false); // already freed
    expect(pool.activeCount).toBe(0);
  });

  it('identity persists across completion; session is retired (not reused)', () => {
    const pool = new AgentPool({ members: members(1) });
    const a = pool.allocate({ workBeadId: 'w1', conversationId: 'conv-1' })!;
    expect(a.session.conversationId).toBe('conv-1');
    pool.onComplete(a.slotId);
    const b = pool.allocate({ workBeadId: 'w2' })!;
    expect(b.identity.agentId).toBe(a.identity.agentId); // same persistent agent
    expect(b.session.conversationId).toBeUndefined(); // retired session, fresh
  });

  it('idempotent per work bead: allocating the same work bead twice does not consume two slots', () => {
    const pool = new AgentPool({ members: members(2) });
    const a = pool.allocate({ workBeadId: 'w1' })!;
    const again = pool.allocate({ workBeadId: 'w1' })!;
    expect(again.slotId).toBe(a.slotId); // same slot
    expect(pool.activeCount).toBe(1); // only one slot consumed
    expect(pool.availableCount).toBe(1);
  });

  it('active count stays accurate across an interleaved allocate/complete sequence (no over/under-count)', () => {
    const pool = new AgentPool({ members: members(3) });
    const claims: string[] = [];
    // Fill the pool.
    for (const w of ['w1', 'w2', 'w3']) {
      const c = pool.allocate({ workBeadId: w });
      expect(c).not.toBeNull();
      claims.push(c!.slotId);
    }
    expect(pool.activeCount).toBe(3);
    expect(pool.allocate({ workBeadId: 'w4' })).toBeNull(); // governed

    // Free one, allocate one — count must never exceed poolSize.
    pool.onComplete(claims[0]!);
    expect(pool.activeCount).toBe(2);
    const c4 = pool.allocate({ workBeadId: 'w4' });
    expect(c4).not.toBeNull();
    expect(pool.activeCount).toBe(3);
    expect(pool.allocate({ workBeadId: 'w5' })).toBeNull();

    // Drain fully.
    for (const s of pool.view().filter((v) => v.state === 'working')) {
      pool.onComplete(s.slotId);
    }
    expect(pool.activeCount).toBe(0);
    expect(pool.availableCount).toBe(3);
  });
});
