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

  it('sets, replaces and lists a project\'s role agents (vibesync-9lzk.55.5)', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('alpha') });
    const id = created.body.project.identifier as string;
    const A = 'agent-11111111-1111-4111-8111-111111111111';
    const B = 'agent-22222222-2222-4222-8222-222222222222';
    const C = 'agent-33333333-3333-4333-8333-333333333333';

    expect((await call('GET', `/api/registry/projects/${id}/role-agents`)).body.roleAgents).toEqual([]);

    const set = await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [{ roleName: 'tester', agentId: B }, { roleName: 'coder', agentId: A }] });
    expect(set.status).toBe(200);
    expect(set.body.roleAgents).toEqual([{ roleName: 'coder', agentId: A }, { roleName: 'tester', agentId: B }]);

    // A replace: a role left out is removed, a listed role is set to its new agent.
    const replaced = await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [{ roleName: 'coder', agentId: C }, { roleName: 'reviewer', agentId: B }] });
    expect(replaced.body.roleAgents).toEqual([{ roleName: 'coder', agentId: C }, { roleName: 'reviewer', agentId: B }]);
    expect((await call('GET', `/api/registry/projects/${id}/role-agents`)).body.roleAgents).toEqual(replaced.body.roleAgents);
    // The scheduler's pool reads the same rows.
    expect(db.listRoleAgents(id).map((r) => [r.roleName, r.agentId])).toEqual([['coder', C], ['reviewer', B]]);

    // An empty list clears them.
    expect((await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [] })).body.roleAgents).toEqual([]);
  });

  it('refuses role agents for an unknown project, and a body that is not a valid set, without changing anything', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('beta') });
    const id = created.body.project.identifier as string;
    const A = 'agent-11111111-1111-4111-8111-111111111111';
    await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [{ roleName: 'coder', agentId: A }] });

    expect((await call('GET', '/api/registry/projects/no-such/role-agents')).status).toBe(404);
    expect((await call('PUT', '/api/registry/projects/no-such/role-agents', { roleAgents: [] })).status).toBe(404);
    for (const bad of [
      {},
      { roleAgents: 'coder' },
      { roleAgents: [{ roleName: '', agentId: A }] },
      { roleAgents: [{ roleName: 'Coder', agentId: A }] },
      { roleAgents: [{ roleName: 'coder', agentId: 'not-an-agent' }] },
      { roleAgents: [{ roleName: 'coder', agentId: A }, { roleName: 'coder', agentId: A }] },
    ]) {
      const res = await call('PUT', `/api/registry/projects/${id}/role-agents`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.listRoleAgents(id).map((r) => [r.roleName, r.agentId])).toEqual([['coder', A]]);
  });

  it('role agents: a body that is not JSON or not an object is 400, not 500 (CodeRabbit on #178)', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('gamma') });
    const id = created.body.project.identifier as string;
    for (const raw of ['{not json', 'null', '[]', '"text"']) {
      const res = await fetch(`${base}/api/registry/projects/${id}/role-agents`, { method: 'PUT', body: raw, headers: { 'Content-Type': 'application/json' } });
      expect(res.status, raw).toBe(400);
    }
  });

  it('role agents: an archived project is refused with 409 and keeps nothing (startup would drop them)', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('delta') });
    const id = created.body.project.identifier as string;
    await call('PATCH', `/api/registry/projects/${id}`, { status: 'archived' });
    const res = await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [{ roleName: 'coder', agentId: 'agent-11111111-1111-4111-8111-111111111111' }] });
    expect(res.status).toBe(409);
    expect(db.listRoleAgents(id)).toEqual([]);
  });

  it('role agents: a failure part way through a replace leaves the previous set whole (one transaction)', async () => {
    const created = await call('POST', '/api/registry/projects', { filesystem_path: repo('epsilon') });
    const id = created.body.project.identifier as string;
    const A = 'agent-11111111-1111-4111-8111-111111111111';
    const B = 'agent-22222222-2222-4222-8222-222222222222';
    await call('PUT', `/api/registry/projects/${id}/role-agents`, { roleAgents: [{ roleName: 'coder', agentId: A }, { roleName: 'tester', agentId: B }] });
    // The replace removes tester, then fails while setting reviewer.
    const repo2 = (db as unknown as { projects: { roleAgents: { upsertRoleAgent: (...a: unknown[]) => unknown } } }).projects.roleAgents;
    const real = repo2.upsertRoleAgent.bind(repo2);
    repo2.upsertRoleAgent = (...args: unknown[]) => { if (args[1] === 'reviewer') throw new Error('disk full'); return real(...args); };
    try {
      expect(() => db.replaceRoleAgents(id, [{ roleName: 'coder', agentId: A }, { roleName: 'reviewer', agentId: B }], 'http://localhost:8291')).toThrow('disk full');
    } finally {
      repo2.upsertRoleAgent = real;
    }
    expect(db.listRoleAgents(id).map((r) => [r.roleName, r.agentId])).toEqual([['coder', A], ['tester', B]]);
  });

  it('a browser preflight allows PUT, so the role-agent route can be called from a page', async () => {
    const res = await fetch(`${base}/api/registry/projects/x/role-agents`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
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
