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
  BdFormulaResolver,
  BdLivenessProbe,
  BdReadyBeadSource,
  BdSlingContextStore,
  type CommandRunner,
} from './bd-adapters.js';
import { BdCommentEscalationStore, createLogNotificationTransport } from '../escalation/bd-store.js';
import { GhCliGitHubPort, disabledGitHubPort } from '../refinery/github.js';
import { createInboxWakeSink, type InboxMessageAdapter } from '../pm-wake/inbox-sink.js';
import { SchedulerDaemon, type DaemonLogger, type DaemonTickReport } from './daemon.js';
import type { StepDispatcher } from './step-dispatcher.js';
import { EscalationManager, type NotificationTransport } from '../escalation/escalation.js';
import { FilePmWakeStateStore, type PmWakeStateStore } from '../pm-wake/state.js';
import { BdPendingWakeStore } from '../pm-wake/pending-store.js';
import type { InboxCliOptions } from '../pm-wake/inbox-cli-adapter.js';
import { LoggingPmWakeSink, PmWaker, type PmWakeSink } from '../pm-wake/waker.js';
import type { GitHubPort } from '../refinery/refinery.js';

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
    /** 'log' (default) or receiver-routed 'inbox'. */
    readonly sink?: 'log' | 'inbox';
    readonly cli?: InboxCliOptions | undefined;
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
    readonly inboxAdapter?: InboxMessageAdapter;
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

export { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../events/beads.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../events/beads.js';


/** Target statuses of `beads/issue.status_changed` that trigger a tick. */
export const TICK_TRIGGER_BEAD_STATUSES: ReadonlySet<string> = new Set(['ready', 'in_progress', 'closed']);

export type { InboxMessageAck, InboxMessageAdapter } from '../pm-wake/inbox-sink.js';
export { normalizeInboxWakeAck } from '../pm-wake/inbox-sink.js';

type StartOptions = BootSchedulerOptions & {
  readonly dispatcher: FormulaDispatcher;
  readonly bus: EventBus;
  /** Ready-step source (vibesync-efee); ticked by the daemon, woken by its requestTick. */
  readonly steps?: StepDispatcher;
};

export function startSchedulerDaemon(opts: StartOptions): SchedulerHandle {
  const { config, bus, logger } = opts;
  if (!config.enabled) {
    throw new Error('startSchedulerDaemon called with scheduler.enabled=false (caller must gate on config)');
  }

  const members = selectPoolMembers(opts);
  const effectivePoolSize = members.length;
  const pack = loadSchedulerPack(opts);

  const contextStore = new BdSlingContextStore(opts.bd);
  const readyBeads = new BdReadyBeadSource({
    bd: opts.bd,
    readyLabel: config.readyLabel,
    excludeWorkBeadIds: () => contextStore.listTerminalWorkBeadIds(),
    ...(logger ? { logger } : {}),
  });
  const formulaResolver = new BdFormulaResolver({
    bd: opts.bd,
    pack,
    formulaName: config.formula,
    projectIdentifier: config.projectIdentifier,
    ...(logger ? { logger } : {}),
  });
  const github = selectGitHubPort(opts);

  const escalationManager = new EscalationManager({
    store: new BdCommentEscalationStore(opts.bd),
    transport: opts.notification ?? createLogNotificationTransport(logger),
    ...(logger ? { logger } : {}),
  });
  // The waker reads the daemon's backlog, and the daemon reports to the waker:
  // the daemon is assigned below, before either can call the other.
  let daemon!: SchedulerDaemon;
  const pmWaker = buildPmWaker(opts, () => daemon.backlogSnapshot());
  const escalateSafely = safeEscalator(escalationManager, logger);

  daemon = new SchedulerDaemon({
    dispatcher: opts.dispatcher,
    ...(opts.steps ? { steps: opts.steps } : {}),
    formulaResolver,
    readyBeads,
    contextStore,
    poolMembers: members,
    github,
    allowedRepos: config.allowedRepos,
    requiredCheckNames: () => config.requiredChecks,
    livenessProbe: new BdLivenessProbe(opts.bd),
    escalation: escalationHooks(config, pmWaker, escalateSafely, logger),
    config: () => ({ poolSize: effectivePoolSize, batchSize: config.batchSize, paused: config.paused }),
    ...(config.eventDebounceMs !== undefined ? { eventDebounceMs: config.eventDebounceMs } : {}),
    ...(config.runDeadlineMs !== undefined ? { runDeadlineMs: config.runDeadlineMs } : {}),
    ...(logger ? { logger } : {}),
    ...(pmWaker ? pmWakeTriggers(pmWaker) : {}),
    onTick: tickReporter(config, bus, pmWaker, logger),
  });

  daemon.run(config.intervalMs);
  // The step loop is now the daemon's: a cooked molecule / settled step asks the
  // daemon for a (debounced) tick via requestStepTick instead of ticking on its own.
  opts.steps?.setWake(() => { daemon.requestStepTick(); });
  // Trigger (b): bead status change -> immediate (debounced) tick. Layering
  // invariant 3: observed through the bus, never by polling bd.
  const unsubscribeStatus = subscribeStatusTrigger(bus, daemon);
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
        opts.steps?.setWake(null);
        await daemon.stop();
        pmWaker?.dispose();
        bus.emit({ layer: 'daemon', kind: SCHEDULER_STOPPED_EVENT, payload: { project: config.projectIdentifier } });
      })();
      return stopped;
    },
  };
}

/**
 * Pool identities come from project_role_agents; dedupe by agent id (AgentPool
 * requires unique ids) and cap at the configured pool size.
 */
function selectPoolMembers(opts: StartOptions): PoolMemberIdentity[] {
  const { config, logger } = opts;
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
  return members;
}

function loadSchedulerPack(opts: StartOptions): Pack {
  const appRoot = opts.appRoot ?? process.env['VIBESYNC_APP_ROOT'] ?? process.cwd();
  const packRoot = path.isAbsolute(opts.config.packDir) ? opts.config.packDir : path.join(appRoot, opts.config.packDir);
  return (opts.loadPack ?? ((root: string) => loadPack(root, 'global')))(packRoot);
}

/** The refinery's GitHub port: disabled unless auto-merge is on and fully configured. */
function selectGitHubPort(opts: StartOptions): GitHubPort {
  const { config, logger } = opts;
  if (!config.autoMerge) return disabledGitHubPort;
  if (!opts.gh) throw new Error('scheduler.autoMerge=true but no gh command runner was supplied');
  if (config.requiredChecks.length === 0) {
    throw new Error('scheduler.autoMerge=true requires at least one scheduler.requiredChecks name');
  }
  if (config.allowedRepos.length === 0) {
    throw new Error('scheduler.autoMerge=true requires at least one scheduler.allowedRepos owner/repo');
  }
  logger?.warn?.({ requiredChecks: config.requiredChecks, allowedRepos: config.allowedRepos }, 'scheduler: AUTO-MERGE ENABLED — refinery may merge PRs that pass all gates');
  return new GhCliGitHubPort(opts.gh, config.allowedRepos);
}

/** vibesync-2bgv: the PM waker, constructed ONLY when scheduler.pmWake.enabled. */
function buildPmWaker(opts: StartOptions, backlog: () => ReturnType<SchedulerDaemon['backlogSnapshot']>): PmWaker | null {
  const { config, bus, logger } = opts;
  const pw = config.pmWake;
  if (!pw?.enabled) return null;
  if (!opts.pmWake) {
    logger?.warn?.({ project: config.projectIdentifier }, 'pm-wake: enabled but no PM registry lookup supplied — PM wake not started');
    return null;
  }
  const inbox = pw.sink === 'inbox' ? opts.pmWake.inboxAdapter : undefined;
  return new PmWaker({
    projectIdentifier: config.projectIdentifier,
    lookupAgentId: opts.pmWake.lookupAgentId,
    sink: selectPmWakeSink(pw.sink, opts.pmWake, logger),
    store: opts.pmWake.store ?? new FilePmWakeStateStore(pw.statePath, logger),
    ...(inbox ? { pendingWakeStore: new BdPendingWakeStore(opts.bd, { ...(logger ? { logger } : {}) }) } : {}),
    backlog,
    emit: (kind, payload) => bus.emit({ layer: 'daemon', kind, payload }),
    minIntervalMs: pw.minIntervalMs,
    backstopMs: pw.backstopMs,
    ...(opts.pmWake.now ? { now: opts.pmWake.now } : {}),
    ...(logger ? { logger } : {}),
  });
}

function selectPmWakeSink(
  configured: 'log' | 'inbox' | undefined,
  pmWake: NonNullable<BootSchedulerOptions['pmWake']>,
  logger: DaemonLogger | undefined,
): PmWakeSink {
  if (pmWake.sink) return pmWake.sink;
  if (configured === 'inbox') {
    if (!pmWake.inboxAdapter) {
      throw new Error("scheduler.pmWake.sink='inbox' is blocked until the approved MobileAgentMessageSender service adapter is supplied");
    }
    return createInboxWakeSink(pmWake.inboxAdapter);
  }
  return new LoggingPmWakeSink(logger);
}

type Escalate = (workBeadId: string, summary: string, runId: string) => Promise<void>;

/** An escalation that can never throw into the daemon: a failure is logged. */
function safeEscalator(manager: EscalationManager, logger: DaemonLogger | undefined): Escalate {
  return async (workBeadId, summary, runId) => {
    try {
      await manager.escalate({ workBeadId, runId, summary });
    } catch (err) {
      logger?.warn?.(
        { workBeadId, error: err instanceof Error ? err.message : String(err) },
        'scheduler: escalation failed',
      );
    }
  };
}

function escalationHooks(
  config: SchedulerBootConfig,
  pmWaker: PmWaker | null,
  escalateSafely: Escalate,
  logger: DaemonLogger | undefined,
): ConstructorParameters<typeof SchedulerDaemon>[0]['escalation'] {
  return {
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
  };
}

/** Daemon events that should wake the PM. */
function pmWakeTriggers(pmWaker: PmWaker) {
  return {
    // Webhook / bead-status requests are the "new event for the project" wake reason.
    onTickRequested: (reason: string, detail: string | undefined) => {
      if (reason === 'webhook' || reason === 'bead-status') pmWaker.noteEvent(reason, detail ?? '');
    },
    // A run cancelled at its deadline is a stall the PM should hear about.
    onRunExpired: (i: { workBeadId: string; deadlineMs: number; elapsedMs: number }) => {
      pmWaker.noteStall(i.workBeadId, `run exceeded its deadline of ${i.deadlineMs}ms (${i.elapsedMs}ms)`);
    },
  };
}

function tickReporter(
  config: SchedulerBootConfig,
  bus: EventBus,
  pmWaker: PmWaker | null,
  logger: DaemonLogger | undefined,
): (report: DaemonTickReport) => void {
  return (report) => {
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
  };
}

/** A bead moving to a triggering status asks the daemon for a (debounced) tick. */
function subscribeStatusTrigger(bus: EventBus, daemon: SchedulerDaemon): () => void {
  return bus.subscribe((event) => {
    if (event.kind !== BEADS_ISSUE_STATUS_CHANGED_EVENT) return;
    const to = event.payload?.['to'];
    if (typeof to !== 'string' || !TICK_TRIGGER_BEAD_STATUSES.has(to)) return;
    const issueId = event.payload?.['issueId'];
    const from = event.payload?.['from'];
    daemon.requestTick('bead-status', `${typeof issueId === 'string' ? issueId : 'issue'} ${typeof from === 'string' ? from : '?'}->${to}`);
  });
}
