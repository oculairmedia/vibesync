/**
 * Admin route — POST /api/admin/agents-md/refresh
 *
 * Body: { projectId?: string, dryRun?: boolean }
 * Resp: { total, updated, dryRun, skipped, errors, results: [...] }
 *
 * Walks the project registry, re-renders AGENTS.md from the global
 * templates for each target project. Operators call this after editing
 * `templates/agents-md/<section>.md` to fan out the change immediately
 * instead of waiting for the next Letta agent persist.
 *
 * See AgentsMdRefreshService for the underlying logic.
 */

import { refreshAgentsMd, type AgentsMdRefreshDeps } from '../../AgentsMdRefreshService';

interface RouteContext {
  pathname: string;
  method: string;
}

interface HandleContext {
  req: unknown;
  res: unknown;
  url: URL;
}

interface App {
  registerRoute(opts: { match: (ctx: RouteContext) => boolean; handle: (ctx: HandleContext) => Promise<void> }): void;
}

export interface AgentsMdRouteDeps extends AgentsMdRefreshDeps {
  parseJsonBody: (req: unknown) => Promise<Record<string, unknown>>;
  sendJson: (res: unknown, code: number, data: unknown) => void;
  sendError: (res: unknown, code: number, message: string, details?: Record<string, unknown>) => void;
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export function registerAgentsMdRoutes(app: App, deps: AgentsMdRouteDeps): void {
  const { parseJsonBody, sendJson, sendError, logger } = deps;

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/admin/agents-md/refresh' && method === 'POST',
    handle: async ({ req, res }) => {
      if (!deps.db) {
        sendError(res, 503, 'Database not available');
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await parseJsonBody(req)) ?? {};
      } catch (err) {
        sendError(res, 400, 'Invalid JSON body', { error: (err as Error).message });
        return;
      }
      const projectId = typeof body['projectId'] === 'string' ? (body['projectId'] as string) : undefined;
      const dryRun = body['dryRun'] === true;
      try {
        const summary = await refreshAgentsMd(deps, {
          ...(projectId !== undefined ? { projectId } : {}),
          dryRun,
        });
        logger.info(
          { total: summary.total, updated: summary.updated, errors: summary.errors, projectId, dryRun },
          'AGENTS.md refresh endpoint completed',
        );
        sendJson(res, 200, summary);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'AGENTS.md refresh endpoint failed');
        sendError(res, 500, 'AGENTS.md refresh failed', { error: (err as Error).message });
      }
    },
  });
}
