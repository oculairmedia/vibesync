/**
 * vibesync-p489 — event-driven scheduler ticks.
 *
 * Everything goes through the REAL boot path (`bootOrchestrationPlane` ->
 * `startSchedulerDaemon`) with fake timers and an interval (60 s) far above the
 * 5 s debounce window, so a tick observed inside the window can only have come
 * from an event. The false pass this suite guards against: the normal interval
 * firing and masking a missing event trigger — every "within 5 s" assertion
 * therefore also asserts that NO tick carries reason 'interval'.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/orchestration/boot.js';
import type { Event } from '../../../../src/orchestration/events/index.js';
import {
  BEADS_ISSUE_STATUS_CHANGED_EVENT,
  type BootSchedulerOptions,
} from '../../../../src/orchestration/scheduler/boot-scheduler.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const TICK = 'daemon/scheduler.tick';
const STATUS_CHANGED = 'beads/issue.status_changed';
const INTERVAL = 60_000;

type Row = Record<string, unknown>;

/** Fake `bd` CLI (same shape as boot-scheduler.test.ts) tracking `bd ready` concurrency. */
function fakeBd(handlers: { ready?: () => Row[] | Promise<Row[]> } = {}) {
  const calls: string[][] = [];
  const contexts: Array<{ id: string; description: string; open: boolean; reason?: string }> = [];
  let readyActive = 0;
  let readyMaxActive = 0;
  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    switch (args[0]) {
      case 'ready': {
        readyActive += 1;
        readyMaxActive = Math.max(readyMaxActive, readyActive);
        try {
          return JSON.stringify(await (handlers.ready?.() ?? []));
        } finally {
          readyActive -= 1;
        }
      }
      case 'list': {
        const status = args[args.indexOf('--status') + 1];
        return JSON.stringify(
          contexts
            .filter((c) => (status === 'open' ? c.open : !c.open))
            .map((c) => ({ id: c.id, description: c.description, status, close_reason: c.reason })),
        );
      }
      case 'show':
        return JSON.stringify([{ id: args[1], title: 'T', description: 'D', status: 'open' }]);
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
  return {
    calls,
    run,
    callsFor: (cmd: string) => calls.filter((c) => c[0] === cmd),
    get readyMaxActive() { return readyMaxActive; },
  };
}

function schedulerConfig(over: Partial<BootSchedulerOptions['config']> = {}): BootSchedulerOptions['config'] {
  return {
    enabled: true,
    projectIdentifier: 'proj-x',
    intervalMs: INTERVAL,
    poolSize: 2,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [],
    ...over,
  };
}

const POOL = [
  { agentId: 'agent-a', role: 'role-one', lettaBaseUrl: 'http://shim' },
  { agentId: 'agent-b', role: 'role-two', lettaBaseUrl: 'http://shim' },
];

async function boot(opts: Partial<BootSchedulerOptions> & { bd: BootSchedulerOptions['bd'] }): Promise<OrchestrationHandle> {
  process.env['VIBESYNC_WORK_ACTIVITY_REPORT'] = '0';
  process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-subagent';
  process.env['VIBESYNC_LETTA_CODE_SHIM_URL'] = 'http://shim:8291';
  process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = 'agent-parent';
  return bootOrchestrationPlane({
    dolt: new InMemoryDoltClient() as never,
    persistEvents: false,
    runDriftAuditOnBoot: false,
    scheduler: {
      config: schedulerConfig(),
      listPoolMembers: () => POOL,
      appRoot: process.cwd(),
      ...opts,
    },
  });
}

function recordTicks(handle: OrchestrationHandle): Event[] {
  const ticks: Event[] = [];
  handle.bus.subscribe((e) => {
    if (e.kind === TICK) ticks.push(e);
  });
  return ticks;
}

const reasons = (ticks: Event[]) => ticks.map((t) => (t.payload as { reason?: string }).reason);

function statusChanged(handle: OrchestrationHandle, to: unknown, extra: Record<string, unknown> = {}): void {
  handle.bus.emit({
    layer: 'dispatcher',
    kind: STATUS_CHANGED,
    payload: { issueId: 'bd-1', from: 'open', to, ...extra },
  });
}

describe('SchedulerDaemon — event-driven ticks (vibesync-p489)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('the status-change event kind is the exported constant', () => {
    expect(BEADS_ISSUE_STATUS_CHANGED_EVENT).toBe(STATUS_CHANGED);
  });

  for (const to of ['ready', 'in_progress', 'closed']) {
    it(`(b) beads/issue.status_changed to=${to} ticks within 5 s with reason bead-status, the interval timer NOT having fired`, async () => {
      const bd = fakeBd();
      const handle = await boot({ bd: bd.run });
      const ticks = recordTicks(handle);

      statusChanged(handle, to);
      await vi.advanceTimersByTimeAsync(10);
      expect(ticks).toHaveLength(1);
      expect(reasons(ticks)).toEqual(['bead-status']);

      await vi.advanceTimersByTimeAsync(4_900); // t = 4910 ms, far below the 60 s interval
      expect(ticks).toHaveLength(1);
      expect(reasons(ticks)).not.toContain('interval');
      await handle.shutdown();
    });
  }

  it('(b) a status change to a non-triggering status (open) or a malformed payload causes no tick', async () => {
    const bd = fakeBd();
    const handle = await boot({ bd: bd.run });
    const ticks = recordTicks(handle);

    statusChanged(handle, 'open');
    statusChanged(handle, 'blocked');
    statusChanged(handle, undefined);
    statusChanged(handle, 42);
    handle.bus.emit({ layer: 'dispatcher', kind: STATUS_CHANGED });
    // The right payload under a different kind is not a trigger either.
    handle.bus.emit({ layer: 'dispatcher', kind: 'dispatcher/formula.completed', payload: { to: 'closed' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).toHaveLength(0);
    expect(bd.calls).toHaveLength(0);
    await handle.shutdown();
  });

  it('(c) a worker run finishing ticks within 5 s with reason run-finished, the interval timer NOT having fired', async () => {
    const bd = fakeBd({ ready: () => [{ id: 'work-1', title: 'T', priority: 1, dependent_count: 0 }] });
    const handle = await boot({ bd: bd.run, config: schedulerConfig({ poolSize: 1 }) });
    let finish!: () => void;
    const runGate = new Promise<void>((r) => { finish = r; });
    const run = vi
      .spyOn(handle.dispatcher, 'run')
      .mockImplementation(async () => { await runGate; return { moleculeId: 'mol-1', outputs: { result: 'done' } } as never; });
    const ticks = recordTicks(handle);

    // The first (interval) tick dispatches the run; the run then stays in flight.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(reasons(ticks)).toEqual(['interval']);
    expect(run).toHaveBeenCalledTimes(1);

    // The run finishes between interval ticks.
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons(ticks)).toEqual(['interval', 'run-finished']);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(reasons(ticks)).toEqual(['interval', 'run-finished']); // no further interval tick in the window
    await handle.shutdown();
  });

  it('a failed run also counts as finished (tick with reason run-finished)', async () => {
    const bd = fakeBd({ ready: () => [{ id: 'work-1', title: 'T', priority: 1, dependent_count: 0 }] });
    const handle = await boot({ bd: bd.run, config: schedulerConfig({ poolSize: 1 }) });
    let fail!: () => void;
    const runGate = new Promise<void>((_, rej) => { fail = () => rej(new Error('boom')); });
    vi.spyOn(handle.dispatcher, 'run').mockImplementation(() => runGate as never);
    const ticks = recordTicks(handle);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    fail();
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons(ticks)).toEqual(['interval', 'run-finished']);
    await handle.shutdown();
  });

  it('burst: 10 events in 1 s -> exactly ONE tick inside the 5 s window, then exactly one trailing tick at window end', async () => {
    const bd = fakeBd();
    const handle = await boot({ bd: bd.run });
    const ticks = recordTicks(handle);
    const baseTimers = vi.getTimerCount();

    for (let i = 0; i < 10; i += 1) {
      statusChanged(handle, i % 2 === 0 ? 'ready' : 'closed');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ticks).toHaveLength(1); // leading edge only, t = 1000 ms
    await vi.advanceTimersByTimeAsync(3_899); // t = 4899 ms
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(101); // t = 5000 ms: the single trailing tick
    expect(ticks).toHaveLength(2);
    expect(reasons(ticks)).toEqual(['bead-status', 'bead-status']);
    await vi.advanceTimersByTimeAsync(40_000); // t = 45 s: nothing re-trails, interval (60 s) not reached
    expect(ticks).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(baseTimers); // trailing timer is gone, nothing re-trails

    statusChanged(handle, 'ready'); // a fresh event after a quiet window ticks promptly again
    await vi.advanceTimersByTimeAsync(10);
    expect(ticks).toHaveLength(3);
    await handle.shutdown();
  });

  it('the debounce window is configurable (scheduler.eventDebounceMs)', async () => {
    const bd = fakeBd();
    const handle = await boot({ bd: bd.run, config: schedulerConfig({ eventDebounceMs: 2_000 }) });
    const ticks = recordTicks(handle);

    statusChanged(handle, 'ready');
    await vi.advanceTimersByTimeAsync(10);
    statusChanged(handle, 'ready'); // inside the 2 s window -> trailing tick at t = 2000
    await vi.advanceTimersByTimeAsync(1_980);
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(ticks).toHaveLength(2);
    await handle.shutdown();
  });

  it('a tick requested while a tick holds the lock is skipped as locked — never two concurrent ticks, nothing queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bd = fakeBd({ ready: async () => { await gate; return []; } });
    const info = vi.fn();
    const handle = await boot({ bd: bd.run, logger: { info, warn: vi.fn() } });
    const ticks = recordTicks(handle);
    const daemon = handle.scheduler!.daemon;

    expect(daemon.requestTick('bead-status')).toBe('started'); // tick 1 blocks inside `bd ready`
    await vi.advanceTimersByTimeAsync(10);
    expect(bd.callsFor('ready')).toHaveLength(1);

    // Past the debounce window, tick 1 still holds the lock: skipped as 'locked'.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(daemon.requestTick('run-finished')).toBe('locked');
    expect(daemon.requestTick('bead-status')).toBe('locked');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'run-finished', skippedReason: 'locked' }), expect.stringContaining('locked'));

    // A request inside the window schedules a trailing tick; if the lock is STILL held then, it is skipped, not queued.
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(ticks).toHaveLength(1);
    const readyAfterTick1 = bd.callsFor('ready').length; // one tick = schedule phase + scheduler phase
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveLength(1); // nothing was queued behind the locked requests
    expect(bd.callsFor('ready')).toHaveLength(readyAfterTick1);
    expect(bd.readyMaxActive).toBe(1);
    await handle.shutdown();
  });

  it('an event arriving while the INTERVAL tick is running never starts a second concurrent tick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bd = fakeBd({ ready: async () => { await gate; return []; } });
    const handle = await boot({ bd: bd.run });
    const ticks = recordTicks(handle);

    await vi.advanceTimersByTimeAsync(INTERVAL); // interval tick blocks in `bd ready`
    expect(bd.callsFor('ready')).toHaveLength(1);
    statusChanged(handle, 'ready');
    await vi.advanceTimersByTimeAsync(10);
    expect(bd.callsFor('ready')).toHaveLength(1);
    expect(bd.readyMaxActive).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons(ticks)).toEqual(['interval']);
    await handle.shutdown();
  });

  it('the trigger reason is on the bus payload and in the "SchedulerDaemon tick" log line; interval ticks say interval', async () => {
    const bd = fakeBd();
    const info = vi.fn();
    const handle = await boot({ bd: bd.run, logger: { info, warn: vi.fn() } });
    const ticks = recordTicks(handle);

    statusChanged(handle, 'ready');
    await vi.advanceTimersByTimeAsync(10);
    expect(ticks[0]!.payload).toMatchObject({ seq: 1, reason: 'bead-status' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, reason: 'bead-status' }), 'SchedulerDaemon tick');

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(ticks.at(-1)!.payload).toMatchObject({ reason: 'interval' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'interval' }), 'SchedulerDaemon tick');
    await handle.shutdown();
  });

  it('requestTick accepts the webhook reason (entry point for vibesync-xgnf) and logs it', async () => {
    const bd = fakeBd();
    const info = vi.fn();
    const handle = await boot({ bd: bd.run, logger: { info, warn: vi.fn() } });
    const ticks = recordTicks(handle);

    expect(handle.scheduler!.daemon.requestTick('webhook')).toBe('started');
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons(ticks)).toEqual(['webhook']);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'webhook' }), 'SchedulerDaemon tick');
    await handle.shutdown();
  });

  it('after stop(): events and requestTick cause no tick and leave no timers (a pending trailing tick is cancelled)', async () => {
    const bd = fakeBd();
    const handle = await boot({ bd: bd.run });
    const ticks = recordTicks(handle);
    const baseTimers = vi.getTimerCount(); // interval + whatever the plane itself holds

    statusChanged(handle, 'ready'); // leading tick
    await vi.advanceTimersByTimeAsync(10);
    statusChanged(handle, 'ready'); // trailing timer now pending
    expect(vi.getTimerCount()).toBe(baseTimers + 1); // exactly one pending trailing timer
    expect(ticks).toHaveLength(1);

    await handle.shutdown();
    expect(vi.getTimerCount()).toBe(0); // interval AND trailing timer cleared
    const callsAtShutdown = bd.calls.length;

    statusChanged(handle, 'ready');
    statusChanged(handle, 'closed');
    expect(handle.scheduler!.daemon.requestTick('webhook')).toBe('inactive');
    expect(handle.scheduler!.daemon.requestTick('run-finished')).toBe('inactive');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(ticks).toHaveLength(1);
    expect(bd.calls.length).toBe(callsAtShutdown);
    expect(vi.getTimerCount()).toBe(0);
  });
});
