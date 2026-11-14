/**
 * vibesync-2bgv — the loop wakes a project's PM agent only for a reason.
 *
 * Everything is driven through the REAL boot path (`bootOrchestrationPlane` ->
 * `startSchedulerDaemon` -> SchedulerDaemon ticks / bus events) with fake timers.
 * Nothing here calls `PmWaker.wake`/`evaluate` directly: a wake can only happen
 * because a daemon tick completed or a real bus event reached the daemon. The
 * clock is the fake system clock (`Date` is faked), the PM state file is a REAL
 * JSON file under a tmp dir, and the sink is a fake that records calls.
 *
 * False passes guarded against:
 *   - wake() called directly instead of through ticks/events;
 *   - a backstop that fires only because an interval tick happens to coincide
 *     with the 8 h mark: the non-aligned-interval test uses an interval that does
 *     NOT divide 8 h and asserts the wake lands in [8 h, 8 h + interval);
 *   - an "event" wake that is really the interval tick: the event tests assert
 *     the wake happened before the first interval tick fired.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { Event } from '../../../../src/engine/events/index.js';
import type { BootSchedulerOptions } from '../../../../src/engine/scheduler/boot-scheduler.js';
import {
  PM_WAKE_RETRY_BACKOFF_MS,
  PM_WAKE_SKIPPED_EVENT,
  PM_WOKEN_EVENT,
  registryPmAgentLookup,
  type PmWakeInput,
  type PmWakeSink,
  type WakeReason,
} from '../../../../src/engine/scheduler/index.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';

/** These tests never dispatch a turn; a dial would mean a real Iroh host. */
function neverDialIroh(): IrohConnection {
  return new IrohConnection({
    dial: async () => { throw new Error('test must not dial Iroh'); },
    peerName: 'scheduler-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 1 },
  });
}

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date('2026-01-01T00:00:00Z');
const PROJECT = 'proj-x';
const PM = 'agent-pm-1';

type Row = Record<string, unknown>;

function fakeBd(handlers: { ready?: () => Row[]; closed?: Set<string> } = {}) {
  const contexts: Array<{ id: string; description: string; open: boolean; reason?: string }> = [];
  const run = async (args: readonly string[]): Promise<string> => {
    switch (args[0]) {
      case 'ready':
        return JSON.stringify(handlers.ready?.() ?? []);
      case 'list': {
        const status = args[args.indexOf('--status') + 1];
        return JSON.stringify(
          contexts
            .filter((c) => (status === 'open' ? c.open : !c.open))
            .map((c) => ({ id: c.id, description: c.description, status, close_reason: c.reason })),
        );
      }
      case 'show':
        return JSON.stringify([
          { id: args[1], title: 'T', description: 'D', status: handlers.closed?.has(String(args[1])) ? 'closed' : 'open' },
        ]);
      case 'create': {
        const id = `ctx-${contexts.length + 1}`;
        contexts.push({ id, description: args[args.indexOf('--description') + 1]!, open: true });
        return `${id}\n`;
      }
      case 'close': {
        const c = contexts.find((x) => x.id === args[1]);
        if (c) { c.open = false; c.reason = args[args.indexOf('--reason') + 1]; }
        return '{}';
      }
      case 'comments':
        return args[1] === 'add' ? '{}' : '[]';
      default:
        throw new Error(`unexpected bd call: ${args.join(' ')}`);
    }
  };
  return { run };
}

interface WakeCall extends PmWakeInput { at: number }

function fakeSink(behaviour: (call: WakeCall, n: number) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string } = () => ({ ok: true })) {
  const calls: WakeCall[] = [];
  const sink: PmWakeSink = {
    async wake(input) {
      const call = { ...input, at: Date.now() };
      calls.push(call);
      return behaviour(call, calls.length);
    },
  };
  return { sink, calls, reasons: () => calls.map((c) => c.reason) };
}

function schedulerConfig(over: Partial<BootSchedulerOptions['config']> = {}): BootSchedulerOptions['config'] {
  return {
    enabled: true,
    projectIdentifier: PROJECT,
    intervalMs: MIN,
    poolSize: 2,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [],
    allowedRepos: [],
    ...over,
  };
}

const POOL = [
  { agentId: 'agent-a', role: 'role-one' },
  { agentId: 'agent-b', role: 'role-two' },
];

describe('PM wake (vibesync-2bgv)', () => {
  it('accepted-only wake retries retain the logical id and leave completed-delivery time unchanged', async () => {
    const calls: PmWakeInput[] = [];
    const sink: PmWakeSink = {
      wake: async (input) => {
        calls.push(input);
        return { ok: true, accepted: true, applicationDelivered: false, msgId: input.wakeId, reason: 'queued' };
      },
    };
    const { handle, woken } = await boot({ sink, intervalMs: 60 * MIN });
    await vi.advanceTimersByTimeAsync(8 * HOUR + 60 * MIN);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await vi.advanceTimersByTimeAsync(PM_WAKE_RETRY_BACKOFF_MS);
    }

    expect(calls.length).toBeGreaterThan(1);
    expect(new Set(calls.map((call) => call.wakeId)).size).toBe(1);
    expect(calls.every((call) => JSON.stringify(call) === JSON.stringify(calls[0]))).toBe(true);
    expect(calls[0]!.correlation).toBeUndefined();
    expect(calls.every((call) => JSON.stringify(call.correlation) === JSON.stringify(calls[0]!.correlation))).toBe(true);
    expect(woken.every((event) => {
      const eventPayload = payload(event);
      return eventPayload['accepted'] === true && eventPayload['applicationDelivered'] === false && eventPayload['ok'] === false && eventPayload['reason'] === 'backstop' && eventPayload['sinkReason'] === 'queued';
    })).toBe(true);
    expect(readState()[PROJECT]!.lastWokenAt).toBeNull();
    await handle.shutdown();
  });

  const originalEnv = { ...process.env };
  let dir: string;
  let statePath: string;
  const handles: OrchestrationHandle[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wake-'));
    statePath = path.join(dir, 'nested', 'pm-wake-state.json');
  });

  afterEach(async () => {
    for (const h of handles.splice(0)) await h.shutdown();
    vi.useRealTimers();
    process.env = { ...originalEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  interface BootOpts {
    bd?: ReturnType<typeof fakeBd>;
    sink?: PmWakeSink;
    lookup?: (p: string) => string | null | undefined;
    intervalMs?: number;
    pmWake?: Partial<NonNullable<BootSchedulerOptions['config']['pmWake']>>;
    pmWakeSeams?: boolean;
    poolSize?: number;
    paused?: boolean;
    logger?: { info?: (o: unknown, m: string) => void; warn?: (o: unknown, m: string) => void };
  }

  async function boot(o: BootOpts = {}) {
    process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-iroh';
    process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = 'agent-parent';
    const sink = o.sink ?? fakeSink().sink;
    const handle = await bootOrchestrationPlane({
      ...inMemoryBeads(),
      irohConnectionFactory: neverDialIroh,
      persistEvents: false,
      runDriftAuditOnBoot: false,
      schedulers: [{
        config: schedulerConfig({
          intervalMs: o.intervalMs ?? MIN,
          poolSize: o.poolSize ?? 2,
          paused: o.paused ?? false,
          pmWake: { enabled: true, minIntervalMs: 30 * MIN, backstopMs: 8 * HOUR, statePath, ...o.pmWake },
        }),
        listPoolMembers: () => o.pmWakeSeams === false ? [] : POOL,
        bd: (o.bd ?? fakeBd()).run,
        appRoot: process.cwd(),
        pmWake: { lookupAgentId: o.lookup ?? (() => PM), sink },
        ...(o.logger ? { logger: o.logger } : {}),
      }],
    });
    handles.push(handle);
    const woken: Event[] = [];
    const skipped: Event[] = [];
    const ticks: Event[] = [];
    handle.bus.subscribe((e) => {
      if (e.kind === PM_WOKEN_EVENT) woken.push(e);
      if (e.kind === PM_WAKE_SKIPPED_EVENT) skipped.push(e);
      if (e.kind === 'daemon/scheduler.tick') ticks.push(e);
    });
    return { handle, woken, skipped, ticks };
  }

  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, { firstSeenAt: string; lastWokenAt: string | null; lastByReason: Record<string, string> }>;
  const payload = (e: Event) => e.payload as Record<string, unknown>;

  it('1. 24 h, no events, no ready beads, ticks every 60 s: exactly 3 backstop wakes (8 h, 16 h, 24 h)', async () => {
    const s = fakeSink();
    const { woken, ticks } = await boot({ sink: s.sink });
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(ticks.length).toBe(24 * 60); // the daemon really ticked every minute
    expect(s.reasons()).toEqual(['backstop', 'backstop', 'backstop']);
    expect(s.calls.map((c) => (c.at - T0.getTime()) / HOUR)).toEqual([8, 16, 24]);
    expect(s.calls.every((c) => c.agentId === PM && c.projectIdentifier === PROJECT)).toBe(true);
    expect(new Set(s.calls.map((c) => c.wakeId)).size).toBe(3);
    expect(woken.map((e) => payload(e)['ok'])).toEqual([true, true, true]);
    expect(woken.map((e) => payload(e)['reason'])).toEqual(['backstop', 'backstop', 'backstop']);
  });

  it('1b. interval that does NOT divide 8 h: backstop never early, at most one interval late (no fake coincidence)', async () => {
    const interval = 61_000;
    expect((8 * HOUR) % interval).not.toBe(0);
    const s = fakeSink();
    await boot({ sink: s.sink, intervalMs: interval });
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(s.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.calls.length).toBeLessThanOrEqual(3);
    let prev = T0.getTime();
    for (const c of s.calls) {
      expect(c.reason).toBe('backstop');
      expect(c.at - prev).toBeGreaterThanOrEqual(8 * HOUR);
      expect(c.at - prev).toBeLessThan(8 * HOUR + interval);
      prev = c.at;
    }
  });

  it('2. restart at t=5 h: no wake at boot, still wakes at t=8 h (not 5 h + 8 h)', async () => {
    const s = fakeSink();
    const interval = 70_000;
    const first = await boot({ sink: s.sink, intervalMs: interval });
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(s.calls).toHaveLength(0);
    await first.handle.shutdown();

    const second = await boot({ sink: s.sink, intervalMs: interval }); // new PmWaker, same state file
    await vi.advanceTimersByTimeAsync(5);
    expect(s.calls, 'no wake at boot').toHaveLength(0);
    expect(second.woken).toHaveLength(0);
    expect(readState()[PROJECT]!.firstSeenAt).toBe(T0.toISOString()); // anchor survived the restart

    await vi.advanceTimersByTimeAsync(8 * HOUR - 5 * HOUR - 5 - 1000); // just before 8 h
    expect(s.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * interval); // past 8 h
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.reason).toBe('backstop');
    expect(s.calls[0]!.at - T0.getTime()).toBeGreaterThanOrEqual(8 * HOUR);
    expect(s.calls[0]!.at - T0.getTime()).toBeLessThan(8 * HOUR + interval + 1000);

    await vi.advanceTimersByTimeAsync(6 * HOUR); // t ~ 14 h > 5 h + 8 h: a reset clock would have woken
    expect(s.calls).toHaveLength(1);
  });

  it('2b. restart AFTER a wake: lastWokenAt (not boot time) anchors the next backstop', async () => {
    const s = fakeSink();
    const interval = 70_000;
    const first = await boot({ sink: s.sink, intervalMs: interval });
    await vi.advanceTimersByTimeAsync(8 * HOUR + interval);
    expect(s.calls).toHaveLength(1);
    const wokeAt = s.calls[0]!.at;
    await first.handle.shutdown();
    await vi.advanceTimersByTimeAsync(3 * HOUR); // daemon down for 3 h
    await boot({ sink: s.sink, intervalMs: interval });
    await vi.advanceTimersByTimeAsync(5 * HOUR - 2 * interval); // 8 h after wake not yet reached
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * interval);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.at - wokeAt).toBeGreaterThanOrEqual(8 * HOUR);
  });

  it('3. one injected bead-status event: wake "event" within 60 s with the detail, before any interval tick; backstop clock resets', async () => {
    const s = fakeSink();
    const { handle, woken, ticks } = await boot({ sink: s.sink });
    await vi.advanceTimersByTimeAsync(HOUR); // quiet hour, nothing woke
    expect(s.calls).toHaveLength(0);

    // Move to just after an interval tick so the next interval tick is ~60 s away.
    const before = ticks.length;
    handle.bus.emit({ layer: 'dispatcher', kind: 'beads/issue.status_changed', payload: { issueId: 'bd-42', from: 'open', to: 'ready' } });
    await vi.advanceTimersByTimeAsync(10);
    expect(ticks.length).toBe(before + 1);
    expect(payload(ticks[ticks.length - 1]!)['reason']).toBe('bead-status'); // not the interval tick
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.reason).toBe('event');
    expect(call.detail).toContain('bd-42');
    expect(call.detail).toContain('open->ready');
    expect(call.at - T0.getTime()).toBeGreaterThanOrEqual(HOUR);
    expect(call.at - T0.getTime()).toBeLessThan(HOUR + 60_000);
    expect(woken).toHaveLength(1);
    expect(payload(woken[0]!)).toMatchObject({ reason: 'event', agentId: PM, ok: true, project: PROJECT, wakeId: call.wakeId });
    expect(String(payload(woken[0]!)['detail'])).toContain('bd-42');

    // Backstop clock reset by the event: nothing at 8 h, wake at event + 8 h.
    await vi.advanceTimersByTimeAsync(8 * HOUR - 2 * MIN); // would be past 8 h of boot, but <8 h after the event
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(s.reasons()).toEqual(['event', 'backstop']);
    expect(s.calls[1]!.at - call.at).toBeGreaterThanOrEqual(8 * HOUR);
  });

  it('3b. an event inside min-interval is not lost nor spammed: skipped once, then woken when the interval allows; a recent ready wake does not suppress an event', async () => {
    const s = fakeSink();
    const beads = [{ id: 'w1', title: 'T', priority: 1, dependent_count: 0 }];
    const closed = new Set(['w1']); // no formula resolves -> nothing dispatches -> 'ready' wake
    const { handle, skipped } = await boot({ sink: s.sink, bd: fakeBd({ ready: () => beads, closed }) });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.reasons()).toEqual(['ready']);

    const emit = (id: string) =>
      handle.bus.emit({ layer: 'dispatcher', kind: 'beads/issue.status_changed', payload: { issueId: id, from: 'open', to: 'closed' } });
    emit('bd-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(s.reasons(), 'event is not suppressed by the recent ready wake').toEqual(['ready', 'event']);

    await vi.advanceTimersByTimeAsync(6_000);
    emit('bd-2');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.reasons()).toEqual(['ready', 'event']);
    expect(skipped.filter((e) => payload(e)['reason'] === 'event' && payload(e)['why'] === 'min-interval')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(s.reasons().filter((r) => r === 'event')).toHaveLength(2);
    expect(s.calls.filter((c) => c.reason === 'event')[1]!.detail).toContain('bd-2');
  });

  it('4. ready beads + free capacity + nothing dispatched: one "ready" wake "<n> ready beads, capacity <c>"; a second tick inside minInterval does not wake (wake_skipped)', async () => {
    const s = fakeSink();
    const beads = ['w1', 'w2', 'w3'].map((id) => ({ id, title: 'T', priority: 1, dependent_count: 0 }));
    const { woken, skipped, ticks } = await boot({ sink: s.sink, bd: fakeBd({ ready: () => beads, closed: new Set(['w1', 'w2', 'w3']) }) });

    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.reason).toBe('ready');
    expect(s.calls[0]!.detail).toBe('3 ready beads, capacity 2');
    expect(payload(woken[0]!)).toMatchObject({ reason: 'ready', detail: '3 ready beads, capacity 2', ok: true });

    await vi.advanceTimersByTimeAsync(MIN); // second tick, well inside 30 min
    expect(ticks).toHaveLength(2);
    expect(s.calls).toHaveLength(1);
    expect(skipped.map(payload)).toContainEqual({ project: PROJECT, reason: 'ready', why: 'min-interval' });

    await vi.advanceTimersByTimeAsync(30 * MIN); // interval elapsed: allowed again
    expect(s.reasons()).toEqual(['ready', 'ready']);
  });

  it('4b. no free capacity (a run holds the only slot) -> no "ready" wake', async () => {
    const s = fakeSink();
    const beads = [{ id: 'w1', title: 'T', priority: 1, dependent_count: 0 }, { id: 'w2', title: 'T', priority: 2, dependent_count: 0 }];
    const { handle } = await boot({ sink: s.sink, bd: fakeBd({ ready: () => beads }), poolSize: 1 });
    vi.spyOn(handle.dispatcher, 'run').mockImplementation(() => new Promise(() => { /* run stays in flight */ }));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.calls).toHaveLength(0);
  });

  it('4c. scheduler paused -> no "ready" wake (the loop is deliberately not dispatching)', async () => {
    const s = fakeSink();
    const beads = [{ id: 'w1', title: 'T', priority: 1, dependent_count: 0 }];
    await boot({ sink: s.sink, bd: fakeBd({ ready: () => beads, closed: new Set(['w1']) }), paused: true });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.calls).toHaveLength(0);
  });

  it('5. witness onRepeatedRecovery -> "stall" wake naming the bead', async () => {
    const s = fakeSink();
    const { handle } = await boot({ sink: s.sink, bd: fakeBd({ closed: new Set(['wz']) }) });
    const pool = (handle.schedulers.get(PROJECT)!.daemon as unknown as { pool: { allocate(i: { workBeadId: string }): unknown } }).pool;

    for (let i = 0; i < 3; i += 1) {
      pool.allocate({ workBeadId: 'wz' }); // a working slot the scheduler does not track; its bead is closed
      await vi.advanceTimersByTimeAsync(MIN);
      expect(s.calls, `recovery ${i + 1} is below the escalation threshold`).toHaveLength(i < 2 ? 0 : 1);
    }
    expect(s.calls[0]!.reason).toBe('stall');
    expect(s.calls[0]!.detail).toContain('wz');
    expect(s.calls[0]!.detail).toContain('recovered 3x');
  });

  it('5b. a run-deadline expiry (vibesync-izn3) -> "stall" wake naming the bead and the deadline', async () => {
    const s = fakeSink();
    const { handle } = await boot({ sink: s.sink });
    const daemon = handle.schedulers.get(PROJECT)!.daemon as unknown as { deps: { onRunExpired?: (i: { workBeadId: string; moleculeId?: string; deadlineMs: number; elapsedMs: number }) => void } };
    // The daemon reports an expiry through its observer seam; boot must route it to the waker.
    expect(typeof daemon.deps.onRunExpired).toBe('function');
    daemon.deps.onRunExpired!({ workBeadId: 'wd', moleculeId: 'mol-wd-1', deadlineMs: 3_600_000, elapsedMs: 3_600_004 });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.reason).toBe('stall');
    expect(s.calls[0]!.detail).toContain('wd');
    expect(s.calls[0]!.detail).toContain('deadline');
  });

  it('6. PM target comes from the injected lookup; null -> no wake and exactly one warn', async () => {
    const s = fakeSink();
    const warn = vi.fn();
    const lookup = vi.fn((_p: string): string | null => null);
    const { woken } = await boot({ sink: s.sink, lookup, logger: { warn, info: vi.fn() }, pmWake: { backstopMs: 2 * MIN } });
    await vi.advanceTimersByTimeAsync(20 * MIN); // backstop is long overdue on every tick
    expect(s.calls).toHaveLength(0);
    expect(woken).toHaveLength(0);
    expect(lookup).toHaveBeenCalledWith(PROJECT);
    expect(warn.mock.calls.filter(([, m]) => String(m).includes('no agent to wake'))).toHaveLength(1);

    lookup.mockImplementation(() => 'agent-from-lookup');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.agentId).toBe('agent-from-lookup');
  });

  it('6b. production resolution path: the lookup wired to a REAL Registry (projects.letta_agent_id)', async () => {
    const { createRegistry } = await import('../../../../src/app/registry/registry.js');
    const db = createRegistry(path.join(dir, 'sync-state.db'));
    try {
      const s = fakeSink();
      db.upsertProject({ identifier: PROJECT, name: 'Proj X' });
      const { handle } = await boot({ sink: s.sink, lookup: registryPmAgentLookup(db), pmWake: { backstopMs: 2 * MIN } });

      // Row exists but has no agent to wake yet -> no wake.
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(s.calls).toHaveLength(0);

      db.setProjectLettaAgent(PROJECT, { agentId: 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1' });
      await vi.advanceTimersByTimeAsync(MIN);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]).toMatchObject({ agentId: 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1', projectIdentifier: PROJECT, reason: 'backstop' });

      // Fixing the row again needs no restart.
      db.setProjectLettaAgent(PROJECT, { agentId: 'agent-replacement' });
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(s.calls[s.calls.length - 1]!.agentId).toBe('agent-replacement');

      // A project that is not in the registry resolves to null.
      expect(registryPmAgentLookup(db)('no-such-project')).toBeNull();
      expect(handle.schedulers.get(PROJECT)!.pmWaker).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('7. sink throws / returns ok:false: lastWokenAt unchanged, ok:false event, ticks keep running, retry reuses the wakeId', async () => {
    let n = 0;
    const s = fakeSink(() => {
      n += 1;
      if (n === 1) throw new Error('iroh down');
      if (n === 2) return { ok: false, error: 'rejected' };
      return { ok: true };
    });
    const { woken, ticks } = await boot({ sink: s.sink, pmWake: { backstopMs: 2 * MIN } });

    await vi.advanceTimersByTimeAsync(2 * MIN); // first backstop attempt: sink throws
    expect(s.calls).toHaveLength(1);
    expect(payload(woken[0]!)).toMatchObject({ ok: false, reason: 'backstop', error: 'iroh down' });
    expect(readState()[PROJECT]!.lastWokenAt).toBeNull();
    const tickCount = ticks.length;

    await vi.advanceTimersByTimeAsync(PM_WAKE_RETRY_BACKOFF_MS - 2 * MIN); // still inside the retry backoff
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * MIN); // retry #1: ok:false
    expect(s.calls).toHaveLength(2);
    expect(payload(woken[1]!)).toMatchObject({ ok: false, error: 'rejected' });
    expect(readState()[PROJECT]!.lastWokenAt).toBeNull();
    expect(s.calls[1]!.wakeId).toBe(s.calls[0]!.wakeId);
    expect(ticks.length).toBeGreaterThan(tickCount); // the tick loop was never broken

    await vi.advanceTimersByTimeAsync(PM_WAKE_RETRY_BACKOFF_MS + MIN); // retry #2: succeeds
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]!.wakeId).toBe(s.calls[0]!.wakeId);
    expect(payload(woken[2]!)).toMatchObject({ ok: true });
    expect(readState()[PROJECT]!.lastWokenAt).toBe(new Date(s.calls[2]!.at).toISOString());
  });

  it('8. enabled=false: no PmWaker, no file, no sink/lookup call, no extra timers', async () => {
    const s = fakeSink();
    const lookup = vi.fn(() => PM);
    const { handle, woken, skipped } = await boot({ sink: s.sink, lookup, pmWake: { enabled: false, backstopMs: 2 * MIN } });
    const timersAtBoot = vi.getTimerCount(); // daemon interval + orchestration plane timers, none from the waker
    expect(handle.schedulers.get(PROJECT)).not.toBeNull();
    expect(handle.schedulers.get(PROJECT)!.pmWaker).toBeNull();
    handle.bus.emit({ layer: 'dispatcher', kind: 'beads/issue.status_changed', payload: { issueId: 'bd-1', from: 'open', to: 'ready' } });
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(s.calls).toHaveLength(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(woken).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(path.dirname(statePath))).toBe(false);
    expect(vi.getTimerCount()).toBe(timersAtBoot);
  });
});
