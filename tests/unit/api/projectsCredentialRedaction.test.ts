/**
 * SECURITY (vibesync-6kg): defense-in-depth tests for credential redaction on
 * the project response surface.
 *
 * The original bug: `GET /api/projects` returned `repo.remote_url` containing a
 * `https://<github_pat>@github.com/...` string verbatim, leaking the PAT to any
 * client that could reach the API.
 *
 * These tests pin the contract: NO HTTP response body from any project
 * serializer may contain a token, key, password, or credential — even when the
 * underlying DB row still carries one (defense in depth).
 *
 * Credential patterns asserted:
 *   - `github_pat_*` (fine-grained GitHub PATs)
 *   - `ghp_*`         (classic GitHub PATs)
 *   - `sk-*`          (OpenAI-style API keys)
 *   - `https?://[^@]+@`  (any URL with inline userinfo)
 */
import { describe, it, expect, vi } from 'vitest';
import { registerProjectRoutes } from '../../../src/api/routes/projects.js';
import type {
  App,
  HandleContext,
  Logger,
  ProjectRegistryApi,
  RouteContext,
  RouteDb,
} from '../../../src/types/api.js';

// Regexes that must NEVER match any string in a serialized response body.
const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'github_pat_', pattern: /github_pat_/ },
  { name: 'ghp_', pattern: /\bghp_[A-Za-z0-9]/ },
  { name: 'sk-', pattern: /\bsk-[A-Za-z0-9]/ },
  { name: 'https://userinfo@', pattern: /https?:\/\/[^@\s/?#]+@/i },
];

function assertNoCredentialsInBody(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    expect(
      serialized,
      `response body must not contain credential pattern: ${name}\nbody: ${serialized}`,
    ).not.toMatch(pattern);
  }
}

interface Route {
  match: (ctx: RouteContext) => boolean;
  handle: (ctx: HandleContext) => Promise<void>;
}

interface Harness {
  routes: Route[];
  sendJson: ReturnType<typeof vi.fn>;
  sendError: ReturnType<typeof vi.fn>;
  find: (method: string, pathname: string) => Route;
}

function makeHarness(opts: {
  projects: Record<string, unknown>[];
  registryProjects?: Record<string, unknown>[];
}): Harness {
  const routes: Route[] = [];
  const app: App = { registerRoute: (route) => { routes.push(route as Route); } };
  const sendJson = vi.fn();
  const sendError = vi.fn();
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const db = {
    getProject: (id: string) => opts.projects.find((p) => p.identifier === id) ?? null,
    getAllProjects: () => opts.projects,
    getProjectSummary: () => opts.projects,
    getProjectIssues: () => [],
    getIssue: () => null,
    resolveProjectIdentifier: (id: string) => id,
    db: { prepare: () => ({ run: () => undefined }) },
  } as unknown as RouteDb;
  const projectRegistry = {
    getProjects: () => opts.registryProjects ?? opts.projects,
    getProject: (id: string) =>
      (opts.registryProjects ?? opts.projects).find((p) => p.identifier === id) ?? null,
    registerProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    scanProjects: vi.fn(),
  } as unknown as ProjectRegistryApi & { scanProjects?: () => unknown };
  registerProjectRoutes(app, {
    db,
    config: {},
    parseJsonBody: vi.fn(async () => ({})),
    sendJson,
    sendError,
    logger,
    projectRegistry,
    doltHubProvisioner: null,
    beadsIssueService: null,
    beadsAdapter: null,
  });
  return {
    routes,
    sendJson,
    sendError,
    find: (method, pathname) => {
      const route = routes.find((r) => r.match({ method, pathname }));
      if (!route) throw new Error(`route not found: ${method} ${pathname}`);
      return route;
    },
  };
}

function makeCtx(pathname: string, method = 'GET'): HandleContext {
  return {
    req: { headers: {}, method } as never,
    res: {} as never,
    url: new URL(`http://localhost${pathname}`),
    pathname,
  };
}

// Realistic leaked-PAT URL — matches the shape captured in the original
// incident (vibesync-6kg observed 2026-05-21).
const LEAKED_PAT_URL =
  'https://github_pat_11ADUGUOI0CTabcdefghijklmnop@github.com/oculairmedia/vibesync.git';

describe('vibesync-6kg: credential redaction on project responses', () => {
  it('GET /api/projects strips inline PAT from repo.remote_url (the original leak)', async () => {
    const harness = makeHarness({
      projects: [
        { identifier: 'vibesync', name: 'Vibesync', status: 'active', git_url: LEAKED_PAT_URL },
      ],
    });
    const route = harness.find('GET', '/api/projects');
    await route.handle(makeCtx('/api/projects'));

    expect(harness.sendJson).toHaveBeenCalled();
    const [, status, body] = harness.sendJson.mock.calls[0]!;
    expect(status).toBe(200);
    assertNoCredentialsInBody(body);

    // And specifically: the remote_url field is now credential-free but
    // structurally intact (host/path preserved).
    const project = (body as { projects: Array<{ repo: { remote_url: string } }> }).projects[0]!;
    expect(project.repo.remote_url).toBe('https://github.com/oculairmedia/vibesync.git');
  });

  it('GET /api/projects/:id strips inline PAT from repo.remote_url', async () => {
    const harness = makeHarness({
      projects: [
        { identifier: 'vibesync', name: 'Vibesync', status: 'active', git_url: LEAKED_PAT_URL },
      ],
    });
    const route = harness.find('GET', '/api/projects/vibesync');
    await route.handle(makeCtx('/api/projects/vibesync'));

    expect(harness.sendJson).toHaveBeenCalled();
    const [, status, body] = harness.sendJson.mock.calls[0]!;
    expect(status).toBe(200);
    assertNoCredentialsInBody(body);
  });

  it('GET /api/registry/projects strips inline PAT from git_url', async () => {
    const harness = makeHarness({
      projects: [],
      registryProjects: [
        {
          identifier: 'vibesync',
          name: 'Vibesync',
          status: 'active',
          tech_stack: 'node',
          letta_agent_id: null,
          last_checked_at: 0,
          issue_count: 0,
          filesystem_path: '/opt/stacks/vibesync',
          git_url: LEAKED_PAT_URL,
        },
      ],
    });
    const route = harness.find('GET', '/api/registry/projects');
    await route.handle(makeCtx('/api/registry/projects'));

    expect(harness.sendJson).toHaveBeenCalled();
    const [, status, body] = harness.sendJson.mock.calls[0]!;
    expect(status).toBe(200);
    assertNoCredentialsInBody(body);

    const project = (body as { projects: Array<{ git_url: string }> }).projects[0]!;
    expect(project.git_url).toBe('https://github.com/oculairmedia/vibesync.git');
  });

  it('strips credentials from beads_remote.url too', async () => {
    const harness = makeHarness({
      projects: [],
      registryProjects: [
        {
          identifier: 'vibesync',
          name: 'Vibesync',
          status: 'active',
          tech_stack: 'node',
          letta_agent_id: null,
          last_checked_at: 0,
          issue_count: 0,
          filesystem_path: '/opt/stacks/vibesync',
          git_url: 'https://github.com/oculairmedia/vibesync.git',
          beads_remote_url: 'https://ghp_secrettoken123@dolthub.com/oculairmedia/beads.git',
          beads_remote_status: 'provisioned',
        },
      ],
    });
    const route = harness.find('GET', '/api/registry/projects');
    await route.handle(makeCtx('/api/registry/projects'));

    const [, , body] = harness.sendJson.mock.calls[0]!;
    assertNoCredentialsInBody(body);
  });

  it('responses with credential-free URLs are returned verbatim (no over-eager stripping)', async () => {
    const cleanUrl = 'https://github.com/oculairmedia/vibesync.git';
    const harness = makeHarness({
      projects: [
        { identifier: 'vibesync', name: 'Vibesync', status: 'active', git_url: cleanUrl },
      ],
    });
    const route = harness.find('GET', '/api/projects');
    await route.handle(makeCtx('/api/projects'));

    const [, , body] = harness.sendJson.mock.calls[0]!;
    const project = (body as { projects: Array<{ repo: { remote_url: string } }> }).projects[0]!;
    expect(project.repo.remote_url).toBe(cleanUrl);
  });

  it('handles a project record carrying multiple credential shapes in different fields', async () => {
    const harness = makeHarness({
      projects: [],
      registryProjects: [
        {
          identifier: 'evil',
          name: 'evil',
          status: 'active',
          tech_stack: null,
          letta_agent_id: null,
          last_checked_at: 0,
          issue_count: 0,
          filesystem_path: '/tmp/evil',
          git_url: 'https://github_pat_AAA@github.com/o/r.git',
          beads_remote_url: 'https://ghp_BBB@dolthub.com/o/b.git',
          beads_remote_status: 'provisioned',
        },
      ],
    });
    const route = harness.find('GET', '/api/registry/projects');
    await route.handle(makeCtx('/api/registry/projects'));

    const [, , body] = harness.sendJson.mock.calls[0]!;
    assertNoCredentialsInBody(body);
  });
});
