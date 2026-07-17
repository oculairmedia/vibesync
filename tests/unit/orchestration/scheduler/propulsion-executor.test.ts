import { describe, expect, it } from 'vitest';

import {
  PropulsionExecutor,
  classifyOutcome,
  extractArtifacts,
  NEEDS_MERIDIAN_MARKER,
  type DispatchRunner,
  type DispatchRunResult,
  type SelfCompletionSink,
  type EscalationSink,
  type SlotReleaser,
} from '../../../../src/orchestration/scheduler/index.js';
import type { DispatchCandidate } from '../../../../src/orchestration/scheduler/plan-dispatch.js';

function candidate(workBeadId: string): DispatchCandidate {
  return {
    contextId: `ctx-${workBeadId}`, workBeadId, priority: 2, unblockCount: 0,
    enqueuedAt: '2026-07-17T20:00:00Z', files: [], dispatchFailures: 0,
  };
}

/** A runner that records how it was called (to prove no survey turn). */
function fakeRunner(result: (c: DispatchCandidate) => DispatchRunResult): {
  runner: DispatchRunner; calls: DispatchCandidate[];
} {
  const calls: DispatchCandidate[] = [];
  return {
    calls,
    runner: { async run(c) { calls.push(c); return result(c); } },
  };
}

function fakePool(): { pool: SlotReleaser; freed: string[] } {
  const freed: string[] = [];
  return { freed, pool: { onComplete(slotId) { freed.push(slotId); return true; } } };
}

function sinks(): {
  completion: SelfCompletionSink; completed: unknown[];
  escalation: EscalationSink; escalated: unknown[];
} {
  const completed: unknown[] = [];
  const escalated: unknown[] = [];
  return {
    completed, escalated,
    completion: { async onCompleted(i) { completed.push(i); } },
    escalation: { async onBlocked(i) { escalated.push(i); } },
  };
}

const okResult = (output: string): ((c: DispatchCandidate) => DispatchRunResult) =>
  (c) => ({ runId: `mol-${c.workBeadId}`, output, ok: true });

describe('classifyOutcome / extractArtifacts (vibesync-63zx.4)', () => {
  it('classifies completed / blocked / failed', () => {
    expect(classifyOutcome({ runId: 'r', output: 'done, PR opened', ok: true })).toBe('completed');
    expect(classifyOutcome({ runId: 'r', output: `${NEEDS_MERIDIAN_MARKER}: which db?`, ok: true })).toBe('blocked');
    expect(classifyOutcome({ runId: 'r', output: '', ok: false, error: 'boom' })).toBe('failed');
  });
  it('extracts PR/branch/commit artifacts', () => {
    const out = 'opened https://github.com/oculairmedia/vibesync/pull/42 on branch feat/x-1 sha ' + 'a'.repeat(40);
    const a = extractArtifacts(out);
    expect(a.prUrl).toBe('https://github.com/oculairmedia/vibesync/pull/42');
    expect(a.branch).toBe('feat/x-1');
    expect(a.commitSha).toBe('a'.repeat(40));
  });
});

describe('PropulsionExecutor (vibesync-63zx.4)', () => {
  it('propulsion: runs the reused dispatch path EXACTLY once — no survey/pre-flight turn', async () => {
    const { runner, calls } = fakeRunner(okResult('completed; PR opened'));
    const { pool } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: () => 'slot-0',
    });
    await exec.execute(candidate('w1'));
    // Exactly one run call, with the candidate directly — the agent is spawned
    // WITH the work on its hook, no separate survey turn.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.workBeadId).toBe('w1');
  });

  it('self-completion: a completed run records artifacts and FREES the slot', async () => {
    const { runner } = fakeRunner(okResult('done https://github.com/o/r/pull/7'));
    const { pool, freed } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: (w) => `slot-${w}`,
    });
    await exec.execute(candidate('w1'));
    expect(s.completed).toHaveLength(1);
    expect((s.completed[0] as { artifacts: { prUrl?: string } }).artifacts.prUrl).toBe('https://github.com/o/r/pull/7');
    expect(freed).toEqual(['slot-w1']); // slot freed
    expect(s.escalated).toHaveLength(0);
  });

  it('block: a NEEDS-MERIDIAN-DECISION run escalates AND frees the slot (does not idle, not a failure)', async () => {
    const { runner } = fakeRunner(okResult(`${NEEDS_MERIDIAN_MARKER}: pick A or B\nmore detail`));
    const { pool, freed } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: () => 'slot-b',
    });
    // Blocked is HANDLED (resolves) — not a dispatch failure.
    await expect(exec.execute(candidate('wb'))).resolves.toBeUndefined();
    expect(s.escalated).toHaveLength(1);
    expect((s.escalated[0] as { summary: string }).summary).toContain(NEEDS_MERIDIAN_MARKER);
    expect(freed).toEqual(['slot-b']); // slot freed even when blocked
    expect(s.completed).toHaveLength(0);
  });

  it('failure: a failed run frees the slot THEN rethrows (so the loop circuit breaker counts it)', async () => {
    const runner: DispatchRunner = { async run(c) { return { runId: `mol-${c.workBeadId}`, output: '', ok: false, error: 'exec failed' }; } };
    const { pool, freed } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: () => 'slot-f',
    });
    await expect(exec.execute(candidate('wf'))).rejects.toThrow(/exec failed/);
    expect(freed).toEqual(['slot-f']); // freed before rethrow
    expect(s.completed).toHaveLength(0);
    expect(s.escalated).toHaveLength(0);
  });

  it('runner throwing before returning still frees the slot and rethrows', async () => {
    const runner: DispatchRunner = { async run() { throw new Error('provider unreachable'); } };
    const { pool, freed } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: () => 'slot-x',
    });
    await expect(exec.execute(candidate('wx'))).rejects.toThrow(/provider unreachable/);
    expect(freed).toEqual(['slot-x']);
  });

  it('skips the free safely when no slot is tracked for the work bead', async () => {
    const { runner } = fakeRunner(okResult('done'));
    const { pool, freed } = fakePool();
    const s = sinks();
    const exec = new PropulsionExecutor({
      runner, pool, completion: s.completion, escalation: s.escalation,
      slotIdFor: () => null, // untracked
    });
    await exec.execute(candidate('w1'));
    expect(freed).toHaveLength(0); // nothing to free, no crash
    expect(s.completed).toHaveLength(1);
  });
});

describe('PropulsionExecutor end-to-end with SchedulerLoop + AgentPool (vibesync-63zx.4)', () => {
  it('freed slot triggers the next dispatch: pool_size=1, two ready beads dispatch across two ticks', async () => {
    const { AgentPool, SchedulerLoop } = await import('../../../../src/orchestration/scheduler/index.js');
    // Build the same fakes the 63zx.3 loop uses.
    const { InMemory } = await buildLoopHarness();
    const pool = new AgentPool({ members: [{ agentId: 'a0', role: 'coder', lettaBaseUrl: 'x' }] }); // size 1

    const executed: string[] = [];
    // slotIdFor: on dispatch, allocate a slot for the work bead and remember it.
    const slotByBead = new Map<string, string>();
    const runner: DispatchRunner = {
      async run(c) {
        const alloc = pool.allocate({ workBeadId: c.workBeadId });
        // Under capacity the loop only dispatches within free slots; alloc should succeed.
        if (alloc) slotByBead.set(c.workBeadId, alloc.slotId);
        executed.push(c.workBeadId);
        return { runId: `mol-${c.workBeadId}`, output: 'done', ok: true };
      },
    };
    const exec = new PropulsionExecutor({
      runner,
      pool: { onComplete: (s) => pool.onComplete(s) },
      completion: { async onCompleted() {} },
      escalation: { async onBlocked() {} },
      slotIdFor: (w) => slotByBead.get(w) ?? null,
    });

    const store = new InMemory([ctxRow('w1'), ctxRow('w2')]);
    const loop = new SchedulerLoop({
      config: () => ({ poolSize: 1, batchSize: 10, paused: false }),
      capacity: { get activeCount() { return pool.activeCount; } },
      contextStore: store,
      readyWork: { async readyWorkBeadIds() { return new Set(['w1', 'w2']); } },
      candidateMetadata: { async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; } },
      executor: exec,
    });

    // Tick 1: pool_size=1 → dispatch exactly w1; propulsion frees the slot on
    // completion so capacity returns.
    await loop.runTick();
    expect(executed).toEqual(['w1']);
    expect(pool.activeCount).toBe(0); // slot freed by self-completion

    // Tick 2: freed slot → next ready bead w2 dispatches.
    await loop.runTick();
    expect(executed).toEqual(['w1', 'w2']);
  });
});

// --- minimal harness for the end-to-end test ---
async function buildLoopHarness(): Promise<{ InMemory: typeof InMemoryStore }> {
  return { InMemory: InMemoryStore };
}

function ctxRow(workBeadId: string): import('../../../../src/orchestration/scheduler/sling-context.js').SlingContextRecord {
  return {
    id: `ctx-${workBeadId}`, status: 'open',
    params: {
      version: 1, work_bead_id: workBeadId, target_project: 'vibesync', formula: 'onboard-feature',
      args: '', vars: '', enqueued_at: '2026-07-17T20:00:00Z', merge: 'direct', convoy: '',
      dispatch_failures: 0, last_failure: '',
    },
  };
}

class InMemoryStore {
  constructor(private contexts: Array<import('../../../../src/orchestration/scheduler/sling-context.js').SlingContextRecord>) {}
  async queryPending() { return this.contexts.filter((c) => c.status === 'open'); }
  async closeContext(id: string) {
    const c = this.contexts.find((x) => x.id === id);
    if (c) (c as { status: string }).status = 'closed';
  }
  async recordDispatchFailure(id: string) {
    const c = this.contexts.find((x) => x.id === id);
    const n = ((c?.params.dispatch_failures ?? 0) + 1);
    if (c) (c.params as { dispatch_failures: number }).dispatch_failures = n;
    return n;
  }
}
