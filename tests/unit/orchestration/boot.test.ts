import { describe, expect, it } from 'vitest';

import { bootOrchestrationPlane } from '../../../src/orchestration/boot.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

describe('bootOrchestrationPlane', () => {
  it('returns a wired orchestration handle', async () => {
    const handle = await bootForTest();

    expect(handle.dispatcher).toBeDefined();
    expect(handle.provider.kind).toBe('letta-code-subagent');
    // One subscriber wired by default: the writeback hook (vibesync-0xo).
    // Detaches on shutdown — see the assertion after shutdown below.
    expect(handle.bus.subscriberCount()).toBe(1);
    expect(handle.patrol.daemonSnapshot()).toEqual([]);
    expect(handle.walker).toBeDefined();

    await handle.shutdown();
    expect(handle.bus.subscriberCount()).toBe(0);
  });

  it('shutdown is idempotent', async () => {
    const handle = await bootForTest();

    await handle.shutdown();
    await handle.shutdown();
    expect(handle.bus.subscriberCount()).toBe(0);
  });

  it('construct and shutdown leaves no tracked daemon behind', async () => {
    const handle = await bootForTest();

    await handle.shutdown();

    expect(handle.patrol.daemonSnapshot()).toEqual([]);
  });

  it('rejects the removed letta-teams provider kind', async () => {
    await expect(bootForTest({ VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-teams' })).rejects.toThrow('Letta Teams was removed');
  });

  it('boots with provider routing even when the global default parent env is absent', async () => {
    const handle = await bootForTest(
      { VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: '' },
      {
        providerRouting: {
          store: {
            getProjectProviderRouting(projectIdentifier) {
              if (projectIdentifier !== 'vibesync') return null;
              return {
                lettaBaseUrl: 'http://shim:8291',
                providerKind: 'letta-code-subagent',
                parentAgentId: 'agent-project-parent',
              };
            },
          },
        },
      },
    );

    expect(handle.provider.kind).toBe('letta-code-subagent');

    await handle.shutdown();
  });

  it('wires roleAgentBootstrapper when all deps are present', async () => {
    const fakeBootstrapper = {
      async ensureRoleAgent() {
        return { agentId: 'agent-test-role' } as never;
      },
    };
    const handle = await bootForTest(
      {},
      {
        providerRouting: {
          store: {
            getProjectProviderRouting(projectIdentifier) {
              if (projectIdentifier !== 'test-project') return null;
              return {
                lettaBaseUrl: 'http://shim:8291',
                providerKind: 'letta-code-subagent',
                parentAgentId: 'agent-project-parent',
              };
            },
          },
          roleAgentBootstrapper: fakeBootstrapper,
          packDirsByProject: { 'test-project': '/packs/test' },
          storageDirsByProject: { 'test-project': '/storage/test' },
        },
      },
    );

    expect(handle.dispatcher).toBeDefined();
    // The dispatcher should have a roleAgentContextResolver wired
    expect((handle.dispatcher as never as { roleAgentContextResolver?: unknown }).roleAgentContextResolver).toBeDefined();

    await handle.shutdown();
  });
});

async function bootForTest(
  env: Record<string, string> = {},
  opts: Partial<Parameters<typeof bootOrchestrationPlane>[0]> = {},
) {
  const previousApiKey = process.env.LETTA_API_KEY;
  const previousPassword = process.env.LETTA_PASSWORD;
  const previousProvider = process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
  const previousShim = process.env.VIBESYNC_LETTA_CODE_SHIM_URL;
  const previousParent = process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
  process.env.LETTA_API_KEY = 'test-key';
  delete process.env.LETTA_PASSWORD;
  delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
  delete process.env.VIBESYNC_LETTA_CODE_SHIM_URL;
  delete process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
  Object.assign(process.env, {
    VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-subagent',
    VIBESYNC_LETTA_CODE_SHIM_URL: 'http://shim:8291',
    VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: 'agent-parent',
    ...env,
  });
  try {
    return await bootOrchestrationPlane({
      dolt: new InMemoryDoltClient() as never,
      persistEvents: false,
      runDriftAuditOnBoot: false,
      ...opts,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = previousApiKey;
    if (previousPassword === undefined) delete process.env.LETTA_PASSWORD;
    else process.env.LETTA_PASSWORD = previousPassword;
    if (previousProvider === undefined) delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
    else process.env.VIBESYNC_ORCHESTRATION_PROVIDER = previousProvider;
    if (previousShim === undefined) delete process.env.VIBESYNC_LETTA_CODE_SHIM_URL;
    else process.env.VIBESYNC_LETTA_CODE_SHIM_URL = previousShim;
    if (previousParent === undefined) delete process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
    else process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID = previousParent;
  }
}
