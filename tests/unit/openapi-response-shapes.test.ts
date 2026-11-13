/**
 * The documented response of each project route must match the body its handler
 * actually sends (CodeRabbit on #160: four routes documented the inner project
 * object while the handlers wrap it, so a client following /openapi.json read
 * fields at the wrong level).
 *
 * Each real handler runs against an in-memory registry; its JSON body is
 * validated against the schema the description declares for that status code.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import { ApiSchemas } from '../../src/app/http/openapi/schemas.js';
import { registerHealthRoutes } from '../../src/app/http/routes/health.js';
import { registerProjectRoutes } from '../../src/app/http/routes/projects.js';
import type { App, HandleContext, RouteContext } from '../../src/app/types/api.js';
import type { ProjectRow } from '../../src/app/types/db.js';

const checkout = mkdtempSync(join(tmpdir(), 'openapi-shapes-'));
mkdirSync(join(checkout, '.beads'));
afterAll(() => rmSync(checkout, { recursive: true, force: true }));

function row(): ProjectRow {
  return {
    identifier: 'demo', name: 'Demo', filesystem_path: checkout, git_url: null, status: 'active', tech_stack: null,
    last_scan_at: null, last_checked_at: null, created_at: 1, updated_at: 2, letta_agent_id: null, provider_kind: null,
    beads_prefix: 'demo', beads_remote_owner: null, beads_remote_repo: null, beads_remote_url: null, beads_remote_name: null,
    beads_remote_status: null, beads_remote_visibility: null, beads_remote_provisioned_at: null, beads_remote_last_push_at: null,
    beads_remote_last_error: null,
  };
}

type Route = { match: (ctx: RouteContext) => boolean; handle: (ctx: HandleContext) => Promise<void> };

function server(body: Record<string, unknown> = {}) {
  const routes: Route[] = [];
  const app: App = { registerRoute: (route) => { routes.push(route); } };
  let sent: { status: number; body: unknown } | null = null;
  const sendJson = (_res: unknown, status: number, data: unknown) => { sent = { status, body: data }; };
  const sendError = (_res: unknown, status: number, error: string) => { sent = { status, body: { error } }; };
  const project = row();
  const db = { getAllProjects: () => [project], getProject: (id: string) => (id === 'demo' ? project : undefined), resolveProjectIdentifier: (id: string) => id };
  const projectRegistry = {
    registerProject: () => project,
    updateProject: () => project,
    getProject: (id: string) => (id === 'demo' ? project : null),
    deleteProject: (id: string) => id === 'demo',
  };
  const doltHubProvisioner = { provisionProject: async () => ({ dry_run: true, steps: [] }) };
  registerHealthRoutes(app, { startedAt: 0, orchestrationReady: () => true, sendJson: sendJson as never });
  registerProjectRoutes(app, {
    db, projectRegistry, doltHubProvisioner, sendJson, sendError, logger: console,
    parseJsonBody: async () => body,
  } as never);
  return async (method: string, pathname: string) => {
    const route = routes.find((r) => r.match({ method, pathname }));
    if (!route) throw new Error(`no route for ${method} ${pathname}`);
    await route.handle({ req: {} as never, res: {} as never, url: new URL(`http://x${pathname}`), pathname });
    return sent!;
  };
}

const cases: [string, string, number, ZodType, Record<string, unknown>?][] = [
  ['GET', '/health', 200, ApiSchemas.Health],
  ['GET', '/api/projects', 200, ApiSchemas.ProjectListResponse],
  ['GET', '/api/projects/demo', 200, ApiSchemas.ProjectDetailResponse],
  ['GET', '/api/projects/demo/beads-remote', 200, ApiSchemas.BeadsRemoteResponse],
  ['POST', '/api/projects/demo/beads-remote/provision', 200, ApiSchemas.ProvisionBeadsRemoteResponse, { push: false }],
  ['POST', '/api/registry/projects', 201, ApiSchemas.RegisteredProjectResponse, { filesystem_path: '/abs/demo' }],
  ['GET', '/api/registry/projects/demo', 200, ApiSchemas.RegistryProjectRead],
  ['PATCH', '/api/registry/projects/demo', 200, ApiSchemas.RegisteredProjectResponse, { status: 'archived' }],
  ['DELETE', '/api/registry/projects/demo', 200, ApiSchemas.DeleteProjectResponse],
  ['POST', '/api/sync/trigger', 410, ApiSchemas.RetiredSyncResponse],
];

describe('documented response shapes match what the handlers send', () => {
  it.each(cases)('%s %s -> %i', async (method, pathname, status, schema, body) => {
    const sent = await server(body)(method, pathname);
    expect(sent.status).toBe(status);
    const parsed = schema.safeParse(sent.body);
    expect(parsed.success ? 'matches' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe('matches');
  });
});
