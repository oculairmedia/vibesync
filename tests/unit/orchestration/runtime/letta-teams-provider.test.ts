import { describe, expect, it, vi } from 'vitest';

import { LettaTeamsProvider } from '../../../../src/orchestration/runtime/index.js';
import type { SessionEvent } from '../../../../src/orchestration/runtime/provider.js';
import { EventBus, type Event } from '../../../../src/orchestration/events/bus.js';

/**
 * Unit-tests for LettaTeamsProvider. The SDK import is real; we inject
 * a fake runtime via the private `runtime` field for isolation. The
 * full integration (real SDK daemon + real Letta agents) is exercised
 * out-of-band; here we pin the interface contract.
 */

type TaskStateLike = {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  toolCalls?: { name: string; input?: string; success: boolean; error?: string }[];
};

function fakeRuntime(opts: { taskTimeline?: TaskStateLike[]; agentId?: string } = {}) {
  const exists = vi.fn(async (_name: string) => false);
  const spawn = vi.fn(async (input: { name: string; role: string }) => ({
    name: input.name,
    role: input.role,
    agentId: opts.agentId ?? `agent-${input.name}`,
  }));
  const remove = vi.fn(async (_name: string) => true);
  const getTeammate = vi.fn(async (name: string) => ({
    name,
    role: 'r',
    agentId: opts.agentId ?? `agent-${name}`,
  }));
  const dispatch = vi.fn(async (input: { target: string; message: string }) => ({
    taskId: `task-${input.target}`,
  }));
  const ensureRunning = vi.fn(async () => undefined);
  const daemonIsRunning = vi.fn(() => true);
  const daemonStop = vi.fn(async () => true);

  // tasks.get returns successive states from the supplied timeline,
  // sticking on the last entry once exhausted. Default: a single
  // done state so observe() short-circuits quickly.
  const timeline = opts.taskTimeline ?? [
    {
      id: 'task-default',
      status: 'done',
      createdAt: '2026-05-17T00:00:00.000Z',
      completedAt: '2026-05-17T00:00:01.000Z',
    },
  ];
  let cursor = 0;
  const get = vi.fn(async (_id: string): Promise<TaskStateLike> => {
    const state = timeline[Math.min(cursor, timeline.length - 1)]!;
    cursor = Math.min(cursor + 1, timeline.length - 1);
    return state;
  });

  return {
    runtime: {
      daemon: { ensureRunning, isRunning: daemonIsRunning, stop: daemonStop },
      teammates: { exists, spawn, remove, get: getTeammate },
      tasks: { dispatch, get },
    },
    spies: { exists, spawn, remove, dispatch, ensureRunning, get, daemonIsRunning, daemonStop, getTeammate },
  };
}

function newProvider(opts: ConstructorParameters<typeof LettaTeamsProvider>[0] = {}): LettaTeamsProvider {
  return new LettaTeamsProvider({
    pollIntervalMs: 0,
    initialTaskTimeoutMs: 50,
    sleep: async () => undefined,
    ...opts,
  });
}

function inject(provider: LettaTeamsProvider, runtime: unknown): void {
  (provider as unknown as { runtime: unknown }).runtime = runtime;
}

describe('LettaTeamsProvider', () => {
  it('spawns a teammate on first start and reuses it on second start', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);

    const h1 = await provider.start({ role: 'reviewer' });
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'reviewer', role: 'reviewer' });
    expect(h1.providerKind).toBe('letta-teams');
    expect(h1.id).toBe('letta-teams:reviewer');

    spies.exists.mockResolvedValueOnce(true);
    await provider.start({ role: 'reviewer' });
    expect(spies.spawn).toHaveBeenCalledTimes(1); // not re-spawned
  });

  it('uses an explicit target from spec.extra over the role', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    const h = await provider.start({ role: 'reviewer', extra: { target: 'reviewer-prime' } });
    expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'reviewer-prime' });
    expect(h.id).toBe('letta-teams:reviewer-prime');
  });

  it('forwards model/contextWindowLimit/spawnPrompt/memfsEnabled when provided', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    await provider.start({
      role: 'reviewer',
      extra: {
        model: 'letta/auto',
        contextWindowLimit: 50_000,
        spawnPrompt: 'Read carefully.',
        memfsEnabled: true,
      },
    });
    expect(spies.spawn.mock.calls[0]![0]).toMatchObject({
      model: 'letta/auto',
      contextWindowLimit: 50_000,
      spawnPrompt: 'Read carefully.',
      memfsEnabled: true,
    });
  });

  it('prompt joins text content blocks and dispatches to the target', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    const h = await provider.start({ role: 'reviewer' });
    await provider.prompt(h, [
      { type: 'text', text: 'review this:' },
      { type: 'text', text: 'foo bar' },
    ]);
    expect(spies.dispatch).toHaveBeenCalledWith({
      target: 'reviewer',
      message: 'review this:\nfoo bar',
    });
  });

  it('prompt surfaces an [image: <mime>] placeholder for image content', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    const h = await provider.start({ role: 'reviewer' });
    await provider.prompt(h, [
      { type: 'text', text: 'look:' },
      { type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' },
    ]);
    expect(spies.dispatch.mock.calls[0]![0]).toMatchObject({
      message: 'look:\n[image: image/jpeg]',
    });
  });

  it('rejects handles from other providers', async () => {
    const provider = newProvider();
    inject(provider, fakeRuntime().runtime);
    await expect(
      provider.prompt({ id: 'x', providerKind: 'letta-pm-agent' } as never, [
        { type: 'text', text: 'hi' },
      ]),
    ).rejects.toThrow(/handle from wrong provider/);
  });

  it('observe yields stopped when no task is dispatched before the timeout', async () => {
    const provider = newProvider();
    inject(provider, fakeRuntime().runtime);
    const h = await provider.start({ role: 'r' });
    const kinds: string[] = [];
    for await (const ev of provider.observe(h)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toEqual(['stopped']);
  });

  it('observe maps pending → running → done to started/first-token/turn-done', async () => {
    const provider = newProvider();
    const { runtime } = fakeRuntime({
      taskTimeline: [
        { id: 'task-r', status: 'pending', createdAt: '2026-05-17T00:00:00.000Z' },
        {
          id: 'task-r',
          status: 'running',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:01.000Z',
        },
        {
          id: 'task-r',
          status: 'done',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:01.000Z',
          completedAt: '2026-05-17T00:00:02.000Z',
          result: 'ok',
        },
      ],
    });
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });
    await provider.prompt(h, [{ type: 'text', text: 'go' }]);
    const events: SessionEvent[] = [];
    for await (const ev of provider.observe(h)) events.push(ev);

    expect(events.map((e) => e.kind)).toEqual(['started', 'first-token', 'message-delta', 'turn-done']);
    expect(events[0]!.ts).toBe('2026-05-17T00:00:00.000Z');
    expect(events[1]!.ts).toBe('2026-05-17T00:00:01.000Z');
    expect(events[2]).toMatchObject({ kind: 'message-delta', text: 'ok' });
    const last = events[3] as Extract<SessionEvent, { kind: 'turn-done' }>;
    expect(last.ts).toBe('2026-05-17T00:00:02.000Z');
    expect(last.stopReason).toBe('done');
  });

  it('observe can reattach to a task id supplied at start time', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime({
      taskTimeline: [
        {
          id: 'task-resume-1',
          status: 'done',
          createdAt: '2026-05-17T00:00:00.000Z',
          completedAt: '2026-05-17T00:00:01.000Z',
          result: 'recovered',
        },
      ],
    });
    inject(provider, runtime);
    const h = await provider.start({ role: 'reviewer', extra: { moleculeId: 'mol-1', resumeTaskId: 'task-resume-1' } });
    const events: SessionEvent[] = [];

    for await (const ev of provider.observe(h)) events.push(ev);

    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.get).toHaveBeenCalledWith('task-resume-1');
    expect(events.map((e) => e.kind)).toEqual(['started', 'message-delta', 'turn-done']);
    expect(events[1]).toMatchObject({ kind: 'message-delta', text: 'recovered' });
  });

  it('observe emits tool-call + tool-result frames as toolCalls grow', async () => {
    const provider = newProvider();
    const { runtime } = fakeRuntime({
      taskTimeline: [
        {
          id: 'task-r',
          status: 'running',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:00.500Z',
        },
        {
          id: 'task-r',
          status: 'running',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:00.500Z',
          toolCalls: [{ name: 'read_file', input: 'src/foo.ts', success: true }],
        },
        {
          id: 'task-r',
          status: 'done',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:00.500Z',
          completedAt: '2026-05-17T00:00:02.000Z',
          toolCalls: [
            { name: 'read_file', input: 'src/foo.ts', success: true },
            { name: 'write_file', input: 'src/foo.ts', success: false, error: 'EACCES' },
          ],
        },
      ],
    });
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });
    await provider.prompt(h, [{ type: 'text', text: 'edit' }]);
    const events: SessionEvent[] = [];
    for await (const ev of provider.observe(h)) events.push(ev);

    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'first-token',
      'tool-call',
      'tool-result',
      'tool-call',
      'tool-result',
      'turn-done',
    ]);
    const firstToolCall = events[2] as Extract<SessionEvent, { kind: 'tool-call' }>;
    expect(firstToolCall.tool).toBe('read_file');
    expect(firstToolCall.args).toBe('src/foo.ts');
    const firstResult = events[3] as Extract<SessionEvent, { kind: 'tool-result' }>;
    expect(firstResult.ok).toBe(true);
    const secondResult = events[5] as Extract<SessionEvent, { kind: 'tool-result' }>;
    expect(secondResult.ok).toBe(false);
    expect(secondResult.result).toBe('EACCES');
  });

  it('observe surfaces a terminal error when the task fails', async () => {
    const provider = newProvider();
    const { runtime } = fakeRuntime({
      taskTimeline: [
        {
          id: 'task-r',
          status: 'error',
          createdAt: '2026-05-17T00:00:00.000Z',
          completedAt: '2026-05-17T00:00:01.000Z',
          error: 'agent crashed',
        },
      ],
    });
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });
    await provider.prompt(h, [{ type: 'text', text: 'go' }]);
    const events: SessionEvent[] = [];
    for await (const ev of provider.observe(h)) events.push(ev);

    expect(events.map((e) => e.kind)).toEqual(['started', 'error']);
    const err = events[1] as Extract<SessionEvent, { kind: 'error' }>;
    expect(err.code).toBe('task_error');
    expect(err.message).toBe('agent crashed');
  });

  it('observe ends with stopped when stop() is called mid-stream', async () => {
    const provider = newProvider();
    const { runtime } = fakeRuntime({
      taskTimeline: [
        { id: 'task-r', status: 'pending', createdAt: '2026-05-17T00:00:00.000Z' },
        {
          id: 'task-r',
          status: 'running',
          createdAt: '2026-05-17T00:00:00.000Z',
          startedAt: '2026-05-17T00:00:01.000Z',
        },
        // After this point, the timeline keeps repeating 'running' so
        // observe() would loop forever without an external stop.
      ],
    });
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });
    await provider.prompt(h, [{ type: 'text', text: 'go' }]);

    const events: SessionEvent[] = [];
    const consumer = (async () => {
      for await (const ev of provider.observe(h)) {
        events.push(ev);
        if (ev.kind === 'first-token') {
          await provider.stop(h);
        }
      }
    })();

    await consumer;
    expect(events.map((e) => e.kind)).toEqual(['started', 'first-token', 'stopped']);
  });

  it('a second turn re-streams events without re-emitting prior turn-done', async () => {
    const provider = newProvider();
    const timeline: TaskStateLike[] = [
      { id: 'task-r', status: 'pending', createdAt: '2026-05-17T00:00:00.000Z' },
      {
        id: 'task-r',
        status: 'done',
        createdAt: '2026-05-17T00:00:00.000Z',
        completedAt: '2026-05-17T00:00:01.000Z',
      },
    ];
    const { runtime, spies } = fakeRuntime({ taskTimeline: timeline });
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });

    await provider.prompt(h, [{ type: 'text', text: 'turn 1' }]);
    const first: SessionEvent[] = [];
    for await (const ev of provider.observe(h)) first.push(ev);
    expect(first.map((e) => e.kind)).toEqual(['started', 'turn-done']);

    // Reset the get-cursor so a second turn replays the pending → done arc.
    spies.get.mockClear();
    let cursor = 0;
    spies.get.mockImplementation(async () => {
      const state = timeline[Math.min(cursor, timeline.length - 1)]!;
      cursor = Math.min(cursor + 1, timeline.length - 1);
      return state as never;
    });

    await provider.prompt(h, [{ type: 'text', text: 'turn 2' }]);
    const second: SessionEvent[] = [];
    for await (const ev of provider.observe(h)) second.push(ev);
    expect(second.map((e) => e.kind)).toEqual(['started', 'turn-done']);
  });

  it('ensureDaemonRunning calls daemon.ensureRunning', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    await provider.ensureDaemonRunning();
    expect(spies.ensureRunning).toHaveBeenCalled();
  });

  it('stop calls teammates.remove', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);
    const h = await provider.start({ role: 'r' });
    await provider.stop(h);
    expect(spies.remove).toHaveBeenCalledWith('r');
  });

  it('stop can reconstruct the teammate target from a persisted handle id', async () => {
    const provider = newProvider();
    const { runtime, spies } = fakeRuntime();
    inject(provider, runtime);

    await provider.stop({ id: 'letta-teams:mol-1-reviewer', providerKind: 'letta-teams' });

    expect(spies.remove).toHaveBeenCalledWith('mol-1-reviewer');
  });

  describe('memory-block seeding', () => {
    it('calls the seeder with the role pack blocks after spawning a new teammate', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime, spies } = fakeRuntime({ agentId: 'agent-xyz' });
      inject(provider, runtime);
      await provider.start({
        role: 'reviewer',
        extra: {
          memoryBlocks: [
            { label: 'persona', value: 'You are a senior reviewer.', limit: 2000 },
            { label: 'guardrails', value: 'Block PRs that miss tests.' },
          ],
        },
      });
      expect(spies.spawn).toHaveBeenCalledTimes(1);
      expect(seed).toHaveBeenCalledTimes(1);
      expect(seed).toHaveBeenCalledWith('agent-xyz', [
        { label: 'persona', value: 'You are a senior reviewer.', limit: 2000 },
        { label: 'guardrails', value: 'Block PRs that miss tests.' },
      ]);
    });

    it('seeds against an existing teammate via teammates.get', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime, spies } = fakeRuntime({ agentId: 'agent-existing' });
      spies.exists.mockResolvedValueOnce(true);
      inject(provider, runtime);
      await provider.start({
        role: 'reviewer',
        extra: {
          memoryBlocks: [{ label: 'persona', value: 'reuse' }],
        },
      });
      expect(spies.spawn).not.toHaveBeenCalled();
      expect(spies.getTeammate).toHaveBeenCalledWith('reviewer');
      expect(seed).toHaveBeenCalledWith('agent-existing', [{ label: 'persona', value: 'reuse' }]);
    });

    it('does nothing when no memoryBlocks are supplied', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime } = fakeRuntime();
      inject(provider, runtime);
      await provider.start({ role: 'reviewer' });
      expect(seed).not.toHaveBeenCalled();
    });

    it('throws a useful error when memoryBlocks supplied but no seeder injected', async () => {
      const provider = newProvider();
      const { runtime } = fakeRuntime();
      inject(provider, runtime);
      await expect(
        provider.start({
          role: 'reviewer',
          extra: { memoryBlocks: [{ label: 'p', value: 'v' }] },
        }),
      ).rejects.toThrow(/no memoryBlockSeeder was injected/);
    });

    it('filters out malformed block entries before seeding', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);
      await provider.start({
        role: 'reviewer',
        extra: {
          memoryBlocks: [
            { label: 'good', value: 'ok' },
            { label: '', value: 'missing label' },
            { value: 'no label' },
            { label: 'bad-value', value: 42 },
            'not even a block',
          ],
        },
      });
      expect(seed).toHaveBeenCalledWith('agent-1', [{ label: 'good', value: 'ok' }]);
    });

    it('passes replace mode through to the memory block seeder', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await provider.start({
        role: 'reviewer',
        extra: {
          memoryBlocks: [{ label: 'persona', value: 'replace me' }],
          memoryBlockSeedMode: 'replace',
        },
      });

      expect(seed).toHaveBeenCalledWith('agent-1', [{ label: 'persona', value: 'replace me' }], { mode: 'replace' });
    });

    it('calls the seeder for replace mode even when the role has no memory blocks', async () => {
      const seed = vi.fn(async () => undefined);
      const provider = newProvider({ memoryBlockSeeder: { seed } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await provider.start({
        role: 'reviewer',
        extra: { memoryBlocks: [], memoryBlockSeedMode: 'replace' },
      });

      expect(seed).toHaveBeenCalledWith('agent-1', [], { mode: 'replace' });
    });
  });

  describe('role-tool attachment (vibesync-cs2)', () => {
    const collectToolAttachEvents = (bus: EventBus): Event[] => {
      const out: Event[] = [];
      bus.subscribe((event) => {
        if (event.kind.startsWith('runtime/teammate.tool_attach.')) out.push(event);
      });
      return out;
    };

    it('calls the attacher once per declared tool and emits per-tool events on the bus', async () => {
      const bus = new EventBus({ noPersist: true });
      const events = collectToolAttachEvents(bus);

      const attach = vi.fn(async (_agentId: string, toolName: string) => {
        if (toolName === 'dispatch_molecule') return { status: 'attached' as const };
        if (toolName === 'search_folder_passages') return { status: 'already_attached' as const };
        if (toolName === 'read_file') return { status: 'unknown' as const };
        return { status: 'error' as const, error: 'boom' };
      });
      const provider = newProvider({ eventBus: bus, toolAttacher: { attach } });
      const { runtime } = fakeRuntime({ agentId: 'agent-mayor' });
      inject(provider, runtime);

      await provider.start({
        role: 'mayor',
        extra: {
          moleculeId: 'mol-1',
          tools: ['dispatch_molecule', 'search_folder_passages', 'read_file', 'flaky_tool'],
        },
      });

      expect(attach).toHaveBeenCalledTimes(4);
      expect(attach.mock.calls.map((c) => c[1])).toEqual([
        'dispatch_molecule',
        'search_folder_passages',
        'read_file',
        'flaky_tool',
      ]);
      const byKind = (k: string) => events.filter((e) => e.kind === k);
      expect(byKind('runtime/teammate.tool_attach.attached')).toHaveLength(1);
      expect(byKind('runtime/teammate.tool_attach.already_attached')).toHaveLength(1);
      expect(byKind('runtime/teammate.tool_attach.unknown')).toHaveLength(1);
      expect(byKind('runtime/teammate.tool_attach.error')).toHaveLength(1);
      const errorEvt = byKind('runtime/teammate.tool_attach.error')[0]!;
      expect(errorEvt.payload).toMatchObject({ tool: 'flaky_tool', agent_id: 'agent-mayor', error: 'boom' });
      expect(errorEvt.molecule_id).toBe('mol-1');
      expect(errorEvt.teammate).toBe('mol-1-mayor');
    });

    it('reports a thrown attacher as an error event without crashing start()', async () => {
      const bus = new EventBus({ noPersist: true });
      const events = collectToolAttachEvents(bus);

      const attach = vi.fn(async () => {
        throw new Error('letta down');
      });
      const provider = newProvider({ eventBus: bus, toolAttacher: { attach } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await expect(
        provider.start({ role: 'mayor', extra: { tools: ['dispatch_molecule'] } }),
      ).resolves.toBeDefined();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ tool: 'dispatch_molecule', error: 'letta down' });
    });

    it('emits a single skipped event with reason=no_attacher when tools declared but no attacher wired', async () => {
      const bus = new EventBus({ noPersist: true });
      const events = collectToolAttachEvents(bus);

      const provider = newProvider({ eventBus: bus });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await provider.start({ role: 'mayor', extra: { tools: ['dispatch_molecule', 'read_file'] } });

      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        reason: 'no_attacher',
        tools: ['dispatch_molecule', 'read_file'],
      });
    });

    it('emits a single skipped event with reason=no_agent_id when teammate lacks agentId', async () => {
      const bus = new EventBus({ noPersist: true });
      const events = collectToolAttachEvents(bus);

      const attach = vi.fn(async () => ({ status: 'attached' as const }));
      const provider = newProvider({ eventBus: bus, toolAttacher: { attach } });
      const { runtime, spies } = fakeRuntime();
      // Make spawn return a teammate without an agentId.
      spies.spawn.mockImplementationOnce(async (input: { name: string; role: string }) => ({
        name: input.name,
        role: input.role,
      } as never));
      inject(provider, runtime);

      await provider.start({ role: 'mayor', extra: { tools: ['dispatch_molecule'] } });

      expect(attach).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ reason: 'no_agent_id', tools: ['dispatch_molecule'] });
    });

    it('does nothing when no tools are declared', async () => {
      const attach = vi.fn(async () => ({ status: 'attached' as const }));
      const provider = newProvider({ toolAttacher: { attach } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await provider.start({ role: 'reviewer' });
      expect(attach).not.toHaveBeenCalled();
    });

    it('dedupes tool names and drops non-string entries before iterating', async () => {
      const attach = vi.fn(async (_agentId: string, _toolName: string) => ({ status: 'attached' as const }));
      const provider = newProvider({ toolAttacher: { attach } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);

      await provider.start({
        role: 'mayor',
        extra: { tools: ['dispatch_molecule', '', 42, 'dispatch_molecule', 'search_folder_passages'] as unknown as readonly string[] },
      });

      expect(attach.mock.calls.map((call) => call[1])).toEqual(['dispatch_molecule', 'search_folder_passages']);
    });
  });

  describe('memfs lifecycle', () => {
    it('forwards memfsStartup when supplied as a valid mode', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      await provider.start({
        role: 'coder',
        extra: { memfsEnabled: true, memfsStartup: 'blocking' },
      });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({
        memfsEnabled: true,
        memfsStartup: 'blocking',
      });
    });

    it('omits memfsStartup when caller supplies an invalid value', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      await provider.start({
        role: 'coder',
        extra: { memfsEnabled: true, memfsStartup: 'nonsense' },
      });
      const args = spies.spawn.mock.calls[0]![0] as Record<string, unknown>;
      expect(args['memfsEnabled']).toBe(true);
      expect('memfsStartup' in args).toBe(false);
    });

    it('memfs teardown rides with teammates.remove on stop()', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const h = await provider.start({ role: 'coder', extra: { memfsEnabled: true } });
      await provider.stop(h);
      expect(spies.remove).toHaveBeenCalledWith('coder');
    });
  });

  describe('teammate delete (vibesync-6zj)', () => {
    it('calls teammateDeleter.delete with the Letta agentId captured at spawn time', async () => {
      const del = vi.fn(async (_agentId: string) => undefined);
      const provider = newProvider({ teammateDeleter: { delete: del } });
      const { runtime, spies } = fakeRuntime({ agentId: 'agent-coder-123' });
      inject(provider, runtime);
      const h = await provider.start({ role: 'coder' });
      await provider.stop(h);
      // The SDK's local-file remove still runs first.
      expect(spies.remove).toHaveBeenCalledWith('coder');
      // Then the actual Letta agent gets deleted via the injected deleter.
      expect(del).toHaveBeenCalledWith('agent-coder-123');
    });

    it('logs but does not throw when the deleter rejects (e.g. server unreachable)', async () => {
      const del = vi.fn(async () => { throw new Error('letta down'); });
      const provider = newProvider({ teammateDeleter: { delete: del } });
      const { runtime } = fakeRuntime({ agentId: 'agent-x' });
      inject(provider, runtime);
      const h = await provider.start({ role: 'coder' });
      // stop() must not propagate the deleter failure — it runs from the
      // dispatcher's finally-block; throwing would mask the real error.
      await expect(provider.stop(h)).resolves.toBeUndefined();
      expect(del).toHaveBeenCalledWith('agent-x');
    });

    it('skips the deleter cleanly when no agentId was captured', async () => {
      const del = vi.fn(async () => undefined);
      const provider = newProvider({ teammateDeleter: { delete: del } });
      const { runtime, spies } = fakeRuntime();
      // Make spawn return a teammate without an agentId.
      spies.spawn.mockImplementationOnce(async (input: { name: string; role: string }) => ({
        name: input.name,
        role: input.role,
      } as never));
      inject(provider, runtime);
      const h = await provider.start({ role: 'coder' });
      await provider.stop(h);
      expect(del).not.toHaveBeenCalled();
    });

    it('warns once when no deleter is wired but spawned agents have ids', async () => {
      const provider = newProvider(); // no teammateDeleter
      const warnSpy = vi.spyOn(console, 'warn');
      const ourWarns: string[] = [];
      warnSpy.mockImplementation((...args: unknown[]) => {
        const msg = args.map((p) => String(p)).join(' ');
        if (msg.includes('teammateDeleter not wired')) ourWarns.push(msg);
      });
      try {
        const { runtime } = fakeRuntime({ agentId: 'agent-1' });
        inject(provider, runtime);
        const h1 = await provider.start({ role: 'coder' });
        await provider.stop(h1);
        const h2 = await provider.start({ role: 'reviewer' });
        await provider.stop(h2);
        // Warning fires exactly once across two stops on the same provider.
        expect(ourWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('emits runtime/teammate.delete.skipped on EVERY stop with a missing deleter (vibesync-03k)', async () => {
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => {
        if (e.kind === 'runtime/teammate.delete.skipped') events.push(e);
      });
      const provider = newProvider({ eventBus: bus }); // no teammateDeleter
      // Silence the (intentional) one-shot console.warn so test output stays clean.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { runtime } = fakeRuntime({ agentId: 'agent-1' });
        inject(provider, runtime);

        const h1 = await provider.start({ role: 'coder', extra: { moleculeId: 'mol-1' } });
        await provider.stop(h1);
        const h2 = await provider.start({ role: 'reviewer', extra: { moleculeId: 'mol-2' } });
        await provider.stop(h2);
        const h3 = await provider.start({ role: 'tester' });
        await provider.stop(h3);

        // Three stops → three events. The whole point of vibesync-03k.
        expect(events).toHaveLength(3);

        // Envelope shape: layer=runtime, kind set, teammate carries the
        // target, molecule_id carries through when supplied, agent_id
        // surfaces in payload so dashboards can show which agent leaked.
        expect(events[0]).toMatchObject({
          layer: 'runtime',
          kind: 'runtime/teammate.delete.skipped',
          teammate: 'mol-1-coder',
          molecule_id: 'mol-1',
          payload: { reason: 'no_deleter', agent_id: 'agent-1', target: 'mol-1-coder' },
        });
        expect(events[1]).toMatchObject({
          teammate: 'mol-2-reviewer',
          molecule_id: 'mol-2',
          payload: { agent_id: 'agent-1' },
        });
        // No moleculeId provided → no molecule_id on the envelope.
        expect(events[2]!.teammate).toBe('tester');
        expect(events[2]!.molecule_id).toBeUndefined();

        // Console warn remains one-shot — bus event is the canonical
        // per-leak signal, the warn just announces the wiring gap.
        const ourWarns = warnSpy.mock.calls
          .map((c) => c.map((p) => String(p)).join(' '))
          .filter((m) => m.includes('teammateDeleter not wired'));
        expect(ourWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('emits no delete.skipped event when no bus is wired', async () => {
      const provider = newProvider(); // no bus, no deleter
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { runtime } = fakeRuntime({ agentId: 'agent-1' });
        inject(provider, runtime);
        const h = await provider.start({ role: 'coder' });
        // Should not throw; helper exits early when this.eventBus is undefined.
        await expect(provider.stop(h)).resolves.toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('clears its session entry on stop so a re-spawn starts fresh', async () => {
      const del = vi.fn(async () => undefined);
      const provider = newProvider({ teammateDeleter: { delete: del } });
      const { runtime } = fakeRuntime({ agentId: 'agent-1' });
      inject(provider, runtime);
      const h = await provider.start({ role: 'coder' });
      const sessionsBefore = (provider as unknown as { sessions: Map<string, unknown> }).sessions.size;
      await provider.stop(h);
      const sessionsAfter = (provider as unknown as { sessions: Map<string, unknown> }).sessions.size;
      expect(sessionsBefore).toBe(1);
      expect(sessionsAfter).toBe(0);
    });
  });

  describe('init handling (role packs own memory blocks)', () => {
    it('passes skipInit: true on spawn by default', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      await provider.start({ role: 'reviewer' });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ skipInit: true });
    });

    it('opts back in to teams init when extra.runTeamsInit is true', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      await provider.start({ role: 'reviewer', extra: { runTeamsInit: true } });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ skipInit: false });
    });
  });

  describe('molecule-scoped naming', () => {
    it('uses ${moleculeId}-${role} as the teammate target when moleculeId is supplied', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const h = await provider.start({ role: 'reviewer', extra: { moleculeId: 'mol-1' } });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'mol-1-reviewer' });
      expect(h.id).toBe('letta-teams:mol-1-reviewer');
    });

    it('falls back to the bare role name when no moleculeId is supplied', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const h = await provider.start({ role: 'reviewer' });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'reviewer' });
      expect(h.id).toBe('letta-teams:reviewer');
    });

    it('explicit extra.target wins over moleculeId-derived naming', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const h = await provider.start({
        role: 'reviewer',
        extra: { moleculeId: 'mol-1', target: 'reviewer-prime' },
      });
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'reviewer-prime' });
      expect(h.id).toBe('letta-teams:reviewer-prime');
    });

    it('two molecules running the same role spawn distinct teammates', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const h1 = await provider.start({ role: 'reviewer', extra: { moleculeId: 'mol-1' } });
      const h2 = await provider.start({ role: 'reviewer', extra: { moleculeId: 'mol-2' } });

      expect(spies.spawn).toHaveBeenCalledTimes(2);
      expect(spies.spawn.mock.calls[0]![0]).toMatchObject({ name: 'mol-1-reviewer' });
      expect(spies.spawn.mock.calls[1]![0]).toMatchObject({ name: 'mol-2-reviewer' });
      expect(h1.id).not.toBe(h2.id);

      // Stopping one removes only that molecule's teammate.
      await provider.stop(h1);
      expect(spies.remove).toHaveBeenCalledTimes(1);
      expect(spies.remove).toHaveBeenLastCalledWith('mol-1-reviewer');
    });
  });

  describe('daemonSupervisor()', () => {
    it('returns an adapter that delegates to the SDK daemon surface', async () => {
      const provider = newProvider();
      const { runtime, spies } = fakeRuntime();
      inject(provider, runtime);
      const sup = provider.daemonSupervisor();

      expect(sup.id).toBe('letta-teams-daemon');
      expect(sup.providerKind).toBe('letta-teams');

      await sup.ensureRunning();
      expect(spies.ensureRunning).toHaveBeenCalledTimes(1);

      expect(await sup.isRunning()).toBe(true);
      expect(spies.daemonIsRunning).toHaveBeenCalled();

      await sup.stop();
      expect(spies.daemonStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('EventBus integration', () => {
    function makeBus(): { bus: EventBus; events: Event[] } {
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      return { bus, events };
    }

    it('publishes one runtime/session.* event per yielded SessionEvent', async () => {
      const { bus, events } = makeBus();
      const provider = newProvider({ eventBus: bus });
      const { runtime } = fakeRuntime({
        taskTimeline: [
          { id: 'task-r', status: 'pending', createdAt: '2026-05-17T00:00:00.000Z' },
          {
            id: 'task-r',
            status: 'running',
            createdAt: '2026-05-17T00:00:00.000Z',
            startedAt: '2026-05-17T00:00:01.000Z',
          },
          {
            id: 'task-r',
            status: 'done',
            createdAt: '2026-05-17T00:00:00.000Z',
            startedAt: '2026-05-17T00:00:01.000Z',
            completedAt: '2026-05-17T00:00:02.000Z',
          },
        ],
      });
      inject(provider, runtime);
      const h = await provider.start({ role: 'r' });
      await provider.prompt(h, [{ type: 'text', text: 'go' }]);
      const yielded: SessionEvent[] = [];
      for await (const ev of provider.observe(h)) yielded.push(ev);

      expect(events.map((e) => e.kind)).toEqual([
        'runtime/session.started',
        'runtime/session.first-token',
        'runtime/session.turn-done',
      ]);
      expect(events.length).toBe(yielded.length);
      for (const e of events) {
        expect(e.layer).toBe('runtime');
        expect(e.teammate).toBe('r');
        expect(e.task_id).toBe('task-r');
      }
    });

    it('carries molecule_id from SessionSpec.extra into every published event', async () => {
      const { bus, events } = makeBus();
      const provider = newProvider({ eventBus: bus });
      const { runtime } = fakeRuntime({
        taskTimeline: [
          {
            id: 'task-r',
            status: 'done',
            createdAt: '2026-05-17T00:00:00.000Z',
            completedAt: '2026-05-17T00:00:01.000Z',
          },
        ],
      });
      inject(provider, runtime);
      const h = await provider.start({ role: 'r', extra: { moleculeId: 'mol-42' } });
      await provider.prompt(h, [{ type: 'text', text: 'go' }]);
      for await (const _ of provider.observe(h)) void _;

      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e.molecule_id).toBe('mol-42');
    });

    it('carries tool-call args + tool-result ok/result into payload', async () => {
      const { bus, events } = makeBus();
      const provider = newProvider({ eventBus: bus });
      const { runtime } = fakeRuntime({
        taskTimeline: [
          {
            id: 'task-r',
            status: 'running',
            createdAt: '2026-05-17T00:00:00.000Z',
            startedAt: '2026-05-17T00:00:00.500Z',
            toolCalls: [{ name: 'read_file', input: 'src/foo.ts', success: true }],
          },
          {
            id: 'task-r',
            status: 'done',
            createdAt: '2026-05-17T00:00:00.000Z',
            completedAt: '2026-05-17T00:00:02.000Z',
            toolCalls: [
              { name: 'read_file', input: 'src/foo.ts', success: true },
              { name: 'write_file', input: 'src/foo.ts', success: false, error: 'EACCES' },
            ],
          },
        ],
      });
      inject(provider, runtime);
      const h = await provider.start({ role: 'r' });
      await provider.prompt(h, [{ type: 'text', text: 'edit' }]);
      for await (const _ of provider.observe(h)) void _;

      const toolCalls = events.filter((e) => e.kind === 'runtime/session.tool-call');
      const toolResults = events.filter((e) => e.kind === 'runtime/session.tool-result');
      expect(toolCalls.map((e) => e.payload?.['tool'])).toEqual(['read_file', 'write_file']);
      expect(toolResults.map((e) => e.payload?.['ok'])).toEqual([true, false]);
      expect(toolResults[1]!.payload?.['result']).toBe('EACCES');
    });

    it('publishes nothing when no bus is supplied', async () => {
      const provider = newProvider();
      const { runtime } = fakeRuntime({
        taskTimeline: [
          {
            id: 'task-r',
            status: 'done',
            createdAt: '2026-05-17T00:00:00.000Z',
            completedAt: '2026-05-17T00:00:01.000Z',
          },
        ],
      });
      inject(provider, runtime);
      const h = await provider.start({ role: 'r' });
      await provider.prompt(h, [{ type: 'text', text: 'go' }]);
      // Sanity check: observe() still yields events to the consumer.
      const yielded: SessionEvent[] = [];
      for await (const ev of provider.observe(h)) yielded.push(ev);
      expect(yielded.length).toBeGreaterThan(0);
      // No assertion against a bus — there is none. This case just
      // pins the no-op contract under the type checker.
    });
  });
});
