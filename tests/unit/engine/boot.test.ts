import { describe, expect, it, vi } from 'vitest';
import { WrongDoltDatabaseError } from '../../../src/engine/store/dolt-client.js';

import { bootOrchestrationPlane, releaseDoltAfterFailedBoot } from '../../../src/engine/boot.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../_fixtures/in-memory-dolt-client.js';
import { FakeIrohWrapper } from '../../_fixtures/fake-iroh-wrapper.js';
import { IrohConnection } from '../../../src/engine/runtime/iroh/connection.js';

describe('bootOrchestrationPlane', () => {
  it('rejects identity mismatch before schema checks or runtime startup', async () => {
    const failure = new WrongDoltDatabaseError({
      expectedRepoId: 'expected', actualRepoId: 'wrong', database: 'db', port: 33123,
    });
    const verifySchema = vi.fn();
    await expect(bootOrchestrationPlane({
      dolt: { verifyFingerprint: vi.fn().mockRejectedValue(failure), verifySchema } as never,
    })).rejects.toBe(failure);
    expect(verifySchema).not.toHaveBeenCalled();
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
    const handle = await bootForTest();

    expect(handle.dispatcher).toBeDefined();
    // vibesync-9lzk.29: Iroh is the only provider, so it is the default.
    expect(handle.provider.kind).toBe('letta-code-iroh');
    // One subscriber wired by default: the writeback hook (vibesync-0xo).
    // Detaches on shutdown — see the assertion after shutdown below.
    expect(handle.bus.subscriberCount()).toBe(1);
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

  // vibesync-9lzk.29: the removed providers are configuration errors at boot.
  for (const removed of ['letta-code-subagent', 'letta-teams', 'bogus']) {
    it(`rejects VIBESYNC_ORCHESTRATION_PROVIDER=${removed} at boot`, async () => {
      await expect(bootForTest({ VIBESYNC_ORCHESTRATION_PROVIDER: removed })).rejects.toThrow(
        `Unsupported orchestration provider "${removed}": letta-code-iroh is the only provider`,
      );
    });
  }

  it('boots with provider routing even when the global default parent env is absent', async () => {
    const handle = await bootForTest(
      { VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: '' },
      {
        providerRouting: {
          store: {
            getProjectProviderRouting: (id) => (id === 'vibesync' ? { providerKind: 'letta-code-iroh', parentAgentId: 'agent-project-parent' } : null),
          },
        },
      },
    );
    // No env parent: the default provider is a fail-at-start stand-in, and
    // routed projects still dispatch.
    expect(handle.provider.kind).toBe('letta-code-iroh');
    await expect(handle.provider.start({ role: 'r' })).rejects.toThrow('requires VIBESYNC_LETTA_CODE_PARENT_AGENT_ID');
    await handle.shutdown();
  });

  // vibesync-x38j: provider kind 'letta-code-iroh' selected by config.
  describe('letta-code-iroh provider kind', () => {
    const irohFactory = (fake: FakeIrohWrapper) => () =>
      new IrohConnection({ dial: fake.dial, peerName: 'boot-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } });

    it('an explicit VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh boots an Iroh provider, nothing dialed at boot', async () => {
      const fake = new FakeIrohWrapper();
      const handle = await bootForTest(
        { VIBESYNC_ORCHESTRATION_PROVIDER: 'letta-code-iroh' },
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
              getProjectProviderRouting: (id) => (id === 'p1' ? { providerKind: 'letta-code-iroh', parentAgentId: 'agent-project-parent' } : null),
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

    // vibesync-9lzk.29: production still held letta-code-subagent rows for
    // letta-mobile and letta-code-parallel (the dead :8291 shim). Through the
    // real dispatcher, such a run must fail before any molecule is cooked,
    // naming the stale row, never silently running on the default provider.
    it('a stale letta-code-subagent routing row fails the run loudly and cooks no molecule', async () => {
      const fake = new FakeIrohWrapper({ scope: ['agent-parent'] });
      const handle = await bootForTest(
        {},
        {
          irohConnectionFactory: irohFactory(fake),
          providerRouting: {
            store: {
              getProjectProviderRouting: (id) => (id === 'letta-mobile' ? { providerKind: 'letta-code-subagent', parentAgentId: 'agent-pm' } : null),
            },
          },
        },
      );
      const formula = { name: 'f', description: '', whenToUse: '', steps: [{ name: 's', role: 'r', promptTemplate: 'p.md' }] };
      const pack = { manifest: { name: 'p', version: '1' }, root: '/', scope: 'global' as const, roles: [{ name: 'r', memoryBlocks: [] }], formulas: [] };
      await expect(handle.dispatcher.run({ formula, pack, input: 'go', projectIdentifier: 'letta-mobile' })).rejects.toThrow(
        "project letta-mobile routes to provider_kind='letta-code-subagent', which was removed",
      );
      expect(await handle.walker.listMolecules({ limit: 10 })).toEqual([]);
      expect(fake.dials).toBe(0);
      await handle.shutdown();
    });
  });

});

async function bootForTest(
  env: Record<string, string> = {},
  opts: Partial<Parameters<typeof bootOrchestrationPlane>[0]> = {},
) {
  const previousApiKey = process.env.LETTA_API_KEY;
  const previousPassword = process.env.LETTA_PASSWORD;
  const previousProvider = process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
  const previousParent = process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
  process.env.LETTA_API_KEY = 'test-key';
  delete process.env.LETTA_PASSWORD;
  delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
  delete process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
  Object.assign(process.env, {
    VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: 'agent-parent',
    ...env,
  });
  try {
    return await bootOrchestrationPlane({
      ...inMemoryBeads(),
      persistEvents: false,
      runDriftAuditOnBoot: false,
      // Never dial a real Iroh host from a unit test.
      irohConnectionFactory: () => new IrohConnection({ dial: new FakeIrohWrapper().dial, peerName: 'boot-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } }),
      ...opts,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = previousApiKey;
    if (previousPassword === undefined) delete process.env.LETTA_PASSWORD;
    else process.env.LETTA_PASSWORD = previousPassword;
    if (previousProvider === undefined) delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
    else process.env.VIBESYNC_ORCHESTRATION_PROVIDER = previousProvider;
    if (previousParent === undefined) delete process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID;
    else process.env.VIBESYNC_LETTA_CODE_PARENT_AGENT_ID = previousParent;
  }
}
