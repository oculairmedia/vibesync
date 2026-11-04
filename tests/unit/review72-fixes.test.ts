/**
 * Regression tests for the #72 review findings on project archiving.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { portSweepScope, sweepAll, type PortSweeperDeps } from '../../src/app/registry/port-sweep/PortSweeper.js';
import { createSyncDatabase, type SyncDatabase } from '../../src/app/registry/registry.js';
import * as provisioner from '../../src/app/registry/rig/provisioner.js';
import { ProjectRegistry } from '../../src/app/registry/project-registry.js';

describe('port sweep scope', () => {
  const rows = [
    { identifier: 'live', filesystem_path: '/p/live', status: 'active' },
    { identifier: 'old', filesystem_path: '/p/old', status: 'archived' },
  ];

  it('compares archived ports but repairs only active projects', () => {
    const scope = portSweepScope({ getAllProjects: () => rows });
    expect(scope.registry.map((r) => r.identifier)).toEqual(['live', 'old']);
    expect([...scope.only]).toEqual(['live']);
  });

  it('an active project sharing a pinned port with an archived one is detected and repaired, the archived one untouched', async () => {
    const runBd = vi.fn(async () => '');
    const deps: PortSweeperDeps = {
      readPort: () => 32000, // both pin the same port, neither is listening yet
      listeningPorts: () => new Set(),
      portOwnerCwd: () => null,
      runBd,
    };
    const scope = portSweepScope({ getAllProjects: () => rows });
    const report = await sweepAll(scope.registry, deps, { apply: true, only: scope.only, portStart: 33000, portEnd: 33010 });
    expect(report.conflicts.map((c) => c.project.identifier)).toEqual(['live']);
    expect(report.repairs.map((r) => r.project.identifier)).toEqual(['live']);
    expect(runBd.mock.calls.every(([, opts]) => !String((opts as { cwd?: string })?.cwd ?? '').includes('/p/old'))).toBe(true);
  });
});

describe('archiving and provisioning', () => {
  let dir: string;
  let db: SyncDatabase;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-r72-'));
    db = createSyncDatabase(path.join(dir, 'registry.db'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed status write keeps the role-agent bindings (one transaction)', () => {
    db.upsertProject({ identifier: 'p', name: 'P' });
    db.upsertRoleAgent('p', 'coder', 'agent-1', 'http://shim');
    db.db!.exec(`CREATE TRIGGER fail_archive BEFORE UPDATE OF status ON projects
      WHEN NEW.status = 'archived' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    expect(() => db.updateProject('p', { status: 'archived' })).toThrow('injected failure');
    expect(db.getProject('p')?.status).toBe('active');
    expect(db.listRoleAgents('p')).toHaveLength(1);
  });

  it('a boot scan never provisions an archived project; explicit registration does', () => {
    const repo = path.join(dir, 'stacks', 'old-proj');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const ensureRig = vi.spyOn(provisioner, 'ensureRig').mockReturnValue({ ok: true, action: 'none', message: '' } as never);
    const registry = new ProjectRegistry({ db, baseDir: path.join(dir, 'stacks') });
    registry.scanProjects();
    expect(ensureRig).toHaveBeenCalledTimes(1);
    registry.archiveProject('old-proj');
    registry.scanProjects();
    expect(ensureRig).toHaveBeenCalledTimes(1);
    registry.registerProject(repo);
    expect(ensureRig).toHaveBeenCalledTimes(2);
  });
});
