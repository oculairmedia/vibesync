/**
 * Characterisation tests for the scheduler's boot code (vibesync-ji3w), written
 * BEFORE refactoring src/engine/scheduler/boot-scheduler.ts (startSchedulerDaemon
 * cc 13 / 84 lines, buildPmWaker cc 11, selectGitHubPort cc 10, selectPoolMembers
 * cc 9). The full suite takes 66 of its 89 branch arms; these pin the paths it
 * never takes, most importantly the auto-merge safeguards. They call the
 * exported startSchedulerDaemon directly with a stub bd, a stub pack and a
 * no-op dispatcher; nothing dials Iroh and no tick dispatches (paused).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../../../src/engine/events/index.js';
import {
  startSchedulerDaemon,
  type BootSchedulerOptions,
  type SchedulerBootConfig,
  type SchedulerHandle,
} from '../../../../src/engine/scheduler/boot-scheduler.js';
import type { Pack } from '../../../../src/engine/packs/pack.js';

const handles: SchedulerHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  vi.useRealTimers();
});

function config(over: Partial<SchedulerBootConfig> = {}): SchedulerBootConfig {
  return {
    enabled: true, projectIdentifier: 'proj', intervalMs: 3_600_000, poolSize: 2, batchSize: 1, paused: true,
    readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: 'packs/gastown',
    autoMerge: false, requiredChecks: [], allowedRepos: [], ...over,
  };
}

function start(over: Partial<SchedulerBootConfig> = {}, extra: Partial<BootSchedulerOptions> = {}) {
  const logs: Array<{ level: string; o: Record<string, unknown>; m: string }> = [];
  const logger = {
    info: (o: unknown, m: string) => { logs.push({ level: 'info', o: o as Record<string, unknown>, m }); },
    warn: (o: unknown, m: string) => { logs.push({ level: 'warn', o: o as Record<string, unknown>, m }); },
  };
  const packRoots: string[] = [];
  const bdCalls: string[][] = [];
  const bus = new EventBus({ noPersist: true });
  const started: Record<string, unknown>[] = [];
  bus.subscribe((e) => { if (e.kind === 'daemon/scheduler.started') started.push(e.payload as Record<string, unknown>); });
  const handle = startSchedulerDaemon({
    config: config(over),
    listPoolMembers: () => [{ agentId: 'a1', role: 'coder' }, { agentId: 'a1', role: 'coder' }, { agentId: 'a2', role: 'coder' }],
    bd: async (args: readonly string[]) => { bdCalls.push([...args]); return '[]'; },
    logger,
    dispatcher: { run: vi.fn(), cancel: vi.fn() } as never,
    bus,
    loadPack: (root) => { packRoots.push(root); return { formulas: [{ name: 'onboard-feature' }], manifest: { name: 'stub' } } as unknown as Pack; },
    ...extra,
  } as never);
  handles.push(handle);
  return { handle, logs, packRoots, bus, started, bdCalls };
}

describe('auto-merge safeguards', () => {
  it('auto-merge without a gh runner is refused', () => {
    expect(() => start({ autoMerge: true, requiredChecks: ['ci'], allowedRepos: ['o/r'] })).toThrow('scheduler.autoMerge=true but no gh command runner was supplied');
  });

  it('auto-merge without required checks is refused', () => {
    expect(() => start({ autoMerge: true, requiredChecks: [], allowedRepos: ['o/r'] }, { gh: async () => '' })).toThrow('requires at least one scheduler.requiredChecks name');
  });

  it('auto-merge without allowed repos is refused', () => {
    expect(() => start({ autoMerge: true, requiredChecks: ['ci'], allowedRepos: [] }, { gh: async () => '' })).toThrow('requires at least one scheduler.allowedRepos owner/repo');
  });

  it('auto-merge fully configured starts, and says so loudly', () => {
    const { logs } = start({ autoMerge: true, requiredChecks: ['ci'], allowedRepos: ['o/r'] }, { gh: async () => '' });
    const enabled = logs.find((l) => l.m.startsWith('scheduler: AUTO-MERGE ENABLED'));
    expect(enabled?.level).toBe('warn');
    expect(enabled?.o).toEqual({ requiredChecks: ['ci'], allowedRepos: ['o/r'] });
  });
});

describe('start', () => {
  it('refuses to start when the scheduler is disabled', () => {
    expect(() => start({ enabled: false })).toThrow('scheduler.enabled=false');
  });

  it('a duplicated pool member is counted once; too few members warns and shrinks the pool', () => {
    const { logs, bus } = start({ poolSize: 3 });
    const warn = logs.find((l) => l.m.includes('fewer pool members than scheduler.poolSize'));
    expect(warn?.o).toEqual({ configured: 3, available: 2, project: 'proj' });
    void bus;
  });

  it('enough members: no shrink warning, and the pool stops at poolSize', () => {
    const { logs, started } = start({ poolSize: 1 });
    expect(logs.some((l) => l.m.includes('fewer pool members'))).toBe(false);
    expect(started[0]?.['poolSize']).toBe(1);
  });

  it('a relative pack directory resolves against the app root; an absolute one is used as is', () => {
    expect(start({}, { appRoot: '/srv/app' }).packRoots).toEqual(['/srv/app/packs/gastown']);
    expect(start({ packDir: '/opt/packs/x' }, { appRoot: '/srv/app' }).packRoots).toEqual(['/opt/packs/x']);
  });

  it('without an app root it falls back to VIBESYNC_APP_ROOT, then the working directory', () => {
    const saved = process.env['VIBESYNC_APP_ROOT'];
    try {
      process.env['VIBESYNC_APP_ROOT'] = '/env/root';
      expect(start().packRoots).toEqual(['/env/root/packs/gastown']);
      delete process.env['VIBESYNC_APP_ROOT'];
      expect(start().packRoots).toEqual([`${process.cwd()}/packs/gastown`]);
    } finally {
      if (saved === undefined) delete process.env['VIBESYNC_APP_ROOT']; else process.env['VIBESYNC_APP_ROOT'] = saved;
    }
  });
});

describe('the PM waker', () => {
  const pmWake = { enabled: true, minIntervalMs: 1000, backstopMs: 60_000, statePath: '/tmp/never-written.json' };
  const store = { load: () => ({}), save: () => undefined } as never;

  it('disabled or absent: no waker, even with a registry lookup supplied', () => {
    expect(start().handle.pmWaker).toBeNull();
    const disabled = start({ pmWake: { ...pmWake, enabled: false } }, { pmWake: { lookupAgentId: () => 'agent-pm', store } });
    expect(disabled.handle.pmWaker).toBeNull();
    expect(disabled.logs.some((l) => l.m.startsWith('pm-wake:'))).toBe(false);
  });

  it('enabled without a registry lookup: no waker, and a warning names the project', () => {
    const { handle, logs } = start({ pmWake });
    expect(handle.pmWaker).toBeNull();
    const warned = logs.find((l) => l.m.startsWith('pm-wake: enabled but no PM registry lookup supplied'));
    expect(warned?.level).toBe('warn');
    expect(warned?.o).toEqual({ project: 'proj' });
  });

  it('enabled with a lookup: a waker is built', () => {
    expect(start({ pmWake }, { pmWake: { lookupAgentId: () => 'agent-pm', store } }).handle.pmWaker).not.toBeNull();
  });

  it("sink 'inbox' without an inbox adapter is refused", () => {
    expect(() => start({ pmWake: { ...pmWake, sink: 'inbox' } }, { pmWake: { lookupAgentId: () => 'agent-pm', store } }))
      .toThrow("scheduler.pmWake.sink='inbox' is blocked until the approved MobileAgentMessageSender service adapter is supplied");
  });
});

describe('a bead status change asks for a tick', () => {
  it('only for a triggering status, with the issue and both statuses in the detail', () => {
    const { handle, bus } = start();
    const asked = vi.spyOn(handle.daemon, 'requestTick');
    bus.emit({ layer: 'daemon', kind: 'beads/issue.status_changed', payload: { issueId: 'b-1', from: 'open', to: 'closed' } });
    bus.emit({ layer: 'daemon', kind: 'beads/issue.status_changed', payload: { issueId: 'b-2', from: 'open', to: 'blocked' } });
    bus.emit({ layer: 'daemon', kind: 'beads/issue.status_changed', payload: { to: 'ready' } });
    expect(asked.mock.calls).toEqual([['bead-status', 'b-1 open->closed'], ['bead-status', 'issue ?->ready']]);
  });
});

/** The daemon's own dependencies, as boot wired them (read-only view for wiring checks). */
const depsOf = (handle: SchedulerHandle) => (handle.daemon as unknown as { deps: Record<string, unknown> }).deps;

describe('what boot hands the daemon', () => {
  it('the effective pool size (after dedupe), not the configured one', () => {
    const { handle, started } = start({ poolSize: 5 });
    expect((depsOf(handle)['config'] as () => { poolSize: number })().poolSize).toBe(2);
    expect(started[0]?.['poolSize']).toBe(2);
  });

  it('the run deadline and debounce overrides, when configured, and nothing when not', () => {
    expect(depsOf(start({ runDeadlineMs: 1234, eventDebounceMs: 56 }).handle)).toMatchObject({ runDeadlineMs: 1234, eventDebounceMs: 56 });
    const plain = depsOf(start().handle);
    expect(plain).not.toHaveProperty('runDeadlineMs');
    expect(plain).not.toHaveProperty('eventDebounceMs');
  });

  it('an escalated run leaves its reason on the bead and, with a waker, notes a stall', async () => {
    const pmWake = { enabled: true, minIntervalMs: 1000, backstopMs: 60_000, statePath: '/tmp/never-written.json' };
    const store = { load: () => ({}), save: () => undefined } as never;
    const { handle, bdCalls } = start({ pmWake }, { pmWake: { lookupAgentId: () => 'agent-pm', store } });
    const stall = vi.spyOn(handle.pmWaker!, 'noteStall');
    const escalated = depsOf(handle)['onRunEscalated'] as (i: { workBeadId: string; contextId: string; reason: string }) => Promise<void>;
    await escalated({ workBeadId: 'b-9', contextId: 'ctx-1', reason: 'gate failed\nmore' });
    expect(bdCalls.find((c) => c[0] === 'comments' && c[1] === 'add' && c[2] === 'b-9')?.[3]).toContain('gate failed');
    expect(stall).toHaveBeenCalledWith('b-9', expect.stringContaining('gate failed'));
  });
});

describe('stop', () => {
  it('is idempotent: a second stop returns the same promise and emits stopped once', async () => {
    const { handle, bus } = start();
    const stoppedEvents: unknown[] = [];
    bus.subscribe((e) => { if (e.kind === 'daemon/scheduler.stopped') stoppedEvents.push(e); });
    const first = handle.stop();
    expect(handle.stop()).toBe(first);
    await first;
    expect(stoppedEvents).toHaveLength(1);
  });
});
