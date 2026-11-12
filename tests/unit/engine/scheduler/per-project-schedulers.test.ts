import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { BootSchedulerOptions } from '../../../../src/engine/scheduler/boot-scheduler.js';
import { FilePmWakeStateStore } from '../../../../src/engine/pm-wake/state.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';
import { StoreReadyStepSource } from '../../../../src/engine/scheduler/step-dispatcher.js';

const handles: OrchestrationHandle[] = [];
const dirs: string[] = [];

function scheduler(project: string, bd: BootSchedulerOptions['bd'], over: Partial<BootSchedulerOptions> = {}): BootSchedulerOptions {
  return {
    config: {
      enabled: true, projectIdentifier: project, intervalMs: 600_000, poolSize: 1, batchSize: 1, paused: false,
      readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: 'packs/gastown', autoMerge: false,
      requiredChecks: [], allowedRepos: [],
    },
    listPoolMembers: () => [{ agentId: `agent-${project}`, role: 'coder' }],
    bd,
    appRoot: process.cwd(),
    ...over,
  };
}

function fakeBd() {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'ready' || args[0] === 'list') return '[]';
      throw new Error(`unexpected bd call: ${args.join(' ')}`);
    },
  };
}

async function boot(schedulers: readonly BootSchedulerOptions[], startupEvents: string[] = []) {
  process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-iroh';
  process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = 'agent-parent';
  const dolt = new InMemoryDoltClient();
  const emit = vi.spyOn(console, 'error').mockImplementation((line) => {
    const text = String(line);
    if (text.includes('failed to start')) startupEvents.push(text);
  });
  const handle = await bootOrchestrationPlane({
    ...inMemoryBeads(), dolt: dolt as never,
    provider: { kind: 'fake', capabilities: [], start: vi.fn(), prompt: vi.fn(), observe: vi.fn(), stop: vi.fn() } as never,
    irohConnectionFactory: () => new IrohConnection({ dial: async () => { throw new Error('unexpected Iroh dial'); }, peerName: 'scheduler-test', backoff: { initialMs: 1, capMs: 1, maxAttempts: 1 } }),
    persistEvents: false, runDriftAuditOnBoot: false, schedulers,
  });
  emit.mockRestore();
  handles.push(handle);
  return { handle, startupEvents };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('per-project schedulers (vibesync-9lzk.55.9)', () => {
  it('starts one daemon per project and reads ready beads only through that project bd', async () => {
    const a = fakeBd();
    const b = fakeBd();
    const { handle } = await boot([scheduler('a', a.run), scheduler('b', b.run)]);
    expect(handle.schedulers.size).toBe(2);
    await handle.schedulers.get('a')!.daemon.tick();
    await handle.schedulers.get('b')!.daemon.tick();
    expect(a.calls.filter(([command]) => command === 'ready')).toHaveLength(2);
    expect(b.calls.filter(([command]) => command === 'ready')).toHaveLength(2);
  });

  it('contains an individual start failure and emits its project identifier', async () => {
    const failedBd = fakeBd();
    const workingBd = fakeBd();
    const startupEvents: string[] = [];
    const { handle } = await boot([
      scheduler('bad', failedBd.run, { listPoolMembers: () => [] }),
      scheduler('good', workingBd.run),
    ], startupEvents);
    expect(handle.schedulers.has('bad')).toBe(false);
    expect(handle.schedulers.has('good')).toBe(true);
    expect(startupEvents.join('\n')).toContain('project "bad"');
    await handle.schedulers.get('good')!.daemon.tick();
    expect(workingBd.calls.some(([command]) => command === 'ready')).toBe(true);
  });

  it('does not pause project B molecules when project A is paused', async () => {
    const visited: string[] = [];
    const ready = new StoreReadyStepSource(
      { findReadyStepsForMolecule: async (id) => { visited.push(id); return []; } },
      () => ['molecule-a', 'molecule-b'],
      (id) => id === 'molecule-a',
    );
    await ready.readySteps();
    expect(visited).toEqual(['molecule-b']);
  });

  it('rejects duplicate project options before boot work begins', async () => {
    const bd = fakeBd();
    await expect(boot([scheduler('same', bd.run), scheduler('same', bd.run)])).rejects.toThrow(/Duplicate scheduler project identifier/);
    expect(bd.calls).toEqual([]);
  });

  it('each project\'s PM wake uses its OWN inbox adapter when it has one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'per-project-inbox-'));
    dirs.push(dir);
    const sent: string[] = [];
    const adapter = (project: string) => ({
      sendInboxMessage: async (input: { to: string; msgId: string }) => {
        sent.push(`${project}:${input.to}`);
        return { accepted: true, delivered: true, msgId: input.msgId };
      },
    });
    const withInbox = (project: string) => scheduler(project, fakeBd().run, {
      pmWake: { lookupAgentId: () => `pm-${project}`, inboxAdapter: adapter(project) } as never,
    });
    const configured = (project: string) => {
      const opts = withInbox(project);
      return { ...opts, config: { ...opts.config, pmWake: { enabled: true, minIntervalMs: 60_000, backstopMs: 3_600_000, statePath: join(dir, 'pm-wake-state.json'), sink: 'inbox' as const } } };
    };
    const { handle } = await boot([configured('alpha'), configured('beta')]);
    const sinkOf = (project: string) => (handle.schedulers.get(project)!.pmWaker as unknown as { deps: { sink: { wake(i: unknown): Promise<unknown> } } }).deps.sink;
    await sinkOf('alpha').wake({ agentId: 'pm-alpha', reason: 'test', detail: 'd', wakeId: 'w-alpha' });
    await sinkOf('beta').wake({ agentId: 'pm-beta', reason: 'test', detail: 'd', wakeId: 'w-beta' });
    expect(sent).toEqual(['alpha:pm-alpha', 'beta:pm-beta']);
  });

  it('preserves both projects in the shared PM wake state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-wake-projects-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    const state = new FilePmWakeStateStore(file);
    state.save('a', { firstSeenAt: '2026-01-01T00:00:00.000Z', lastWokenAt: null, lastByReason: {} });
    state.save('b', { firstSeenAt: '2026-02-01T00:00:00.000Z', lastWokenAt: null, lastByReason: {} });
    expect(state.load('a')?.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.load('b')?.firstSeenAt).toBe('2026-02-01T00:00:00.000Z');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('a');
  });
});
