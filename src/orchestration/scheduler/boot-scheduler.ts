/**
 * Boot composition for the SchedulerDaemon (vibesync-z2ws).
 *
 * `startSchedulerDaemon` is the ONE place that turns a scheduler config section
 * plus injected adapters into a running SchedulerDaemon. It is called from
 * `bootOrchestrationPlane` and nowhere else, so the production path and the
 * tests exercise the same composition.
 *
 * Layering:
 *   - invariant 1: no database/HTTP imports. Pool members and the bd/gh CLIs
 *     arrive as injected interfaces (same pattern as `providerRouting.store`).
 *   - invariant 3: every tick is reported on the EventBus (`daemon/scheduler.tick`)
 *     as well as logged.
 *   - invariant 4: this module is only reached when `config.enabled` is true.
 *     When it is false NOTHING is constructed — no daemon, no timer, no bd call.
 *   - invariant 5: pool members are whatever `project_role_agents` rows exist
 *     for the project; no role name appears here.
 *
 * SAFETY (first production boot): the refinery is wired to `disabledGitHubPort`
 * — which throws on every call — unless `config.autoMerge === true` AND at least
 * one required check name is configured. With auto-merge off, a PR the daemon's
 * agents produce is NEVER merged by the daemon; the refinery isolates it and
 * the escalation sink records a bead comment. Escalations never send agent
 * messages (log + bead comment only).
 */

import path from 'node:path';

import type { EventBus } from '../events/index.js';
import type { FormulaDispatcher } from '../dispatcher/index.js';
import { loadPack, type Pack } from '../packs/index.js';
import type { PoolMemberIdentity } from './agent-pool.js';
import {
  BdCommentEscalationStore,
  BdFormulaResolver,
  BdLivenessProbe,
  BdReadyBeadSource,
  BdSlingContextStore,
  GhCliGitHubPort,
  createLogNotificationTransport,
  disabledGitHubPort,
  type CommandRunner,
} from './bd-adapters.js';
import { SchedulerDaemon, type DaemonLogger, type DaemonTickReport } from './daemon.js';
import { EscalationManager, type NotificationTransport } from './escalation.js';
import type { GitHubPort } from './refinery.js';

/** The `scheduler` config section (structurally identical to AppConfig['scheduler']). */
export interface SchedulerBootConfig {
  readonly enabled: boolean;
  readonly projectIdentifier: string;
  readonly intervalMs: number;
  readonly poolSize: number;
  readonly batchSize: number;
  readonly paused: boolean;
  readonly readyLabel: string;
  readonly formula: string;
  readonly packDir: string;
  readonly autoMerge: boolean;
  readonly requiredChecks: readonly string[];
}

export interface BootSchedulerOptions {
  readonly config: SchedulerBootConfig;
  /**
   * project_role_agents rows for the project → pool identities. The production
   * caller wires `(id) => db.listRoleAgents(id).map(...)`.
   */
  readonly listPoolMembers: (projectIdentifier: string) => readonly PoolMemberIdentity[];
  /** Runs `bd` against the scheduled project's beads database. */
  readonly bd: CommandRunner;
  /** Runs `gh`. Only used when `config.autoMerge` is true. */
  readonly gh?: CommandRunner;
  /** Escalation transport. Default: log only — no agent messages. */
  readonly notification?: NotificationTransport;
  readonly logger?: DaemonLogger;
  /** Test seam: pack loader. Default loads `config.packDir` under the app root. */
  readonly loadPack?: (packRoot: string) => Pack;
  /** Directory relative `packDir` resolves against. Default: VIBESYNC_APP_ROOT or cwd. */
  readonly appRoot?: string;
}

export interface SchedulerHandle {
  readonly daemon: SchedulerDaemon;
  /** Stop the interval and await any in-flight tick. Idempotent. */
  stop(): Promise<void>;
}

export const SCHEDULER_TICK_EVENT = 'daemon/scheduler.tick';
export const SCHEDULER_STARTED_EVENT = 'daemon/scheduler.started';
export const SCHEDULER_STOPPED_EVENT = 'daemon/scheduler.stopped';
export const SCHEDULER_START_FAILED_EVENT = 'daemon/scheduler.start_failed';

/**
 * Build and start the daemon. Throws on misconfiguration (unknown formula, no
 * pool members, auto-merge without required checks); the caller decides how to
 * surface that.
 */
export function startSchedulerDaemon(
  opts: BootSchedulerOptions & { readonly dispatcher: FormulaDispatcher; readonly bus: EventBus },
): SchedulerHandle {
  const { config, bus, logger } = opts;
  if (!config.enabled) {
    throw new Error('startSchedulerDaemon called with scheduler.enabled=false (caller must gate on config)');
  }

  // Pool identities come from project_role_agents; dedupe by agent id (AgentPool
  // requires unique ids) and cap at the configured pool size.
  const seen = new Set<string>();
  const members: PoolMemberIdentity[] = [];
  for (const m of opts.listPoolMembers(config.projectIdentifier)) {
    if (seen.has(m.agentId)) continue;
    seen.add(m.agentId);
    members.push(m);
    if (members.length >= config.poolSize) break;
  }
  if (members.length === 0) {
    throw new Error(
      `scheduler: no project_role_agents rows for project "${config.projectIdentifier}" — nothing to build a pool from`,
    );
  }
  if (members.length < config.poolSize) {
    logger?.warn?.(
      { configured: config.poolSize, available: members.length, project: config.projectIdentifier },
      'scheduler: fewer pool members than scheduler.poolSize — effective pool size reduced',
    );
  }
  const effectivePoolSize = members.length;

  const appRoot = opts.appRoot ?? process.env['VIBESYNC_APP_ROOT'] ?? process.cwd();
  const packRoot = path.isAbsolute(config.packDir) ? config.packDir : path.join(appRoot, config.packDir);
  const pack = (opts.loadPack ?? ((root: string) => loadPack(root, 'global')))(packRoot);

  const contextStore = new BdSlingContextStore(opts.bd);
  const readyBeads = new BdReadyBeadSource({
    bd: opts.bd,
    readyLabel: config.readyLabel,
    excludeWorkBeadIds: () => contextStore.listTerminalWorkBeadIds(),
  });
  const formulaResolver = new BdFormulaResolver({
    bd: opts.bd,
    pack,
    formulaName: config.formula,
    projectIdentifier: config.projectIdentifier,
  });

  let github: GitHubPort = disabledGitHubPort;
  if (config.autoMerge) {
    if (!opts.gh) throw new Error('scheduler.autoMerge=true but no gh command runner was supplied');
    if (config.requiredChecks.length === 0) {
      throw new Error('scheduler.autoMerge=true requires at least one scheduler.requiredChecks name');
    }
    github = new GhCliGitHubPort(opts.gh);
    logger?.warn?.({ requiredChecks: config.requiredChecks }, 'scheduler: AUTO-MERGE ENABLED — refinery may merge PRs that pass all gates');
  }

  const escalationManager = new EscalationManager({
    store: new BdCommentEscalationStore(opts.bd),
    transport: opts.notification ?? createLogNotificationTransport(logger),
    ...(logger ? { logger } : {}),
  });
  const escalateSafely = async (workBeadId: string, summary: string, runId: string): Promise<void> => {
    try {
      await escalationManager.escalate({ workBeadId, runId, summary });
    } catch (err) {
      logger?.warn?.(
        { workBeadId, error: err instanceof Error ? err.message : String(err) },
        'scheduler: escalation failed',
      );
    }
  };

  const daemon = new SchedulerDaemon({
    dispatcher: opts.dispatcher,
    formulaResolver,
    readyBeads,
    contextStore,
    poolMembers: members,
    github,
    requiredCheckNames: () => config.requiredChecks,
    livenessProbe: new BdLivenessProbe(opts.bd),
    escalation: {
      onIsolated: async (i) => {
        if (!config.autoMerge) {
          // Auto-merge is off: every agent-produced PR is "isolated" by design.
          // That is the expected hand-off to human review, not an escalation —
          // log it, do not post a NEEDS-MERIDIAN-DECISION marker per PR.
          logger?.info?.(
            { workBeadId: i.workBeadId, repo: i.repo, prNumber: i.prNumber },
            'scheduler: PR left for human review (scheduler.autoMerge is off)',
          );
          return;
        }
        await escalateSafely(i.workBeadId, `PR ${i.repo}#${i.prNumber} not auto-merged: ${i.failure.gate} — ${i.failure.detail}`, `pr-${i.prNumber}`);
      },
      onRepeatedRecovery: (i) =>
        escalateSafely(i.workBeadId, `slot ${i.slotId} recovered ${i.recoveries}x (${i.reason})`, i.slotId),
      onBlocked: (i) => escalateSafely(i.workBeadId, i.summary, i.runId),
    },
    config: () => ({ poolSize: effectivePoolSize, batchSize: config.batchSize, paused: config.paused }),
    repoFor: () => '',
    ...(logger ? { logger } : {}),
    onTick: (report: DaemonTickReport) => {
      const { result } = report;
      const payload = {
        seq: report.seq,
        durationMs: report.durationMs,
        startedAt: report.startedAt,
        project: config.projectIdentifier,
        skippedReason: result.scheduler.skippedReason ?? null,
        dispatched: result.scheduler.dispatched.length,
        failed: result.scheduler.failed.length,
        circuitBroken: result.scheduler.circuitBroken.length,
        merged: result.merged.length,
        recovered: result.recovered.length,
      };
      bus.emit({ layer: 'daemon', kind: SCHEDULER_TICK_EVENT, payload });
      logger?.info?.(payload, 'SchedulerDaemon tick');
    },
  });

  daemon.run(config.intervalMs);
  bus.emit({
    layer: 'daemon',
    kind: SCHEDULER_STARTED_EVENT,
    payload: {
      project: config.projectIdentifier,
      intervalMs: config.intervalMs,
      poolSize: effectivePoolSize,
      batchSize: config.batchSize,
      paused: config.paused,
      autoMerge: config.autoMerge,
      formula: config.formula,
    },
  });

  let stopped: Promise<void> | null = null;
  return {
    daemon,
    stop(): Promise<void> {
      stopped ??= (async () => {
        await daemon.stop();
        bus.emit({ layer: 'daemon', kind: SCHEDULER_STOPPED_EVENT, payload: { project: config.projectIdentifier } });
      })();
      return stopped;
    },
  };
}
