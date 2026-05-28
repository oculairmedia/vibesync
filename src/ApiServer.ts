import http from 'http';
import { URL } from 'url';
import { logger } from './logger';
import { getHealthMetrics, updateSystemMetrics, getMetricsRegistry } from './HealthService.js';
import type { HealthStats } from './HealthService.js';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerProjectRoutes } from './api/routes/projects.js';
import { registerConfigRoutes } from './api/routes/config.js';
import { registerSyncRoutes } from './api/routes/sync.js';
import { registerEventsRoutes } from './api/routes/events.js';
import { registerFilesRoutes } from './api/routes/files.js';
import { registerDocsRoutes } from './api/routes/docs.js';
import { registerTemporalRoutes } from './api/routes/temporal.js';
import { registerAgentRoutes } from './api/routes/agents.js';
import { registerAgentsMdRoutes } from './api/routes/agentsMd.js';
import { registerFormulaRoutes } from './api/routes/formulas.js';
import { registerOpenApiRoutes } from './api/routes/openapi.js';
import { sseManager } from './api/SSEManager.js';
import { syncHistory } from './api/SyncHistoryStore.js';
import { ConfigurationHandler } from './api/ConfigurationHandler.js';
import { createProjectMcpServer } from './mcp/ProjectMcpServer.js';
import { registerMeridianTools } from './mcp/MeridianTools.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SyncDatabase } from './database.js';
import type {
  App,
  BeadsAdapterApi,
  BeadsIssueMirrorApi,
  BeadsIssueServiceApi,
  DoltHubProvisionerApi,
  HandleContext,
  OrchestrationApi,
  ProjectRegistryApi,
  RouteContext,
} from './types/api.js';

export { sseManager, syncHistory };

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += (chunk || '').toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: http.ServerResponse, statusCode: number, message: string, details: Record<string, unknown> | null = null): void {
  const error: Record<string, unknown> = { error: message, statusCode, timestamp: new Date().toISOString() };
  if (details) error.details = details;
  sendJson(res, statusCode, error);
}

interface ApiServerDeps {
  config: Record<string, unknown>;
  healthStats: HealthStats;
  db: SyncDatabase | null;
  onSyncTrigger: ((projectId: string | null) => Promise<void>) | null;
  onConfigUpdate: ((updates: Record<string, unknown>) => void) | null;
  webhookHandler?: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null;
  getTemporalClient?: (() => Promise<unknown>) | null;
  codePerceptionWatcher?: Record<string, unknown> | null;
  projectRegistry?: ProjectRegistryApi | null;
  doltHubProvisioner?: DoltHubProvisionerApi | null;
  beadsIssueService?: BeadsIssueServiceApi | null;
  beadsAdapter?: BeadsAdapterApi | null;
  beadsIssueMirror?: BeadsIssueMirrorApi | null;
  orchestration?: OrchestrationApi | null;
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3099', 10);
  const configHandler = new (ConfigurationHandler as unknown as new (...args: unknown[]) => ConfigurationHandler)(deps.config, deps.onConfigUpdate, { sseManager, parseJsonBody, sendJson, sendError });

  interface Route { match: (ctx: RouteContext) => boolean; handle: (ctx: HandleContext) => Promise<void> }
  const routes: Route[] = [];
  const app: App = { registerRoute(route: Route) { routes.push(route); } };

  const routeDeps = { ...deps, configHandler, sseManager, syncHistory, getHealthMetrics, getMetricsRegistry, parseJsonBody, sendJson, sendError, logger };

  registerHealthRoutes(app, routeDeps as never);
  registerProjectRoutes(app, routeDeps as never);
  registerConfigRoutes(app, routeDeps as never);
  registerSyncRoutes(app, routeDeps as never);
  registerEventsRoutes(app, routeDeps as never);
  registerFilesRoutes(app, routeDeps as never);
  registerDocsRoutes(app);
  registerTemporalRoutes(app, routeDeps as never);
  registerAgentRoutes(app, routeDeps as never);
  registerAgentsMdRoutes(app, routeDeps as never);
  registerFormulaRoutes(app, routeDeps as never);
  registerOpenApiRoutes(app, routeDeps as never);

  const mcpConfig = (deps.config as Record<string, Record<string, unknown>>)?.projectMcp || {};
  const mcpPath = (mcpConfig.path as string) || '/mcp';
  const mcpEnabled = mcpConfig?.enabled !== false;

  const server = http.createServer(async (req, res) => {
    try {
      updateSystemMetrics();
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
        });
        res.end();
        return;
      }

      if (mcpEnabled && pathname === mcpPath) {
        if (method === 'POST') {
          try {
            let body = '';
            for await (const chunk of req) body += (chunk || '').toString();
            const parsed = body ? JSON.parse(body) : {};
            const mcpServer = createProjectMcpServer({ db: deps.db as never, logger, registry: deps.projectRegistry as never });
            registerMeridianTools(mcpServer);
            const transport = new StreamableHTTPServerTransport({} as never);
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, parsed);
            res.on('close', () => { transport.close(); mcpServer.close(); });
          } catch (mcpError) {
            logger.error({ err: mcpError }, 'MCP request failed');
            if (!res.headersSent) {
              sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
            }
          }
          return;
        } else if (method === 'GET' || method === 'DELETE') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
          return;
        }
      }

      const context: HandleContext & RouteContext = { req, res, url, pathname, method };
      for (const route of routes) {
        if (route.match(context)) { await route.handle(context); return; }
      }

      sendError(res, 404, 'Endpoint not found', {
        path: pathname, method,
        availableEndpoints: [
          'GET /health', 'GET /metrics', 'GET /api/config', 'PATCH /api/config',
          'POST /api/sync/trigger', 'GET /api/sync/history', 'GET /api/sync/mappings',
          'GET /api/events', 'GET /api/events/stream', 'POST /webhook', 'GET /api/webhook/stats',
          'GET /api/temporal/schedule', 'POST /api/temporal/schedule/start',
          'POST /api/temporal/schedule/stop', 'PATCH /api/temporal/schedule',
          'POST /api/temporal/reconciliation/run', 'GET /api/temporal/workflows',
          'GET /api/agents', 'GET /api/agents/lookup?repo=<name>',
          'GET /api/projects', 'GET /api/projects/:id', 'GET /api/projects/:id/issues',
          'GET /api/projects/:id/ready-work', 'GET /api/projects/:id/work-items',
          'GET /api/projects/:id/issue-analytics', 'GET /api/issues/:id',
          'POST /api/issues/:id/claim', 'POST /api/issues/:id/unclaim',
          'POST /api/issues/:id/close', 'POST /api/issues/:id/reopen',
          'PATCH /api/issues/:id/status', 'POST /api/issues/:id/notes',
          'POST /api/registry/projects', 'GET /api/registry/projects/:id',
          'POST /api/projects/:id/beads-remote/provision', 'POST /api/admin/agents-md/refresh',
          'GET /formulas', 'POST /formulas/:name/run', 'GET /molecules/:id', 'GET /molecules/:id/trace',
          'POST /molecules/:id/resume', 'DELETE /molecules/:id', 'GET /molecules/:id/events',
          'GET /openapi.json', 'GET /docs',
          `POST ${mcpPath}`,
        ],
      });
    } catch (error) {
      logger.error({ err: error }, 'Unhandled error in API server');
      sendError(res, 500, 'Internal server error', { error: (error as Error).message });
    }
  });

  server.listen(HEALTH_PORT, () => { logger.info({ port: HEALTH_PORT, mcpEnabled, mcpPath }, 'API server running'); });
  server.on('close', () => { sseManager.closeAll(); logger.info('API server closed, all SSE connections terminated'); });
  return server;
}

export function broadcastSyncEvent(eventType: string, data: Record<string, unknown>): void {
  sseManager.broadcast(eventType, data);
  if (eventType.startsWith('sync:')) {
    syncHistory.addEvent({ type: eventType, ...data });
  }
}

export function recordIssueMapping(hulyIdentifier: string, vibeTaskId: string, metadata: Record<string, unknown> = {}): void {
  syncHistory.addMapping(hulyIdentifier, vibeTaskId, metadata);
}
