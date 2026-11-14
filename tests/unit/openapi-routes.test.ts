/**
 * The published API description (GET /openapi.json) must list exactly the routes
 * the server handles. Until this test, it listed 17 routes removed in the
 * 2026-11-04 cleanup (issues, stats, metrics, agents, ...) and left out the
 * formula and molecule routes, so /docs advertised calls that returned 404.
 *
 * The real route table is built by the same register*Routes functions
 * createApiServer uses, with inert dependencies: only each route's `match`
 * predicate is used, and no handler runs.
 */
import { describe, expect, it } from 'vitest';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { registry } from '../../src/app/http/openapi/registry.js';
import '../../src/app/http/openapi/routes.js';
import { registerFormulaRoutes } from '../../src/app/http/routes/formulas.js';
import { registerHealthRoutes } from '../../src/app/http/routes/health.js';
import { registerOpenApiRoutes } from '../../src/app/http/routes/openapi.js';
import { registerProjectRoutes } from '../../src/app/http/routes/projects.js';
import type { App, RouteContext } from '../../src/app/types/api.js';

type Matcher = (ctx: RouteContext) => boolean;

function realRouteMatchers(): Matcher[] {
  const matchers: Matcher[] = [];
  const app: App = { registerRoute: (route) => { matchers.push(route.match); } };
  const inert = (() => undefined) as never;
  registerHealthRoutes(app, { startedAt: 0, orchestrationReady: () => false, sendJson: inert });
  registerProjectRoutes(app, { db: null, projectRegistry: null, doltHubProvisioner: null, parseJsonBody: inert, sendJson: inert, sendError: inert, logger: console } as never);
  registerFormulaRoutes(app, { orchestration: null, sseManager: null, parseJsonBody: inert, sendJson: inert, sendError: inert, logger: console } as never);
  registerOpenApiRoutes(app, { sendJson: inert } as never);
  return matchers;
}

/** Every documented method and path, with each `{param}` filled by a sample value. */
function documentedRoutes(): { method: string; path: string; sample: string }[] {
  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0', info: { title: 't', version: '0' } });
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m) => ({ method: m.toUpperCase(), path, sample: path.replace(/\{[^}]+\}/g, 'sample-id') })));
}

const handled = (matchers: Matcher[], method: string, pathname: string) => matchers.some((match) => match({ method, pathname }));

describe('API description matches the routes the server handles', () => {
  const matchers = realRouteMatchers();
  const documented = documentedRoutes();

  it('every documented route has a handler', () => {
    const missing = documented.filter((r) => !handled(matchers, r.method, r.sample)).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('every handler is documented', () => {
    // One sample request per handler: the routes the server actually serves, as the clients call them.
    const served = [
      'GET /health',
      'GET /api/projects', 'GET /api/projects/p', 'GET /api/projects/p/beads-remote', 'POST /api/projects/p/beads-remote/provision',
      'POST /api/registry/projects', 'GET /api/registry/projects/p', 'PATCH /api/registry/projects/p', 'DELETE /api/registry/projects/p',
      'GET /api/registry/projects/p/role-agents', 'PUT /api/registry/projects/p/role-agents',
      'POST /api/sync/trigger',
      'GET /formulas', 'POST /formulas/f/run',
      'GET /molecules', 'GET /molecules/m', 'GET /molecules/m/trace', 'GET /molecules/m/events', 'POST /molecules/m/resume', 'DELETE /molecules/m',
      'GET /openapi.json', 'GET /docs',
    ];
    // The sample list itself must cover every handler: each matcher accepts at least one sample.
    const unsampled = matchers.filter((match) => !served.some((s) => { const [method, pathname] = s.split(' '); return match({ method: method!, pathname: pathname! }); }));
    expect(unsampled.length).toBe(0);
    const documentedAs = (method: string, pathname: string) =>
      documented.some((r) => r.method === method && new RegExp(`^${r.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(pathname));
    const undocumented = served.filter((s) => { const [method, pathname] = s.split(' '); return !documentedAs(method!, pathname!); });
    expect(undocumented).toEqual([]);
  });

  it('documents the orchestration token on the routes that check it', () => {
    const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0', info: { title: 't', version: '0' } });
    const secured = (method: string, path: string) => Boolean((doc.paths?.[path] as Record<string, { security?: unknown[] }>)?.[method]?.security?.length);
    expect(secured('post', '/formulas/{name}/run')).toBe(true);
    expect(secured('get', '/molecules/{id}')).toBe(true);
    expect(secured('get', '/formulas')).toBe(false);
    expect(secured('get', '/health')).toBe(false);
  });
});
