/**
 * vibesync-q50w — a scheduler tick DISPATCHES and RETURNS; the run settles off
 * the tick.
 *
 * Every dispatcher fake here returns a promise the TEST controls (a deferred
 * that stays pending until released). The pre-existing daemon/boot fakes all
 * resolve immediately, which is exactly why "the tick awaits the whole LLM
 * run" was invisible to the suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SchedulerDaemon,
  type DaemonTickResult,
  type SchedulerDaemonDeps,
} from '../../../../src/orchestration/scheduler/daemon.js';
import type { FormulaDispatcher } from '../../../../src/orchestration/dispatcher/dispatcher.js';
import {
  tryParseParams,
  type SlingContextStore,
} from '../../../../src/orchestration/scheduler/sling-context.js';
import type { PrFacts } from '../../../../src/orchestration/scheduler/refinery.js';

interface Deferred {
  readonly beadId: string;
  readonly promise: Promise<{ moleculeId: string; outputs: Record<string, string> }>;
  resolve(output: string): void;
  reject(err: Error): void;
}

type CtxRow = { id: string; description: string; tracks: string; open: boolean; reason?: string };

/**
 * In-memory sling-context store that, like BdSlingContextStore, remembers
 * which work beads have a TERMINAL context (closed dispatched/circuit-broken).
 */
function makeStore(): SlingContextStore & {
  terminalWorkBeadIds(): Set<string>;
  rows: CtxRow[];
} {
  const rows: CtxRow[] = [];
  let seq = 0;
  return {
    rows,
    async createSlingContext(input) {
      const id = `ctx-${++seq}`;
      rows.push({ id, description: input.description, tracks: input.tracksWorkBeadId, open: true });
      return id;
    },
    async listOpenSlingContexts(_label) {
      return rows.filter((r) => r.open).map((r) => ({ id: r.id, description: r.description }));
    },
    async closeSlingContext(id, reason) {
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.open = false;
        r.reason = reason;
      }
    },
    terminalWorkBeadIds() {
      const out = new Set<string>();
      for (const r of rows) {
        if (r.open || r.reason === 'cleared') continue;
        const p = tryParseParams(r.description);
        if (p) out.add(p.work_bead_id);
      }
      return out;
    },
  };
}

function harness(opts: { beads: string[]; poolSize: number }) {
  const runs: Deferred[] = [];
  const merged: number[] = [];
  const probeCalls: string[] = [];
  const logs: Array<{ level: 'info' | 'warn'; o: unknown; m: string }> = [];
  const store = makeStore();
  const ready = new Set(opts.beads);
  const concurrentByBead = new Map<string, number>();
  let maxConcurrentByBead = 0;

  const dispatcher = {
    run(input: { motivatingBeadId: string }) {
      const beadId = input.motivatingBeadId;
      let resolveFn!: (v: { moleculeId: string; outputs: Record<string, string> }) => void;
      let rejectFn!: (e: Error) => void;
      const promise = new Promise<{ moleculeId: string; outputs: Record<string, string> }>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      const n = (concurrentByBead.get(beadId) ?? 0) + 1;
      concurrentByBead.set(beadId, n);
      maxConcurrentByBead = Math.max(maxConcurrentByBead, n);
      const settleCount = () => concurrentByBead.set(beadId, (concurrentByBead.get(beadId) ?? 1) - 1);
      const d: Deferred = {
        beadId,
        promise,
        resolve: (output) => {
          settleCount();
          resolveFn({ moleculeId: `mol-${beadId}-${runs.length}`, outputs: { result: output } });
        },
        reject: (err) => {
          settleCount();
          rejectFn(err);
        },
      };
      runs.push(d);
      return promise;
    },
  } as unknown as FormulaDispatcher;

  const facts: PrFacts = { requiredChecks: { ci: 'SUCCESS' }, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false };
  const deps: SchedulerDaemonDeps = {
    dispatcher,
    formulaResolver: {
      async resolve(workBeadId) {
        return { formula: { name: 'onboard' } as never, pack: { name: 'gastown' } as never, projectIdentifier: 'vibesync', input: `work ${workBeadId}` };
      },
    },
    readyBeads: {
      async readyWorkBeadIds() {
        const terminal = store.terminalWorkBeadIds();
        return new Set([...ready].filter((id) => !terminal.has(id)));
      },
      async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; },
    },
    contextStore: store,
    poolMembers: Array.from({ length: opts.poolSize }, (_, i) => ({ agentId: `a${i}`, role: 'coder', lettaBaseUrl: 'http://x' })),
    github: {
      async fetchFacts() { return facts; },
      async merge(_repo, prNumber) { merged.push(prNumber); return `sha-${prNumber}`; },
    },
    requiredCheckNames: () => ['ci'],
    livenessProbe: { async probe(slot) { probeCalls.push(slot.workBeadId); return 'alive'; } },
    escalation: { async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {} },
    config: () => ({ poolSize: opts.poolSize, batchSize: 10, paused: false }),
    logger: {
      info: (o, m) => { logs.push({ level: 'info', o, m }); },
      warn: (o, m) => { logs.push({ level: 'warn', o, m }); },
    },
  } as SchedulerDaemonDeps;

  const daemon = new SchedulerDaemon(deps);
  return {
    daemon, runs, merged, probeCalls, logs, store,
    maxConcurrentByBead: () => maxConcurrentByBead,
    runsFor: (id: string) => runs.filter((r) => r.beadId === id),
  };
}

/** A tick that does not return while runs are unresolved is the bug. */
async function tickReturns(daemon: SchedulerDaemon, ms = 300): Promise<DaemonTickResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`tick() did not return within ${ms}ms while runs were unresolved`)), ms);
  });
  try {
    return await Promise.race([daemon.tick(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SchedulerDaemon — dispatch off the tick (vibesync-q50w)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    // Release anything still pending so a hung (old-code) tick can unwind.
    for (const c of cleanups.splice(0)) c();
  });

  function track(h: ReturnType<typeof harness>) {
    cleanups.push(() => {
      for (const r of h.runs) r.resolve('released by test cleanup');
    });
    return h;
  }

  it('1. poolSize=2: ONE tick dispatches BOTH ready beads and returns while both runs are unresolved', async () => {
    const h = track(harness({ beads: ['w1', 'w2'], poolSize: 2 }));
    const t = await tickReturns(h.daemon);
    expect(h.runs.map((r) => r.beadId).sort()).toEqual(['w1', 'w2']);
    expect([...t.scheduler.dispatched].sort()).toEqual(['w1', 'w2']);
  });

  it('2. witness patrols on later ticks while runs are still in flight', async () => {
    const h = track(harness({ beads: ['w1', 'w2'], poolSize: 2 }));
    await tickReturns(h.daemon);
    h.probeCalls.length = 0;
    await tickReturns(h.daemon); // both runs still unresolved
    expect([...h.probeCalls].sort()).toEqual(['w1', 'w2']);
    expect(h.runs).toHaveLength(2); // no re-dispatch of in-flight beads
  });

  it('3. stop() resolves while runs are unresolved and logs the in-flight bead ids', async () => {
    const h = track(harness({ beads: ['w1', 'w2'], poolSize: 2 }));
    h.daemon.run(5);
    await vi.waitFor(() => expect(h.runs).toHaveLength(2), { timeout: 1000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      h.daemon.stop().then(() => true),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 300); }),
    ]);
    clearTimeout(timer);
    expect(stopped, 'stop() must not wait for the LLM runs').toBe(true);
    const entry = h.logs.find((l) => {
      const ids = (l.o as { inFlightWorkBeadIds?: string[] } | null)?.inFlightWorkBeadIds;
      return Array.isArray(ids) && [...ids].sort().join() === 'w1,w2';
    });
    expect(entry, 'stop must log inFlightWorkBeadIds').toBeDefined();
    await h.daemon.stop(); // idempotent
  });

  it('4. releasing one run frees its slot, enqueues its PR, and the next tick dispatches a third bead', async () => {
    const h = track(harness({ beads: ['w1', 'w2', 'w3'], poolSize: 2 }));
    await tickReturns(h.daemon);
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1', 'w2']); // capacity 2 → w3 waits
    await tickReturns(h.daemon);
    expect(h.runs).toHaveLength(2); // still full

    h.runsFor('w1')[0]!.resolve('done https://github.com/o/r/pull/101');
    // The slot is freed and the PR is enqueued by the off-tick settlement; the
    // tick that sees it dispatches w3 and the refinery phase merges the PR.
    await vi.waitFor(async () => {
      await tickReturns(h.daemon);
      expect(h.runs.map((r) => r.beadId)).toContain('w3');
    }, { timeout: 1500 });
    await vi.waitFor(async () => {
      await tickReturns(h.daemon);
      expect(h.merged).toContain(101);
    }, { timeout: 1500 });
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1', 'w2', 'w3']);
    expect(h.runsFor('w1')).toHaveLength(1); // completed bead is not re-dispatched
  });

  it('5. a run that fails 3 times is circuit-broken (not a 4th run); a completed run is never re-dispatched', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = track(harness({ beads: ['wf', 'wc'], poolSize: 2 }));

      // Round 1: both dispatched; wc completes, wf fails.
      await tickReturns(h.daemon);
      expect(h.runs.map((r) => r.beadId).sort()).toEqual(['wc', 'wf']);
      h.runsFor('wc')[0]!.resolve('done, no pr');
      h.runsFor('wf')[0]!.reject(new Error('provider down 1'));

      for (const attempt of [2, 3]) {
        // wf is retried each time its failure has settled (never while in flight).
        await vi.waitFor(async () => {
          await tickReturns(h.daemon);
          expect(h.runsFor('wf')).toHaveLength(attempt);
        }, { timeout: 1500 });
        h.runsFor('wf')[attempt - 1]!.reject(new Error(`provider down ${attempt}`));
      }

      // After the 3rd failure settles the breaker must hold: no 4th run.
      await sleep(50);
      for (let i = 0; i < 4; i += 1) {
        await tickReturns(h.daemon);
        await sleep(10);
      }
      expect(h.runsFor('wf')).toHaveLength(3);
      expect(h.runsFor('wc')).toHaveLength(1); // success → closed → not re-dispatched
      const wfCtx = h.store.rows.filter((r) => r.tracks === 'wf');
      expect(wfCtx.every((r) => !r.open)).toBe(true);
      expect(wfCtx.map((r) => r.reason)).toContain('circuit-broken');
      expect(h.store.rows.find((r) => r.tracks === 'wc')?.reason).toBe('dispatched');
      await sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('6. the same bead never has two concurrent runs, across many ticks', async () => {
    const h = track(harness({ beads: ['w1'], poolSize: 2 }));
    await tickReturns(h.daemon);
    for (let i = 0; i < 4; i += 1) await tickReturns(h.daemon);
    expect(h.runsFor('w1')).toHaveLength(1);
    expect(h.maxConcurrentByBead()).toBe(1);

    // Fail it: the retry may only start after the first run settled.
    h.runsFor('w1')[0]!.reject(new Error('boom'));
    await vi.waitFor(async () => {
      await tickReturns(h.daemon);
      expect(h.runsFor('w1')).toHaveLength(2);
    }, { timeout: 1500 });
    expect(h.maxConcurrentByBead()).toBe(1);
  });
});
