import type { App, SendJson } from '../../types/api.js';

interface HealthDeps {
  startedAt: number;
  orchestrationReady: () => boolean;
  sendJson: SendJson;
}

/** Liveness plus whether the molecule engine booted. */
export function registerHealthRoutes(app: App, deps: HealthDeps): void {
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/health' && method === 'GET',
    handle: async ({ res }) => {
      const uptimeMs = Date.now() - deps.startedAt;
      const memory = process.memoryUsage();
      deps.sendJson(res, 200, {
        status: 'healthy',
        service: 'vibesync',
        uptime: { milliseconds: uptimeMs, seconds: Math.floor(uptimeMs / 1000) },
        orchestration: { ready: deps.orchestrationReady() },
        memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      });
    },
  });
}
