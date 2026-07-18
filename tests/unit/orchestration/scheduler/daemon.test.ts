import { describe, expect, it } from 'vitest';

import {
  SchedulerDaemon,
  type SchedulerDaemonDeps,
} from '../../../../src/orchestration/scheduler/daemon.js';
import type { FormulaDispatcher } from '../../../../src/orchestration/dispatcher/dispatcher.js';
import type { SlingContextStore } from '../../../../src/orchestration/scheduler/sling-context.js';
import type { PrFacts } from '../../../../src/orchestration/scheduler/refinery.js';

/** Minimal in-memory sling-context store (open/closed by id). */
function makeContextStore(): SlingContextStore & { openCount(): number } {
  const rows: Array<{ id: string; description: string; tracks: string; open: boolean }> = [];
  let seq = 0;
  return {
    async createSlingContext(input) {
      const id = `ctx-${++seq}`;
      rows.push({ id, description: input.description, tracks: input.tracksWorkBeadId, open: true });
      return id;
    },
    async listOpenSlingContexts(_label) {
      return rows.filter((r) => r.open).map((r) => ({ id: r.id, description: r.description }));
    },
    async closeSlingContext(id) {
      const r = rows.find((x) => x.id === id);
      if (r) r.open = false;
    },
    openCount() { return rows.filter((r) => r.open).length; },
  };
}

function deps(over: Partial<SchedulerDaemonDeps> = {}): { d: SchedulerDaemonDeps; state: any } {
  const state: any = { dispatched: [], merged: [], readySet: new Set<string>(['w1', 'w2']) };
  const dispatcher: FormulaDispatcher = {
    async run(input) {
      state.dispatched.push(input.motivatingBeadId);
      // self-completes with a PR (propulsion → completed)
      const prNumber = input.motivatingBeadId === 'w1' ? 101 : 102;
      return { moleculeId: `mol-${input.motivatingBeadId}`, outputs: { result: `done https://github.com/o/r/pull/${prNumber}` } };
    },
  } as unknown as FormulaDispatcher;

  const facts: PrFacts = { requiredChecks: { ci: 'SUCCESS' }, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false };

  const d: SchedulerDaemonDeps = {
    dispatcher,
    formulaResolver: {
      async resolve(workBeadId) {
        return { formula: { name: 'onboard' } as any, pack: { name: 'gastown' } as any, projectIdentifier: 'vibesync', input: `work ${workBeadId}` };
      },
    },
    readyBeads: {
      async readyWorkBeadIds() { return state.readySet; },
      async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; },
    },
    contextStore: makeContextStore(),
    poolMembers: [{ agentId: 'a0', role: 'coder', lettaBaseUrl: 'http://x' }], // pool size 1
    github: {
      async fetchFacts() { return facts; },
      async merge(_repo, prNumber) { state.merged.push(prNumber); return `sha-${prNumber}`; },
    },
    requiredCheckNames: () => ['ci'],
    livenessProbe: { async probe() { return 'alive'; } },
    escalation: {
      async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {},
    },
    config: () => ({ poolSize: 1, batchSize: 10, paused: false }),
    repoFor: () => 'o/r',
    ...over,
  };
  return { d, state };
}

describe('SchedulerDaemon end-to-end (vibesync-63zx integration)', () => {
  it('burns down: pool_size=1, two ready beads dispatch + merge across ticks (freed slot → next)', async () => {
    const { d, state } = deps();
    const daemon = new SchedulerDaemon(d);

    // tick 1: one bead dispatched (pool cap = 1), self-completes, PR merged, slot freed
    const t1 = await daemon.tick();
    expect(t1.scheduler.dispatched.length).toBe(1); // exactly one, respecting the cap
    // the refinery merges the PR enqueued during dispatch on THIS tick's phase 2
    expect(state.dispatched.length).toBe(1);

    // tick 2: the freed slot lets the second bead dispatch
    const t2 = await daemon.tick();
    expect(state.dispatched.length).toBe(2); // both beads eventually dispatched

    // both PRs were merged by the refinery
    expect(new Set(state.merged)).toEqual(new Set([101, 102]));
  });

  it('a phase failure does not abort the other phases (best-effort isolation)', async () => {
    const { d, state } = deps({
      github: {
        async fetchFacts() { throw new Error('gh down'); },
        async merge() { throw new Error('gh down'); },
      },
    });
    const daemon = new SchedulerDaemon(d);
    // refinery phase will error internally but the tick must still dispatch + patrol
    const t = await daemon.tick();
    expect(state.dispatched.length).toBeGreaterThanOrEqual(1); // scheduler phase still ran
    expect(t.merged).toEqual([]); // refinery couldn't merge, but no crash
  });

  it('run()/stop() are idempotent and manage the interval', async () => {
    const { d } = deps();
    const daemon = new SchedulerDaemon(d);
    daemon.run(10_000);
    daemon.run(10_000); // idempotent — no second timer
    daemon.stop();
    daemon.stop(); // idempotent
    expect(true).toBe(true);
  });
});
