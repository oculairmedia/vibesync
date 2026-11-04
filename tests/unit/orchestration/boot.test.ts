import { describe, expect, it, vi } from 'vitest';
import { HealthPatrol } from '../../../src/orchestration/health/patrol.js';
import { WrongDoltDatabaseError } from '../../../src/orchestration/store/dolt-client.js';

import { bootOrchestrationPlane, releaseDoltAfterFailedBoot } from '../../../src/orchestration/boot.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../_fixtures/in-memory-dolt-client.js';
import { FakeIrohWrapper } from '../../_fixtures/fake-iroh-wrapper.js';
import { IrohConnection } from '../../../src/orchestration/runtime/iroh/connection.js';
import { WorkActivityReporter } from '../../../src/orchestration/events/index.js';

describe('bootOrchestrationPlane', () => {
  it('rejects identity mismatch before schema checks or runtime startup', async () => {
    const failure = new WrongDoltDatabaseError({
      expectedRepoId: 'expected', actualRepoId: 'wrong', database: 'db', port: 33123,
    });
    const verifySchema = vi.fn();
    const start = vi.spyOn(HealthPatrol.prototype, 'start');
    try {
      await expect(bootOrchestrationPlane({
        dolt: { verifyFingerprint: vi.fn().mockRejectedValue(failure), verifySchema } as never,
      })).rejects.toBe(failure);
      expect(verifySchema).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  // vibesync-fxu4 / CodeRabbit #44: main's retry loop owns the Dolt pool once
  // DoltClient.connect returns. On boot failure it must close that pool before
  // the next connect attempt, and cleanup failures must not mask the boot error.
  describe('releaseDoltAfterFailedBoot (retry pool ownership)', () => {
    it('awaits close when boot failed and no orchestration was produced', async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      await releaseDoltAfterFailedBoot({ close }, false);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not close when orchestration was initialized (handle owns the pool)', async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      await releaseDoltAfterFailedBoot({ close }, true);
      expect(close).not.toHaveBeenCalled();
    });

    it('is a no-op when connect never returned a client', async () => {
      // Should not throw despite an undefined client.
      await expect(releaseDoltAfterFailedBoot(undefined, false)).resolves.toBeUndefined();
    });

    it('swallows cleanup errors and reports them instead of masking the boot error', async () => {
      const cleanupError = new Error('pool close failed');
      const close = vi.fn().mockRejectedValue(cleanupError);
      const onCleanupError = vi.fn();
      await expect(
        releaseDoltAfterFailedBoot({ close }, false, { onCleanupError }),
      ).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
    });
  });

  it('returns a wired orchestration handle', async () => {
    // vibesync-ryhc: the work-activity reporter wires an extra bus subscriber
    // when a shim URL is present in the environment (true on CI runners).
    // Disable it explicitly — this test asserts the BASELINE wiring.
    process.env['VIBESYNC_WORK_ACTIVITY_REPORT'] = '0';
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

  // vibesync-x38j: provider kind 'letta-code-iroh' selected by config.
  describe('letta-code-iroh provider kind', () => {
    const irohFactory = (fake: FakeIrohWrapper) => () =>
      new IrohConnection({ dial: fake.dial, peerName: 'boot-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } });

    it('VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh boots an Iroh provider (no shim URL needed), nothing dialed at boot', async () => {
      const fake = new FakeIrohWrapper();
      const handle = await bootForTest(
        { VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-iroh', VIBESYNC_LETTA_CODE_SHIM_URL: '' },
        { irohConnectionFactory: irohFactory(fake) },
      );
      expect(handle.provider.kind).toBe('letta-code-iroh');
      expect(fake.dials).toBe(0);
      await handle.shutdown();
    });

    it('the default provider really dispatches over Iroh DIRECTLY to the role agent (not the parent)', async () => {
      const fake = new FakeIrohWrapper({ scope: ['agent-parent', 'agent-role'] });
      const handle = await bootForTest(
        { VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-iroh' },
        { irohConnectionFactory: irohFactory(fake) },
      );
      const h = await handle.provider.start({ role: 'r', extra: { agentId: 'agent-role', moleculeId: 'm', stepName: 's' } });
      await handle.provider.prompt(h, [{ type: 'text', text: 'hello' }]);
      const events = [];
      for await (const e of handle.provider.observe(h)) events.push(e);
      await handle.provider.stop(h);
      expect(events.find((e) => e.kind === 'message-delta')).toMatchObject({ text: 'PONG' });
      expect(fake.received.some((f) => f['type'] === 'input')).toBe(true);
      expect([...fake.conversationAgent.values()]).toEqual(['agent-role']);
      expect(fake.violations).toEqual([]);
      await handle.shutdown();
    });

    it('does NOT construct the WorkActivityReporter (it targets the retired shim) even if a shim URL is set', async () => {
      const start = vi.spyOn(WorkActivityReporter.prototype, 'start');
      try {
        const handle = await bootForTest(
          { VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-iroh', VIBESYNC_LETTA_CODE_SHIM_URL: 'http://127.0.0.1:8291', VIBESYNC_WORK_ACTIVITY_REPORT: '1' },
          { irohConnectionFactory: irohFactory(new FakeIrohWrapper()) },
        );
        expect(start).not.toHaveBeenCalled();
        await handle.shutdown();
      } finally {
        start.mockRestore();
      }
    });

    it('letta-code-subagent still constructs the reporter when the shim URL is set (default unchanged)', async () => {
      const start = vi.spyOn(WorkActivityReporter.prototype, 'start').mockImplementation(() => undefined);
      try {
        const handle = await bootForTest({ VIBESYNC_WORK_ACTIVITY_REPORT: '1' });
        expect(handle.provider.kind).toBe('letta-code-subagent');
        expect(start).toHaveBeenCalledTimes(1);
        await handle.shutdown();
      } finally {
        start.mockRestore();
      }
    });

    it('fails loudly at boot when the parent agent id is missing and no routing exists', async () => {
      await expect(
        bootForTest({ VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-iroh', VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: '' }, { irohConnectionFactory: irohFactory(new FakeIrohWrapper()) }),
      ).rejects.toThrow('letta-code-iroh orchestration requires VIBESYNC_LETTA_CODE_PARENT_AGENT_ID');
    });

    it('per-project routing row provider_kind=letta-code-iroh resolves to the shared Iroh provider (no letta_base_url needed); the role agent comes from project_role_agents', async () => {
      const fake = new FakeIrohWrapper({ scope: ['agent-project-parent', 'agent-p1-reviewer'] });
      const lookups: Array<[string, string]> = [];
      const handle = await bootForTest(
        {},
        {
          irohConnectionFactory: irohFactory(fake),
          providerRouting: {
            store: {
              getProjectProviderRouting: (id) => (id === 'p1' ? { lettaBaseUrl: null, providerKind: 'letta-code-iroh', parentAgentId: 'agent-project-parent' } : null),
            },
            roleAgentLookup: {
              getRoleAgent: (project, role) => {
                lookups.push([project, role]);
                return project === 'p1' && role === 'reviewer' ? { agentId: 'agent-p1-reviewer' } : null;
              },
            },
          },
        },
      );
      const resolver = (handle.dispatcher as never as { providerResolver: { resolve(i: unknown): { kind: string; start(s: unknown): Promise<{ id: string }>; prompt(h: unknown, c: unknown): Promise<{ conversationId?: string }>; observe(h: unknown): AsyncIterable<{ kind: string; text?: string }>; stop(h: unknown): Promise<void> } | null } }).providerResolver;
      const routed = resolver.resolve({ projectIdentifier: 'p1' });
      expect(routed?.kind).toBe('letta-code-iroh');
      // end to end: wrapWithParentAgentId -> IrohWrapperProvider -> resolver -> project_role_agents -> role agent
      const h = await routed!.start({ role: 'reviewer', extra: { projectIdentifier: 'p1', moleculeId: 'm', stepName: 's' } });
      expect(h.id).toContain('agent-p1-reviewer');
      expect(h.id).not.toContain('agent-project-parent');
      const pr = await routed!.prompt(h, [{ type: 'text', text: 'go' }]);
      for await (const _ of routed!.observe(h)) { /* drain */ }
      await routed!.stop(h);
      expect(lookups).toEqual([['p1', 'reviewer']]);
      expect([...fake.conversationAgent.values()]).toEqual(['agent-p1-reviewer']);
      expect(pr.conversationId).toBe('conv-1');
      // a role with no project_role_agents row fails loudly instead of going to the parent
      await expect(routed!.start({ role: 'tester', extra: { projectIdentifier: 'p1' } })).rejects.toThrow(/no role agent id for role "tester" in project "p1"/);
      expect(JSON.stringify(fake.received)).not.toContain('agent-project-parent');
      await handle.shutdown();
    });

    it('still rejects unknown provider kinds', async () => {
      await expect(bootForTest({ VIBESYNC_ORCHESTRATION_PROVIDER: 'bogus' })).rejects.toThrow('Unsupported orchestration provider');
    });
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
  const previousReport = process.env.VIBESYNC_WORK_ACTIVITY_REPORT;
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
      ...inMemoryBeads(),
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
    if (previousReport === undefined) delete process.env.VIBESYNC_WORK_ACTIVITY_REPORT;
    else process.env.VIBESYNC_WORK_ACTIVITY_REPORT = previousReport;
  }
}
