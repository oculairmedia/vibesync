import http from 'node:http';

import { logger } from '../logger';
import { registerFormulaRoutes } from './routes/formulas.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOpenApiRoutes } from './routes/openapi.js';
import { registerProjectRoutes } from './routes/projects.js';
import { sseManager } from './SSEManager.js';
import type { SyncDatabase } from '../registry/registry.js';
import type { App, DoltHubProvisionerApi, HandleContext, OrchestrationApi, ProjectRegistryApi, RouteContext } from '../types/api.js';

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk ?? ''); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: http.ServerResponse, statusCode: number, message: string, details?: Record<string, unknown>): void {
  sendJson(res, statusCode, { error: message, statusCode, timestamp: new Date().toISOString(), ...(details ? { details } : {}) });
}

export interface ApiServerDeps {
  db: SyncDatabase;
  projectRegistry: ProjectRegistryApi | null;
  doltHubProvisioner: DoltHubProvisionerApi | null;
  orchestration: OrchestrationApi | null;
  port?: number;
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const port = deps.port ?? Number.parseInt(process.env.HEALTH_PORT || '3099', 10);
  type Route = { match: (ctx: RouteContext) => boolean; handle: (ctx: HandleContext) => Promise<void> };
  const routes: Route[] = [];
  const app: App = { registerRoute(route) { routes.push(route); } };
  const startedAt = Date.now();

  registerHealthRoutes(app, { startedAt, orchestrationReady: () => deps.orchestration !== null, sendJson });
  registerProjectRoutes(app, {
    db: deps.db, projectRegistry: deps.projectRegistry, doltHubProvisioner: deps.doltHubProvisioner,
    parseJsonBody, sendJson, sendError, logger,
  });
  registerFormulaRoutes(app, { orchestration: deps.orchestration, sseManager, parseJsonBody, sendJson, sendError, logger } as never);
  registerOpenApiRoutes(app, { sendJson } as never);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const method = req.method || 'GET';
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      const context: HandleContext & RouteContext = { req, res, url, pathname: url.pathname, method };
      const route = routes.find((candidate) => candidate.match(context));
      if (route) { await route.handle(context); return; }
      sendError(res, 404, 'Endpoint not found', { path: url.pathname, method });
    } catch (error) {
      logger.error({ err: error }, 'Unhandled error in API server');
      sendError(res, 500, 'Internal server error', { error: (error as Error).message });
    }
  });

  server.listen(port, () => { logger.info({ port }, 'API server running'); });
  server.on('close', () => { sseManager.closeAll(); });
  return server;
}
