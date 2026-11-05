import 'dotenv/config';
import { configSchema, type AppConfig } from './configSchema';


/**
 * Strict non-negative integer parse: the WHOLE string must be digits. Anything
 * else ('5s', '1e3', '-1', '5.5', ' ') yields NaN so schema validation rejects
 * it instead of parseInt silently truncating.
 */
function parseStrictInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

/** setTimeout/setInterval ceiling; larger values overflow to a 1 ms timer. */
const MAX_TIMER_MS = 2_147_483_647;

function parseCappedMs(raw: string | undefined, fallback: number): number {
  const n = parseStrictInt(raw, fallback);
  return Number.isNaN(n) ? n : Math.min(n, MAX_TIMER_MS);
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    stacks: {
      baseDir: process.env.STACKS_DIR || '/opt/stacks',
    },
    doltHub: {
      enabled: process.env.DOLTHUB_PROVISIONING_ENABLED === 'true',
      dryRun: process.env.DOLTHUB_PROVISIONING_DRY_RUN === 'true',
      apiUrl: process.env.DOLTHUB_API_URL || 'https://www.dolthub.com/api/v1alpha1',
      apiToken: process.env.DOLTHUB_API_TOKEN || '',
      owner: process.env.DOLTHUB_OWNER || 'oulair',
      defaultVisibility: (process.env.DOLTHUB_DEFAULT_VISIBILITY || 'private') as 'public' | 'private',
      remoteName: process.env.DOLTHUB_REMOTE_NAME || 'origin',
    },
    scheduler: {
      // vibesync-z2ws: SchedulerDaemon activation. OFF unless explicitly enabled.
      enabled: process.env.VIBESYNC_SCHEDULER_ENABLED === 'true',
      projectIdentifier: process.env.VIBESYNC_SCHEDULER_PROJECT || '',
      intervalMs: parseStrictInt(process.env.VIBESYNC_SCHEDULER_INTERVAL_MS, 30000),
      // vibesync-p489: min spacing between event-triggered ticks.
      eventDebounceMs: parseStrictInt(process.env.VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS, 5000),
      // vibesync-izn3: wall-clock budget for a started run; 0 = no deadline.
      runDeadlineMs: parseStrictInt(process.env.VIBESYNC_SCHEDULER_RUN_DEADLINE_MS, 3_600_000),
      poolSize: parseStrictInt(process.env.VIBESYNC_SCHEDULER_POOL_SIZE, 1),
      batchSize: parseStrictInt(process.env.VIBESYNC_SCHEDULER_BATCH_SIZE, 1),
      paused: process.env.VIBESYNC_SCHEDULER_PAUSED === 'true',
      readyLabel: process.env.VIBESYNC_SCHEDULER_READY_LABEL ?? 'scheduler:eligible',
      formula: process.env.VIBESYNC_SCHEDULER_FORMULA || 'onboard-feature',
      packDir: process.env.VIBESYNC_SCHEDULER_PACK_DIR || 'packs/gastown',
      // Safety: never auto-merge unless explicitly requested.
      autoMerge: process.env.VIBESYNC_SCHEDULER_AUTO_MERGE === 'true',
      requiredChecks: parseCsv(process.env.VIBESYNC_SCHEDULER_REQUIRED_CHECKS),
      allowedRepos: parseCsv(process.env.VIBESYNC_SCHEDULER_ALLOWED_REPOS),
      // vibesync-2bgv: PM wake policy. OFF unless explicitly enabled.
      pmWake: {
        enabled: process.env.VIBESYNC_PM_WAKE_ENABLED === 'true',
        minIntervalMs: parseCappedMs(process.env.VIBESYNC_PM_WAKE_MIN_INTERVAL_MS, 1_800_000),
        backstopMs: parseCappedMs(process.env.VIBESYNC_PM_WAKE_BACKSTOP_MS, 28_800_000),
        statePath: process.env.VIBESYNC_PM_WAKE_STATE_PATH || '/opt/stacks/vibesync/logs/pm-wake-state.json',
        // vibesync-2bgv: whole-string enum; anything else fails validation.
        sink: (process.env.VIBESYNC_PM_WAKE_SINK || 'log') as 'log' | 'inbox',
        ...(process.env.VIBESYNC_PM_WAKE_CLI_EXECUTABLE !== undefined ? {
          cli: {
            executable: process.env.VIBESYNC_PM_WAKE_CLI_EXECUTABLE,
            senderAgentId: (process.env.VIBESYNC_PM_WAKE_CLI_SENDER ?? '').trim(),
            identityDir: process.env.VIBESYNC_PM_WAKE_CLI_IDENTITIES ?? '',
            addressStore: process.env.VIBESYNC_PM_WAKE_CLI_ADDRESS_STORE ?? '',
            contractVerified: process.env.VIBESYNC_PM_WAKE_CLI_CONTRACT_VERIFIED === 'true',
          },
        } : {}),
      },
    },
    waits: {
      // vibesync-9g24: durable wait watcher. OFF unless explicitly enabled.
      enabled: process.env.VIBESYNC_WAITS_ENABLED === 'true',
      reconcileIntervalMs: parseStrictInt(process.env.VIBESYNC_WAITS_RECONCILE_INTERVAL_MS, 60_000),
      maxWakeAttempts: parseStrictInt(process.env.VIBESYNC_WAITS_MAX_WAKE_ATTEMPTS, 5),
    },
  };

  const result = configSchema.safeParse(config);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Config validation failed: ${messages}`);
  }

  if (process.env.VIBESYNC_PM_WAKE_CONVERSATION_ID !== undefined) {
    throw new Error('Config validation failed: VIBESYNC_PM_WAKE_CONVERSATION_ID was removed; inbox routing is owned by the receiver');
  }

  return config;
}

export function getConfigSummary(config: AppConfig) {
  return {
    stacksDir: config.stacks.baseDir,
    doltHubProvisioningEnabled: config.doltHub.enabled,
    doltHubProvisioningDryRun: config.doltHub.dryRun,
    doltHubOwner: config.doltHub.owner,
    schedulerEnabled: config.scheduler.enabled,
    schedulerProject: config.scheduler.enabled ? config.scheduler.projectIdentifier : undefined,
    schedulerAutoMerge: config.scheduler.autoMerge,
    pmWakeEnabled: config.scheduler.pmWake.enabled,
    pmWakeSink: config.scheduler.pmWake.sink,
    waitsEnabled: config.waits.enabled,
  };
}
