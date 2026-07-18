import { describe, expect, it } from 'vitest';

import {
  Witness,
  toWorkingSlot,
  DEFAULT_RECOVERY_ESCALATION_THRESHOLD,
  type RunLiveness,
  type RunLivenessProbe,
  type SlotReaper,
  type WitnessEscalation,
  type WorkingSlot,
} from '../../../../src/orchestration/scheduler/witness.js';
import type { PoolSlotView } from '../../../../src/orchestration/scheduler/agent-pool.js';

const IDENT = { agentId: 'a0', role: 'coder', lettaBaseUrl: 'http://x' };

function workingView(slotId: string, workBeadId: string, allocatedAt = new Date('2026-07-18T00:00:00Z')): PoolSlotView {
  return { slotId, identity: IDENT, state: 'working', session: { workBeadId, allocatedAt } };
}
function idleView(slotId: string): PoolSlotView {
  return { slotId, identity: IDENT, state: 'idle' };
}

/** Probe returning a fixed verdict per workBeadId. */
function probeMap(map: Record<string, RunLiveness | 'throw'>): RunLivenessProbe {
  return {
    async probe(slot: WorkingSlot) {
      const v = map[slot.workBeadId];
      if (v === 'throw') throw new Error('probe boom');
      return (v ?? 'alive') as RunLiveness;
    },
  };
}

function harness(probe: RunLivenessProbe, threshold?: number) {
  const freed: string[] = [];
  const escalated: Array<{ workBeadId: string; reason: string; recoveries: number }> = [];
  const reaper: SlotReaper = { onComplete(slotId) { freed.push(slotId); return true; } };
  const escalation: WitnessEscalation = {
    async onRepeatedRecovery(i) { escalated.push({ workBeadId: i.workBeadId, reason: i.reason, recoveries: i.recoveries }); },
  };
  const witness = new Witness({ probe, reaper, escalation, recoveryEscalationThreshold: threshold });
  return { witness, freed, escalated };
}

describe('toWorkingSlot (vibesync-63zx.7)', () => {
  it('extracts a working slot', () => {
    expect(toWorkingSlot(workingView('s1', 'w1'))?.workBeadId).toBe('w1');
  });
  it('returns null for idle/done slots', () => {
    expect(toWorkingSlot(idleView('s1'))).toBeNull();
    expect(toWorkingSlot({ slotId: 's', identity: IDENT, state: 'done' })).toBeNull();
  });
});

describe('Witness.patrol (vibesync-63zx.7)', () => {
  it('leaves an ALIVE slot untouched regardless of how old it is (causal, not wall-clock)', async () => {
    // allocated 10 hours ago — but alive → must NOT be reaped.
    const old = new Date(Date.now() - 10 * 3600 * 1000);
    const { witness, freed } = harness(probeMap({ w1: 'alive' }));
    const r = await witness.patrol([workingView('s1', 'w1', old)]);
    expect(freed).toEqual([]);
    expect(r.recovered).toEqual([]);
    expect(r.healthy).toBe(1);
  });

  it('recovers a run-dead slot (crash) — frees it', async () => {
    const { witness, freed } = harness(probeMap({ w1: 'run-dead' }));
    const r = await witness.patrol([workingView('s1', 'w1')]);
    expect(freed).toEqual(['s1']);
    expect(r.recovered).toEqual([{ slotId: 's1', workBeadId: 'w1', reason: 'run-dead' }]);
  });

  it('recovers each contradiction class: run-zombie, bead-closed, run-missing', async () => {
    const { witness, freed } = harness(probeMap({ wz: 'run-zombie', wc: 'bead-closed', wm: 'run-missing' }));
    const r = await witness.patrol([workingView('s1', 'wz'), workingView('s2', 'wc'), workingView('s3', 'wm')]);
    expect(new Set(freed)).toEqual(new Set(['s1', 's2', 's3']));
    expect(r.recovered.map((x) => x.reason).sort()).toEqual(['bead-closed', 'run-missing', 'run-zombie']);
  });

  it('ignores idle/done slots — only working slots are patrolled', async () => {
    const { witness, freed } = harness(probeMap({ w1: 'run-dead' }));
    const r = await witness.patrol([idleView('s0'), workingView('s1', 'w1')]);
    expect(freed).toEqual(['s1']); // only the working one
    expect(r.recovered).toHaveLength(1);
  });

  it('FAIL SAFE: a probe error does NOT reap the slot (never kill what we cannot prove dead)', async () => {
    const { witness, freed } = harness(probeMap({ w1: 'throw' }));
    const r = await witness.patrol([workingView('s1', 'w1')]);
    expect(freed).toEqual([]); // untouched
    expect(r.recovered).toEqual([]);
  });

  it('escalates a work bead recovered >= threshold times (repeatedly dying)', async () => {
    const { witness, freed, escalated } = harness(probeMap({ w1: 'run-dead' }), DEFAULT_RECOVERY_ESCALATION_THRESHOLD);
    // patrol the same dead bead threshold times
    for (let i = 0; i < DEFAULT_RECOVERY_ESCALATION_THRESHOLD; i++) {
      await witness.patrol([workingView('s1', 'w1')]);
    }
    expect(freed.length).toBe(DEFAULT_RECOVERY_ESCALATION_THRESHOLD);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toEqual({ workBeadId: 'w1', reason: 'run-dead', recoveries: DEFAULT_RECOVERY_ESCALATION_THRESHOLD });
  });

  it('does not escalate below threshold', async () => {
    const { witness, escalated } = harness(probeMap({ w1: 'run-dead' }), 3);
    await witness.patrol([workingView('s1', 'w1')]);
    await witness.patrol([workingView('s1', 'w1')]);
    expect(escalated).toEqual([]); // only 2 recoveries < 3
  });

  it('escalation sink failure never kills the patrol', async () => {
    const probe = probeMap({ w1: 'run-dead' });
    const reaper: SlotReaper = { onComplete() { return true; } };
    const escalation: WitnessEscalation = { async onRepeatedRecovery() { throw new Error('sink down'); } };
    const witness = new Witness({ probe, reaper, escalation, recoveryEscalationThreshold: 1 });
    // threshold 1 → escalates on first recovery, which throws internally
    const r = await witness.patrol([workingView('s1', 'w1')]); // must not throw
    expect(r.recovered).toHaveLength(1);
  });

  it('a mixed cycle: alive kept, dead recovered, counted correctly', async () => {
    const { witness, freed } = harness(probeMap({ alive1: 'alive', dead1: 'run-dead', alive2: 'alive' }));
    const r = await witness.patrol([
      workingView('s1', 'alive1'),
      workingView('s2', 'dead1'),
      workingView('s3', 'alive2'),
    ]);
    expect(freed).toEqual(['s2']);
    expect(r.recovered).toHaveLength(1);
    expect(r.healthy).toBe(2);
  });
});
