import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createProjectFileSettingsSource, readCommittedFileAt, readDefaultBranchCommittedFile } from '../../../src/app/project-settings.js';

function source(content: string | null) {
  const reads: Array<{ checkout: string; path: string }> = [];
  const load = createProjectFileSettingsSource({
    checkoutOf: () => '/checkout',
    readCommittedFile: (checkout, path) => { reads.push({ checkout, path }); return content; },
  });
  return { load, reads };
}

describe('committed project engine settings', () => {
  it('returns empty settings for a missing file', () => {
    expect(source(null).load('alpha')).toEqual({});
  });

  it('returns only supported fields from engine and ignores unknown fields', () => {
    const { load } = source(JSON.stringify({ unknown: true, engine: { formula: 'implement-fix', readyLabel: 'ready:now', poolSize: 4, ciChecks: ['check'], other: 1 } }));
    expect(load('alpha')).toEqual({ formula: 'implement-fix', readyLabel: 'ready:now', poolSize: 4, ciChecks: ['check'] });
  });

  it.each([
    ['formula', { formula: 'Bad' }, 'formula', 'match'],
    ['readyLabel', { readyLabel: 'Bad label' }, 'readyLabel', 'match'],
    ['poolSize', { poolSize: 9 }, 'poolSize', 'integer from 1 to 8'],
    ['poolSize type', { poolSize: 1.5 }, 'poolSize', 'integer from 1 to 8'],
    ['ciChecks type', { ciChecks: 'check' }, 'ciChecks', 'array of at most 16'],
    ['ciChecks count', { ciChecks: Array(17).fill('x') }, 'ciChecks', 'at most 16'],
    ['ciChecks entry', { ciChecks: [''] }, 'ciChecks', '1 to 100'],
    ['ciChecks entry length', { ciChecks: ['x'.repeat(101)] }, 'ciChecks', '1 to 100'],
  ])('rejects invalid %s and names the field and rule', (_case, invalid, field, rule) => {
    const { load } = source(JSON.stringify({ engine: invalid }));
    expect(() => load('alpha')).toThrow(new RegExp(`alpha.*engine\\.${field}.*${rule}`));
  });

  it('uses the injected committed-file reader rather than working-tree content', () => {
    const { load, reads } = source('{"engine":{"formula":"default"}}');
    expect(load('alpha').formula).toBe('default');
    expect(reads).toEqual([{ checkout: '/checkout', path: '.meridian/project.json' }]);
  });

  it('rejects malformed JSON and files over 16 KiB', () => {
    expect(() => source('{oops').load('alpha')).toThrow(/alpha.*file.*strict JSON/);
    expect(() => source(' '.repeat(16 * 1024 + 1)).load('alpha')).toThrow(/alpha.*file.*16 KiB/);
  });
});

describe('readDefaultBranchCommittedFile against a real repository', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'project-settings-git-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return dir;
  }

  it('returns null when the default branch has no project file', () => {
    expect(readDefaultBranchCommittedFile(repo(), '.meridian/project.json')).toBeNull();
  });

  it('ignores a project file that exists only in the working tree', () => {
    const dir = repo();
    mkdirSync(join(dir, '.meridian'));
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"working-tree-only"}');
    expect(readDefaultBranchCommittedFile(dir, '.meridian/project.json')).toBeNull();
  });

  it('reads main, not the feature branch the checkout is sitting on (no origin/HEAD)', () => {
    const dir = repo();
    mkdirSync(join(dir, '.meridian'));
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"on-main"}');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'project file on main');
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"on-feature"}');
    git(dir, 'commit', '-qam', 'changed on a feature branch');
    expect(readDefaultBranchCommittedFile(dir, '.meridian/project.json')).toBe('{"key":"on-main"}');
  });

  it('prefers origin\'s default branch over a local branch of the same name', () => {
    const upstream = repo();
    mkdirSync(join(upstream, '.meridian'));
    writeFileSync(join(upstream, '.meridian/project.json'), '{"key":"upstream"}');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'upstream project file');
    const clone = mkdtempSync(join(tmpdir(), 'project-settings-clone-'));
    execFileSync('git', ['clone', '-q', upstream, clone], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    git(clone, 'remote', 'set-head', 'origin', '-d'); // a clone with no recorded origin/HEAD
    writeFileSync(join(clone, '.meridian/project.json'), '{"key":"local-main"}');
    git(clone, 'commit', '-qam', 'local change, not pushed');
    expect(readDefaultBranchCommittedFile(clone, '.meridian/project.json')).toBe('{"key":"upstream"}');
  });

  it('refuses to guess when the default branch has another name and there is no origin/HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-settings-trunk-'));
    git(dir, 'init', '-q', '-b', 'trunk');
    mkdirSync(join(dir, '.meridian'));
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"on-trunk"}');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'trunk');
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"on-feature"}');
    git(dir, 'commit', '-qam', 'feature');
    expect(() => readDefaultBranchCommittedFile(dir, '.meridian/project.json')).toThrow(/cannot tell the default branch/);
  });

  it('a path that is not a git repository is an error, not "no project file"', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'project-settings-norepo-'));
    expect(() => readDefaultBranchCommittedFile(notRepo, '.meridian/project.json')).toThrow();
  });

  it('readCommittedFileAt (the release reader) throws on a non-repository or a ref that does not resolve', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'project-settings-norepo-at-'));
    expect(() => readCommittedFileAt(notRepo, 'HEAD', '.meridian/project.json')).toThrow();
    const dir = repo();
    expect(() => readCommittedFileAt(dir, 'refs/heads/no-such-branch', '.meridian/project.json')).toThrow();
    expect(readCommittedFileAt(dir, 'HEAD', '.meridian/project.json')).toBeNull(); // a real commit without the file
  });

  it('returns the committed content, not an uncommitted edit', () => {
    const dir = repo();
    mkdirSync(join(dir, '.meridian'));
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"committed"}');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'add project file');
    writeFileSync(join(dir, '.meridian/project.json'), '{"key":"edited-not-committed"}');
    expect(readDefaultBranchCommittedFile(dir, '.meridian/project.json')).toBe('{"key":"committed"}');
  });
});
