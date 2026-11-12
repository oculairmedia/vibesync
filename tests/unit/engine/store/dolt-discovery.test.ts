import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import mysql from 'mysql2/promise';
import {
  DOLT_QUERY_TIMEOUT_MS,
  DoltClient,
  resolveDoltPort,
  type DoltBootDeps,
} from '../../../../src/engine/store/dolt-client.js';

vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => fakePool(vi.fn(async () => [[]]))) } }));

/**
 * A pool whose verification queries run through one acquired connection, as
 * DoltClient does (vibesync-9lzk.55.8: mysql2 only honours a query deadline on
 * `query`, and a timed-out connection is destroyed rather than released).
 */
function fakePool(query: ReturnType<typeof vi.fn>, end: ReturnType<typeof vi.fn> = vi.fn(async () => undefined)) {
  const connection = { query, release: vi.fn(), destroy: vi.fn() };
  return { end, getConnection: vi.fn(async () => connection), connection };
}

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dolt-discovery-'));
  fixtures.push(base);
  const root = join(base, 'primary-repo');
  mkdirSync(root);
  return { base, root };
}

function beads(root: string, database = 'authoritative-db', port = '33123') {
  mkdirSync(join(root, '.beads'), { recursive: true });
  writeFileSync(join(root, '.beads', 'metadata.json'), JSON.stringify({ dolt_database: database }));
  writeFileSync(join(root, '.beads', 'dolt-server.port'), port);
}

function linked(root: string, base: string, absolute = false) {
  execFileSync('git', ['init', '--quiet', root]);
  const worktree = join(base, 'linked-worktree');
  const admin = join(root, '.git', 'worktrees', 'linked');
  mkdirSync(worktree);
  mkdirSync(admin, { recursive: true });
  // Valid Git administrative files without creating commits or checking out code.
  writeFileSync(
    join(worktree, '.git'),
    `gitdir: ${absolute ? admin : relative(worktree, admin)}\n`,
  );
  writeFileSync(join(admin, 'commondir'), absolute ? join(root, '.git') : '../..');
  writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/linked\n');
  writeFileSync(join(admin, 'gitdir'), join(worktree, '.git'));
  return worktree;
}

function bootDeps(): DoltBootDeps {
  return {
    readPortFile: vi.fn(() => '33123'),
    startDoltServer: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
}

describe('canonical Dolt discovery', () => {
  it.each(['mismatch', 'query failure', 'cleanup failure'])('closes an unverified pool on %s', async (kind) => {
    const failure = new Error('identity query failed');
    const pool = fakePool(
      kind === 'query failure'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue([[{ value: 'wrong' }]]),
      kind === 'cleanup failure'
        ? vi.fn().mockRejectedValue(new Error('cleanup failed'))
        : vi.fn().mockResolvedValue(undefined),
    );
    vi.mocked(mysql.createPool).mockReturnValueOnce(pool as never);
    await expect(DoltClient.connect({ port: 33123, database: 'explicit', expectedRepoId: 'test' }))
      .rejects.toThrow(kind === 'query failure' ? failure : /WrongDoltDatabase/);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('verifies before returning a client and caches successful verification', async () => {
    const pool = fakePool(vi.fn().mockResolvedValue([[{ value: 'test' }]]), vi.fn());
    vi.mocked(mysql.createPool).mockReturnValueOnce(pool as never);
    const client = await DoltClient.connect({ port: 33123, database: 'explicit', expectedRepoId: 'test' });
    expect(pool.connection.query).toHaveBeenCalledWith({
      sql: 'SELECT value FROM metadata WHERE `key` = ? LIMIT 1', values: ['repo_id'], timeout: DOLT_QUERY_TIMEOUT_MS,
    });
    expect(pool.connection.release).toHaveBeenCalledTimes(1);
    await client.verifyFingerprint();
    expect(pool.connection.query).toHaveBeenCalledTimes(1);
    expect(pool.end).not.toHaveBeenCalled();
    await client.close();
  });

  it.each([false, true])('explicit endpoints resolve canonical identity (redirect=%s)', async (redirect) => {
    const { base, root } = fixture();
    const worktree = linked(root, base);
    beads(root);
    const target = join(base, 'target');
    if (redirect) {
      beads(target);
      writeFileSync(join(root, '.beads', 'redirect'), '../../target/.beads');
    }
    const identityRoot = redirect ? target : root;
    const readGitRemote = vi.fn((path: string) => redirect ? `https://example.com/${path === target ? 'target' : 'wrong'}` : null);
    const realpath = vi.fn((path: string) => path);
    const cfg = { beadsRoot: worktree, repoFingerprintDeps: { readGitRemote, realpath } };
    const discovered = new DoltClient(cfg);
    const deps = bootDeps();
    const explicit = await DoltClient.connect({ ...cfg, port: 33123, database: 'explicit' }, deps);
    expect(readGitRemote.mock.calls).toEqual([[identityRoot], [identityRoot]]);
    if (!redirect) expect(realpath.mock.calls).toEqual([[root], [root]]);
    expect(deps.readPortFile).not.toHaveBeenCalled();
    expect(deps.startDoltServer).not.toHaveBeenCalled();
    await discovered.close();
    await explicit.close();
  });

  it('requires resolvable identity unless explicit expected identity is supplied', async () => {
    const { root } = fixture();
    beads(root);
    writeFileSync(join(root, '.beads', 'redirect'), 'missing');
    const deps = bootDeps();
    await expect(DoltClient.connect({ beadsRoot: root, port: 33123, database: 'explicit' }, deps))
      .rejects.toThrow(/redirect/);
    expect(mysql.createPool).not.toHaveBeenCalled();
    await DoltClient.connect({ beadsRoot: root, port: 33123, database: 'explicit', expectedRepoId: 'test' }, deps);
    expect(deps.readPortFile).not.toHaveBeenCalled();
  });

  it('rejects unsupported store layout before polling, starting or pooling', async () => {
    const { base, root } = fixture();
    beads(root);
    const target = join(base, 'beads-store');
    mkdirSync(target);
    writeFileSync(join(target, 'metadata.json'), JSON.stringify({ dolt_database: 'valid' }));
    writeFileSync(join(target, 'dolt-server.port'), '33123');
    writeFileSync(join(root, '.beads', 'redirect'), target);
    const deps = bootDeps();
    vi.mocked(deps.readPortFile).mockReturnValue(null);
    await expect(DoltClient.connect({ beadsRoot: root }, deps)).rejects.toThrow(/unsupported Beads redirect layout/);
    await expect(resolveDoltPort({ beadsRoot: root }, deps)).rejects.toThrow(/unsupported Beads redirect layout/);
    expect(deps.readPortFile).not.toHaveBeenCalled();
    expect(deps.startDoltServer).not.toHaveBeenCalled();
    expect(mysql.createPool).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses primary repo metadata/port for a linked worktree (absolute=%s)',
    async (absolute) => {
      const { base, root } = fixture();
      const worktree = linked(root, base, absolute);
      beads(root);
      beads(worktree, 'wrong_local_db', '33999');
      mkdirSync(join(root, '.beads', 'dolt', 'unrelated_directory'), { recursive: true });
      const client = new DoltClient({ beadsRoot: worktree, expectedRepoId: 'test' });
      expect(client.database).toBe('authoritative-db');
      expect(client.port).toBe(33123);
      await client.close();
      const deps = bootDeps();
      await DoltClient.connect({ beadsRoot: worktree, expectedRepoId: 'test' }, deps);
      expect(deps.readPortFile).toHaveBeenCalledWith(join(root, '.beads', 'dolt-server.port'));
      expect(mysql.createPool).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: 'authoritative-db', port: 33123 }),
      );
    },
  );

  it('starts and polls only in the canonical primary repository', async () => {
    const { base, root } = fixture();
    const worktree = linked(root, base);
    beads(root);
    const deps = bootDeps();
    vi.mocked(deps.readPortFile).mockReturnValueOnce(null);
    await resolveDoltPort({ beadsRoot: worktree }, deps);
    expect(deps.startDoltServer).toHaveBeenCalledWith(root);
    expect(deps.readPortFile).toHaveBeenNthCalledWith(2, join(root, '.beads', 'dolt-server.port'));
  });

  it.each([false, true])('follows canonical Beads redirects (absolute=%s)', async (absolute) => {
    const { base, root } = fixture();
    const worktree = linked(root, base);
    const target = join(base, 'target');
    beads(root, 'stale');
    beads(target, 'redirected_db', '33124');
    writeFileSync(
      join(root, '.beads', 'redirect'),
      absolute ? join(target, '.beads') : '../../target/.beads\n',
    );
    const deps = bootDeps();
    vi.mocked(deps.readPortFile).mockReturnValueOnce(null).mockReturnValue('33124');
    const client = await DoltClient.connect({ beadsRoot: worktree, expectedRepoId: 'test' }, deps);
    expect(client.database).toBe('redirected_db');
    expect(client.port).toBe(33124);
    expect(deps.startDoltServer).toHaveBeenCalledWith(target);
    expect(deps.readPortFile).toHaveBeenCalledWith(join(target, '.beads', 'dolt-server.port'));
  });

  it.each(['standalone', 'git'])('preserves %s repositories', (kind) => {
    const { root } = fixture();
    if (kind === 'git') execFileSync('git', ['init', '--quiet', root]);
    beads(root, 'beads_123');
    expect(new DoltClient({ beadsRoot: root, expectedRepoId: 'test' }).database).toBe('beads_123');
  });

  it('does not inherit Beads from an enclosing checkout for a standalone root', () => {
    const { root } = fixture();
    execFileSync('git', ['init', '--quiet', root]);
    beads(root, 'parent');
    const nested = join(root, 'nested');
    beads(nested, 'nested');
    expect(new DoltClient({ beadsRoot: nested, expectedRepoId: 'test' }).database).toBe('nested');
  });

  it('preserves full and individual explicit overrides', async () => {
    const { root } = fixture();
    beads(root);
    expect(new DoltClient({ beadsRoot: root, port: 33444, expectedRepoId: 'test' }).port).toBe(
      33444,
    );
    writeFileSync(join(root, '.beads', 'metadata.json'), '{broken');
    expect(
      new DoltClient({ beadsRoot: root, database: 'override', expectedRepoId: 'test' }).database,
    ).toBe('override');
    writeFileSync(join(root, '.beads', 'redirect'), 'missing');
    const deps = bootDeps();
    const client = await DoltClient.connect(
      { beadsRoot: root, database: 'override', port: 33445, expectedRepoId: 'test' },
      deps,
    );
    expect(client.port).toBe(33445);
    expect(deps.readPortFile).not.toHaveBeenCalled();
  });

  it.each([
    '{broken',
    'null',
    '[]',
    '{}',
    '{"database":"legacy.db"}',
    '{"dolt_database":null}',
    '{"dolt_database":123}',
    '{"dolt_database":""}',
    '{"dolt_database":"../bad"}',
    '{"dolt_database":"db/branch"}',
    '{"dolt_database":"db`; DROP TABLE issues"}',
    '{"dolt_database":" padded "}',
    JSON.stringify({ dolt_database: 'a'.repeat(65) }),
  ])('fails closed on unreliable metadata: %s', async (raw) => {
    const { root } = fixture();
    beads(root);
    writeFileSync(join(root, '.beads', 'metadata.json'), raw);
    mkdirSync(join(root, '.beads', 'dolt', 'plausible_db'), { recursive: true });
    const deps = bootDeps();
    await expect(DoltClient.connect({ beadsRoot: root }, deps)).rejects.toThrow(
      /metadata|dolt_database/,
    );
    expect(deps.readPortFile).not.toHaveBeenCalled();
    expect(deps.startDoltServer).not.toHaveBeenCalled();
    expect(mysql.createPool).not.toHaveBeenCalled();
  });

  it('rejects missing metadata instead of directory or basename guessing', () => {
    const { root } = fixture();
    mkdirSync(join(root, '.beads', 'dolt', 'looks_like_db'), { recursive: true });
    expect(() => new DoltClient({ beadsRoot: root, port: 33123 })).toThrow(
      /no reliable database name/,
    );
  });

  it.each(['', '.', 'missing', 'one\ntwo'])(
    'rejects invalid/cyclic/dangling redirects: %s',
    async (redirect) => {
      const { root } = fixture();
      beads(root);
      writeFileSync(join(root, '.beads', 'redirect'), redirect);
      const deps = bootDeps();
      await expect(DoltClient.connect({ beadsRoot: root }, deps)).rejects.toThrow(/redirect/);
      expect(deps.startDoltServer).not.toHaveBeenCalled();
    },
  );

  it('preserves standalone repositories with a separate Git directory', () => {
    const { base, root } = fixture();
    execFileSync('git', ['init', '--quiet', '--separate-git-dir', join(base, 'git-data'), root]);
    beads(root, 'separate_git_db');
    expect(new DoltClient({ beadsRoot: root, expectedRepoId: 'test' }).database).toBe(
      'separate_git_db',
    );
  });

  it('keeps one canonical location through async boot and fingerprinting', async () => {
    const { base, root } = fixture();
    const worktree = linked(root, base);
    beads(root);
    const other = join(base, 'other');
    beads(other, 'wrong');
    const readGitRemote = vi.fn(() => null);
    const realpath = vi.fn((path: string) => path);
    const deps = bootDeps();
    vi.mocked(deps.readPortFile).mockReturnValueOnce(null);
    vi.mocked(deps.startDoltServer).mockImplementation(async () => {
      writeFileSync(join(root, '.beads', 'redirect'), '../../other/.beads');
    });
    const client = await DoltClient.connect(
      { beadsRoot: worktree, repoFingerprintDeps: { readGitRemote, realpath } },
      deps,
    );
    expect(client.database).toBe('authoritative-db');
    expect(deps.readPortFile).toHaveBeenNthCalledWith(2, join(root, '.beads', 'dolt-server.port'));
    expect(readGitRemote).toHaveBeenCalledWith(root);
    expect(realpath).toHaveBeenCalledWith(root);
  });

  it('rejects a broken Git marker rather than trusting local metadata', () => {
    const { root } = fixture();
    beads(root);
    writeFileSync(join(root, '.git'), 'gitdir: /nonexistent-dolt-discovery-git');
    expect(() => new DoltClient({ beadsRoot: root })).toThrow(/cannot resolve canonical/);
  });

  it.each(['', '../db', 'db/branch'])(
    'rejects invalid explicit database override: %s',
    (database) => {
      expect(() => new DoltClient({ port: 33123, database })).toThrow(/invalid dolt_database/);
      expect(mysql.createPool).not.toHaveBeenCalled();
    },
  );

  it('does not fall back to local metadata if a linked primary has none', async () => {
    const { base, root } = fixture();
    const worktree = linked(root, base);
    beads(worktree, 'wrong');
    await expect(DoltClient.connect({ beadsRoot: worktree }, bootDeps())).rejects.toThrow(
      /no reliable database name/,
    );
  });
});
