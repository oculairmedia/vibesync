import { describe, it, expect, vi } from 'vitest';

import { registerProjectRoutes } from '../../src/api/routes/projects.js';
import type {
  App,
  BeadsAdapterApi,
  BeadsIssueMirrorApi,
  HandleContext,
  RouteContext,
  RouteDb,
} from '../../src/types/api.js';
import type { ProjectRow, IssueRow } from '../../src/types/db.js';

type Handler = (ctx: HandleContext) => Promise<void>;

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => silentLogger(),
  };
}

function captureWorkItemsHandler(routes: { match: (ctx: RouteContext) => boolean; handle: Handler }[]): Handler {
  const route = routes.find((r) =>
    r.match({ pathname: '/api/projects/letta-mobile/work-items', method: 'GET' }),
  );
  if (!route) throw new Error('work-items route not registered');
  return route.handle;
}

interface InvokeOpts {
  db: RouteDb | null;
  beadsAdapter?: BeadsAdapterApi | null;
  beadsIssueMirror?: BeadsIssueMirrorApi | null;
  projectId: string;
  search?: string;
}

async function invokeWorkItems(opts: InvokeOpts): Promise<{ code: number; body: Record<string, unknown> }> {
  const routes: { match: (ctx: RouteContext) => boolean; handle: Handler }[] = [];
  const app: App = {
    registerRoute: (r) => {
      routes.push(r);
    },
  };

  let captured: { code: number; body: Record<string, unknown> } | null = null;
  const sendJson = (_res: unknown, code: number, body: unknown) => {
    captured = { code, body: body as Record<string, unknown> };
  };
  const sendError = (_res: unknown, code: number, message: string, details?: Record<string, unknown>) => {
    captured = { code, body: { error: message, ...(details ?? {}) } };
  };

  registerProjectRoutes(app, {
    db: opts.db,
    config: {},
    parseJsonBody: async () => ({}),
    sendJson: sendJson as never,
    sendError: sendError as never,
    logger: silentLogger() as never,
    projectRegistry: null,
    doltHubProvisioner: null,
    beadsIssueService: null,
    beadsAdapter: opts.beadsAdapter ?? null,
    ...(opts.beadsIssueMirror !== undefined ? { beadsIssueMirror: opts.beadsIssueMirror } : {}),
  } as never);

  const handler = captureWorkItemsHandler(routes);
  const search = opts.search ? `?${opts.search}` : '';
  const url = new URL(`http://test/api/projects/${opts.projectId}/work-items${search}`);

  await handler({
    req: {} as never,
    res: {} as never,
    url,
    pathname: `/api/projects/${opts.projectId}/work-items`,
  });

  if (!captured) throw new Error('handler did not respond');
  return captured;
}

const baseProject: ProjectRow = {
  identifier: 'letta-mobile',
  name: 'Letta Mobile',
  filesystem_path: '/tmp/letta-mobile',
  last_sync_at: new Date('2026-05-01T12:00:00.000Z').getTime(),
  status: 'active',
  issue_count: 3,
} as ProjectRow;

const beadsIssues = [
  { id: 'lm-1', identifier: 'lm-1', title: 'Ready', status: 'open', priority: 'high', updatedAt: '2026-05-10T00:00:00.000Z' },
  { id: 'lm-2', identifier: 'lm-2', title: 'In flight', status: 'in_progress', priority: 'medium', updatedAt: '2026-05-11T00:00:00.000Z' },
  { id: 'lm-3', identifier: 'lm-3', title: 'Done', status: 'closed', priority: 'low', updatedAt: '2026-05-12T00:00:00.000Z' },
];

describe('GET /api/projects/:id/work-items', () => {
  it('returns 404 when project missing', async () => {
    const db: RouteDb = {
      getProject: () => null,
      getAllProjects: () => [],
      getProjectIssues: () => [],
      getIssue: () => null,
    };
    const result = await invokeWorkItems({ db, projectId: 'missing' });
    expect(result.code).toBe(404);
  });

  it('hydrates work items from Beads when local DB is empty', async () => {
    const db: RouteDb = {
      getProject: () => baseProject,
      getAllProjects: () => [],
      getProjectIssues: () => [],
      getIssue: () => null,
    };
    const beadsAdapter: BeadsAdapterApi = {
      listIssues: vi.fn(async () => ({ items: beadsIssues as never })),
    };
    const result = await invokeWorkItems({ db, beadsAdapter, projectId: 'letta-mobile' });

    expect(result.code).toBe(200);
    const body = result.body as { project_identifier: string; provider: string; work_items: unknown[]; data_freshness: Record<string, unknown>; etag: string };
    expect(body.project_identifier).toBe('letta-mobile');
    expect(body.provider).toBe('beads');
    expect(body.work_items).toHaveLength(3);
    expect(body.work_items[0]).toMatchObject({ id: 'lm-1', provider: 'beads', title: 'Ready' });
    expect((body.work_items[0] as { cursor: string }).cursor).toEqual(expect.any(String));
    expect(body.data_freshness.source).toBe('beads');
    expect(body.etag).toBe('letta-mobile:work-items:2026-05-01T12:00:00.000Z');
  });

  it('filters by status', async () => {
    const db: RouteDb = {
      getProject: () => baseProject,
      getAllProjects: () => [],
      getProjectIssues: () => beadsIssues as unknown as IssueRow[],
      getIssue: () => null,
    };
    const result = await invokeWorkItems({ db, projectId: 'letta-mobile', search: 'status=in_progress' });
    expect(result.code).toBe(200);
    const items = (result.body as { work_items: { id: string }[] }).work_items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('lm-2');
  });

  it('paginates with offset cursor', async () => {
    const db: RouteDb = {
      getProject: () => baseProject,
      getAllProjects: () => [],
      getProjectIssues: () => beadsIssues as unknown as IssueRow[],
      getIssue: () => null,
    };
    const first = await invokeWorkItems({ db, projectId: 'letta-mobile', search: 'limit=2' });
    const firstBody = first.body as { work_items: unknown[]; page: { next_cursor: string | null; has_more: boolean; total_known: number } };
    expect(firstBody.work_items).toHaveLength(2);
    expect(firstBody.page.has_more).toBe(true);
    expect(firstBody.page.total_known).toBe(3);
    expect(firstBody.page.next_cursor).toEqual(expect.any(String));

    const second = await invokeWorkItems({
      db,
      projectId: 'letta-mobile',
      search: `limit=2&cursor=${firstBody.page.next_cursor}`,
    });
    const secondBody = second.body as { work_items: { id: string }[]; page: { has_more: boolean; next_cursor: string | null } };
    expect(secondBody.work_items).toHaveLength(1);
    expect(secondBody.work_items[0]!.id).toBe('lm-3');
    expect(secondBody.page.has_more).toBe(false);
    expect(secondBody.page.next_cursor).toBeNull();
  });

  it('returns sanitized freshness error when DB read throws', async () => {
    const db: RouteDb = {
      getProject: () => baseProject,
      getAllProjects: () => [],
      getProjectIssues: () => {
        throw new Error('raw sql stack with secret token');
      },
      getIssue: () => null,
    };
    const result = await invokeWorkItems({ db, projectId: 'letta-mobile' });
    expect(result.code).toBe(200);
    const body = result.body as { work_items: unknown[]; data_freshness: Record<string, unknown> };
    expect(body.work_items).toEqual([]);
    expect(body.data_freshness.status).toBe('error');
    expect(body.data_freshness.error).toBe('Work item data is temporarily unavailable');
    expect(JSON.stringify(body.data_freshness)).not.toContain('secret');
  });

  it('ensures freshness via the mirror when available', async () => {
    const ensureFresh = vi.fn(async () => ({ source: 'incremental' as const, error: null, changed: 1, durationMs: 5 }));
    const db: RouteDb = {
      getProject: () => baseProject,
      getAllProjects: () => [],
      getProjectIssues: () => beadsIssues as unknown as IssueRow[],
      getIssue: () => null,
    };
    const beadsIssueMirror: BeadsIssueMirrorApi = { ensureFresh };
    const result = await invokeWorkItems({ db, projectId: 'letta-mobile', beadsIssueMirror });
    expect(result.code).toBe(200);
    expect(ensureFresh).toHaveBeenCalledWith('letta-mobile');
    expect((result.body as { data_freshness: { source: string } }).data_freshness.source).toBe('mirror');
  });
});
