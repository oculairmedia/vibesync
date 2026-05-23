import http from 'node:http';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import { formatDuration } from './utils';
import { getPoolStats } from './http';
import { logger } from './logger';
import { auditRigs, summarizeRigHealth, type RigHealthSummary } from './rig/provisioner.js';

const register = new Registry();

const STACKS_DIR = process.env.STACKS_DIR || '/opt/stacks';
const RIG_CACHE_TTL_MS = 5 * 60_000;
let rigHealthCache: { summary: RigHealthSummary; updatedAt: number } | null = null;
let previousDegradedSet: Set<string> = new Set();

function getRigHealth(): RigHealthSummary {
  const now = Date.now();
  if (rigHealthCache && now - rigHealthCache.updatedAt < RIG_CACHE_TTL_MS) {
    return rigHealthCache.summary;
  }
  try {
    const statuses = auditRigs(STACKS_DIR);
    const summary = summarizeRigHealth(statuses);
    rigHealthCache = { summary, updatedAt: now };
    return summary;
  } catch (err) {
    logger.warn({ err }, 'Rig health audit failed');
    return rigHealthCache?.summary ?? { total: 0, healthy: 0, degraded: 0, noRig: 0, degradedProjects: [] };
  }
}

export type RigDegradationCallback = (data: { degradedProjects: string[]; newlyDegraded: string[]; total: number; healthy: number; degraded: number }) => void;

let rigDegradationCallback: RigDegradationCallback | null = null;
let rigDegradationTimer: ReturnType<typeof setInterval> | null = null;

export function onRigDegradation(cb: RigDegradationCallback): void {
  rigDegradationCallback = cb;
}

export function startRigDegradationWatch(intervalMs = 5 * 60_000): void {
  if (rigDegradationTimer) return;
  rigDegradationTimer = setInterval(() => checkRigDegradation(), intervalMs);
}

export function stopRigDegradationWatch(): void {
  if (rigDegradationTimer) { clearInterval(rigDegradationTimer); rigDegradationTimer = null; }
}

function checkRigDegradation(): void {
  const summary = getRigHealth();
  const currentSet = new Set(summary.degradedProjects);
  const newlyDegraded = summary.degradedProjects.filter(p => !previousDegradedSet.has(p));

  if (newlyDegraded.length > 0 && rigDegradationCallback) {
    rigDegradationCallback({
      degradedProjects: summary.degradedProjects,
      newlyDegraded,
      total: summary.total,
      healthy: summary.healthy,
      degraded: summary.degraded,
    });
  }

  previousDegradedSet = currentSet;
}

export interface HealthStats {
  startTime: number;
  lastSyncTime: number | null;
  lastSyncDuration: number | null;
  syncCount: number;
  errorCount: number;
  lastError: { message: string; timestamp: number } | null;
  bookstack?: { enabled: boolean };
}

export interface HealthConfig {
  sync: {
    interval: number;
    apiDelay: number;
    parallel: boolean;
    maxWorkers: number;
    dryRun: boolean;
  };
  letta: { enabled: boolean };
}

export const metrics = {
  syncRunsTotal: new Counter({ name: 'sync_runs_total', help: 'Total number of sync runs', labelNames: ['status'], registers: [register] }),
  syncDuration: new Histogram({ name: 'sync_duration_seconds', help: 'Sync run duration in seconds', buckets: [1, 5, 10, 30, 60, 120, 300, 600], registers: [register] }),
  hulyApiLatency: new Histogram({ name: 'huly_api_latency_seconds', help: 'API call latency in seconds', labelNames: ['operation'], buckets: [0.1, 0.5, 1, 2, 5, 10], registers: [register] }),
  projectsProcessed: new Gauge({ name: 'projects_processed', help: 'Number of projects processed in current sync', registers: [register] }),
  issuesSynced: new Gauge({ name: 'issues_synced', help: 'Number of issues synced in current sync', registers: [register] }),
  memoryUsageBytes: new Gauge({ name: 'memory_usage_bytes', help: 'Memory usage in bytes', labelNames: ['type'], registers: [register] }),
  connectionPoolActive: new Gauge({ name: 'connection_pool_active', help: 'Number of active connections in the pool', labelNames: ['protocol'], registers: [register] }),
  connectionPoolFree: new Gauge({ name: 'connection_pool_free', help: 'Number of free connections in the pool', labelNames: ['protocol'], registers: [register] }),
};

export function updateSystemMetrics(): void {
  const mem = process.memoryUsage();
  metrics.memoryUsageBytes.set({ type: 'rss' }, mem.rss);
  metrics.memoryUsageBytes.set({ type: 'heapUsed' }, mem.heapUsed);
  metrics.memoryUsageBytes.set({ type: 'heapTotal' }, mem.heapTotal);

  const poolStats = getPoolStats() as { http: { sockets: number; freeSockets: number }; https: { sockets: number; freeSockets: number } };
  metrics.connectionPoolActive.set({ protocol: 'http' }, poolStats.http.sockets);
  metrics.connectionPoolActive.set({ protocol: 'https' }, poolStats.https.sockets);
  metrics.connectionPoolFree.set({ protocol: 'http' }, poolStats.http.freeSockets);
  metrics.connectionPoolFree.set({ protocol: 'https' }, poolStats.https.freeSockets);
}

export function getHealthMetrics(healthStats: HealthStats, config: HealthConfig): Record<string, unknown> {
  const uptime = Date.now() - healthStats.startTime;
  return {
    status: 'healthy', service: 'vibesync', version: '1.0.0',
    uptime: { milliseconds: uptime, seconds: Math.floor(uptime / 1000), human: formatDuration(uptime) },
    sync: {
      lastSyncTime: healthStats.lastSyncTime ? new Date(healthStats.lastSyncTime).toISOString() : null,
      lastSyncDuration: healthStats.lastSyncDuration ? `${healthStats.lastSyncDuration}ms` : null,
      totalSyncs: healthStats.syncCount,
      errorCount: healthStats.errorCount,
      successRate: healthStats.syncCount > 0 ? `${(((healthStats.syncCount - healthStats.errorCount) / healthStats.syncCount) * 100).toFixed(2)}%` : 'N/A',
    },
    lastError: healthStats.lastError ? { message: healthStats.lastError.message, timestamp: new Date(healthStats.lastError.timestamp).toISOString(), age: formatDuration(Date.now() - healthStats.lastError.timestamp) } : null,
    config: { syncInterval: `${config.sync.interval / 1000}s`, apiDelay: `${config.sync.apiDelay}ms`, parallelSync: config.sync.parallel, maxWorkers: config.sync.maxWorkers, dryRun: config.sync.dryRun, lettaEnabled: !!config.letta.enabled },
    memory: { rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`, heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB` },
    connectionPool: getPoolStats(),
    bookstack: healthStats.bookstack || { enabled: false },
    rigs: getRigHealth(),
  };
}

export function createHealthServer(healthStats: HealthStats, config: HealthConfig): http.Server {
  const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3099', 10);

  const server = http.createServer(async (req, res) => {
    updateSystemMetrics();
    if (req.url === '/health') {
      const health = getHealthMetrics(healthStats, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } else if (req.url === '/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(await register.metrics());
      } catch (error) {
        logger.error({ err: error }, 'Failed to generate Prometheus metrics');
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Vibesync Service\nHealth check: /health\nMetrics: /metrics');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(HEALTH_PORT, () => { logger.info({ port: HEALTH_PORT }, 'Health check and metrics endpoint running'); });
  return server;
}

export function initializeHealthStats(): HealthStats {
  return { startTime: Date.now(), lastSyncTime: null, lastSyncDuration: null, syncCount: 0, errorCount: 0, lastError: null };
}

export function recordSuccessfulSync(healthStats: HealthStats, duration: number): void {
  healthStats.lastSyncTime = Date.now();
  healthStats.lastSyncDuration = duration;
  healthStats.syncCount++;
  metrics.syncRunsTotal.inc({ status: 'success' });
  metrics.syncDuration.observe(duration / 1000);
}

export function recordFailedSync(healthStats: HealthStats, error: Error): void {
  healthStats.errorCount++;
  healthStats.lastError = { message: error.message, timestamp: Date.now() };
  metrics.syncRunsTotal.inc({ status: 'error' });
}

export function recordSyncStats(projectsCount: number, issuesCount: number): void {
  metrics.projectsProcessed.set(projectsCount);
  metrics.issuesSynced.set(issuesCount);
}

export function recordApiLatency(service: string, operation: string, durationMs: number): void {
  if (service === 'huly') {
    metrics.hulyApiLatency.observe({ operation }, durationMs / 1000);
  }
}

export function getMetricsRegistry(): Registry {
  return register;
}
