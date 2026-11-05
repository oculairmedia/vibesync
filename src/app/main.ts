#!/usr/bin/env node
/**
 * Vibesync: the molecule orchestration engine plus the small project registry
 * and HTTP surface its consumers use. Canonical work state lives in Beads/Dolt.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';

import { createApiServer } from './http/server';
import { portSweepScope, sweepAll as sweepBeadsPorts } from './registry/port-sweep/PortSweeper.js';
import { startPeriodicPortSweep } from './registry/port-sweep/startPeriodicPortSweep.js';
import { getConfigSummary, loadConfig } from './config';
import { createRegistry, type Registry } from './registry/registry';
import { createDoltHubProvisioningService } from './registry/dolthub-provisioning.js';
import { logger } from './logger';
import { bootOrchestrationPlane, releaseDoltAfterFailedBoot, type OrchestrationHandle } from '../engine/boot.js';
import { createBdProjectMemorySource } from '../engine/dispatcher/index.js';
import { BdVersionTooOldError, probeBdVersion } from '../engine/bd-version.js';
import { createCliRunner } from '../engine/scheduler/bd-adapters.js';
import { registryPmAgentLookup } from '../engine/pm-wake/waker.js';
import { DoltClient, defaultDoltBootDeps } from '../engine/store/index.js';
import { ProjectRegistry } from './registry/project-registry';
import { resolveFromAppRoot } from './runtimePaths';
import type { DoltHubProvisionerApi } from './types/api.js';

const config = loadConfig();
const DB_PATH = process.env.VIBESYNC_DB_PATH || resolveFromAppRoot('logs', 'sync-state.db');
export function parseShutdownGraceMs(raw: string | undefined, warn: (variable: string, value: string) => void): number {
  if (raw === undefined) return 20000;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  warn('VIBESYNC_SHUTDOWN_GRACE_MS', raw);
  return 20000;
}

const SHUTDOWN_GRACE_MS = parseShutdownGraceMs(process.env['VIBESYNC_SHUTDOWN_GRACE_MS'], (variable, value) => {
  logger.warn({ variable, value }, 'Invalid shutdown grace period; using default');
});
const MAX_BOOT_ATTEMPTS = Number.parseInt(process.env['ORCHESTRATION_BOOT_ATTEMPTS'] ?? '5', 10);

function openRegistry(): Registry {
  try {
    const db = createRegistry(DB_PATH);
    logger.info({ dbPath: DB_PATH }, 'Registry database initialized');
    return db;
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to initialize registry database, exiting');
    process.exit(1);
  }
}

/**
 * vibesync-52g: repair Beads/Dolt port collisions before anything connects to a
 * project's local Dolt server; otherwise a project can silently read another's
 * database after a host reboot. vibesync-1ue keeps sweeping afterwards.
 */
async function repairBeadsPorts(db: Registry): Promise<void> {
  try {
    const { registry, only } = portSweepScope(db);
    const report = await sweepBeadsPorts(registry, undefined, { apply: true, only });
    logger.info(
      { scanned: report.scanned, conflicts: report.conflicts.length, repaired: report.repairs.filter((r) => r.ok).length },
      'Beads/Dolt port-collision sweep complete',
    );
    for (const repair of report.repairs.filter((r) => !r.ok)) {
      logger.warn({ project: repair.project.identifier, oldPort: repair.oldPort, newPort: repair.newPort, err: repair.error }, 'Beads/Dolt port repair failed');
    }
  } catch (error) {
    logger.warn({ err: error }, 'Beads/Dolt port-collision sweep failed — proceeding without repair');
  }
  const intervalMs = Number.parseInt(process.env.VIBESYNC_PORT_SWEEP_INTERVAL_MS ?? '', 10);
  if (intervalMs === 0) {
    logger.info('Periodic Beads/Dolt port sweep disabled via VIBESYNC_PORT_SWEEP_INTERVAL_MS=0');
    return;
  }
  startPeriodicPortSweep({ listProjects: () => portSweepScope(db).registry, repairable: () => portSweepScope(db).only, logger, ...(intervalMs > 0 ? { intervalMs } : {}) });
}

function createProvisioner(db: Registry): DoltHubProvisionerApi | null {
  if (!config.doltHub.enabled && !config.doltHub.dryRun) return null;
  try {
    const { apiToken, ...doltHub } = config.doltHub;
    return createDoltHubProvisioningService({ config: { ...doltHub, ...(apiToken ? { apiToken } : {}) }, db, logger }) as unknown as DoltHubProvisionerApi;
  } catch (error) {
    logger.warn({ err: error }, 'DoltHub provisioning unavailable');
    return null;
  }
}

/** bd runner bound to the scheduled project's own Beads directory, resolved per call. */
function projectCli(db: Registry, binary: 'bd' | 'gh', actor: string) {
  return async (args: readonly string[]): Promise<string> => {
    const project = db.getProject(config.scheduler.projectIdentifier);
    const fsPath = project?.filesystem_path;
    if (binary === 'bd' && !fsPath) {
      throw new Error(`project "${config.scheduler.projectIdentifier}" has no filesystem_path`);
    }
    return createCliRunner({
      binary,
      ...(fsPath ? { cwd: fsPath } : {}),
      ...(binary === 'bd' ? { env: { BEADS_DIR: `${fsPath}/.beads`, BEADS_ACTOR: actor } } : {}),
    })(args);
  };
}

/**
 * vibesync-nl0l: a restart can race the Dolt fleet coming back up, so connect
 * resiliently and retry the whole plane boot with backoff.
 */
async function bootEngine(db: Registry): Promise<OrchestrationHandle | null> {
  if (process.env.ENABLE_ORCHESTRATION !== 'true') {
    logger.info('Orchestration plane disabled (ENABLE_ORCHESTRATION is not true)');
    return null;
  }
  const { RoleAgentBootstrapper } = await import('./letta/RoleAgentBootstrapper.js');
  const roleAgentBootstrapper = new RoleAgentBootstrapper({
    repo: { getRoleAgent: db.getRoleAgent.bind(db), upsertRoleAgent: db.upsertRoleAgent.bind(db) },
    defaultModel: process.env['VIBESYNC_ROLE_AGENT_MODEL'] ?? 'lmstudio/MiniMax-M3',
  });

  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt += 1) {
    let dolt: DoltClient | undefined;
    try {
      dolt = await DoltClient.connect({}, { ...defaultDoltBootDeps, log: (level, obj, msg) => logger[level](obj, msg) });
      const handle = await bootOrchestrationPlane({
        dolt,
        bdVersion: probeBdVersion,
        scheduler: {
          config: config.scheduler,
          logger,
          listPoolMembers: (projectIdentifier) =>
            db.listRoleAgents(projectIdentifier).map((row) => ({ agentId: row.agentId, role: row.roleName, lettaBaseUrl: row.lettaBaseUrl })),
          pmWake: { lookupAgentId: registryPmAgentLookup(db) },
          bd: projectCli(db, 'bd', 'vibesync-scheduler'),
          gh: projectCli(db, 'gh', 'vibesync-scheduler'),
        },
        waits: { config: config.waits, logger, bd: projectCli(db, 'bd', 'vibesync-waits') },
        // vibesync-9lzk.25: each step reads ITS project's codebase memories,
        // through that project's own checkout; memories never cross projects.
        projectMemory: createBdProjectMemorySource((projectIdentifier) => {
          const fsPath = db.getProject(projectIdentifier)?.filesystem_path;
          if (!fsPath) return null;
          return createCliRunner({ binary: 'bd', cwd: fsPath, env: { BEADS_DIR: `${fsPath}/.beads`, BEADS_ACTOR: 'vibesync-memory' } });
        }),
        providerRouting: {
          store: { getProjectProviderRouting: db.getProjectProviderRouting.bind(db) },
          roleAgentBootstrapper,
          roleAgentLookup: { getRoleAgent: db.getRoleAgent.bind(db) },
        },
      });
      logger.info({ provider: handle.provider.kind, attempt }, 'Orchestration plane initialized');
      return handle;
    } catch (error) {
      await releaseDoltAfterFailedBoot(dolt, false, {
        onCleanupError: (cleanupError) => logger.warn({ err: cleanupError, attempt }, 'Failed to close Dolt pool after boot failure'),
      });
      if (error instanceof BdVersionTooOldError) {
        logger.error({ err: error, bdVersionFound: error.found, bdVersionRequired: error.minimum }, 'Orchestration plane NOT started: bd is older than the required minimum');
        return null;
      }
      const lastAttempt = attempt >= MAX_BOOT_ATTEMPTS;
      logger.warn({ err: error, attempt, maxBootAttempts: MAX_BOOT_ATTEMPTS }, lastAttempt
        ? 'Failed to initialize orchestration plane after all attempts, continuing without it'
        : 'Failed to initialize orchestration plane, retrying with backoff');
      if (!lastAttempt) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2_000 * 2 ** (attempt - 1))));
    }
  }
  return null;
}

/** Stop the scheduler and in-flight work within a bounded grace period. */
function installShutdownHandlers(handle: OrchestrationHandle): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, 'Shutdown signal received, stopping orchestration plane');
    const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS).unref());
    void Promise.race([handle.shutdown().then(() => 'done' as const), grace])
      .then((outcome) => {
        if (outcome === 'timeout') logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'Orchestration shutdown exceeded grace period, exiting anyway');
        else logger.info('Orchestration plane stopped cleanly');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Orchestration shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

async function main(): Promise<void> {
  logger.info({ config: getConfigSummary(config) }, 'Vibesync starting');
  const db = openRegistry();

  const projectRegistry = new ProjectRegistry({ db, logger });
  try {
    const scan = projectRegistry.scanProjects();
    logger.info({ discovered: scan.discovered, updated: scan.updated }, 'ProjectRegistry initial scan complete');
  } catch (error) {
    logger.warn({ err: error }, 'ProjectRegistry scan failed, continuing');
  }

  await repairBeadsPorts(db);
  const doltHubProvisioner = createProvisioner(db);
  const orchestration = await bootEngine(db);
  if (orchestration) installShutdownHandlers(orchestration);

  createApiServer({ db, projectRegistry, doltHubProvisioner, orchestration });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    logger.fatal({ err: error }, 'Fatal error, exiting');
    process.exit(1);
  });
}
