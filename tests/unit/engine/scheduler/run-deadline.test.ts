/**
 * vibesync-izn3 — every started formula run has a deadline.
 *
 * Since q50w/nic6 a started run owns its pool slot until it SETTLES and the
 * witness deliberately does not reap in-flight slots, so a run that never
 * settles (hung provider, stuck stream) would hold its slot forever. Past its
 * deadline the daemon cancels the molecule, counts ONE failure on the sling
 * context, frees the slot ONCE and asks for a prompt tick.
 *
 * Every dispatcher fake is a deferred the TEST controls, fake timers drive the
 * clock, the deadline (10 s) is far below the interval (10 min). FALSE PASS this
 * suite guards against: a run that settles before the deadline elapses proves
 * nothing about the deadline — every "expired" assertion first asserts the
 * deadline timer is armed and the run is still unsettled when it fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SchedulerDaemon,
  type DaemonTickReport,
  type SchedulerDaemonDeps,
} from '../../../../src/engine/scheduler/daemon.js';
import { FormulaCancellationConflictError, type FormulaDispatcher } from '../../../../src/engine/dispatcher/dispatcher.js';
import { tryParseParams, type SlingContextStore } from '../../../../src/engine/scheduler/sling-context.js';
import type { AgentPool } from '../../../../src/engine/scheduler/agent-pool.js';

const DEADLINE = 10_000;
const INTERVAL = 600_000;

type Outcome = { moleculeId: string; outputs: Record<string, string> };
interface Run {
  readonly beadId: string;
  readonly moleculeId: string;
  resolve(output?: string): void;
  reject(err: Error): void;
}
type CancelMode = 'ok' | 'conflict' | 'throw' | 'hang';
type CtxRow = { id: string; description: string; tracks: string; open: boolean; reason?: string };

function makeStore(): SlingContextStore & { rows: CtxRow[]; terminalWorkBeadIds(): Set<string> } {
  const rows: CtxRow[] = [];
  let seq = 0;
  return {
    rows,
    async createSlingContext(input) {
      const id = `ctx-${++seq}`;
      rows.push({ id, description: input.description, tracks: input.tracksWorkBeadId, open: true });
      return id;
    },
    async listOpenSlingContexts() {
      return rows.filter((r) => r.open).map((r) => ({ id: r.id, description: r.description }));
    },
    async closeSlingContext(id, reason) {
      const r = rows.find((x) => x.id === id);
      if (r) { r.open = false; r.reason = reason; }
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

function harness(opts: {
  beads: string[];
  poolSize?: number;
  runDeadlineMs?: number;
  runDeadlineFor?: (id: string) => number | undefined;
  cancelMode?: CancelMode;
  /** When false the fake dispatcher never calls onStarted (no molecule id is learned). */
  reportMolecule?: boolean;
  /** The daemon's onRunExpired observer. */
  onRunExpired?: (input: { workBeadId: string; moleculeId: string | undefined; deadlineMs: number; elapsedMs: number }) => void;
  /** The daemon's onTickRequested observer. */
  onTickRequested?: (reason: string, detail: string | undefined) => void;
}) {
  const runs: Run[] = [];
  const cancels: string[] = [];
  const logs: Array<{ level: 'info' | 'warn'; o: Record<string, unknown>; m: string }> = [];
  const reports: DaemonTickReport[] = [];
  const store = makeStore();
  const ready = new Set(opts.beads);
  const priority = new Map<string, number>();
  let cancelMode: CancelMode = opts.cancelMode ?? 'ok';

  const dispatcher = {
    run(input: { motivatingBeadId: string; onStarted?: (id: string) => void }) {
      const beadId = input.motivatingBeadId;
      const moleculeId = `mol-${beadId}-${runs.length + 1}`;
      if (opts.reportMolecule !== false) input.onStarted?.(moleculeId);
      let res!: (v: Outcome) => void;
      let rej!: (e: Error) => void;
      const promise = new Promise<Outcome>((a, b) => { res = a; rej = b; });
      runs.push({
        beadId,
        moleculeId,
        resolve: (output = 'done') => res({ moleculeId, outputs: { result: output } }),
        reject: (err) => rej(err),
      });
      return promise;
    },
    async cancel(moleculeId: string) {
      cancels.push(moleculeId);
      if (cancelMode === 'conflict') throw new FormulaCancellationConflictError(`molecule ${moleculeId} has no running steps to cancel`, moleculeId);
      if (cancelMode === 'throw') throw new Error('provider stop failed');
      if (cancelMode === 'hang') return new Promise<never>(() => {});
      return { moleculeId, cancelledStepCount: 1 };
    },
  } as unknown as FormulaDispatcher;

  const deps = {
    dispatcher,
    formulaResolver: {
      async resolve(workBeadId: string) {
        return { formula: { name: 'onboard' } as never, pack: { name: 'gastown' } as never, projectIdentifier: 'vibesync', input: `work ${workBeadId}` };
      },
    },
    readyBeads: {
      async readyWorkBeadIds() {
        const terminal = store.terminalWorkBeadIds();
        return new Set([...ready].filter((id) => !terminal.has(id)));
      },
      async metadataFor(id: string) { return { priority: priority.get(id) ?? 2, unblockCount: 0, files: [] }; },
    },
    contextStore: store,
    poolMembers: Array.from({ length: opts.poolSize ?? 1 }, (_, i) => ({ agentId: `a${i}`, role: 'coder' })),
    github: {
      async fetchFacts() { return { requiredChecks: { ci: 'SUCCESS' }, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false }; },
      async merge() { return 'sha'; },
    },
    requiredCheckNames: () => ['ci'],
    livenessProbe: { async probe() { return 'alive'; } },
    escalation: { async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {} },
    config: () => ({ poolSize: opts.poolSize ?? 1, batchSize: 10, paused: false }),
    ...(opts.runDeadlineMs !== undefined ? { runDeadlineMs: opts.runDeadlineMs } : { runDeadlineMs: DEADLINE }),
    ...(opts.runDeadlineFor ? { runDeadlineFor: opts.runDeadlineFor } : {}),
    ...(opts.onRunExpired ? { onRunExpired: opts.onRunExpired } : {}),
    ...(opts.onTickRequested ? { onTickRequested: opts.onTickRequested } : {}),
    onTick: (r: DaemonTickReport) => { reports.push(r); },
    logger: {
      info: (o: unknown, m: string) => { logs.push({ level: 'info', o: o as Record<string, unknown>, m }); },
      warn: (o: unknown, m: string) => { logs.push({ level: 'warn', o: o as Record<string, unknown>, m }); },
    },
  } as unknown as SchedulerDaemonDeps;

  const daemon = new SchedulerDaemon(deps);
  const pool = (daemon as unknown as { pool: AgentPool }).pool;
  const onComplete = vi.spyOn(pool, 'onComplete');
  return {
    daemon, runs, cancels, logs, reports, store, ready, priority, onComplete,
    setCancelMode: (m: CancelMode) => { cancelMode = m; },
    runsFor: (id: string) => runs.filter((r) => r.beadId === id),
    workingBeads: () => pool.view().filter((s) => s.state === 'working').map((s) => s.session!.workBeadId),
    /** dispatch_failures the daemon has counted on this bead's sling context. */
    failuresFor: (id: string) => {
      const ctx = store.rows.find((r) => r.tracks === id);
      const counts = (daemon as unknown as { failureCounts: Map<string, number> }).failureCounts;
      return ctx ? (counts.get(ctx.id) ?? 0) : 0;
    },
  };
}

/** Let promise chains (cancel, settlement, bookkeeping) drain without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

describe('SchedulerDaemon — run deadline (vibesync-izn3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('1. a hung run is cancelled at its deadline: cancel once, slot freed once, ONE failure counted, a later tick dispatches another bead', async () => {
    const h = harness({ beads: ['w1'] });
    await h.daemon.tick();
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1']);
    expect(h.workingBeads()).toEqual(['w1']);
    expect(vi.getTimerCount()).toBe(1); // the armed deadline timer: the run is genuinely unsettled

    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(h.cancels).toEqual([]); // not before the deadline
    expect(h.workingBeads()).toEqual(['w1']);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.cancels).toEqual(['mol-w1-1']); // cancel called ONCE, with the molecule id learned early
    expect(h.onComplete).toHaveBeenCalledTimes(1); // slot freed ONCE
    expect(h.workingBeads()).toEqual([]);
    expect(h.failuresFor('w1')).toBe(1); // failure counted on its sling context
    expect(vi.getTimerCount()).toBe(0);
    const warn = h.logs.find((l) => l.m.includes('exceeded its deadline'));
    expect(warn?.level).toBe('warn');
    expect(warn?.o).toMatchObject({ workBeadId: 'w1', moleculeId: 'mol-w1-1', elapsedMs: DEADLINE });

    // A later tick can dispatch other work: w2 is higher priority than the (still retryable) w1.
    h.ready.add('w2');
    h.priority.set('w2', 0);
    await h.daemon.tick();
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1', 'w2']);
    expect(h.workingBeads()).toEqual(['w2']);
  });

  it('1b. expiry requests a prompt tick (reason run-finished) — the freed slot is used without waiting for the interval', async () => {
    const h = harness({ beads: ['w1'] });
    h.daemon.run(INTERVAL);
    await h.daemon.tick();
    expect(h.runs).toHaveLength(1);
    h.ready.add('w2');
    h.priority.set('w2', 0);
    h.reports.length = 0;

    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.runs.map((r) => r.beadId)).toEqual(['w1', 'w2']); // dispatched by the event tick, interval is 600 s away
    expect(h.reports.map((r) => r.reason)).toContain('run-finished');
    expect(h.reports.map((r) => r.reason)).not.toContain('interval');
    await h.daemon.stop();
  });

  it('2b. (CodeRabbit #51) a throw while enqueueing the PR still settles the run and frees the slot, even with no deadline armed', async () => {
    const h = harness({ beads: ['w1'], runDeadlineMs: 0 });
    // Make the PR-enqueue step throw (stand-in for any throwing collaborator inside it).
    (h.daemon as unknown as { maybeEnqueuePr: () => void }).maybeEnqueuePr = () => { throw new Error('enqueue exploded'); };
    await h.daemon.tick();
    expect(vi.getTimerCount()).toBe(0); // deadline disabled: nothing else would ever free the slot
    h.runsFor('w1')[0]!.resolve('done https://github.com/oculairmedia/vibesync/pull/1');
    await flush();
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.workingBeads()).toEqual([]);
    expect(h.logs.some((l) => l.level === 'warn' && /enqueue/i.test(l.m))).toBe(true);
  });

  it('2c. (CodeRabbit #51) a deadline above the setTimeout maximum is clamped, not fired after 1 ms', async () => {
    const h = harness({ beads: ['w1'], runDeadlineMs: 3_000_000_000 });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(10_000); // a 1 ms overflow would have cancelled by now
    expect(h.cancels).toEqual([]);
    expect(h.workingBeads()).toEqual(['w1']);
  });

  it('2. a run that settles BEFORE the deadline is not cancelled and leaves no timer', async () => {
    const h = harness({ beads: ['w1'] });
    await h.daemon.tick();
    expect(vi.getTimerCount()).toBe(1); // deadline armed while the run is in flight
    await vi.advanceTimersByTimeAsync(DEADLINE / 2);
    h.runsFor('w1')[0]!.resolve('fine');
    await flush();
    expect(vi.getTimerCount()).toBe(0); // timer cleared on settle
    expect(h.onComplete).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEADLINE * 3); // well past where the deadline would have fired
    expect(h.cancels).toEqual([]);
    expect(h.failuresFor('w1')).toBe(0);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.store.rows.find((r) => r.tracks === 'w1')?.reason).toBe('dispatched');
  });

  it.each([
    ['resolves', (r: Run) => r.resolve('late')],
    ['rejects', (r: Run) => r.reject(new Error('late boom'))],
  ])('3. a cancelled run that later %s is ignored: no second slot free (not even of a re-dispatched run), no second failure', async (_name, settle) => {
    const h = harness({ beads: ['w1'] });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.failuresFor('w1')).toBe(1);

    // w1 stays retryable: a new run of the SAME bead takes a new slot.
    await h.daemon.tick();
    expect(h.runsFor('w1')).toHaveLength(2);
    expect(h.workingBeads()).toEqual(['w1']);

    settle(h.runsFor('w1')[0]!); // the cancelled run limps home late
    await flush();
    expect(h.onComplete).toHaveBeenCalledTimes(1); // the live run's slot was NOT freed by the stale settlement
    expect(h.workingBeads()).toEqual(['w1']);
    expect(h.failuresFor('w1')).toBe(1);
    expect(h.cancels).toEqual(['mol-w1-1']);
    expect(h.store.rows.find((r) => r.tracks === 'w1')?.open).toBe(true); // not closed by the stale 'ok'
  });

  it.each([
    ['conflict (no running step yet)', 'conflict' as const],
    ['a generic throw', 'throw' as const],
  ])('4. cancel() failing with %s: slot still freed once, failure counted once', async (_name, mode) => {
    const h = harness({ beads: ['w1'], cancelMode: mode });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toEqual(['mol-w1-1']);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.workingBeads()).toEqual([]);
    expect(h.failuresFor('w1')).toBe(1);
    expect(h.logs.some((l) => l.level === 'warn' && l.m.includes('cancel of expired run failed'))).toBe(true);

    h.runsFor('w1')[0]!.reject(new Error('unwound by itself')); // the "conflict" run then fails on its own
    await flush();
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.failuresFor('w1')).toBe(1);
  });

  it('4b. a cancel() that HANGS cannot hold the slot: freed after the grace period', async () => {
    const h = harness({ beads: ['w1'], cancelMode: 'hang' });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toEqual(['mol-w1-1']);
    expect(h.workingBeads()).toEqual(['w1']); // still waiting on the (hung) cancel
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(h.workingBeads()).toEqual([]);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.failuresFor('w1')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('4c. a run that never reported a molecule id has nothing to cancel, but still frees its slot and counts the failure', async () => {
    const h = harness({ beads: ['w1'], reportMolecule: false });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toEqual([]);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.failuresFor('w1')).toBe(1);
  });

  it('4d. the expiry observer is told once, with the bead, the molecule and the timings', async () => {
    const seen: unknown[] = [];
    const h = harness({ beads: ['w1'], onRunExpired: (i) => { seen.push(i); } });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(seen).toEqual([{ workBeadId: 'w1', moleculeId: 'mol-w1-1', deadlineMs: DEADLINE, elapsedMs: DEADLINE }]);
  });

  it('4e. an observer that throws does not stop the expiry: the run is still cancelled and its slot freed', async () => {
    const h = harness({ beads: ['w1'], onRunExpired: () => { throw new Error('observer failed'); } });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toEqual(['mol-w1-1']);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
    expect(h.failuresFor('w1')).toBe(1);
    expect(h.logs.find((l) => l.m.includes('onRunExpired observer failed'))?.o).toMatchObject({ workBeadId: 'w1', error: 'observer failed' });
    expect(h.logs.some((l) => l.m.includes('deadline handling failed'))).toBe(false);
  });

  it('4f. a failed cancel is contained in the cancel step: one "cancel failed" warning, no "deadline handling failed"', async () => {
    const h = harness({ beads: ['w1'], cancelMode: 'throw' });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.logs.filter((l) => l.m.includes('cancel of expired run failed'))).toHaveLength(1);
    expect(h.logs.some((l) => l.m.includes('deadline handling failed'))).toBe(false);
    expect(h.onComplete).toHaveBeenCalledTimes(1);
  });

  it('4g. the expired run fails with a message naming its deadline and how long it ran', async () => {
    const h = harness({ beads: ['w1'] });
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    const failed = h.logs.find((l) => l.m.includes('dispatch failed'));
    expect(failed?.o['error']).toBe(`run exceeded its deadline of ${DEADLINE}ms (cancelled after ${DEADLINE}ms)`);
  });

  it('5. three deadline expiries on the same bead circuit-break it: no 4th dispatch', async () => {
    const h = harness({ beads: ['w1'] });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.daemon.tick();
      expect(h.runsFor('w1')).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(DEADLINE);
      await flush();
      expect(h.failuresFor('w1')).toBe(attempt);
    }
    expect(h.cancels).toEqual(['mol-w1-1', 'mol-w1-2', 'mol-w1-3']);
    for (let i = 0; i < 4; i += 1) await h.daemon.tick();
    expect(h.runsFor('w1')).toHaveLength(3);
    const ctxRows = h.store.rows.filter((r) => r.tracks === 'w1');
    expect(ctxRows.every((r) => !r.open)).toBe(true);
    expect(ctxRows.map((r) => r.reason)).toContain('circuit-broken');
    expect(h.onComplete).toHaveBeenCalledTimes(3);
  });

  it('6. stop() with a run in flight clears its deadline timer: no timers left, nothing fires afterwards', async () => {
    const h = harness({ beads: ['w1'] });
    h.daemon.run(INTERVAL);
    const base = vi.getTimerCount(); // the interval
    await h.daemon.tick();
    expect(vi.getTimerCount()).toBe(base + 1); // + the run's deadline timer
    await h.daemon.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE * 5);
    expect(h.cancels).toEqual([]);
    expect(h.onComplete).not.toHaveBeenCalled();
  });

  it('6c. stop() with a run still in flight says so and names its bead; with none it just says stopped', async () => {
    const h = harness({ beads: ['w1'] });
    h.daemon.run(INTERVAL);
    await h.daemon.tick();
    await h.daemon.stop();
    const stopped = h.logs.find((l) => l.m.startsWith('daemon: stopped'));
    expect(stopped?.m).toBe('daemon: stopped — runs still in flight were NOT awaited');
    expect(stopped?.o['inFlightWorkBeadIds']).toEqual(['w1']);

    const idle = harness({ beads: [] });
    idle.daemon.run(INTERVAL);
    await idle.daemon.stop();
    expect(idle.logs.find((l) => l.m.startsWith('daemon: stopped'))?.m).toBe('daemon: stopped');
  });

  it('6d. a tick-request observer that throws does not block the tick', async () => {
    const h = harness({ beads: ['w1'], onTickRequested: () => { throw new Error('observer down'); } });
    h.daemon.run(INTERVAL);
    expect(h.daemon.requestTick('run-finished')).toBe('started');
    await flush();
    expect(h.runsFor('w1')).toHaveLength(1);
    expect(h.logs.find((l) => l.m.includes('onTickRequested observer failed'))?.o).toMatchObject({ error: 'observer down', reason: 'run-finished' });
    await h.daemon.stop();
  });

  it('6b. stop() during the cancel grace window also leaves no timer', async () => {
    const h = harness({ beads: ['w1'], cancelMode: 'hang' });
    h.daemon.run(INTERVAL);
    await h.daemon.tick();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toHaveLength(1);
    await h.daemon.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('7. runDeadlineMs=0 means no deadline: the run is never cancelled and arms no timer', async () => {
    const h = harness({ beads: ['w1'], runDeadlineMs: 0 });
    await h.daemon.tick();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.cancels).toEqual([]);
    expect(h.workingBeads()).toEqual(['w1']);
    expect(h.failuresFor('w1')).toBe(0);
  });

  it('8. the per-bead override seam wins over the daemon-wide deadline (vibesync-bw97 plugs in here)', async () => {
    const h = harness({ beads: ['w1', 'w2'], poolSize: 2, runDeadlineMs: DEADLINE, runDeadlineFor: (id) => (id === 'w2' ? 3 * DEADLINE : undefined) });
    await h.daemon.tick();
    expect(h.runs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await flush();
    expect(h.cancels).toEqual(['mol-w1-1']); // w1 on the default budget, w2 on its own larger one
    expect(h.workingBeads()).toEqual(['w2']);
  });
});
