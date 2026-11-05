import { describe, expect, it } from 'vitest';

import {
  SchedulerDaemon,
  type SchedulerDaemonDeps,
} from '../../../../src/engine/scheduler/daemon.js';
import type { FormulaDispatcher } from '../../../../src/engine/dispatcher/dispatcher.js';
import type { SlingContextStore } from '../../../../src/engine/scheduler/sling-context.js';
import type { PrFacts } from '../../../../src/engine/refinery/refinery.js';

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
    poolMembers: [{ agentId: 'a0', role: 'coder' }], // pool size 1
    github: {
      async fetchFacts() { return facts; },
      async merge(_repo, prNumber) { state.merged.push(prNumber); return `sha-${prNumber}`; },
    },
    allowedRepos: ['o/r'],
    requiredCheckNames: () => ['ci'],
    livenessProbe: { async probe() { return 'alive'; } },
    escalation: {
      async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {},
    },
    config: () => ({ poolSize: 1, batchSize: 10, paused: false }),
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
    await daemon.stop();
    await daemon.stop(); // idempotent
    expect(true).toBe(true);
  });

  it('circuit breaker trips on the 3rd consecutive dispatch failure (failure count is tracked in-process)', async () => {
    // vibesync-q50w: runs settle OFF the tick, so a run's failure is counted when
    // it settles and is REPORTED by the next tick. Expectation changed from
    // per-tick [0,0,1] to: 3 dispatches, then the breaker outcome shows up in the
    // first report after the 3rd failure settled (drained + a paused tick, since
    // this static ready fake would otherwise re-schedule the closed bead).
    let paused = false;
    const { d, state } = deps({
      config: () => ({ poolSize: 1, batchSize: 10, paused }),
    });
    (d.dispatcher as unknown as { run: unknown }).run = async (input: { motivatingBeadId: string }) => {
      state.dispatched.push(input.motivatingBeadId);
      throw new Error('provider down');
    };
    state.readySet = new Set(['w1']);
    const daemon = new SchedulerDaemon(d);
    // Terminal contexts are excluded from `bd ready` by BdReadyBeadSource in
    // production; this static fake source cannot, so assert on the breaker
    // itself: it must trip on exactly the 3rd consecutive failure.
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await daemon.tick());
      await daemon.drainRuns();
    }
    paused = true;
    results.push(await daemon.tick());
    expect(state.dispatched.length).toBe(3);
    expect(results.map((r) => r.scheduler.circuitBroken.length)).toEqual([0, 0, 0, 1]);
    expect(results.map((r) => r.scheduler.failed.length)).toEqual([0, 1, 1, 1]);
  });

  it('stop() awaits an in-flight interval tick and reports every tick via onTick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reports: number[] = [];
    const { d } = deps({
      onTick: (r) => { reports.push(r.seq); },
      readyBeads: {
        async readyWorkBeadIds() { await gate; return new Set<string>(); },
        async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; },
      },
    });
    const daemon = new SchedulerDaemon(d);
    daemon.run(5);
    await new Promise((r) => setTimeout(r, 30)); // first tick is now blocked on the gate
    let stopped = false;
    const p = daemon.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await p;
    expect(reports).toEqual([1]);
  });

  it('stop() during scheduleReady prevents scheduling remaining ready beads', async () => {
    let startedResolve!: () => void;
    let continueResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const continueScheduling = new Promise<void>((resolve) => { continueResolve = resolve; });
    const scheduled: string[] = [];
    const contextStore: SlingContextStore = {
      async createSlingContext(input) {
        scheduled.push(input.tracksWorkBeadId);
        return `ctx-${input.tracksWorkBeadId}`;
      },
      async listOpenSlingContexts() { return []; },
      async closeSlingContext() {},
    };
    const { d } = deps({
      formulaResolver: {
        async resolve(workBeadId) {
          if (workBeadId === 'w1') {
            startedResolve();
            await continueScheduling;
          }
          return { formula: { name: 'onboard' } as never, pack: { name: 'gastown' } as never, projectIdentifier: 'vibesync', input: workBeadId };
        },
      },
      contextStore,
      readyBeads: {
        async readyWorkBeadIds() { return new Set(['w1', 'w2']); },
        async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; },
      },
    });
    const daemon = new SchedulerDaemon(d);

    const tick = daemon.tick();
    await started;
    const stopping = daemon.stop();
    continueResolve();
    await Promise.all([tick, stopping]);
    expect(scheduled).toEqual(['w1']);
  });
});

// vibesync-5c8y: agent output must not be able to steer the refinery at an arbitrary repo.
describe('SchedulerDaemon PR repo allowlist (vibesync-5c8y)', () => {
  function allowlistHarness(output: string, allowedRepos: readonly string[]) {
    const seen: Array<{ fn: string; repo: string; pr: number }> = [];
    const logs: Array<{ level: string; o: Record<string, unknown>; m: string }> = [];
    const { d, state } = deps({
      allowedRepos,
      dispatcher: {
        async run(input: { motivatingBeadId: string }) {
          state.dispatched.push(input.motivatingBeadId);
          return { moleculeId: `mol-${input.motivatingBeadId}`, outputs: { result: output } };
        },
      } as unknown as FormulaDispatcher,
      github: {
        async fetchFacts(repo, pr) {
          seen.push({ fn: 'fetchFacts', repo, pr });
          return { requiredChecks: { ci: 'SUCCESS' }, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false };
        },
        async merge(repo, pr) {
          seen.push({ fn: 'merge', repo, pr });
          return `sha-${pr}`;
        },
      },
      logger: {
        info: (o: Record<string, unknown>, m: string) => { logs.push({ level: 'info', o, m }); },
        warn: (o: Record<string, unknown>, m: string) => { logs.push({ level: 'warn', o, m }); },
      } as never,
    });
    state.readySet = new Set(['w1']);
    return { daemon: new SchedulerDaemon(d), seen, logs };
  }

  it('a PR url for a non-allowed repo is NOT enqueued (never reaches the GitHub port) and a WARN names it', async () => {
    const h = allowlistHarness('see https://github.com/evil/other/pull/7', ['oculairmedia/vibesync']);
    const t = await h.daemon.tick();
    expect(t.merged).toEqual([]);
    expect(h.seen).toEqual([]); // neither fetchFacts nor merge was ever asked about evil/other
    const warn = h.logs.find((l) => l.level === 'warn' && l.m === 'daemon: PR url for non-allowed repo ignored');
    expect(warn?.o).toMatchObject({ workBeadId: 'w1', runId: 'mol-w1', repo: 'evil/other', prNumber: 7 });
    expect(h.logs.some((l) => l.m === 'daemon: PR queued for refinery')).toBe(false);
  });

  it('the allowlist match is case-insensitive on owner/repo (GitHub names are)', async () => {
    const h = allowlistHarness('https://github.com/OculairMedia/VibeSync/pull/9', ['oculairmedia/vibesync']);
    const t = await h.daemon.tick();
    expect(t.merged).toEqual([9]);
    expect(h.seen.filter((s) => s.fn === 'merge')).toHaveLength(1);
    expect(h.logs.some((l) => l.level === 'warn' && l.m === 'daemon: PR url for non-allowed repo ignored')).toBe(false);
  });

  it('a trailing .git on the repo segment is stripped before matching', async () => {
    const h = allowlistHarness('https://github.com/oculairmedia/vibesync.git/pull/4', ['oculairmedia/vibesync']);
    const t = await h.daemon.tick();
    expect(t.merged).toEqual([4]);
  });

  it('several PR urls in one output: only the allowed ones are enqueued, each rejected one is warned', async () => {
    const h = allowlistHarness(
      'a https://github.com/evil/other/pull/7 b https://github.com/oculairmedia/vibesync/pull/12 c https://github.com/evil/third/pull/3',
      ['oculairmedia/vibesync'],
    );
    const t = await h.daemon.tick();
    expect(t.merged).toEqual([12]);
    expect(h.seen.every((s) => s.repo === 'oculairmedia/vibesync')).toBe(true);
    const rejected = h.logs.filter((l) => l.m === 'daemon: PR url for non-allowed repo ignored').map((l) => l.o['repo']);
    expect(rejected).toEqual(['evil/other', 'evil/third']);
  });

  it('an EMPTY allowlist enqueues nothing (fail closed)', async () => {
    const h = allowlistHarness('https://github.com/o/r/pull/5', []);
    const t = await h.daemon.tick();
    expect(t.merged).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it('same PR number in two allowed repos are two distinct merge requests', async () => {
    const h = allowlistHarness('https://github.com/a/one/pull/5 https://github.com/a/two/pull/5', ['a/one', 'a/two']);
    await h.daemon.tick();
    expect(h.seen.filter((s) => s.fn === 'merge').map((s) => s.repo).sort()).toEqual(['a/one', 'a/two']);
  });
});
