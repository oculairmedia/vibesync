import { REPO_SLUG_PATTERN } from '../engine/repo-allowlist.js';
import { z } from 'zod';
import { isAbsolute } from 'node:path';

const doltHubSchema = z
  .object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    apiUrl: z.string().url(),
    apiToken: z.string().optional(),
    owner: z.string().min(1),
    defaultVisibility: z.enum(['public', 'private']),
    remoteName: z.string().min(1),
  })
  .refine((data) => !data.enabled || data.dryRun || Boolean(data.apiToken), {
    message: 'DOLTHUB_API_TOKEN must be set when DoltHub provisioning is enabled',
  });

/**
 * Orchestration scheduler (vibesync-z2ws). Layering invariant 4: the daemon
 * exists iff this section says `enabled`. Default is OFF.
 */
const schedulerSchema = z
  .object({
    enabled: z.boolean(),
    /** Project whose beads are scheduled and whose project_role_agents rows form the pool. */
    projectIdentifier: z.string(),
    intervalMs: z.number().int().min(1000, 'VIBESYNC_SCHEDULER_INTERVAL_MS must be >= 1000'),
    /** Min spacing between event-triggered ticks (vibesync-p489). 0 disables debouncing. */
    eventDebounceMs: z.number().int().min(0, 'VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS must be >= 0'),
    /** Wall-clock deadline for a started formula run (vibesync-izn3). 0 disables it. */
    runDeadlineMs: z
      .number()
      .int()
      .min(0, 'VIBESYNC_SCHEDULER_RUN_DEADLINE_MS must be >= 0')
      .max(2_147_483_647, 'VIBESYNC_SCHEDULER_RUN_DEADLINE_MS must be <= 2147483647 (setTimeout maximum)'),
    poolSize: z.number().int().min(1, 'VIBESYNC_SCHEDULER_POOL_SIZE must be >= 1'),
    batchSize: z.number().int().min(1, 'VIBESYNC_SCHEDULER_BATCH_SIZE must be >= 1'),
    paused: z.boolean(),
    /** Only ready beads carrying this label are scheduled. Empty string = every ready bead. */
    readyLabel: z.string(),
    /** Formula (from the pack at packDir) every scheduled bead is dispatched as. */
    formula: z.string().min(1),
    packDir: z.string().min(1),
    /** Safety: the refinery only merges PRs when this is explicitly true. */
    autoMerge: z.boolean(),
    /** Check names that must be SUCCESS before an auto-merge. Required non-empty when autoMerge. */
    requiredChecks: z.array(z.string()),
    /** owner/repo slugs the refinery may enqueue/merge (vibesync-5c8y). Required non-empty when autoMerge. */
    allowedRepos: z.array(
      z.string().regex(REPO_SLUG_PATTERN, 'VIBESYNC_SCHEDULER_ALLOWED_REPOS entries must be "owner/repo"'),
    ),
    /** PM wake policy (vibesync-2bgv). */
    pmWake: z.object({
      enabled: z.boolean(),
      minIntervalMs: z.number().int().min(1000, 'VIBESYNC_PM_WAKE_MIN_INTERVAL_MS must be >= 1000'),
      backstopMs: z.number().int().min(1000, 'VIBESYNC_PM_WAKE_BACKSTOP_MS must be >= 1000'),
      statePath: z.string().min(1, 'VIBESYNC_PM_WAKE_STATE_PATH must not be empty'),
      /** Inbox requires an explicitly installed mobile service adapter. */
      sink: z.enum(['log', 'inbox'], { message: 'VIBESYNC_PM_WAKE_SINK must be "log" or "inbox"; direct-input "iroh" wakes were removed' }).default('log'),
      cli: z.object({
        executable: z.string().refine(isAbsolute, 'Inbox executable path must be absolute'),
        senderAgentId: z.string().trim().min(1),
        identityDir: z.string().refine(isAbsolute, 'Inbox identity directory must be absolute'),
        addressStore: z.string().refine(isAbsolute, 'Inbox address store must be absolute'),
        contractVerified: z.boolean(),
      }).strict().optional(),
    }),
  })
  .refine((data) => !data.enabled || data.projectIdentifier.trim().length > 0, {
    message: 'VIBESYNC_SCHEDULER_PROJECT must be set when VIBESYNC_SCHEDULER_ENABLED is true',
  })
  .refine((data) => !data.autoMerge || data.requiredChecks.length > 0, {
    message:
      'VIBESYNC_SCHEDULER_REQUIRED_CHECKS must list at least one check when VIBESYNC_SCHEDULER_AUTO_MERGE is true',
  })
  .refine((data) => !data.autoMerge || data.allowedRepos.length > 0, {
    message:
      'VIBESYNC_SCHEDULER_ALLOWED_REPOS must list at least one owner/repo when VIBESYNC_SCHEDULER_AUTO_MERGE is true',
  });

/**
 * Durable waits (vibesync-9g24). Layering invariant 4: the wait watcher exists
 * iff this section says `enabled`. Default is OFF.
 */
const waitsSchema = z.object({
  enabled: z.boolean(),
  /** Slow safety-net reconcile (ms). The bus event is only a hint; 0 disables the interval. */
  reconcileIntervalMs: z.number().int().min(0, 'VIBESYNC_WAITS_RECONCILE_INTERVAL_MS must be >= 0'),
  /** Sink failures before a wait is closed `failed`. */
  maxWakeAttempts: z.number().int().min(1, 'VIBESYNC_WAITS_MAX_WAKE_ATTEMPTS must be >= 1'),
});

export const configSchema = z.object({
  stacks: z.object({ baseDir: z.string().min(1) }),
  doltHub: doltHubSchema,
  scheduler: schedulerSchema,
  waits: waitsSchema,
});

export type AppConfig = z.infer<typeof configSchema>;
