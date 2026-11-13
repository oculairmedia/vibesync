/**
 * Characterisation tests for the Dolt client (vibesync-9lzk.59), written BEFORE
 * refactoring it. dolt-client.ts scores 7.50 on CodeScene (resolveBeadsLocation
 * cc 25, resolveDoltPort cc 16) and its unit tests take 115 of its 166 branch
 * arms. These pin the paths nothing tested: the bead-row parser's defaults, the
 * Beads redirect rules (cycle, malformed or non-directory target, too many
 * hops), and the two linked-worktree errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

import { DoltClient } from '../../../../src/engine/store/dolt-client.js';

vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => undefined), execute: vi.fn(async () => [[]]) })) } }));

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dolt-char-'));
  fixtures.push(base);
  const root = join(base, 'repo');
  mkdirSync(root);
  return { base, root };
}

function beads(dir: string, database = 'db') {
  mkdirSync(join(dir, '.beads'), { recursive: true });
  writeFileSync(join(dir, '.beads', 'metadata.json'), JSON.stringify({ dolt_database: database }));
  writeFileSync(join(dir, '.beads', 'dolt-server.port'), '33123');
}

/** A client whose pool answers `execute` with the given rows (no Dolt server involved). */
function clientWithRows(rows: unknown[]) {
  const { root } = fixture();
  beads(root);
  const execute = vi.fn(async () => [rows]);
  vi.mocked(mysql.createPool).mockReturnValueOnce({ end: vi.fn(async () => undefined), execute } as never);
  return new DoltClient({ beadsRoot: root, expectedRepoId: 'test' });
}

describe('reading bead rows', () => {
  it('fills defaults for missing fields and keeps a null closed_at', async () => {
    const client = clientWithRows([{ id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null }]);
    const bead = await client.getBead('7');
    expect(bead).toMatchObject({
      id: '7', title: '', description: '', status: 'open', priority: 2, issue_type: 'task', closed_at: null, metadata: {}, notes: '',
    });
    expect(bead!.created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await client.close();
  });

  it('parses metadata stored as JSON text, and keeps metadata that is already an object', async () => {
    const asText = clientWithRows([{ id: 'a', metadata: '{"exec":{"round":2}}', created_at: 0, updated_at: 0 }]);
    expect((await asText.getBead('a'))!.metadata).toEqual({ exec: { round: 2 } });
    await asText.close();
    const asObject = clientWithRows([{ id: 'b', metadata: { exec: { round: 3 } }, created_at: 0, updated_at: 0 }]);
    expect((await asObject.getBead('b'))!.metadata).toEqual({ exec: { round: 3 } });
    await asObject.close();
  });

  it('reads a closed bead\'s closed_at and its notes; a non-string notes value becomes empty', async () => {
    const client = clientWithRows([{ id: 'c', status: 'closed', priority: 0, closed_at: '2026-03-01T00:00:00Z', notes: 'done', created_at: 0, updated_at: 0 }]);
    const bead = (await client.getBead('c'))!;
    expect(bead.status).toBe('closed');
    expect(bead.priority).toBe(0);
    expect(bead.closed_at!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(bead.notes).toBe('done');
    await client.close();
    const numeric = clientWithRows([{ id: 'd', notes: 5, created_at: 0, updated_at: 0 }]);
    expect((await numeric.getBead('d'))!.notes).toBe('');
    await numeric.close();
  });

  it('returns null for an id with no row', async () => {
    const client = clientWithRows([]);
    expect(await client.getBead('nope')).toBeNull();
    await client.close();
  });
});

describe('following Beads redirects', () => {
  it('follows a redirect to another .beads directory', () => {
    const { base, root } = fixture();
    const target = join(base, 'store');
    beads(target, 'redirected-db');
    mkdirSync(join(root, '.beads'));
    writeFileSync(join(root, '.beads', 'redirect'), '../../store/.beads');
    const client = new DoltClient({ beadsRoot: root, expectedRepoId: 'test' });
    expect(client.database).toBe('redirected-db');
  });

  it('rejects a redirect cycle', () => {
    const { base, root } = fixture();
    const other = join(base, 'other');
    mkdirSync(join(root, '.beads'));
    mkdirSync(join(other, '.beads'), { recursive: true });
    writeFileSync(join(root, '.beads', 'redirect'), '../../other/.beads');
    writeFileSync(join(other, '.beads', 'redirect'), '../../repo/.beads');
    expect(() => new DoltClient({ beadsRoot: root, expectedRepoId: 'test' })).toThrow(/Beads redirect cycle/);
  });

  it.each([
    ['an empty target', ''],
    ['a target on two lines', '../a/.beads\n../b/.beads'],
  ])('rejects %s', (_case, target) => {
    const { root } = fixture();
    mkdirSync(join(root, '.beads'));
    writeFileSync(join(root, '.beads', 'redirect'), target);
    expect(() => new DoltClient({ beadsRoot: root, expectedRepoId: 'test' })).toThrow(/malformed Beads redirect/);
  });

  it('rejects a redirect to a .beads that is a file, not a directory', () => {
    const { base, root } = fixture();
    mkdirSync(join(base, 'store'));
    writeFileSync(join(base, 'store', '.beads'), 'not a directory');
    mkdirSync(join(root, '.beads'));
    writeFileSync(join(root, '.beads', 'redirect'), '../../store/.beads');
    expect(() => new DoltClient({ beadsRoot: root, expectedRepoId: 'test' })).toThrow(/redirect target is not a directory/);
  });

  it('rejects a chain of more than 32 redirects', () => {
    const { base, root } = fixture();
    mkdirSync(join(root, '.beads'));
    writeFileSync(join(root, '.beads', 'redirect'), '../../hop-0/.beads');
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(base, `hop-${i}`, '.beads'), { recursive: true });
      writeFileSync(join(base, `hop-${i}`, '.beads', 'redirect'), `../../hop-${i + 1}/.beads`);
    }
    expect(() => new DoltClient({ beadsRoot: root, expectedRepoId: 'test' })).toThrow(/too many Beads redirects/);
  });
});

describe('linked worktrees', () => {
  it('rejects a linked worktree whose common Git directory is not named .git', () => {
    const { base, root } = fixture();
    execFileSync('git', ['init', '--quiet', '--separate-git-dir', join(base, 'gitstore'), root]);
    const worktree = join(base, 'linked');
    const admin = join(base, 'gitstore', 'worktrees', 'linked');
    mkdirSync(worktree);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, 'commondir'), '../..');
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/linked\n');
    writeFileSync(join(admin, 'gitdir'), join(worktree, '.git'));
    beads(worktree);
    expect(() => new DoltClient({ beadsRoot: worktree, expectedRepoId: 'test' })).toThrow(/cannot resolve canonical Beads repository/);
  });

  it('a .beads symlink is resolved to its real directory: its store is the target\'s', () => {
    // realpath first, so the store's root is where the data lives, and the layout
    // check sees the real directory's name.
    const { base, root } = fixture();
    beads(join(base, 'real'), 'symlinked-db');
    symlinkSync(join(base, 'real', '.beads'), join(root, '.beads'));
    const client = new DoltClient({ beadsRoot: root, expectedRepoId: 'test' });
    expect(client.database).toBe('symlinked-db');
    expect(client.beadsRoot).toBe(join(realpathSync(base), 'real'));
  });

  it('a .beads symlink to a directory not named .beads is an unsupported layout', () => {
    const { base, root } = fixture();
    mkdirSync(join(base, 'store'));
    writeFileSync(join(base, 'store', 'metadata.json'), JSON.stringify({ dolt_database: 'db' }));
    symlinkSync(join(base, 'store'), join(root, '.beads'));
    expect(() => new DoltClient({ beadsRoot: root, expectedRepoId: 'test' })).toThrow(/unsupported Beads redirect layout/);
  });
});
