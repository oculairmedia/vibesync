import { z } from 'zod';

const syncSchema = z.object({
  interval: z.number().int().min(0, 'SYNC_INTERVAL must be >= 0'),
  dryRun: z.boolean(),
  incremental: z.boolean(),
  parallel: z.boolean(),
  maxWorkers: z.number().int().min(1, 'MAX_WORKERS must be >= 1'),
  skipEmpty: z.boolean(),
  apiDelay: z.number().int().min(0, 'API_DELAY must be >= 0'),
});

const reconciliationSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1, 'RECONCILIATION_INTERVAL_MINUTES must be >= 1'),
  action: z.enum(['mark_deleted', 'hard_delete'], {
    message: 'RECONCILIATION_ACTION must be mark_deleted or hard_delete',
  }),
  dryRun: z.boolean(),
});

const stacksSchema = z.object({
  baseDir: z.string().min(1),
});

const lettaSchema = z
  .object({
    enabled: z.boolean().or(z.unknown()),
    baseURL: z.string().optional(),
    password: z.string().optional(),
  })
  .refine((data) => !data.enabled || data.baseURL, {
    message: 'LETTA_BASE_URL must be set when Letta is enabled',
  })
  .refine((data) => !data.enabled || data.password, {
    message: 'LETTA_PASSWORD must be set when Letta is enabled',
  });

const graphitiSchema = z.object({
  enabled: z.boolean(),
  apiUrl: z.string(),
  groupIdPrefix: z.string(),
  astEnabled: z.boolean(),
  astGroupIdPrefix: z.string(),
  timeout: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});

const codePerceptionSchema = z.object({
  enabled: z.boolean(),
  debounceMs: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
  maxFileSizeKb: z.number().int().positive(),
  excludePatterns: z.array(z.string()),
  sourceRoots: z.array(z.string()).optional(),
  allowlistMode: z.boolean().optional(),
});

const bookstackSchema = z
  .object({
    enabled: z.boolean(),
    url: z.string(),
    tokenId: z.string(),
    tokenSecret: z.string(),
    syncInterval: z.number().int().positive(),
    exportFormats: z.array(z.string()),
    exportImages: z.boolean(),
    exportAttachments: z.boolean(),
    exportMeta: z.boolean(),
    modifyMarkdownLinks: z.boolean(),
    docsSubdir: z.string(),
    projectBookMappings: z.array(
      z.object({
        projectIdentifier: z.string(),
        bookSlug: z.string(),
      }),
    ),
    exporterOutputPath: z.string(),
    importOnSync: z.boolean(),
    bidirectionalSync: z.boolean(),
  })
  .refine((data) => !data.enabled || data.url, {
    message: 'BOOKSTACK_URL must be set when USE_BOOKSTACK_SYNC is enabled',
  })
  .refine((data) => !data.enabled || (data.tokenId && data.tokenSecret), {
    message:
      'BOOKSTACK_TOKEN_ID and BOOKSTACK_TOKEN_SECRET must be set when USE_BOOKSTACK_SYNC is enabled',
  });

const projectMcpSchema = z.object({
  enabled: z.boolean(),
  path: z.string().min(1),
});

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
    runDeadlineMs: z.number().int().min(0, 'VIBESYNC_SCHEDULER_RUN_DEADLINE_MS must be >= 0'),
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
  })
  .refine((data) => !data.enabled || data.projectIdentifier.trim().length > 0, {
    message: 'VIBESYNC_SCHEDULER_PROJECT must be set when VIBESYNC_SCHEDULER_ENABLED is true',
  })
  .refine((data) => !data.autoMerge || data.requiredChecks.length > 0, {
    message:
      'VIBESYNC_SCHEDULER_REQUIRED_CHECKS must list at least one check when VIBESYNC_SCHEDULER_AUTO_MERGE is true',
  });

export const configSchema = z.object({
  sync: syncSchema,
  reconciliation: reconciliationSchema,
  stacks: stacksSchema,
  letta: lettaSchema,
  graphiti: graphitiSchema,
  codePerception: codePerceptionSchema,
  bookstack: bookstackSchema,
  projectMcp: projectMcpSchema,
  doltHub: doltHubSchema,
  scheduler: schedulerSchema,
});

export type AppConfig = z.infer<typeof configSchema>;
