import type { IncomingMessage, ServerResponse } from 'http';
import type { OrchestrationHandle } from '../orchestration/boot.js';
import type { ProjectRow, IssueRow } from './db.js';
import type { NormalizedBeadsIssue } from './beads.js';

export type Logger = {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug?: (obj: Record<string, unknown> | string, msg?: string) => void;
  child?: (bindings: Record<string, unknown>) => Logger;
  fatal?: (obj: Record<string, unknown> | string, msg?: string) => void;
};

export interface RouteContext {
  pathname: string;
  method: string;
}

export interface HandleContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
}

export interface App {
  registerRoute(opts: {
    match: (ctx: RouteContext) => boolean;
    handle: (ctx: HandleContext) => Promise<void>;
  }): void;
}

export type SendJson = (res: ServerResponse, code: number, data: unknown) => void;
export type SendError = (
  res: ServerResponse,
  code: number,
  message: string,
  details?: Record<string, unknown>,
) => void;
export type ParseJsonBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;

export interface RouteDb {
  getProject: (id: string) => ProjectRow | null;
  getAllProjects: (filters?: ProjectFilters) => ProjectRow[];
  getProjectIssues: (id: string) => IssueRow[];
  getIssue: (id: string) => IssueRow | null;
  resolveProjectIdentifier?: (id: string | null) => string | null;
}

export interface ProjectFilters {
  status?: string;
  tech_stack?: string;
  mcp_enabled?: boolean;
}

export interface ProjectRegistryApi {
  registerProject?: (path: string) => ProjectRow | null;
  getProject?: (id: string) => ProjectRow | null;
  getProjects?: (filters?: ProjectFilters) => ProjectRow[];
  updateProject?: (id: string, updates: Partial<ProjectRow>) => ProjectRow | null;
  archiveProject?: (id: string) => ProjectRow | null;
  unarchiveProject?: (id: string) => ProjectRow | null;
  deleteProject?: (id: string) => boolean;
}

export interface BeadsListFilters {
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  updated_after?: string;
}

export interface BeadsListResult {
  items: NormalizedBeadsIssue[];
}

export interface BeadsAdapterApi {
  listIssues: (
    project: { identifier: string; filesystem_path?: string | null },
    filters?: BeadsListFilters,
    options?: { forceRefresh?: boolean },
  ) => Promise<BeadsListResult>;
  getIssue?: (
    issueId: string,
    project: { identifier: string; filesystem_path?: string | null },
    options?: { forceRefresh?: boolean },
  ) => Promise<NormalizedBeadsIssue>;
}

export interface BeadsIssueMutationResult {
  applied: boolean;
  issue?: NormalizedBeadsIssue;
  error?: string;
  idempotent_replay?: boolean;
}

export interface BeadsIssueServiceApi {
  getIssue?: (id: string) => IssueRow | null;
  claimIssue?: (id: string, body: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
  unclaimIssue?: (id: string, body: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
  closeIssue?: (id: string, body: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
  reopenIssue?: (id: string, body: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
  updateIssueStatus?: (id: string, status: string, opts: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
  addIssueNote?: (id: string, content: string, opts: Record<string, unknown>) => Promise<BeadsIssueMutationResult>;
}

export interface BeadsIssueMirrorApi {
  ensureFresh: (projectId: string, maxAgeMs?: number) => Promise<MirrorSyncResult>;
}

export interface MirrorSyncResult {
  changed: number;
  source: 'full' | 'incremental' | 'cached' | 'skipped';
  error: string | null;
  durationMs: number;
}

export interface DoltHubProvisionerApi {
  provisionProjectBeadsRemote?: (
    id: string,
    opts: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export type OrchestrationApi = OrchestrationHandle;

export interface SerializedIssueSummary {
  id: string;
  provider: string;
  projectId?: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  statusLabel: string;
  ready: boolean;
  assignee: string | null;
  blockedBy: string[];
  blocks: string[];
  isBlocked: boolean;
  updatedAt: string | null;
  summary: string;
  acceptanceCriteria: string[];
  labels: string[];
  validationWarnings: string[];
  etag: string;
}

export interface SerializedProjectSummary {
  identifier: string;
  name: string;
  tech_stack: string | null;
  letta_agent_id: string | null;
  status: string;
  last_scan_at: number | null;
  issue_count: number;
  filesystem_path: string | null;
  git_url: string | null;
  beads_remote: SerializedBeadsRemote;
  description?: string | null;
  last_sync_at: number | null;
}

export interface SerializedBeadsRemote {
  owner: string | null;
  repo: string | null;
  url: string | null;
  name: string | null;
  status: string;
  visibility: string | null;
  provisioned_at: string | null;
  last_push_at: string | null;
  error: string | null;
}
