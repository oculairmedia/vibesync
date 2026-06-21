/**
 * Unit tests for buildRoleAgentContextResolver (vibesync-mcz Phase D).
 *
 * Pure pure-function tests over the resolver — no FormulaDispatcher,
 * no real boot, no real fs. The resolver inspects per-project
 * routing rows and decides whether to opt this dispatch into the
 * persistent role-agent path.
 */

import { describe, expect, it } from 'vitest';

import { buildRoleAgentContextResolver } from '../../../src/orchestration/boot.js';
import type { ProjectProviderRoutingStore } from '../../../src/orchestration/boot.js';
import type { RoleAgentBootstrapperLike } from '../../../src/orchestration/dispatcher/index.js';

function fakeStore(rows: Record<string, {
  providerKind: string | null;
  lettaBaseUrl: string | null;
  packDir?: string | null;
  storageDir?: string | null;
}>): ProjectProviderRoutingStore {
  return {
    getProjectProviderRouting(projectId: string) {
      return rows[projectId] ?? null;
    },
  };
}

function fakeBootstrapper(): RoleAgentBootstrapperLike {
  return {
    async ensureRoleAgent() {
      return { agentId: 'agent-stub' };
    },
  };
}

const PROJECT = 'vibesync';

describe('buildRoleAgentContextResolver (vibesync-mcz Phase D)', () => {
  it('returns null when projectIdentifier is absent on the dispatch input', async () => {
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({}),
      roleAgentBootstrapper: fakeBootstrapper(),
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({ formula: {} as never, pack: {} as never, input: 'go' });
    expect(result).toBeNull();
  });

  it('returns null when the project has no routing row', async () => {
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({}),
      roleAgentBootstrapper: fakeBootstrapper(),
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toBeNull();
  });

  it('returns null when the project routes to removed provider_kind=letta-teams rows', async () => {
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-teams', lettaBaseUrl: null } }),
      roleAgentBootstrapper: fakeBootstrapper(),
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toBeNull();
  });

  it('returns null when no bootstrapper is supplied (full backwards compat)', async () => {
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-code-subagent', lettaBaseUrl: 'http://shim:8291' } }),
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toBeNull();
  });

  it('uses the default packDir when the project has no explicit packDir mapping', async () => {
    const bootstrapper = fakeBootstrapper();
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-code-subagent', lettaBaseUrl: 'http://shim:8291' } }),
      roleAgentBootstrapper: bootstrapper,
      packDirsByProject: { 'other': '/packs/other' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toEqual({
      bootstrapper,
      packDir: 'packs/gastown',
      storageDir: '/storage',
      lettaBaseUrl: 'http://shim:8291',
    });
  });

  it('uses the default storageDir when the project has no explicit storageDir mapping', async () => {
    const bootstrapper = fakeBootstrapper();
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-code-subagent', lettaBaseUrl: 'http://shim:8291' } }),
      roleAgentBootstrapper: bootstrapper,
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: {},
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toEqual({
      bootstrapper,
      packDir: '/packs/gastown',
      storageDir: '/root/.letta/lc-local-backend',
      lettaBaseUrl: 'http://shim:8291',
    });
  });

  it('prefers DB-backed packDir and storageDir over legacy maps', async () => {
    const bootstrapper = fakeBootstrapper();
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({
        [PROJECT]: {
          providerKind: 'letta-code-subagent',
          lettaBaseUrl: 'http://shim:8291',
          packDir: '/db/pack',
          storageDir: '/db/storage',
        },
      }),
      roleAgentBootstrapper: bootstrapper,
      packDirsByProject: { [PROJECT]: '/legacy/pack' },
      storageDirsByProject: { [PROJECT]: '/legacy/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toEqual({
      bootstrapper,
      packDir: '/db/pack',
      storageDir: '/db/storage',
      lettaBaseUrl: 'http://shim:8291',
    });
  });

  it('returns null when lettaBaseUrl is missing on the routing row', async () => {
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-code-subagent', lettaBaseUrl: null } }),
      roleAgentBootstrapper: fakeBootstrapper(),
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toBeNull();
  });

  it('returns a full context when every piece is wired', async () => {
    const bootstrapper = fakeBootstrapper();
    const resolver = buildRoleAgentContextResolver({
      store: fakeStore({ [PROJECT]: { providerKind: 'letta-code-subagent', lettaBaseUrl: 'http://shim:8291' } }),
      roleAgentBootstrapper: bootstrapper,
      packDirsByProject: { [PROJECT]: '/packs/gastown' },
      storageDirsByProject: { [PROJECT]: '/storage' },
    });
    const result = await resolver.resolve({
      formula: {} as never,
      pack: {} as never,
      input: 'go',
      projectIdentifier: PROJECT,
    });
    expect(result).toEqual({
      bootstrapper,
      packDir: '/packs/gastown',
      storageDir: '/storage',
      lettaBaseUrl: 'http://shim:8291',
    });
  });
});
