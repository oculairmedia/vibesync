/**
 * Tests for RoleAgentBootstrapper (vibesync-mcz Phase B, refactored
 * for vibesync-1ix to provision through @letta-ai/letta-code-sdk).
 *
 * Strategy: inject an in-memory repo + in-memory SDK stub + in-memory
 * persona reader, plus stub the LETTA_LOCAL_BACKEND_DIR env via
 * envBackendDir. This keeps the unit suite hermetic and never spawns
 * the real letta-code subprocess.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  RoleAgentBootstrapper,
  encodeAgentIdBase64Url,
  type RoleAgentRepository,
  type RoleAgentSdkAdapter,
} from '../../../src/letta/RoleAgentBootstrapper.js';
import type { ProjectRoleAgentRecord } from '../../../src/database/repositories/ProjectRoleAgentRepository.js';
import type { CreateAgentOptions } from '@letta-ai/letta-code-sdk';

// ──────────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────────

class FakeRepo implements RoleAgentRepository {
  readonly rows = new Map<string, ProjectRoleAgentRecord>();
  upsertCalls = 0;

  private key(project: string, role: string): string {
    return `${project}::${role}`;
  }

  getRoleAgent(project: string, role: string): ProjectRoleAgentRecord | null {
    return this.rows.get(this.key(project, role)) ?? null;
  }

  upsertRoleAgent(
    project: string,
    role: string,
    agentId: string,
    lettaBaseUrl: string,
    now: number = Date.now(),
  ): ProjectRoleAgentRecord {
    this.upsertCalls += 1;
    const k = this.key(project, role);
    const existing = this.rows.get(k);
    const rec: ProjectRoleAgentRecord = {
      projectIdentifier: project,
      roleName: role,
      agentId,
      lettaBaseUrl,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    this.rows.set(k, rec);
    return rec;
  }
}

interface FakeSdk extends RoleAgentSdkAdapter {
  readonly calls: CreateAgentOptions[];
  readonly knownAgents: Set<string>;
  existenceProbes: number;
}

function makeFakeSdk(opts?: {
  idGenerator?: () => string;
  agentExists?: boolean | ((agentId: string) => boolean);
  preCreatedAgents?: readonly string[];
}): FakeSdk {
  const calls: CreateAgentOptions[] = [];
  const idGen = opts?.idGenerator ?? (() => 'agent-stub-uuid-1');
  const knownAgents = new Set<string>(opts?.preCreatedAgents ?? []);
  let existenceProbes = 0;
  const sdk: FakeSdk = {
    calls,
    knownAgents,
    get existenceProbes() {
      return existenceProbes;
    },
    set existenceProbes(v: number) {
      existenceProbes = v;
    },
    async createAgent(options) {
      calls.push(options);
      const id = idGen();
      knownAgents.add(id);
      return id;
    },
  };
  if (opts?.agentExists !== undefined) {
    const probe = opts.agentExists;
    sdk.agentExists = async (agentId: string) => {
      existenceProbes += 1;
      if (typeof probe === 'function') return probe(agentId);
      return probe;
    };
  }
  return sdk;
}

interface FakePersonaReader {
  readonly reads: string[];
  readonly files: Map<string, string>;
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
}

function makeFakePersonaReader(seedFiles: Record<string, string> = {}): FakePersonaReader {
  const files = new Map<string, string>(Object.entries(seedFiles));
  const reads: string[] = [];
  return {
    files,
    reads,
    async readFile(path: string) {
      reads.push(path);
      const v = files.get(path);
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const PROJECT = 'vibesync';
const ROLE = 'reviewer';
const PACK_DIR = '/packs/gastown';
const STORAGE_DIR = '/storage';
const BASE_URL = 'http://192.168.50.90:8291';
const PERSONA_PATH = `${PACK_DIR}/.letta/agents/${ROLE}.md`;
const PERSONA_BODY = [
  '---',
  'name: reviewer',
  'description: Reviews code.',
  'model: auto',
  '---',
  '',
  '# Reviewer',
  '',
  'You are the reviewer.',
].join('\n');

interface Harness {
  readonly repo: FakeRepo;
  readonly sdk: FakeSdk;
  readonly persona: FakePersonaReader;
  readonly bootstrapper: RoleAgentBootstrapper;
}

function makeHarness(opts?: {
  idGenerator?: () => string;
  now?: () => number;
  seedFiles?: Record<string, string>;
  agentExists?: boolean | ((agentId: string) => boolean);
  preCreatedAgents?: readonly string[];
  envBackendDir?: string | undefined;
}): Harness {
  const repo = new FakeRepo();
  const sdk = makeFakeSdk({
    idGenerator: opts?.idGenerator ?? (() => 'agent-stub-uuid-1'),
    agentExists: opts?.agentExists,
    preCreatedAgents: opts?.preCreatedAgents,
  });
  const persona = makeFakePersonaReader({ [PERSONA_PATH]: PERSONA_BODY, ...opts?.seedFiles });
  const envBackendDir: string | undefined =
    'envBackendDir' in (opts ?? {}) ? opts?.envBackendDir : STORAGE_DIR;
  const bootstrapper = new RoleAgentBootstrapper({
    repo,
    sdk,
    readFile: persona.readFile,
    now: opts?.now ?? (() => 1700000000000),
    envBackendDir: () => envBackendDir,
  });
  return { repo, sdk, persona, bootstrapper };
}

const defaultInput = {
  projectIdentifier: PROJECT,
  role: ROLE,
  packDir: PACK_DIR,
  lettaBaseUrl: BASE_URL,
  storageDir: STORAGE_DIR,
};

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('RoleAgentBootstrapper (vibesync-1ix: SDK-based provisioning)', () => {
  describe('first-call (miss path)', () => {
    let h: Harness;

    beforeEach(() => {
      h = makeHarness();
    });

    it('reads the persona from <packDir>/.letta/agents/<role>.md', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.persona.reads).toContain(PERSONA_PATH);
    });

    it('calls sdk.createAgent exactly once', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.calls.length).toBe(1);
    });

    it('passes the persona body verbatim as systemPrompt to the SDK', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.calls[0]?.systemPrompt).toBe(PERSONA_BODY);
    });

    it('asks the SDK for a memfs-backed agent so memory accumulates', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.calls[0]?.memfs).toBe(true);
    });

    it('passes the default model so role agents match PM-vibesync on the same backend', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.calls[0]?.model).toBe('anthropic/claude-opus-4-7');
    });

    it('tags the agent for vibesync/project/role/backend lookup', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.calls[0]?.tags).toEqual([
        'vibesync',
        'project:vibesync',
        'role:reviewer',
        'lc-local-backend',
      ]);
    });

    it('persists the binding via upsertRoleAgent using the SDK-returned id', async () => {
      const harness = makeHarness({ idGenerator: () => 'agent-fresh-42' });
      const result = await harness.bootstrapper.ensureRoleAgent(defaultInput);
      expect(harness.repo.upsertCalls).toBe(1);
      expect(result.agentId).toBe('agent-fresh-42');
      const stored = harness.repo.getRoleAgent(PROJECT, ROLE);
      expect(stored).toEqual(result);
      expect(stored?.projectIdentifier).toBe(PROJECT);
      expect(stored?.roleName).toBe(ROLE);
      expect(stored?.lettaBaseUrl).toBe(BASE_URL);
    });

    it('does not call upsert when the SDK returns an invalid id', async () => {
      const repo = new FakeRepo();
      const sdk = makeFakeSdk({ idGenerator: () => '' });
      const persona = makeFakePersonaReader({ [PERSONA_PATH]: PERSONA_BODY });
      const bootstrapper = new RoleAgentBootstrapper({
        repo,
        sdk,
        readFile: persona.readFile,
        envBackendDir: () => STORAGE_DIR,
      });
      await expect(bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /SDK createAgent returned an invalid agent id/,
      );
      expect(repo.upsertCalls).toBe(0);
    });
  });

  describe('second-call (hit path)', () => {
    it('returns the cached binding without re-reading persona or re-calling the SDK', async () => {
      const h = makeHarness();
      const first = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const sdkCallsAfterFirst = h.sdk.calls.length;
      const readsAfterFirst = h.persona.reads.length;
      const upsertsAfterFirst = h.repo.upsertCalls;

      const second = await h.bootstrapper.ensureRoleAgent(defaultInput);

      expect(second.agentId).toBe(first.agentId);
      expect(second).toEqual(first);
      expect(h.sdk.calls.length).toBe(sdkCallsAfterFirst);
      expect(h.persona.reads.length).toBe(readsAfterFirst);
      expect(h.repo.upsertCalls).toBe(upsertsAfterFirst);
    });

    it('is idempotent across many calls', async () => {
      const h = makeHarness();
      const initial = await h.bootstrapper.ensureRoleAgent(defaultInput);
      for (let i = 0; i < 10; i += 1) {
        const r = await h.bootstrapper.ensureRoleAgent(defaultInput);
        expect(r.agentId).toBe(initial.agentId);
      }
      expect(h.sdk.calls.length).toBe(1);
      expect(h.repo.upsertCalls).toBe(1);
    });

    it('refuses to silently rebind when the cached row points at a different shim', async () => {
      const h = makeHarness();
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, lettaBaseUrl: 'http://other-shim:9999' }),
      ).rejects.toThrow(/refusing to silently rebind/);
    });

    it('uses the optional agentExists probe to validate the cached binding', async () => {
      const h = makeHarness({ agentExists: true });
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      const probesAfterFirst = h.sdk.existenceProbes;
      // First call doesn't probe (no cache yet). Second call should.
      expect(probesAfterFirst).toBe(0);

      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.sdk.existenceProbes).toBe(1);
    });

    it('throws when the SDK reports the cached agent as nonexistent (drift)', async () => {
      const h = makeHarness({ agentExists: false });
      // First call seeds the cache.
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      // Second call probes and the SDK says: gone. Throw, do not re-create.
      await expect(h.bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /SDK reports as nonexistent|refusing to silently re-create/,
      );
      // And the SDK was not called a second time to "fix" it.
      expect(h.sdk.calls.length).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('coalesces simultaneous miss-path calls so the SDK is only invoked once', async () => {
      // SDK that delays so the second call can race in before the first resolves.
      let resolveCreate: (id: string) => void = () => {};
      const sdk: FakeSdk = {
        calls: [],
        knownAgents: new Set<string>(),
        existenceProbes: 0,
        async createAgent(options) {
          this.calls.push(options);
          return new Promise<string>((resolve) => {
            resolveCreate = resolve;
          });
        },
      };
      const repo = new FakeRepo();
      const persona = makeFakePersonaReader({ [PERSONA_PATH]: PERSONA_BODY });
      const bootstrapper = new RoleAgentBootstrapper({
        repo,
        sdk,
        readFile: persona.readFile,
        envBackendDir: () => STORAGE_DIR,
      });

      const p1 = bootstrapper.ensureRoleAgent(defaultInput);
      const p2 = bootstrapper.ensureRoleAgent(defaultInput);

      // Let microtasks drain so provision() awaits past readPersona and
      // actually invokes sdk.createAgent (which sets resolveCreate).
      // Several ticks because the async readFile + executor entry each
      // burn at least one microtask.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      resolveCreate('agent-coalesced-1');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.agentId).toBe('agent-coalesced-1');
      expect(r2.agentId).toBe('agent-coalesced-1');
      expect(sdk.calls.length).toBe(1);
      expect(repo.upsertCalls).toBe(1);
    });
  });

  describe('scoping', () => {
    it('isolates by (project, role) — different role → new agent', async () => {
      const ids = ['agent-rev', 'agent-cod'];
      let i = 0;
      const h = makeHarness({
        idGenerator: () => ids[i++]!,
        seedFiles: {
          [`${PACK_DIR}/.letta/agents/coder.md`]: '---\nname: coder\n---\n# Coder\n',
        },
      });

      const rev = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const cod = await h.bootstrapper.ensureRoleAgent({ ...defaultInput, role: 'coder' });

      expect(rev.agentId).toBe('agent-rev');
      expect(cod.agentId).toBe('agent-cod');
      expect(h.sdk.calls.length).toBe(2);
      expect(h.repo.upsertCalls).toBe(2);
    });

    it('isolates by project — same role, different project → new agent', async () => {
      const ids = ['agent-vibe-rev', 'agent-other-rev'];
      let i = 0;
      const h = makeHarness({ idGenerator: () => ids[i++]! });

      const vibe = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const other = await h.bootstrapper.ensureRoleAgent({
        ...defaultInput,
        projectIdentifier: 'other-project',
      });

      expect(vibe.agentId).toBe('agent-vibe-rev');
      expect(other.agentId).toBe('agent-other-rev');
      const fromRepo = h.repo.getRoleAgent('other-project', ROLE);
      expect(fromRepo?.agentId).toBe('agent-other-rev');
    });
  });

  describe('env contract', () => {
    it('throws when LETTA_LOCAL_BACKEND_DIR is not set', async () => {
      const h = makeHarness({ envBackendDir: undefined });
      await expect(h.bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /LETTA_LOCAL_BACKEND_DIR is not set/,
      );
      expect(h.sdk.calls.length).toBe(0);
      expect(h.repo.upsertCalls).toBe(0);
    });

    it('throws when LETTA_LOCAL_BACKEND_DIR does not match input.storageDir', async () => {
      const h = makeHarness({ envBackendDir: '/different/store' });
      await expect(h.bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /does not match input.storageDir/,
      );
      expect(h.sdk.calls.length).toBe(0);
    });
  });

  describe('errors', () => {
    it('throws a clear error when the persona md is missing', async () => {
      const h = makeHarness({ seedFiles: {} });
      // Strip the persona seed so readPersona ENOENTs.
      h.persona.files.delete(PERSONA_PATH);
      await expect(h.bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /persona for role "reviewer" not found/,
      );
      expect(h.sdk.calls.length).toBe(0);
      expect(h.repo.upsertCalls).toBe(0);
    });

    it('rejects empty required inputs up front', async () => {
      const h = makeHarness();
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, projectIdentifier: '' }),
      ).rejects.toThrow(/projectIdentifier is required/);
      await expect(h.bootstrapper.ensureRoleAgent({ ...defaultInput, role: '' })).rejects.toThrow(
        /role is required/,
      );
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, packDir: '' }),
      ).rejects.toThrow(/packDir is required/);
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, storageDir: '' }),
      ).rejects.toThrow(/storageDir is required/);
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, lettaBaseUrl: '' }),
      ).rejects.toThrow(/lettaBaseUrl is required/);
    });

    it('throws on construction when deps.repo is missing', () => {
      expect(
        () =>
          new RoleAgentBootstrapper({
            // @ts-expect-error — deliberately broken
            repo: undefined,
          }),
      ).toThrow(/deps.repo is required/);
    });
  });

  describe('encodeAgentIdBase64Url', () => {
    it('matches the local-backend convention used for PM-vibesync', () => {
      // PM-vibesync's on-disk filename is well-known; the helper must
      // produce the identical encoding so callers computing expected
      // filenames against the SDK-written JSON agree with the shim.
      const id = 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1';
      const encoded = encodeAgentIdBase64Url(id);
      expect(encoded).toBe('YWdlbnQtYTlkYjdhN2EtMGNhNy00YTNhLWIxMjQtMTFlOGFiN2ZkN2Ux');
    });
  });
});
