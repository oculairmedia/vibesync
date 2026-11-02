import 'dotenv/config';
import { configSchema, type AppConfig } from './configSchema';

function parseBookMappings(raw: string | undefined): { projectIdentifier: string; bookSlug: string }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [projectIdentifier, bookSlug] = pair.split(':').map((s) => s.trim());
      return { projectIdentifier: projectIdentifier!, bookSlug: bookSlug! };
    })
    .filter((m) => m.projectIdentifier && m.bookSlug);
}

/**
 * Strict non-negative integer parse: the WHOLE string must be digits. Anything
 * else ('5s', '1e3', '-1', '5.5', ' ') yields NaN so schema validation rejects
 * it instead of parseInt silently truncating.
 */
function parseStrictInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    sync: {
      interval: parseInt(process.env.SYNC_INTERVAL || '300000', 10),
      dryRun: process.env.DRY_RUN === 'true',
      incremental: process.env.INCREMENTAL_SYNC !== 'false',
      parallel: process.env.PARALLEL_SYNC === 'true',
      maxWorkers: parseInt(process.env.MAX_WORKERS || '5', 10),
      skipEmpty: process.env.SKIP_EMPTY_PROJECTS === 'true',
      apiDelay: parseInt(process.env.API_DELAY || '10', 10),
    },
    reconciliation: {
      enabled: process.env.RECONCILIATION_ENABLED !== 'false',
      intervalMinutes: parseInt(process.env.RECONCILIATION_INTERVAL_MINUTES || '1440', 10),
      action: (process.env.RECONCILIATION_ACTION || 'mark_deleted') as 'mark_deleted' | 'hard_delete',
      dryRun: process.env.RECONCILIATION_DRY_RUN === 'true',
    },
    stacks: {
      baseDir: process.env.STACKS_DIR || '/opt/stacks',
    },
    letta: {
      enabled: Boolean(process.env.LETTA_BASE_URL && process.env.LETTA_PASSWORD),
      baseURL: process.env.LETTA_BASE_URL,
      password: process.env.LETTA_PASSWORD,
    },
    graphiti: {
      enabled: process.env.GRAPHITI_ENABLED === 'true',
      apiUrl: process.env.GRAPHITI_API_URL || 'http://localhost:8003',
      groupIdPrefix: process.env.GRAPHITI_GROUP_ID_PREFIX || 'vibesync_',
      astEnabled: process.env.GRAPHITI_AST_ENABLED !== 'false',
      astGroupIdPrefix: process.env.GRAPHITI_AST_GROUP_ID_PREFIX || 'ast_',
      timeout: parseInt(process.env.GRAPHITI_TIMEOUT || '30000', 10),
      retries: parseInt(process.env.GRAPHITI_RETRIES || '3', 10),
    },
    codePerception: {
      enabled: process.env.CODE_PERCEPTION_ENABLED === 'true',
      debounceMs: parseInt(process.env.CODE_PERCEPTION_DEBOUNCE_MS || '2000', 10),
      batchSize: parseInt(process.env.CODE_PERCEPTION_BATCH_SIZE || '50', 10),
      maxFileSizeKb: parseInt(process.env.CODE_PERCEPTION_MAX_FILE_SIZE_KB || '500', 10),
      excludePatterns: (
        process.env.CODE_PERCEPTION_EXCLUDE_PATTERNS ||
        process.env.AST_EXCLUDE_PATTERNS ||
        ''
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      sourceRoots: (process.env.CODE_PERCEPTION_SOURCE_ROOTS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      allowlistMode: process.env.CODE_PERCEPTION_ALLOWLIST_MODE === 'true',
    },
    bookstack: {
      enabled: process.env.USE_BOOKSTACK_SYNC === 'true',
      url: process.env.BOOKSTACK_URL || 'http://192.168.50.80:8087',
      tokenId: process.env.BOOKSTACK_TOKEN_ID || '',
      tokenSecret: process.env.BOOKSTACK_TOKEN_SECRET || '',
      syncInterval: parseInt(process.env.BOOKSTACK_SYNC_INTERVAL || '3600000', 10),
      exportFormats: (process.env.BOOKSTACK_EXPORT_FORMATS || 'markdown').split(','),
      exportImages: process.env.BOOKSTACK_EXPORT_IMAGES !== 'false',
      exportAttachments: process.env.BOOKSTACK_EXPORT_ATTACHMENTS !== 'false',
      exportMeta: process.env.BOOKSTACK_EXPORT_META !== 'false',
      modifyMarkdownLinks: process.env.BOOKSTACK_MODIFY_LINKS !== 'false',
      docsSubdir: process.env.BOOKSTACK_DOCS_SUBDIR || 'docs/bookstack',
      projectBookMappings: parseBookMappings(process.env.BOOKSTACK_PROJECT_BOOKS),
      exporterOutputPath: process.env.BOOKSTACK_EXPORTER_OUTPUT || '/bookstack-exports',
      importOnSync: process.env.BOOKSTACK_IMPORT_ON_SYNC === 'true',
      bidirectionalSync: process.env.BOOKSTACK_BIDIRECTIONAL_SYNC === 'true',
    },
    projectMcp: {
      enabled: process.env.PROJECT_MCP_ENABLED !== 'false',
      path: process.env.PROJECT_MCP_PATH || '/mcp',
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
      intervalMs: parseInt(process.env.VIBESYNC_SCHEDULER_INTERVAL_MS || '30000', 10),
      // vibesync-p489: min spacing between event-triggered ticks.
      eventDebounceMs: parseStrictInt(process.env.VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS, 5000),
      poolSize: parseInt(process.env.VIBESYNC_SCHEDULER_POOL_SIZE || '1', 10),
      batchSize: parseInt(process.env.VIBESYNC_SCHEDULER_BATCH_SIZE || '1', 10),
      paused: process.env.VIBESYNC_SCHEDULER_PAUSED === 'true',
      readyLabel: process.env.VIBESYNC_SCHEDULER_READY_LABEL ?? 'scheduler:eligible',
      formula: process.env.VIBESYNC_SCHEDULER_FORMULA || 'onboard-feature',
      packDir: process.env.VIBESYNC_SCHEDULER_PACK_DIR || 'packs/gastown',
      // Safety: never auto-merge unless explicitly requested.
      autoMerge: process.env.VIBESYNC_SCHEDULER_AUTO_MERGE === 'true',
      requiredChecks: parseCsv(process.env.VIBESYNC_SCHEDULER_REQUIRED_CHECKS),
      allowedRepos: parseCsv(process.env.VIBESYNC_SCHEDULER_ALLOWED_REPOS),
    },
  };

  const result = configSchema.safeParse(config);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Config validation failed: ${messages}`);
  }

  validateConfig(config);

  return config;
}

export function validateConfig(config: AppConfig): void {
  if (isNaN(config.sync.interval) || config.sync.interval < 1000) {
    throw new Error('SYNC_INTERVAL must be a number >= 1000 (milliseconds)');
  }

  if (isNaN(config.sync.maxWorkers) || config.sync.maxWorkers < 1) {
    throw new Error('MAX_WORKERS must be a number >= 1');
  }

  if (isNaN(config.sync.apiDelay) || config.sync.apiDelay < 0) {
    throw new Error('API_DELAY must be a number >= 0');
  }

  if (isNaN(config.reconciliation.intervalMinutes) || config.reconciliation.intervalMinutes < 1) {
    throw new Error('RECONCILIATION_INTERVAL_MINUTES must be a number >= 1');
  }

  if (!['mark_deleted', 'hard_delete'].includes(config.reconciliation.action)) {
    throw new Error('RECONCILIATION_ACTION must be mark_deleted or hard_delete');
  }

  if (config.letta.enabled) {
    if (!config.letta.baseURL) {
      throw new Error('LETTA_BASE_URL must be set when Letta is enabled');
    }
    if (!config.letta.password) {
      throw new Error('LETTA_PASSWORD must be set when Letta is enabled');
    }
  }

  if (config.bookstack.enabled) {
    if (!config.bookstack.url) {
      throw new Error('BOOKSTACK_URL must be set when USE_BOOKSTACK_SYNC is enabled');
    }
    if (!config.bookstack.tokenId || !config.bookstack.tokenSecret) {
      throw new Error(
        'BOOKSTACK_TOKEN_ID and BOOKSTACK_TOKEN_SECRET must be set when USE_BOOKSTACK_SYNC is enabled',
      );
    }
  }

  if (config.doltHub.enabled && !config.doltHub.dryRun && !config.doltHub.apiToken) {
    throw new Error('DOLTHUB_API_TOKEN must be set when DoltHub provisioning is enabled');
  }
}

export function getConfigSummary(config: AppConfig) {
  return {
    stacksDir: config.stacks.baseDir,
    syncInterval: `${config.sync.interval / 1000}s`,
    incrementalSync: config.sync.incremental,
    parallelProcessing: config.sync.parallel,
    maxWorkers: config.sync.maxWorkers,
    skipEmptyProjects: config.sync.skipEmpty,
    dryRun: config.sync.dryRun,
    reconciliationEnabled: config.reconciliation.enabled,
    reconciliationIntervalMinutes: config.reconciliation.intervalMinutes,
    reconciliationAction: config.reconciliation.action,
    lettaEnabled: config.letta.enabled,
    graphitiEnabled: config.graphiti.enabled,
    graphitiApi: config.graphiti.apiUrl,
    graphitiAstEnabled: config.graphiti.astEnabled,
    codePerceptionEnabled: config.codePerception.enabled,
    codePerceptionAllowlistMode: config.codePerception.allowlistMode,
    codePerceptionSourceRoots: config.codePerception.sourceRoots!.length,
    bookstackEnabled: config.bookstack.enabled,
    bookstackUrl: config.bookstack.enabled ? config.bookstack.url : undefined,
    bookstackMappings: config.bookstack.projectBookMappings.length,
    projectMcpEnabled: config.projectMcp.enabled,
    projectMcpPath: config.projectMcp.path,
    doltHubProvisioningEnabled: config.doltHub.enabled,
    doltHubProvisioningDryRun: config.doltHub.dryRun,
    doltHubOwner: config.doltHub.owner,
    doltHubDefaultVisibility: config.doltHub.defaultVisibility,
    schedulerEnabled: config.scheduler.enabled,
    schedulerProject: config.scheduler.enabled ? config.scheduler.projectIdentifier : undefined,
    schedulerAutoMerge: config.scheduler.autoMerge,
  };
}

export function isLettaEnabled(config: AppConfig): boolean {
  return Boolean(config.letta.enabled && config.letta.baseURL && config.letta.password);
}

export function getEnvironmentOverrides(env: string = process.env.NODE_ENV || 'production') {
  const overrides: Record<string, Record<string, unknown>> = {
    test: {
      sync: {
        interval: 1000,
        dryRun: true,
        parallel: false,
      },
    },
    development: {
      sync: {
        interval: 60000,
      },
    },
    production: {},
  };

  return overrides[env] || overrides.production;
}
