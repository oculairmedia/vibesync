import { describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane } from '../../../src/orchestration/boot.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

const daemon = {
  ensureRunning: vi.fn(async () => undefined),
  isRunning: vi.fn(() => true),
  stop: vi.fn(async () => true),
};

vi.mock('letta-teams-sdk', () => ({
  createTeamsRuntime: () => ({
    daemon,
    teammates: {
      exists: vi.fn(async () => false),
      spawn: vi.fn(async (input: { name: string; role: string }) => ({
        name: input.name,
        role: input.role,
        agentId: `agent-${input.name}`,
      })),
      get: vi.fn(async (name: string) => ({ name, role: name, agentId: `agent-${name}` })),
      remove: vi.fn(async () => true),
    },
    tasks: {
      dispatch: vi.fn(async (input: { target: string }) => ({ taskId: `task-${input.target}` })),
      get: vi.fn(async (id: string) => ({
        id,
        status: 'done',
        createdAt: '2026-05-18T00:00:00.000Z',
        completedAt: '2026-05-18T00:00:01.000Z',
      })),
    },
  }),
}));

describe('bootOrchestrationPlane', () => {
  it('returns a wired orchestration handle', async () => {
    const handle = await bootForTest();

    expect(handle.dispatcher).toBeDefined();
    expect(handle.provider.kind).toBe('letta-teams');
    // One subscriber wired by default: the writeback hook (vibesync-0xo).
    // Detaches on shutdown — see the assertion after shutdown below.
    expect(handle.bus.subscriberCount()).toBe(1);
    expect(handle.patrol.daemonSnapshot()).toEqual([{ id: 'letta-teams-daemon', restartCount: 0, unhealthy: false }]);
    expect(handle.walker).toBeDefined();

    await handle.shutdown();
    expect(handle.bus.subscriberCount()).toBe(0);
  });

  it('shutdown is idempotent', async () => {
    daemon.stop.mockClear();
    const handle = await bootForTest();

    await handle.shutdown();
    await handle.shutdown();

    expect(daemon.stop).toHaveBeenCalledTimes(1);
  });

  it('construct and shutdown leaves no tracked daemon behind', async () => {
    const handle = await bootForTest();

    await handle.shutdown();

    expect(handle.patrol.daemonSnapshot()).toEqual([]);
  });
});

async function bootForTest() {
  const previousApiKey = process.env.LETTA_API_KEY;
  const previousPassword = process.env.LETTA_PASSWORD;
  process.env.LETTA_API_KEY = 'test-key';
  delete process.env.LETTA_PASSWORD;
  try {
    return await bootOrchestrationPlane({
      dolt: new InMemoryDoltClient() as never,
      persistEvents: false,
      runDriftAuditOnBoot: false,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = previousApiKey;
    if (previousPassword === undefined) delete process.env.LETTA_PASSWORD;
    else process.env.LETTA_PASSWORD = previousPassword;
  }
}
