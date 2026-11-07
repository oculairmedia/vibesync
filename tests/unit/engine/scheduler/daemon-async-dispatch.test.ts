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
} from '../../../../src/engine/scheduler/daemon.js';
import type { FormulaDispatcher } from '../../../../src/engine/dispatcher/dispatcher.js';
import { FormulaEscalationError } from '../../../../src/engine/dispatcher/dispatcher.js';
import {
  tryParseParams,
  type SlingContextStore,
} from '../../../../src/engine/scheduler/sling-context.js';
import type { RunLiveness } from '../../../../src/engine/scheduler/witness.js';
import type { AgentPool } from '../../../../src/engine/scheduler/agent-pool.js';
import type { PrFacts } from '../../../../src/engine/refinery/refinery.js';

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

function harness(opts: { beads: string[]; poolSize: number; store?: ReturnType<typeof makeStore>; onRunEscalated?: SchedulerDaemonDeps['onRunEscalated'] }) {
  const runs: Deferred[] = [];
  const merged: number[] = [];
  const probeCalls: string[] = [];
  /** Per-bead probe verdict override (default 'alive'). */
  const verdicts = new Map<string, RunLiveness>();
  const logs: Array<{ level: 'info' | 'warn'; o: unknown; m: string }> = [];
  const store = opts.store ?? makeStore();
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
    ...(opts.onRunEscalated ? { onRunEscalated: opts.onRunEscalated } : {}),
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
    poolMembers: Array.from({ length: opts.poolSize }, (_, i) => ({ agentId: `a${i}`, role: 'coder' })),
    github: {
      async fetchFacts() { return facts; },
      async merge(_repo, prNumber) { merged.push(prNumber); return `sha-${prNumber}`; },
    },
    allowedRepos: ['o/r'],
    requiredCheckNames: () => ['ci'],
    livenessProbe: { async probe(slot) { probeCalls.push(slot.workBeadId); return verdicts.get(slot.workBeadId) ?? 'alive'; } },
    escalation: { async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {} },
    config: () => ({ poolSize: opts.poolSize, batchSize: 10, paused: false }),
    logger: {
      info: (o, m) => { logs.push({ level: 'info', o, m }); },
      warn: (o, m) => { logs.push({ level: 'warn', o, m }); },
    },
  } as SchedulerDaemonDeps;

  const daemon = new SchedulerDaemon(deps);
  return {
    daemon, runs, merged, probeCalls, logs, store, verdicts,
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

  it('5b. (vibesync-9lzk.43) an ESCALATED run is not retried: its context closes as escalated, no 2nd run, not circuit-broken', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = track(harness({ beads: ['we', 'wi'], poolSize: 2 }));
      await tickReturns(h.daemon);
      expect(h.runs.map((r) => r.beadId).sort()).toEqual(['we', 'wi']);
      // Round 13: the review loop ran 3 rounds and escalated. The dispatcher's error for that:
      h.runsFor('we')[0]!.reject(new FormulaEscalationError('FormulaDispatcher: step "reviewer" escalated: review loop exhausted after 3 rounds; escalated', 'mol-we-1'));
      // A plain infra failure on the other bead is still retried.
      h.runsFor('wi')[0]!.reject(new Error('provider down'));
      await vi.waitFor(async () => {
        await tickReturns(h.daemon);
        expect(h.runsFor('wi')).toHaveLength(2);
      }, { timeout: 1500 });
      for (let i = 0; i < 4; i += 1) {
        await tickReturns(h.daemon);
        await sleep(10);
      }
      expect(h.runsFor('we')).toHaveLength(1);
      const weCtx = h.store.rows.filter((r) => r.tracks === 'we');
      expect(weCtx.every((r) => !r.open)).toBe(true);
      expect(weCtx.map((r) => r.reason)).toEqual(['escalated']);
      h.runsFor('wi')[1]!.resolve('done');
      await sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('5c. (vibesync-9lzk.53) an escalated run notifies the observer once with the bead and the reason; a plain failure does not', async () => {
    const seen: Array<{ workBeadId: string; reason: string }> = [];
    const h = track(harness({ beads: ['we', 'wi'], poolSize: 2, onRunEscalated: (i) => { seen.push({ workBeadId: i.workBeadId, reason: i.reason }); } }));
    await tickReturns(h.daemon);
    h.runsFor('we')[0]!.reject(new FormulaEscalationError('FormulaDispatcher: step "reviewer" escalated: review loop exhausted after 3 rounds; escalated', 'mol-we-1'));
    h.runsFor('wi')[0]!.reject(new Error('provider down'));
    await vi.waitFor(() => { expect(seen).toHaveLength(1); }, { timeout: 1500 });
    expect(seen[0]).toMatchObject({ workBeadId: 'we' });
    expect(seen[0]!.reason).toContain('review loop exhausted');
    await sleep(50);
    expect(seen).toHaveLength(1); // wi (plain failure) never notified; we not notified twice
  });

  it('5d. (vibesync-9lzk.53) an observer that throws never breaks settlement: the context still closes as escalated', async () => {
    const h = track(harness({ beads: ['we'], poolSize: 1, onRunEscalated: () => { throw new Error('wake exploded'); } }));
    await tickReturns(h.daemon);
    h.runsFor('we')[0]!.reject(new FormulaEscalationError('step "tester" escalated: x', 'mol-we-1'));
    await vi.waitFor(() => { expect(h.store.rows.filter((r) => r.tracks === 'we').map((r) => r.reason)).toEqual(['escalated']); }, { timeout: 1500 });
    // The failure is contained by the observer guard itself, not by the outer settlement catch:
    // the loop's own message appears and 'run settlement bookkeeping failed' does not.
    await vi.waitFor(() => { expect(h.logs.some((l) => l.m === 'scheduler: onRunEscalated observer failed')).toBe(true); }, { timeout: 1500 });
    expect(h.logs.some((l) => l.m === 'scheduler: run settlement bookkeeping failed')).toBe(false);
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

/**
 * vibesync-nic6 — the witness must not reap a slot whose run is still in
 * flight. A coder normally closes its own bead before its formula run ends, so
 * the probe says 'bead-closed' while the run is genuinely unfinished.
 *
 * The dispatcher fakes are deferreds that stay pending across every witness
 * patrol; a fake that resolved before the patrol would pass vacuously.
 */
describe('SchedulerDaemon — witness vs in-flight runs (vibesync-nic6)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function track(h: ReturnType<typeof harness>) {
    cleanups.push(() => {
      for (const r of h.runs) r.resolve('released by test cleanup');
    });
    return h;
  }

  const poolOf = (h: ReturnType<typeof harness>) => (h.daemon as unknown as { pool: AgentPool }).pool;
  const working = (h: ReturnType<typeof harness>) =>
    poolOf(h).view().filter((s) => s.state === 'working').map((s) => s.session!.workBeadId);

  it('1. bead closed while its run is in flight: witness patrols, slot NOT freed, next bead NOT dispatched', async () => {
    const h = track(harness({ beads: ['w1', 'w2'], poolSize: 1 }));
    await tickReturns(h.daemon);
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1']); // pool=1 → w2 waits
    h.verdicts.set('w1', 'bead-closed'); // agent closed its own bead; the run is NOT finished
    h.probeCalls.length = 0;

    const t = await tickReturns(h.daemon);
    expect(h.probeCalls, 'the witness must actually have patrolled w1').toEqual(['w1']);
    expect(t.recovered, 'in-flight slot must not be reaped').toEqual([]);
    expect(working(h)).toEqual(['w1']);
    expect(t.scheduler.dispatched).toEqual([]);
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1']); // w2 NOT started on w1's capacity
    // and it stays that way across further ticks
    for (let i = 0; i < 3; i += 1) await tickReturns(h.daemon);
    expect(working(h)).toEqual(['w1']);
    expect(h.runs).toHaveLength(1);
  });

  it('2. when the in-flight run settles its slot is freed exactly once; w2 then dispatches; pool never exceeds poolSize', async () => {
    const h = track(harness({ beads: ['w1', 'w2'], poolSize: 1 }));
    const maxWorking = { n: 0 };
    const sample = () => { maxWorking.n = Math.max(maxWorking.n, working(h).length); };
    const freeCalls: string[] = [];
    const pool = poolOf(h);
    const origOnComplete = pool.onComplete.bind(pool);
    pool.onComplete = (slotId: string) => {
      const freed = origOnComplete(slotId);
      if (freed) freeCalls.push(slotId);
      return freed;
    };

    await tickReturns(h.daemon); sample();
    h.verdicts.set('w1', 'bead-closed');
    for (let i = 0; i < 3; i += 1) { await tickReturns(h.daemon); sample(); }
    expect(h.runs).toHaveLength(1);
    expect(freeCalls).toEqual([]); // nothing freed while in flight

    h.runsFor('w1')[0]!.resolve('done, no pr');
    await vi.waitFor(async () => {
      await tickReturns(h.daemon); sample();
      expect(h.runs.map((r) => r.beadId)).toContain('w2');
    }, { timeout: 1500 });
    sample();
    for (let i = 0; i < 3; i += 1) { await tickReturns(h.daemon); sample(); }

    expect(freeCalls, 'w1 slot freed exactly once (by its settlement)').toHaveLength(1);
    expect(working(h)).toEqual(['w2']);
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1', 'w2']);
    expect(maxWorking.n).toBe(1);
    expect(poolOf(h).view().filter((s) => s.state === 'idle')).toHaveLength(0);
  });

  it('3. NO run in flight + bead closed (crash/zombie): witness still reaps the slot', async () => {
    const h = track(harness({ beads: [], poolSize: 1 }));
    // A working slot whose run the scheduler does not track (lost dispatch).
    const alloc = poolOf(h).allocate({ workBeadId: 'wz' });
    expect(alloc).not.toBeNull();
    h.verdicts.set('wz', 'bead-closed');

    const t = await tickReturns(h.daemon);
    expect(t.recovered).toEqual([alloc!.slotId]);
    expect(working(h)).toEqual([]);
  });
});

describe('SchedulerDaemon — restart re-runs interrupted work (vibesync-9lzk.9)', () => {
  it('a run killed by a restart is dispatched again by the next process; a finished one is not', async () => {
    // The sling-context store outlives the process, as bd does in production.
    const store = makeStore();
    const before = harness({ beads: ['w1', 'w2'], poolSize: 2, store });
    await tickReturns(before.daemon);
    expect(before.runs.map((r) => r.beadId).sort()).toEqual(['w1', 'w2']);
    before.runsFor('w2')[0]!.resolve('done');            // w2 finishes before the restart
    // Wait for w2's settlement to close its context; drainRuns() would also
    // wait on w1, which by design never settles (the restart kills it).
    for (let i = 0; i < 100 && store.rows.some((r) => r.open && tryParseParams(r.description)?.work_bead_id === 'w2'); i++) await sleep(5);
    expect(store.rows.find((r) => tryParseParams(r.description)?.work_bead_id === 'w2')).toMatchObject({ open: false, reason: 'dispatched' });
    expect(store.rows.find((r) => tryParseParams(r.description)?.work_bead_id === 'w1')).toMatchObject({ open: true });
    // Restart: w1's run dies with the process. Its run never settles, so its
    // context is still open; nothing in the new process knows about it.
    await before.daemon.stop();

    const after = harness({ beads: ['w1', 'w2'], poolSize: 2, store });
    await tickReturns(after.daemon);
    expect(after.runs.map((r) => r.beadId)).toEqual(['w1']);
    await after.daemon.stop();
  });
});
