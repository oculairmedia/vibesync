/**
 * Tests for RoleAgentBootstrapper (vibesync-mcz Phase B).
 *
 * Strategy: inject an in-memory repo + in-memory fs so the test
 * doesn't touch real disk and doesn't depend on Phase A's SQLite
 * wiring (Phase A is already covered by tests/unit/database.test.ts).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  RoleAgentBootstrapper,
  encodeAgentIdBase64Url,
  type RoleAgentRepository,
} from '../../../src/letta/RoleAgentBootstrapper.js';
import type { ProjectRoleAgentRecord } from '../../../src/database/repositories/ProjectRoleAgentRepository.js';

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

interface FakeFsHandle {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly writes: Array<{ path: string; contents: string }>;
  readonly reads: string[];
  readFile: (p: string, enc: BufferEncoding) => Promise<string>;
  writeFile: (p: string, contents: string, enc?: BufferEncoding) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
}

function makeFakeFs(seedFiles: Record<string, string> = {}): FakeFsHandle {
  const files = new Map<string, string>(Object.entries(seedFiles));
  const dirs = new Set<string>();
  const writes: Array<{ path: string; contents: string }> = [];
  const reads: string[] = [];
  return {
    files,
    dirs,
    writes,
    reads,
    async readFile(p: string) {
      reads.push(p);
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(p: string, contents: string) {
      writes.push({ path: p, contents });
      files.set(p, contents);
    },
    async mkdir(p: string) {
      dirs.add(p);
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
  readonly fs: FakeFsHandle;
  readonly bootstrapper: RoleAgentBootstrapper;
}

function makeHarness(opts?: {
  idGenerator?: () => string;
  now?: () => number;
  seedFiles?: Record<string, string>;
}): Harness {
  const repo = new FakeRepo();
  const fs = makeFakeFs({ [PERSONA_PATH]: PERSONA_BODY, ...opts?.seedFiles });
  const bootstrapper = new RoleAgentBootstrapper({
    repo,
    fs,
    idGenerator: opts?.idGenerator ?? (() => 'agent-stub-uuid-1'),
    now: opts?.now ?? (() => 1700000000000),
  });
  return { repo, fs, bootstrapper };
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

describe('RoleAgentBootstrapper (vibesync-mcz Phase B)', () => {
  describe('first-call (miss path)', () => {
    let h: Harness;

    beforeEach(() => {
      h = makeHarness();
    });

    it('reads the persona from <packDir>/.letta/agents/<role>.md', async () => {
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.fs.reads).toContain(PERSONA_PATH);
    });

    it('writes the agent JSON to <storageDir>/agents/<b64url(id)>.json', async () => {
      const result = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const expectedFilename = `${encodeAgentIdBase64Url(result.agentId)}.json`;
      const expectedPath = `${STORAGE_DIR}/agents/${expectedFilename}`;
      expect(h.fs.writes.length).toBe(1);
      expect(h.fs.writes[0]?.path).toBe(expectedPath);
      expect(h.fs.dirs.has(`${STORAGE_DIR}/agents`)).toBe(true);
    });

    it('persists the binding via upsertRoleAgent', async () => {
      const result = await h.bootstrapper.ensureRoleAgent(defaultInput);
      expect(h.repo.upsertCalls).toBe(1);
      const stored = h.repo.getRoleAgent(PROJECT, ROLE);
      expect(stored).toEqual(result);
      expect(stored?.projectIdentifier).toBe(PROJECT);
      expect(stored?.roleName).toBe(ROLE);
      expect(stored?.lettaBaseUrl).toBe(BASE_URL);
    });

    it('returns a record with a fresh agent id matching the generator', async () => {
      const harness = makeHarness({ idGenerator: () => 'agent-fresh-42' });
      const result = await harness.bootstrapper.ensureRoleAgent(defaultInput);
      expect(result.agentId).toBe('agent-fresh-42');
    });

    it('composes the on-disk JSON with the required PM-vibesync-shaped fields', async () => {
      const result = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const payload = JSON.parse(h.fs.writes[0]!.contents);
      expect(payload.id).toBe(result.agentId);
      expect(payload.name).toBe('Reviewer-vibesync');
      expect(payload.description).toContain('vibesync');
      expect(payload.model).toBe('anthropic/claude-opus-4-7');
      expect(payload.model_settings).toMatchObject({
        provider_type: 'anthropic',
        parallel_tool_calls: true,
      });
      expect(payload.tags).toEqual([
        'vibesync',
        'project:vibesync',
        'role:reviewer',
        'lc-local-backend',
      ]);
      expect(payload.system).toBe(PERSONA_BODY);
    });
  });

  describe('second-call (hit path)', () => {
    it('returns the cached binding without re-reading persona or rewriting JSON', async () => {
      const h = makeHarness();
      const first = await h.bootstrapper.ensureRoleAgent(defaultInput);
      const writesAfterFirst = h.fs.writes.length;
      const readsAfterFirst = h.fs.reads.length;
      const upsertsAfterFirst = h.repo.upsertCalls;

      const second = await h.bootstrapper.ensureRoleAgent(defaultInput);

      expect(second.agentId).toBe(first.agentId);
      expect(second).toEqual(first);
      expect(h.fs.writes.length).toBe(writesAfterFirst);
      expect(h.fs.reads.length).toBe(readsAfterFirst);
      expect(h.repo.upsertCalls).toBe(upsertsAfterFirst);
    });

    it('is idempotent across many calls', async () => {
      const h = makeHarness();
      const initial = await h.bootstrapper.ensureRoleAgent(defaultInput);
      for (let i = 0; i < 10; i += 1) {
        const r = await h.bootstrapper.ensureRoleAgent(defaultInput);
        expect(r.agentId).toBe(initial.agentId);
      }
      expect(h.fs.writes.length).toBe(1);
      expect(h.repo.upsertCalls).toBe(1);
    });

    it('refuses to silently rebind when the cached row points at a different shim', async () => {
      const h = makeHarness();
      await h.bootstrapper.ensureRoleAgent(defaultInput);
      await expect(
        h.bootstrapper.ensureRoleAgent({ ...defaultInput, lettaBaseUrl: 'http://other-shim:9999' }),
      ).rejects.toThrow(/refusing to silently rebind/);
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
      expect(h.fs.writes.length).toBe(2);
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

  describe('errors', () => {
    it('throws a clear error when the persona md is missing', async () => {
      const h = makeHarness({ seedFiles: {} });
      // Make persona missing by stripping it from the seed (override).
      h.fs.files.delete(PERSONA_PATH);
      await expect(h.bootstrapper.ensureRoleAgent(defaultInput)).rejects.toThrow(
        /persona for role "reviewer" not found/,
      );
      expect(h.fs.writes.length).toBe(0);
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
      // PM-vibesync's on-disk filename is well-known; the bootstrapper
      // must produce the identical encoding so role agents land next
      // to PM-vibesync's JSON.
      const id = 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1';
      const encoded = encodeAgentIdBase64Url(id);
      expect(encoded).toBe('YWdlbnQtYTlkYjdhN2EtMGNhNy00YTNhLWIxMjQtMTFlOGFiN2ZkN2Ux');
    });
  });
});
