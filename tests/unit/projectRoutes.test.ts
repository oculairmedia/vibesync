/**
 * Project registry routes, driven through the real ApiServer against a real
 * SQLite registry. Paths mirror letta-mobile's ProjectAdminHandlers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiServer } from '../../src/app/http/server.js';
import { createRegistry, type Registry } from '../../src/app/registry/registry.js';
import { ProjectRegistry } from '../../src/app/registry/project-registry.js';
import type { DoltHubProvisionerApi } from '../../src/app/types/api.js';

describe('project registry routes', () => {
  let dir: string;
  let db: Registry;
  let server: http.Server;
  let base: string;
  let provisioner: DoltHubProvisionerApi;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-routes-'));
    db = createRegistry(path.join(dir, 'registry.db'));
    provisioner = { dryRun: true, provisionProject: vi.fn(async () => ({ status: 'dry_run', dry_run: true })) };
    server = createApiServer({ db, projectRegistry: new ProjectRegistry({ db, baseDir: dir }), doltHubProvisioner: provisioner, orchestration: null, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, route: string, body?: unknown) {
    const res = await fetch(`${base}${route}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  function repo(name: string, { beads = false } = {}): string {
    const repoPath = path.join(dir, name);
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.git', 'config'), '[remote "origin"]\n\turl = https://ghp_secret@github.com/o/r.git\n');
    fs.writeFileSync(path.join(repoPath, 'package.json'), '{}');
    if (beads) fs.mkdirSync(path.join(repoPath, '.beads'));
    return repoPath;
  }

  it('creates, lists, reads, updates, archives and deletes a project (mobile project.* methods)', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('alpha'), name: 'Alpha' });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({ identifier: 'alpha', name: 'Alpha', tech_stack: 'node', git_url: 'https://github.com/o/r.git' });

    const list = await call('GET', '/api/projects?limit=10');
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0]).toMatchObject({ id: 'alpha', identifier: 'alpha', tracker: { provider: 'beads' }, beads_remote: { status: 'not_provisioned' } });
    expect(list.body.page).toMatchObject({ has_more: false, total_known: 1 });

    expect((await call('GET', '/api/projects/alpha')).body.project).toMatchObject({ identifier: 'alpha' });
    expect((await call('GET', '/api/registry/projects/alpha')).body).toMatchObject({ identifier: 'alpha' });

    const archived = await call('PATCH', '/api/registry/projects/alpha', { status: 'archived' });
    expect(archived.body.project.status).toBe('archived');
    expect((await call('PATCH', '/api/registry/projects/alpha', { status: 'bogus' })).status).toBe(400);

    expect((await call('DELETE', '/api/registry/projects/alpha')).status).toBe(200);
    expect((await call('GET', '/api/projects/alpha')).status).toBe(404);
  });

  it('rejects relative registration paths', async () => {
    expect((await call('POST', '/api/registry/projects', { filesystem_path: 'relative/path' })).status).toBe(400);
    expect((await call('POST', '/api/registry/projects', {})).status).toBe(400);
  });

  it('reports and provisions the Beads remote only for projects with a Beads database', async () => {
    await call('POST', '/api/registry/projects', { filesystem_path: repo('with-beads', { beads: true }) });
    await call('POST', '/api/registry/projects', { filesystem_path: repo('no-beads') });

    expect((await call('GET', '/api/projects/with-beads/beads-remote')).body).toMatchObject({ project_identifier: 'with-beads', beads_remote: { status: 'not_provisioned' } });

    const provisioned = await call('POST', '/api/projects/with-beads/beads-remote/provision', { push: false });
    expect(provisioned.status).toBe(200);
    expect(provisioner.provisionProject).toHaveBeenCalledWith(expect.objectContaining({ identifier: 'with-beads' }), { push: false });

    expect((await call('POST', '/api/projects/no-beads/beads-remote/provision')).status).toBe(400);
  });

  it('answers the retired sync trigger explicitly instead of 404 or silent success', async () => {
    const res = await call('POST', '/api/sync/trigger', {});
    expect(res.status).toBe(410);
    expect(res.body.status).toBe('retired');
  });

  it('reports engine readiness on /health', async () => {
    expect((await call('GET', '/health')).body).toMatchObject({ status: 'healthy', orchestration: { ready: false } });
  });
});
