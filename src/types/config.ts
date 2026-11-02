/**
 * Config types derived from zod schemas in lib/configSchema.js.
 * Use `z.infer<typeof configSchema>` once configSchema is moved to TS.
 * Until then, these are manual mirrors kept in sync with configSchema.js.
 */

export interface SyncConfig {
  interval: number;
  dryRun: boolean;
  incremental: boolean;
  parallel: boolean;
  maxWorkers: number;
  skipEmpty: boolean;
  apiDelay: number;
}

export interface ReconciliationConfig {
  enabled: boolean;
  intervalMinutes: number;
  action: 'mark_deleted' | 'hard_delete';
  dryRun: boolean;
}

export interface StacksConfig {
  baseDir: string;
}

export interface LettaConfig {
  enabled: boolean;
  baseURL?: string;
  password?: string;
}

export interface GraphitiConfig {
  enabled: boolean;
  apiUrl: string;
  groupIdPrefix: string;
  astEnabled: boolean;
  astGroupIdPrefix: string;
  timeout: number;
  retries: number;
}

export interface CodePerceptionConfig {
  enabled: boolean;
  debounceMs: number;
  batchSize: number;
  maxFileSizeKb: number;
  excludePatterns: string[];
  sourceRoots?: string[];
  allowlistMode?: boolean;
}

export interface BookStackProjectMapping {
  projectIdentifier: string;
  bookSlug: string;
}

export interface BookStackConfig {
  enabled: boolean;
  url: string;
  tokenId: string;
  tokenSecret: string;
  syncInterval: number;
  exportFormats: string[];
  exportImages: boolean;
  exportAttachments: boolean;
  exportMeta: boolean;
  modifyMarkdownLinks: boolean;
  docsSubdir: string;
  projectBookMappings: BookStackProjectMapping[];
  exporterOutputPath: string;
  importOnSync: boolean;
  bidirectionalSync: boolean;
}

export interface ProjectMcpConfig {
  enabled: boolean;
  path: string;
}

export interface DoltHubConfig {
  enabled: boolean;
  dryRun: boolean;
  apiUrl: string;
  apiToken?: string;
  owner: string;
  defaultVisibility: 'public' | 'private';
  remoteName: string;
}

export interface SchedulerConfigSection {
  enabled: boolean;
  projectIdentifier: string;
  intervalMs: number;
  /** Min spacing between event-triggered ticks (vibesync-p489). */
  eventDebounceMs: number;
  poolSize: number;
  batchSize: number;
  paused: boolean;
  readyLabel: string;
  formula: string;
  packDir: string;
  autoMerge: boolean;
  requiredChecks: string[];
}

export interface AppConfig {
  sync: SyncConfig;
  reconciliation: ReconciliationConfig;
  stacks: StacksConfig;
  letta: LettaConfig;
  graphiti: GraphitiConfig;
  codePerception: CodePerceptionConfig;
  bookstack: BookStackConfig;
  projectMcp: ProjectMcpConfig;
  doltHub: DoltHubConfig;
  scheduler: SchedulerConfigSection;
}

export interface HealthSnapshot {
  status: 'healthy' | 'degraded' | 'error';
  service: string;
  version: string;
  uptime: { milliseconds: number; seconds: number; human: string };
  sync: {
    lastSyncTime: string | null;
    lastSyncDuration: string | null;
    totalSyncs: number;
    errorCount: number;
    successRate: string;
  };
  lastError: string | null;
  config: {
    syncInterval: string;
    apiDelay: string;
    parallelSync: boolean;
    maxWorkers: number;
    dryRun: boolean;
    lettaEnabled: boolean;
  };
  memory: { rss: string; heapUsed: string; heapTotal: string };
}
