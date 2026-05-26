/**
 * TypeScript Type Definitions
 *
 * Shared types for API requests/responses and domain models
 */

// ============================================================================
// API Response Types
// ============================================================================

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  uptime: {
    milliseconds: number;
    seconds: number;
    human: string;
  };
  sync: {
    lastSyncTime: string | null;
    lastSyncDuration: string | null;
    totalSyncs: number;
    errorCount: number;
    successRate: string;
  };
  lastError: {
    message: string;
    timestamp: string;
    age: string;
  } | null;
  config: {
    syncInterval: string;
    apiDelay: string;
    parallelSync: boolean;
    maxWorkers: number;
    dryRun: boolean;
    lettaEnabled: boolean;
  };
  memory: {
    rss: string;
    heapUsed: string;
    heapTotal: string;
  };
  connectionPool: {
    http: { sockets: number; freeSockets: number };
    https: { sockets: number; freeSockets: number };
  };
}

export interface StatsResponse {
  uptime: HealthResponse['uptime'];
  sync: HealthResponse['sync'];
  memory: HealthResponse['memory'];
  connectionPool: HealthResponse['connectionPool'];
  sseClients: number;
  syncHistory: {
    total: number;
    mappings: number;
  };
  database?: {
    totalProjects: number;
    activeProjects: number;
    emptyProjects: number;
    totalIssues: number;
    lastSync: string;
  };
}

export interface ConfigResponse {
  config: Configuration;
  updatedAt: string;
}

export interface Configuration {
  huly: {
    apiUrl: string;
    useRestApi: boolean;
  };
  vibeKanban: {
    apiUrl: string;
    useRestApi: boolean;
  };
  sync: {
    interval: number;
    dryRun: boolean;
    incremental: boolean;
    parallel: boolean;
    maxWorkers: number;
    skipEmpty: boolean;
    apiDelay: number;
  };
  stacks: {
    baseDir: string;
  };
  letta: {
    enabled: boolean;
    baseURL: string;
  };
}

export interface ConfigUpdateRequest {
  syncInterval?: number;
  maxWorkers?: number;
  apiDelay?: number;
  dryRun?: boolean;
  incremental?: boolean;
  parallel?: boolean;
  skipEmpty?: boolean;
}

export interface SyncTriggerRequest {
  projectId?: string;
}

export interface SyncTriggerResponse {
  message: string;
  eventId: string;
  status: string;
}

export interface SyncEvent {
  id: string;
  timestamp: string;
  type: string;
  projectId?: string;
  source?: string;
  duration?: number;
  status?: string;
  error?: string;
}

export interface SyncHistoryResponse {
  total: number;
  limit: number;
  offset: number;
  entries: SyncEvent[];
  hasMore: boolean;
}

export interface IssueMapping {
  hulyIdentifier: string;
  vibeTaskId: string;
  lastSynced: string;
  [key: string]: any;
}

export interface MappingsResponse {
  total: number;
  mappings: IssueMapping[];
}

// ============================================================================
// SSE Event Types
// ============================================================================

export interface SSEEvent {
  type: string;
  data: any;
  timestamp: string;
}

export interface SSEConnectedEvent extends SSEEvent {
  type: 'connected';
  data: {
    clientId: string;
    timestamp: string;
  };
}

export interface SSESyncStartedEvent extends SSEEvent {
  type: 'sync:started';
  data: {
    projectId?: string;
    timestamp: string;
  };
}

export interface SSESyncCompletedEvent extends SSEEvent {
  type: 'sync:completed';
  data: {
    projectId?: string;
    duration: number;
    status: string;
    timestamp: string;
  };
}

export interface SSESyncErrorEvent extends SSEEvent {
  type: 'sync:error';
  data: {
    projectId?: string;
    error: string;
    timestamp: string;
  };
}

export interface SSEConfigUpdatedEvent extends SSEEvent {
  type: 'config:updated';
  data: {
    updates: ConfigUpdateRequest;
    config: Configuration;
    timestamp: string;
  };
}

export interface SSEHealthUpdatedEvent extends SSEEvent {
  type: 'health:updated';
  data: HealthResponse;
}

export interface SSEOrchestrationEvent extends SSEEvent {
  type: string;
  data: {
    id?: string;
    ts?: string;
    layer?: string;
    kind?: string;
    task_id?: string;
    molecule_id?: string;
    teammate?: string;
    payload?: Record<string, unknown>;
    timestamp?: string;
  };
}

export type SSEEventType =
  | SSEConnectedEvent
  | SSESyncStartedEvent
  | SSESyncCompletedEvent
  | SSESyncErrorEvent
  | SSEConfigUpdatedEvent
  | SSEHealthUpdatedEvent
  | SSEOrchestrationEvent;

// ============================================================================
// Error Types
// ============================================================================

export interface ApiError {
  error: string;
  statusCode: number;
  timestamp: string;
  details?: any;
}

// ============================================================================
// UI State Types
// ============================================================================

export interface UIState {
  sidebarOpen: boolean;
  selectedProjectId: string | null;
  filters: {
    status?: string;
    dateRange?: {
      start: Date;
      end: Date;
    };
  };
}

// ============================================================================
// Domain Models
// ============================================================================

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: string;
}

export interface Issue {
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  projectId: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  projectId: string;
}

export interface ProjectSummary {
  identifier: string;
  name: string;
  tech_stack?: string;
  letta_agent_id?: string | null;
  status?: string;
  last_scan_at?: string;
  issue_count?: number;
  filesystem_path?: string;
  git_url?: string;
  description?: string;
  last_sync_at?: string | null;
  [key: string]: any;
}

export interface ProjectsResponse {
  total: number;
  projects: ProjectSummary[];
  timestamp?: string;
}
