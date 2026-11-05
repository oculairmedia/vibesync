/**
 * vibesync-z2ws — SchedulerDaemon is started by the REAL boot path.
 *
 * These tests go through `bootOrchestrationPlane` (the function src/index.ts
 * calls) and never construct SchedulerDaemon themselves. That is the point:
 * tests/unit/engine/scheduler/daemon.test.ts builds the daemon by hand,
 * so it passes even when nothing in production instantiates it (the false pass
 * this bead exists to close). Here, deleting the wiring in boot.ts fails them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { Event } from '../../../../src/engine/events/index.js';
import type { BootSchedulerOptions } from '../../../../src/engine/scheduler/boot-scheduler.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';

/** These tests never dispatch a turn; a dial would mean a real Iroh host. */
function neverDialIroh(): IrohConnection {
  return new IrohConnection({
    dial: async () => { throw new Error('test must not dial Iroh'); },
    peerName: 'scheduler-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 1 },
  });
}

const TICK = 'daemon/scheduler.tick';

type Row = Record<string, unknown>;

/**
 * Fake `bd` CLI: records every invocation and keeps just enough state (created /
 * closed sling-context beads) that the real adapters + daemon complete a full
 * schedule -> dispatch cycle.
 */
function fakeBd(handlers: { ready?: () => Row[] | Promise<Row[]> } = {}) {
  const calls: string[][] = [];
  const contexts: Array<{ id: string; description: string; open: boolean; reason?: string }> = [];
  const comments: Array<{ id: string; text: string }> = [];
  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    switch (args[0]) {
      case 'ready':
        return JSON.stringify(await (handlers.ready?.() ?? []));
      case 'list': {
        const status = args[args.indexOf('--status') + 1];
        return JSON.stringify(
          contexts
            .filter((c) => (status === 'open' ? c.open : !c.open))
            .map((c) => ({ id: c.id, description: c.description, status: status, close_reason: c.reason })),
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
        if (args[1] === 'add') { comments.push({ id: args[2]!, text: args[3]! }); return '{}'; }
        return '[]';
      default:
        throw new Error(`unexpected bd call: ${args.join(' ')}`);
    }
  };
  return { calls, contexts, comments, run, callsFor: (cmd: string) => calls.filter((c) => c[0] === cmd) };
}

function schedulerConfig(over: Partial<BootSchedulerOptions['config']> = {}): BootSchedulerOptions['config'] {
  return {
    enabled: true,
    projectIdentifier: 'proj-x',
    intervalMs: 1000,
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

async function boot(scheduler: BootSchedulerOptions | undefined): Promise<OrchestrationHandle> {
  process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-iroh';
  process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = 'agent-parent';
  return bootOrchestrationPlane({
    ...inMemoryBeads(),
    irohConnectionFactory: neverDialIroh,
    persistEvents: false,
    runDriftAuditOnBoot: false,
    ...(scheduler ? { scheduler } : {}),
  });
}

function recordTicks(handle: OrchestrationHandle): Event[] {
  const ticks: Event[] = [];
  handle.bus.subscribe((e) => {
    if (e.kind === TICK) ticks.push(e);
  });
  return ticks;
}

describe('bootOrchestrationPlane — SchedulerDaemon wiring (vibesync-z2ws)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('flag ON: the boot path starts the daemon, a tick is recorded on the bus and the logger, shutdown stops further ticks', async () => {
    const bd = fakeBd();
    const info = vi.fn();
    const handle = await boot({
      config: schedulerConfig(),
      listPoolMembers: (p) => (p === 'proj-x' ? POOL : []),
      bd: bd.run,
      logger: { info, warn: vi.fn() },
      appRoot: process.cwd(),
    });
    const ticks = recordTicks(handle);

    expect(handle.scheduler).not.toBeNull();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 1000, poolSize: 2 }), 'daemon: started');
    // Nothing runs before the first interval elapses.
    expect(ticks).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.layer).toBe('daemon');
    expect(ticks[0]!.payload).toMatchObject({ seq: 1, project: 'proj-x', dispatched: 0, merged: 0 });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), 'SchedulerDaemon tick');
    // The tick really went through the bd ReadyBeadSource adapter.
    const ready = bd.callsFor('ready');
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready[0]).toEqual(expect.arrayContaining(['--json', '--label', 'scheduler:eligible', '--exclude-label', 'vibesync:sling-context']));

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveLength(3);

    await handle.shutdown();
    const callsAtShutdown = bd.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveLength(3);
    expect(bd.calls.length).toBe(callsAtShutdown);
    expect(vi.getTimerCount()).toBe(0);
    expect(info).toHaveBeenCalledWith(expect.anything(), 'daemon: stopped');
  });

  it('flag OFF (enabled=false): no daemon, no tick, no bd call, no timers', async () => {
    const bd = fakeBd();
    const listPoolMembers = vi.fn(() => POOL);
    const handle = await boot({
      config: schedulerConfig({ enabled: false }),
      listPoolMembers,
      bd: bd.run,
      appRoot: process.cwd(),
    });
    const ticks = recordTicks(handle);

    expect(handle.scheduler).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(0);
    expect(bd.calls).toHaveLength(0);
    expect(listPoolMembers).not.toHaveBeenCalled();
    await handle.shutdown();
  });

  it('flag OFF (scheduler option absent, i.e. today\'s behaviour): nothing changes', async () => {
    const handle = await boot(undefined);
    const ticks = recordTicks(handle);
    const timersBefore = vi.getTimerCount();

    expect(handle.scheduler).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
    await handle.shutdown();
  });

  it('shutdown is idempotent and awaits an in-flight tick (nothing writes after it resolves)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bd = fakeBd({ ready: async () => { await gate; return []; } });
    const handle = await boot({
      config: schedulerConfig(),
      listPoolMembers: () => POOL,
      bd: bd.run,
      appRoot: process.cwd(),
    });
    const ticks = recordTicks(handle);

    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts and blocks inside `bd ready`
    expect(bd.callsFor('ready')).toHaveLength(1);
    expect(ticks).toHaveLength(0);

    let done = false;
    const shutting = handle.shutdown().then(() => { done = true; });
    const again = handle.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false); // still waiting on the in-flight tick

    release();
    await shutting;
    await again;
    const callsAtShutdown = bd.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bd.calls.length).toBe(callsAtShutdown); // no pending tick wrote after shutdown resolved
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing bd never throws out of the interval: the tick is still reported', async () => {
    const warn = vi.fn();
    const bd = fakeBd({ ready: () => { throw new Error('bd exploded'); } });
    const handle = await boot({
      config: schedulerConfig(),
      listPoolMembers: () => POOL,
      bd: bd.run,
      logger: { info: vi.fn(), warn },
      appRoot: process.cwd(),
    });
    const ticks = recordTicks(handle);

    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('bd exploded') }), 'daemon: schedule phase failed');
    await handle.shutdown();
  });

  it('a ready bead is scheduled, dispatched through the booted dispatcher, and its PR is NOT merged (autoMerge off)', async () => {
    const bd = fakeBd({ ready: () => [{ id: 'work-1', title: 'T', priority: 1, dependent_count: 0 }] });
    const info = vi.fn();
    const handle = await boot({
      config: schedulerConfig({ poolSize: 1, allowedRepos: ['o/r'] }),
      listPoolMembers: () => POOL,
      bd: bd.run,
      logger: { info, warn: vi.fn() },
      appRoot: process.cwd(),
    });
    const run = vi
      .spyOn(handle.dispatcher, 'run')
      .mockResolvedValue({ moleculeId: 'mol-1', outputs: { result: 'opened https://github.com/o/r/pull/7' } } as never);
    const ticks = recordTicks(handle);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);
    expect(bd.callsFor('create')[0]).toEqual(expect.arrayContaining(['--ephemeral', '--deps', 'tracks:work-1']));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ motivatingBeadId: 'work-1', projectIdentifier: 'proj-x' });
    expect(ticks[0]!.payload).toMatchObject({ dispatched: 1, merged: 0 });
    expect(bd.contexts[0]).toMatchObject({ open: false, reason: 'dispatched' });
    // PR was left for a human: logged, no escalation marker comment, no merge.
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 7 }), expect.stringContaining('left for human review'));
    expect(bd.comments).toHaveLength(0);

    // Next tick: the bead is still in `bd ready` (the scheduler never mutates it)
    // but already has a terminal context, so it is NOT dispatched again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await handle.shutdown();
  });

  it('start failure (no project_role_agents rows) is contained: plane boots, scheduler null, no bd calls', async () => {
    const bd = fakeBd();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await boot({
      config: schedulerConfig(),
      listPoolMembers: () => [],
      bd: bd.run,
      appRoot: process.cwd(),
    });
    expect(handle.scheduler).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no project_role_agents rows'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(bd.calls).toHaveLength(0);
    await handle.shutdown();
    errSpy.mockRestore();
  });

  it('auto-merge is OFF by default: merging is impossible even if a PR were queued', async () => {
    const { disabledGitHubPort } = await import('../../../../src/engine/refinery/github.js');
    await expect(disabledGitHubPort.merge('o/r', 1)).rejects.toThrow('auto-merge is disabled');
    await expect(disabledGitHubPort.fetchFacts('o/r', 1, [])).rejects.toThrow('auto-merge is disabled');

    const bd = fakeBd();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = await boot({
      config: schedulerConfig({ autoMerge: true, requiredChecks: ['ci'], allowedRepos: ['o/r'] }),
      listPoolMembers: () => POOL,
      bd: bd.run, // no gh runner supplied
      appRoot: process.cwd(),
    });
    // autoMerge=true without a gh runner must refuse to start rather than silently run.
    expect(handle.scheduler).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no gh command runner'));
    await handle.shutdown();
    errSpy.mockRestore();
  });
});
