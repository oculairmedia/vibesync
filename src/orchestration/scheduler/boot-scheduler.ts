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
import { FilePmWakeStateStore, type PmWakeStateStore } from './pm-wake-state.js';
import { LoggingPmWakeSink, PmWaker, type PmWakeSink } from './pm-waker.js';
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
  /** owner/repo slugs the refinery may enqueue/merge (vibesync-5c8y). Required non-empty when autoMerge. */
  readonly allowedRepos: readonly string[];
  /**
   * Minimum spacing (ms) between event-triggered ticks (vibesync-p489).
   * Optional here so hand-built configs keep working; defaults to 5000.
   */
  readonly eventDebounceMs?: number;
  /**
   * PM wake policy (vibesync-2bgv). Absent or `enabled:false` => no PmWaker is
   * constructed (layering invariant 4): no timers, no state file.
   */
  readonly pmWake?: {
    readonly enabled: boolean;
    readonly minIntervalMs: number;
    readonly backstopMs: number;
    readonly statePath: string;
  };
  /**
   * Wall-clock deadline (ms) for a started run (vibesync-izn3); 0 = none.
   * Optional here so hand-built configs keep working; defaults to 1 hour.
   */
  readonly runDeadlineMs?: number;
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
  /**
   * PM wake seams (vibesync-2bgv); used only when `config.pmWake.enabled`.
   * `lookupAgentId` is the projects-registry lookup (production wires
   * `db.getProject(id)?.letta_agent_id`). `sink` defaults to a logging sink; the
   * Iroh-backed sink (vibesync-x38j) plugs in here. `store` defaults to the JSON
   * file at `config.pmWake.statePath`.
   */
  readonly pmWake?: {
    readonly lookupAgentId: (projectIdentifier: string) => string | null | undefined;
    readonly sink?: PmWakeSink;
    readonly store?: PmWakeStateStore;
    readonly now?: () => number;
  };
  /** Test seam: pack loader. Default loads `config.packDir` under the app root. */
  readonly loadPack?: (packRoot: string) => Pack;
  /** Directory relative `packDir` resolves against. Default: VIBESYNC_APP_ROOT or cwd. */
  readonly appRoot?: string;
}

export interface SchedulerHandle {
  readonly daemon: SchedulerDaemon;
  /** The PM waker, or null when `scheduler.pmWake.enabled` is false (vibesync-2bgv). */
  readonly pmWaker: PmWaker | null;
  /** Stop the interval and await any in-flight tick. Idempotent. */
  stop(): Promise<void>;
}

export const SCHEDULER_TICK_EVENT = 'daemon/scheduler.tick';
export const SCHEDULER_STARTED_EVENT = 'daemon/scheduler.started';
export const SCHEDULER_STOPPED_EVENT = 'daemon/scheduler.stopped';
export const SCHEDULER_START_FAILED_EVENT = 'daemon/scheduler.start_failed';

/**
 * Bead status transition, payload `{ issueId, from, to }` (vibesync-p489).
 * The scheduler SUBSCRIBES to this; nothing in the repo emits it yet — the
 * producer (bd -> bus) is a separate bead. A `to` of ready|in_progress|closed
 * requests an immediate (debounced) tick; any other status is ignored.
 */
export const BEADS_ISSUE_STATUS_CHANGED_EVENT = 'beads/issue.status_changed';

/** Target statuses of `beads/issue.status_changed` that trigger a tick. */
export const TICK_TRIGGER_BEAD_STATUSES: ReadonlySet<string> = new Set(['ready', 'in_progress', 'closed']);

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
    if (config.allowedRepos.length === 0) {
      throw new Error('scheduler.autoMerge=true requires at least one scheduler.allowedRepos owner/repo');
    }
    github = new GhCliGitHubPort(opts.gh, config.allowedRepos);
    logger?.warn?.({ requiredChecks: config.requiredChecks, allowedRepos: config.allowedRepos }, 'scheduler: AUTO-MERGE ENABLED — refinery may merge PRs that pass all gates');
  }

  const escalationManager = new EscalationManager({
    store: new BdCommentEscalationStore(opts.bd),
    transport: opts.notification ?? createLogNotificationTransport(logger),
    ...(logger ? { logger } : {}),
  });
  // vibesync-2bgv: PM waker. Constructed ONLY when scheduler.pmWake.enabled.
  let pmWaker: PmWaker | null = null;
  if (config.pmWake?.enabled) {
    if (!opts.pmWake) {
      logger?.warn?.({ project: config.projectIdentifier }, 'pm-wake: enabled but no PM registry lookup supplied — PM wake not started');
    } else {
      const pw = config.pmWake;
      pmWaker = new PmWaker({
        projectIdentifier: config.projectIdentifier,
        lookupAgentId: opts.pmWake.lookupAgentId,
        sink: opts.pmWake.sink ?? new LoggingPmWakeSink(logger),
        store: opts.pmWake.store ?? new FilePmWakeStateStore(pw.statePath, logger),
        backlog: () => daemon.backlogSnapshot(),
        emit: (kind, payload) => bus.emit({ layer: 'daemon', kind, payload }),
        minIntervalMs: pw.minIntervalMs,
        backstopMs: pw.backstopMs,
        ...(opts.pmWake.now ? { now: opts.pmWake.now } : {}),
        ...(logger ? { logger } : {}),
      });
    }
  }
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
    allowedRepos: config.allowedRepos,
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
      onRepeatedRecovery: (i) => {
        pmWaker?.noteStall(i.workBeadId, `slot ${i.slotId} recovered ${i.recoveries}x (${i.reason})`);
        return escalateSafely(i.workBeadId, `slot ${i.slotId} recovered ${i.recoveries}x (${i.reason})`, i.slotId);
      },
      onBlocked: (i) => escalateSafely(i.workBeadId, i.summary, i.runId),
    },
    config: () => ({ poolSize: effectivePoolSize, batchSize: config.batchSize, paused: config.paused }),
    ...(config.eventDebounceMs !== undefined ? { eventDebounceMs: config.eventDebounceMs } : {}),
    ...(config.runDeadlineMs !== undefined ? { runDeadlineMs: config.runDeadlineMs } : {}),
    ...(logger ? { logger } : {}),
    ...(pmWaker
      ? {
          // Webhook / bead-status requests are the "new event for the project" wake reason.
          onTickRequested: (reason: string, detail: string | undefined) => {
            if (reason === 'webhook' || reason === 'bead-status') pmWaker?.noteEvent(reason, detail ?? '');
          },
          // A run cancelled at its deadline is a stall the PM should hear about.
          onRunExpired: (i: { workBeadId: string; deadlineMs: number; elapsedMs: number }) => {
            pmWaker?.noteStall(i.workBeadId, `run exceeded its deadline of ${i.deadlineMs}ms (${i.elapsedMs}ms)`);
          },
        }
      : {}),
    onTick: (report: DaemonTickReport) => {
      const { result } = report;
      const payload = {
        seq: report.seq,
        reason: report.reason,
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
      pmWaker?.onTick(report);
    },
  });

  daemon.run(config.intervalMs);
  // Trigger (b): bead status change -> immediate (debounced) tick. Layering
  // invariant 3: observed through the bus, never by polling bd.
  const unsubscribeStatus = bus.subscribe((event) => {
    if (event.kind !== BEADS_ISSUE_STATUS_CHANGED_EVENT) return;
    const to = event.payload?.['to'];
    if (typeof to === 'string' && TICK_TRIGGER_BEAD_STATUSES.has(to)) {
      const issueId = event.payload?.['issueId'];
      const from = event.payload?.['from'];
      daemon.requestTick('bead-status', `${typeof issueId === 'string' ? issueId : 'issue'} ${typeof from === 'string' ? from : '?'}->${to}`);
    }
  });
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
    pmWaker,
    stop(): Promise<void> {
      stopped ??= (async () => {
        unsubscribeStatus();
        await daemon.stop();
        pmWaker?.dispose();
        bus.emit({ layer: 'daemon', kind: SCHEDULER_STOPPED_EVENT, payload: { project: config.projectIdentifier } });
      })();
      return stopped;
    },
  };
}
