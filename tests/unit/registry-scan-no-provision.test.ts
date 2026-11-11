import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRegistry, type Registry } from '../../src/app/registry/registry.js';
import * as provisioner from '../../src/app/registry/rig/provisioner.js';
import { ProjectRegistry } from '../../src/app/registry/project-registry.js';

describe('registry scan provisioning boundary', () => {
  let root: string;
  let db: Registry;

  function setup(): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-scan-no-provision-'));
    db = createRegistry(path.join(root, 'registry.db'));
    return path.join(root, 'stacks');
  }

  function createGitRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/owner/repo.git']);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('records multiple git projects without calling ensureRig', () => {
    const baseDir = setup();
    for (const name of ['alpha', 'beta']) fs.mkdirSync(path.join(baseDir, name, '.git'), { recursive: true });
    const ensureRig = vi.spyOn(provisioner, 'ensureRig');
    const registry = new ProjectRegistry({ db, baseDir });

    expect(registry.scanProjects()).toEqual({ discovered: 2, updated: 2, errors: [] });
    expect(db.getProject('alpha')).toBeTruthy();
    expect(db.getProject('beta')).toBeTruthy();
    expect(ensureRig).not.toHaveBeenCalled();
  });

  it('scans a real git repository without starting bd or modifying its files', () => {
    const baseDir = setup();
    const repo = path.join(baseDir, 'real-repo');
    createGitRepo(repo);
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    const binDir = path.join(root, 'bin');
    const callsFile = path.join(root, 'bd-calls');
    fs.mkdirSync(binDir);
    const fakeBd = path.join(binDir, 'bd');
    fs.writeFileSync(fakeBd, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsFile}'\n`);
    fs.chmodSync(fakeBd, 0o755);
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
      new ProjectRegistry({ db, baseDir }).scanProjects();
      expect(fs.existsSync(callsFile)).toBe(false);
      expect(fs.existsSync(path.join(repo, '.beads'))).toBe(false);
      expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe(before);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('explicit registration starts bd init for the scanned repository', () => {
    const baseDir = setup();
    const repo = path.join(baseDir, 'real-repo');
    createGitRepo(repo);
    const binDir = path.join(root, 'bin');
    const callsFile = path.join(root, 'bd-calls');
    fs.mkdirSync(binDir);
    const fakeBd = path.join(binDir, 'bd');
    fs.writeFileSync(fakeBd, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsFile}'\nexit 0\n`);
    fs.chmodSync(fakeBd, 0o755);
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
      new ProjectRegistry({ db, baseDir }).registerProject(repo);
      expect(fs.readFileSync(callsFile, 'utf8')).toContain('init --prefix rr');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('logs failed explicit provisioning at warn rather than info', () => {
    const baseDir = setup();
    const repo = path.join(baseDir, 'failed-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    vi.spyOn(provisioner, 'ensureRig').mockReturnValue({ ok: false, action: 'repair', message: 'x' });
    const warn = vi.fn();
    const info = vi.fn();
    const logger = { child: () => ({ warn, info, error: vi.fn() }) } as never;

    new ProjectRegistry({ db, baseDir, logger }).registerProject(repo);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ action: 'repair', message: 'x' }), 'Rig auto-provisioning failed');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'Rig auto-provisioned');
  });
});
