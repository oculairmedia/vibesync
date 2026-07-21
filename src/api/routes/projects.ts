import path from 'path';
import fs from 'fs';
import { buildIssueAnalytics, getAnalyticsRange } from './issueAnalytics.js';
import { stripUrlCredentials } from '../../utils.js';
import type { ProjectRow } from '../../types/db.js';
import type { NormalizedBeadsIssue } from '../../types/beads.js';
import type {
  App,
  BeadsAdapterApi,
  BeadsIssueMirrorApi,
  BeadsIssueServiceApi,
  BeadsListFilters,
  DoltHubProvisionerApi,
  Logger,
  ParseJsonBody,
  ProjectRegistryApi,
  RouteDb,
  SendError,
  SendJson,
} from '../../types/api.js';

/** Union of every issue shape the routes accept (DB rows, normalized bd issues, serialized payloads). */
export interface IssueLike {
  // Identity
  id?: string | number;
  identifier?: string;
  project_id?: string;
  projectId?: string;
  project_identifier?: string;
  // Core fields
  title?: string;
  description?: string | null;
  status?: string | null;
  statusLabel?: string;
  priority?: string | number | null;
  type?: string;
  issue_type?: string | null;
  assignee?: string | null;
  // Arrays / relations
  labels?: string[] | string | null;
  labels_json?: string | null;
  blockedBy?: string[];
  blocked_by?: string[] | string | null;
  blocked_by_json?: string | null;
  blocks?: string[];
  isBlocked?: boolean;
  parent_huly_id?: string | null;
  parent_vibe_id?: string | null;
  parent_id?: string | null;
  sub_issue_count?: number;
  children?: unknown[];
  // External system ids
  huly_id?: string | null;
  vibe_task_id?: number | null;
  // Timestamps (each source uses different shapes)
  created_at?: number | string | null;
  createdAt?: string;
  updated_at?: number | string | null;
  updatedAt?: string;
  modifiedAt?: string | number | null;
  last_sync_at?: number | string | null;
  beads_updated_at?: number | null;
  closed_at?: string | null | undefined;
  closedAt?: string | undefined;
  // Extras
  acceptanceCriteria?: string[];
  acceptance_criteria?: string | string[] | undefined;
  validationWarnings?: string[];
  ready?: boolean;
  source?: string | null;
  owner?: string | null;
  closed_by?: string | null;
  completed_by?: string | null;
  close_reason?: string | null;
  completion_reason?: string | null;
  completed_at?: string | null;
  completedAt?: string;
  deleted_from_huly?: boolean | number | null;
  deleted_from_vibe?: boolean | number | null;
  notes?: unknown;
  comments?: unknown;
}

type ProjectLike = ProjectRow & {
  description?: string | null;
  letta_folder_id?: string | null;
  letta_source_id?: string | null;
  letta_last_sync_at?: number | string | null;
};

const ALLOWED_PROJECT_STATUSES = new Set(['active', 'archived']);
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const TRACKER_PROVIDER = 'beads';
const STALE_AFTER_MS = 15 * 60 * 1000;
const CLOSED_ISSUE_STATUSES = new Set(['done', 'closed', 'resolved', 'complete', 'completed']);
const BLOCKED_ISSUE_STATUSES = new Set(['blocked']);
const DEFERRED_ISSUE_STATUSES = new Set(['deferred', 'snoozed', 'later']);
const IN_PROGRESS_ISSUE_STATUSES = new Set(['inprogress', 'in_progress', 'doing']);

interface RouteDeps {
  db: RouteDb | null;
  config: Record<string, unknown>;
  parseJsonBody: ParseJsonBody;
  sendJson: SendJson;
  sendError: SendError;
  logger: Logger;
  projectRegistry: ProjectRegistryApi | null;
  doltHubProvisioner: DoltHubProvisionerApi | null;
  beadsIssueService: BeadsIssueServiceApi | null;
  beadsAdapter: BeadsAdapterApi | null;
  beadsIssueMirror?: BeadsIssueMirrorApi | null;
  codePerceptionWatcher?: { astInitialSync?: (projectPath: string) => Promise<Record<string, unknown>> } | null;
}

function isAbsolutePath(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && path.isAbsolute(value.trim());
}

interface SerializedProject {
  identifier: string;
  name: string;
  tech_stack: string | null;
  letta_agent_id: string | null;
  status: string;
  last_scan_at: number | null;
  issue_count: number;
  filesystem_path: string | null;
  git_url: string | null;
  beads_remote: SerializedRemote;
  description: string | null;
  last_sync_at: number | null;
}

interface SerializedRemote {
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

function serializeProject(project: ProjectLike | null): SerializedProject | null {
  if (!project) return null;
  return {
    identifier: project.identifier,
    name: project.name,
    tech_stack: project.tech_stack ?? null,
    letta_agent_id: project.letta_agent_id,
    status: project.status,
    last_scan_at: project.last_checked_at,
    issue_count: project.issue_count,
    filesystem_path: project.filesystem_path,
    // SECURITY (vibesync-6kg): defense in depth — sanitize any inlined
    // credential in the URL at serialization time, so a regression in the
    // ingest path (or pre-fix stored rows) cannot leak tokens to the wire.
    git_url: stripUrlCredentials(project.git_url),
    beads_remote: serializeBeadsRemoteStatus(project),
    description: project.description ?? null,
    last_sync_at: project.last_sync_at,
  };
}

function serializeBeadsRemoteStatus(project: ProjectLike): SerializedRemote {
  return {
    owner: project.beads_remote_owner || null,
    repo: project.beads_remote_repo || null,
    // SECURITY (vibesync-6kg): beads remote URLs can be configured with inline
    // credentials too — strip them at serialization (defense in depth).
    url: stripUrlCredentials(project.beads_remote_url || null),
    name: project.beads_remote_name || null,
    status: project.beads_remote_status || 'not_provisioned',
    visibility: project.beads_remote_visibility || null,
    provisioned_at: toIsoTimestamp(project.beads_remote_provisioned_at),
    last_push_at: toIsoTimestamp(project.beads_remote_last_push_at),
    error: project.beads_remote_last_error || null,
  };
}

function toIsoTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const date = new Date(value as number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeIssueStatus(status: string | null | undefined): string {
  if (!status) return 'open';
  const s = status.toLowerCase().trim();
  if (CLOSED_ISSUE_STATUSES.has(s)) return 'closed';
  if (BLOCKED_ISSUE_STATUSES.has(s)) return 'blocked';
  if (DEFERRED_ISSUE_STATUSES.has(s)) return 'deferred';
  if (IN_PROGRESS_ISSUE_STATUSES.has(s)) return 'in_progress';
  return 'open';
}

function isIssueReady(issue: IssueLike): boolean {
  const status = normalizeIssueStatus(issue.status as string | null | undefined);
  if (status === 'closed' || status === 'blocked' || status === 'deferred') return false;
  if (issue.isBlocked) return false;
  if (issue.blockedBy && issue.blockedBy.length > 0) return false;
  return true;
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((x) => String(x));
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch { return []; }
  }
  return [];
}

function parseIssueList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return parseJsonArray(trimmed);
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getIssueTimestamp(issue: IssueLike): number | string | null {
  return issue.updated_at ?? issue.updatedAt ?? issue.modifiedAt ?? issue.beads_updated_at ?? issue.last_sync_at ?? null;
}

function getIssueUpdatedMs(issue: IssueLike): number {
  const value = getIssueTimestamp(issue);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) return parsedNumber;
    const parsedDate = Date.parse(value);
    return Number.isNaN(parsedDate) ? 0 : parsedDate;
  }
  return 0;
}

function getProjectUpdatedAt(project: ProjectLike): number | string | null {
  return project.updated_at ?? project.last_checked_at ?? project.last_sync_at ?? null;
}

function getProjectLastActivityAt(project: ProjectLike): number | string | null {
  return project.last_sync_at ?? project.last_checked_at ?? project.updated_at ?? null;
}

function getProjectFromDb(db: RouteDb, identifier: string): ProjectLike | null {
  const resolvedIdentifier = db.resolveProjectIdentifier?.(identifier) || identifier;
  return db.getProject?.(resolvedIdentifier) ?? null;
}

function getProjectIssuesFromDb(db: RouteDb, identifier: string): IssueLike[] {
  const resolvedIdentifier = db.resolveProjectIdentifier?.(identifier) || identifier;
  return db.getProjectIssues?.(resolvedIdentifier) ?? [];
}

function getCanonicalProjectIdentifier(db: RouteDb, identifier: string): string {
  return db.resolveProjectIdentifier?.(identifier) || identifier;
}

function summarizeTracker(project: ProjectLike, issues: IssueLike[], options: { data_freshness?: Record<string, unknown> } = {}): Record<string, unknown> {
  const totalKnown = issues.length > 0 ? issues.length : toNumber(project.issue_count, issues.length);
  const ready = issues.filter((issue) => isIssueReady(issue)).length;
  const closedRecent = issues.filter((issue) => normalizeIssueStatus(issue.status) === 'closed').length;
  const dataFreshness = options.data_freshness ?? getDataFreshness(project.last_sync_at);
  const status = dataFreshness.status === 'error' ? 'error' : 'available';
  return {
    provider: TRACKER_PROVIDER,
    status,
    capabilities: {
      work_items: true,
      issues: true,
      ready_work: true,
      issue_mutations: true,
    },
    summary: {
      total_known: totalKnown,
      ready,
      closed_recent: closedRecent,
    },
    data_freshness: dataFreshness,
  };
}

function serializeProjectSummary(project: ProjectLike, issues: IssueLike[] = [], options: { tracker?: { data_freshness?: Record<string, unknown> } } = {}): Record<string, unknown> {
  const updatedAt = getProjectUpdatedAt(project);
  return {
    id: project.identifier,
    identifier: project.identifier,
    name: project.name,
    status: project.status || 'active',
    tech_stack: project.tech_stack || null,
    repo: {
      provider: project.git_url ? 'git' : null,
      // SECURITY (vibesync-6kg): this is THE field that leaked the GitHub PAT.
      // Even though ingest now strips credentials, defense in depth requires we
      // sanitize at the response layer too — any future storage regression must
      // not reach the wire.
      remote_url: stripUrlCredentials(project.git_url || null),
      filesystem_path: project.filesystem_path || null,
      branch: null,
      dirty: null,
    },
    agents: {
      total: project.letta_agent_id ? 1 : 0,
      active: project.letta_agent_id ? 1 : 0,
      default_agent_id: project.letta_agent_id || null,
    },
    conversations: {
      total_known: 0,
      has_more: false,
      last_conversation_id: null,
    },
    tracker: summarizeTracker(project, issues, options.tracker),
    last_activity_at: toIsoTimestamp(getProjectLastActivityAt(project)),
    updated_at: toIsoTimestamp(updatedAt),
    version: updatedAt ? String(updatedAt) : null,
    etag: updatedAt ? `${project.identifier}:${updatedAt}` : null,
  };
}

function normalizeBeadsIssueForRoutes(issue: NormalizedBeadsIssue, projectIdentifier: string): IssueLike {
  const record = issue as unknown as Record<string, unknown>;
  return {
    ...issue,
    identifier: issue.identifier || issue.id,
    project_identifier: typeof record.project_identifier === 'string' ? record.project_identifier : projectIdentifier,
    issue_type: issue.issue_type || issue.type,
    created_at: issue.created_at || issue.createdAt,
    updated_at: issue.updated_at || issue.updatedAt,
    closed_at: issue.closed_at || issue.closedAt,
    blocked_by: issue.blocked_by || issue.blockedBy,
    blocks: issue.blocks || [],
    huly_id: typeof record.huly_id === 'string' ? record.huly_id : issue.identifier || issue.id,
    last_sync_at: (record.last_sync_at as string | number | null | undefined) || issue.updated_at || issue.updatedAt,
  };
}

function shouldPreferBeadsIssueSource(project: ProjectLike): boolean {
  return Boolean(project.filesystem_path && project.beads_remote_status === 'error');
}

async function getProjectIssuesWithBeadsFallback(options: {
  db: RouteDb;
  project: ProjectLike;
  projectIdentifier: string;
  beadsAdapter: BeadsAdapterApi | null;
  logger: Logger;
  filters?: BeadsListFilters;
}): Promise<{ issues: IssueLike[]; source: 'database' | 'beads'; error: string | null }> {
  const dbIssues = getProjectIssuesFromDb(options.db, options.projectIdentifier);
  const shouldHydrate =
    options.beadsAdapter &&
    options.project.filesystem_path &&
    (dbIssues.length === 0 || shouldPreferBeadsIssueSource(options.project));
  if (!shouldHydrate || !options.beadsAdapter) {
    return { issues: dbIssues, source: 'database', error: null };
  }

  try {
    const result = await options.beadsAdapter.listIssues(
      { identifier: options.project.identifier, filesystem_path: options.project.filesystem_path },
      options.filters || {},
      { forceRefresh: true },
    );
    const issues = (result.items || [])
      .filter((issue) => Boolean(issue?.id || issue?.identifier))
      .map((issue) => normalizeBeadsIssueForRoutes(issue, options.projectIdentifier));
    const activityDb = options.db as RouteDb & { updateProjectActivity?: (id: string, count: number) => void };
    activityDb.updateProjectActivity?.(options.projectIdentifier, issues.length);
    return { issues, source: 'beads', error: null };
  } catch (error) {
    options.logger.warn({ err: error, project_identifier: options.projectIdentifier }, 'Failed to hydrate issues from Beads fallback');
    return { issues: dbIssues, source: 'database', error: 'Issue data is temporarily unavailable from Beads' };
  }
}

function serializeAndroidIssue(issue: IssueLike, projectIssues: IssueLike[], options: { detail?: boolean } = {}): Record<string, unknown> {
  const id = String(issue.identifier ?? issue.id ?? '');
  const projectId = String(issue.project_identifier ?? issue.projectId ?? issue.project_id ?? '');
  const status = normalizeIssueStatus(issue.status);
  const labels = parseIssueList(issue.labels ?? issue.labels_json);
  const acceptanceCriteria = parseIssueList(issue.acceptanceCriteria ?? issue.acceptance_criteria);
  const blockedBy = parseIssueList(issue.blockedBy ?? issue.blocked_by ?? issue.blocked_by_json).map((blockedId) => ({ id: blockedId }));
  const blocks = projectIssues
    .filter((candidate) => String(candidate.parent_huly_id ?? candidate.parent_id ?? '') === String(issue.huly_id ?? id))
    .map((candidate) => ({ id: String(candidate.identifier ?? candidate.id ?? ''), status: normalizeIssueStatus(candidate.status), title: candidate.title ?? '' }));
  const updatedRaw = getIssueTimestamp(issue);
  const updatedAt = toIsoTimestamp(updatedRaw);
  const description = String(issue.description ?? '');
  const serialized: Record<string, unknown> = {
    id,
    projectId,
    provider: TRACKER_PROVIDER,
    title: String(issue.title ?? ''),
    type: String(issue.issue_type ?? issue.type ?? 'task'),
    priority: String(issue.priority ?? 'medium'),
    status,
    statusLabel: String(issue.status ?? status),
    ready: isIssueReady(issue),
    assignee: issue.assignee ?? null,
    blockedBy,
    blocks,
    isBlocked: blockedBy.length > 0 || status === 'blocked',
    updatedAt,
    summary: description ? description.split('\n\n')[0] : String(issue.title ?? '').slice(0, 200),
    acceptanceCriteria,
    labels,
    validationWarnings: issue.validationWarnings ?? [],
    etag: `${id}:${updatedRaw ?? 'unknown'}`,
  };
  if (options.detail) {
    serialized.description = description;
    serialized.timestamps = {
      created_at: toIsoTimestamp(issue.created_at ?? issue.createdAt),
      updated_at: updatedAt,
      last_sync_at: toIsoTimestamp(issue.last_sync_at),
    };
    serialized.metadata = {
      huly_id: issue.huly_id ?? null,
      vibe_task_id: issue.vibe_task_id ?? null,
    };
  }
  return serialized;
}

function paginateOffset<T>(items: T[], url: URL): { items: T[]; page: { limit: number; next_cursor: string | null; has_more: boolean; total_known: number } } {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const offset = decodeOffsetCursor(url.searchParams.get('cursor'));
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < items.length;
  return {
    items: slice,
    page: {
      limit,
      next_cursor: hasMore ? encodeOffsetCursor(nextOffset) : null,
      has_more: hasMore,
      total_known: items.length,
    },
  };
}

function serializeIssueDetail(issue: IssueLike): Record<string, unknown> {
  const normalizedStatus = normalizeIssueStatus(issue.status as string | null | undefined);
  const labels = parseJsonArray(issue.labels ?? issue.labels_json);
  const blockedByIds = parseJsonArray(issue.blocked_by ?? issue.blocked_by_json ?? issue.blockedBy);
  const blockedByRefs = blockedByIds.map((id) => ({ id }));
  const updatedAt = toIsoTimestamp(issue.beads_updated_at ?? issue.updated_at ?? issue.updatedAt);
  const createdAt = toIsoTimestamp(issue.created_at ?? issue.createdAt);
  const lastSyncAt = toIsoTimestamp(issue.last_sync_at);
  const id = String(issue.identifier ?? issue.id ?? '');
  const projectId = String(issue.project_identifier ?? issue.projectId ?? issue.project_id ?? '');
  return {
    id,
    project_id: projectId,
    provider: (issue.source as string) || TRACKER_PROVIDER,
    title: String(issue.title ?? ''),
    type: (issue.issue_type ?? issue.type ?? 'task'),
    priority: String(issue.priority ?? 'medium'),
    status: normalizedStatus,
    status_label: String(issue.status ?? 'todo'),
    ready: isIssueReady(issue),
    assignee: (issue.assignee ?? (issue as { owner?: string | null }).owner ?? null),
    blocked_by: blockedByRefs,
    blocks: [],
    is_blocked: blockedByIds.length > 0 || normalizedStatus === 'blocked',
    updated_at: updatedAt,
    created_at: createdAt,
    summary: String(issue.title ?? '').slice(0, 200),
    acceptance_criteria: [],
    labels,
    parent_id: (issue.parent_huly_id ?? null),
    child_count: Number(issue.sub_issue_count ?? 0),
    validation_warnings: [],
    etag: `${id}:${updatedAt ?? ''}`,
    description: String(issue.description ?? ''),
    design_notes: null,
    notes: [],
    comments: [],
    children: [],
    timestamps: {
      created_at: createdAt,
      updated_at: updatedAt,
      last_sync_at: lastSyncAt,
    },
    metadata: {
      huly_id: issue.huly_id ?? null,
      vibe_task_id: issue.vibe_task_id ?? null,
    },
  };
}

function serializeIssue(issue: IssueLike | null): Record<string, unknown> | null {
  if (!issue) return null;
  const normalizedStatus = normalizeIssueStatus(issue.status as string | null | undefined);
  const id = issue.id ?? issue.identifier;
  const blockedBy = parseJsonArray(issue.blockedBy ?? issue.blocked_by ?? issue.blocked_by_json);
  const labels = parseJsonArray(issue.labels ?? issue.labels_json);
  const acceptanceCriteria = Array.isArray(issue.acceptanceCriteria)
    ? issue.acceptanceCriteria
    : typeof issue.acceptance_criteria === 'string'
      ? [issue.acceptance_criteria]
      : [];
  const updatedAtRaw = issue.updatedAt ?? issue.modifiedAt ?? issue.updated_at ?? issue.beads_updated_at;
  return {
    id,
    projectId: issue.project_id ?? issue.projectId ?? issue.project_identifier,
    provider: TRACKER_PROVIDER,
    title: issue.title ?? '',
    type: issue.type ?? issue.issue_type ?? 'task',
    priority: String(issue.priority ?? 'medium'),
    status: normalizedStatus,
    statusLabel: issue.statusLabel ?? issue.status ?? 'todo',
    ready: isIssueReady(issue),
    assignee: issue.assignee ?? null,
    blockedBy,
    blocks: Array.isArray(issue.blocks) ? issue.blocks : [],
    isBlocked: !!(issue.isBlocked || blockedBy.length > 0),
    updatedAt: toIsoTimestamp(updatedAtRaw),
    summary: String(issue.title ?? '').slice(0, 200),
    acceptanceCriteria,
    labels,
    validationWarnings: issue.validationWarnings ?? [],
    etag: `${id}:${updatedAtRaw ?? 0}`,
  };
}

interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
  total_known: number;
}

interface KeyedItem {
  id?: string | number;
  identifier?: string | number;
}

function paginate<T extends KeyedItem>(items: T[], cursor?: string, limit = DEFAULT_PAGE_LIMIT): Paginated<T> {
  const effectiveLimit = Math.min(limit, MAX_PAGE_LIMIT);
  let startIdx = 0;
  if (cursor) {
    const idx = items.findIndex((item) => item.id === cursor || item.identifier === cursor);
    if (idx >= 0) startIdx = idx + 1;
  }
  const slice = items.slice(startIdx, startIdx + effectiveLimit);
  const lastItem = slice[slice.length - 1];
  const lastKey = lastItem ? String(lastItem.id ?? lastItem.identifier ?? '') : '';
  return {
    items: slice,
    next_cursor: lastItem && slice.length === effectiveLimit ? Buffer.from(lastKey).toString('base64') : null,
    has_more: startIdx + effectiveLimit < items.length,
    total_known: items.length,
  };
}

function getBeadsListFilters(url: URL): BeadsListFilters {
  const filters: BeadsListFilters = {};
  const status = url.searchParams.get('status');
  const priority = url.searchParams.get('priority');
  const type = url.searchParams.get('type');
  const assignee = url.searchParams.get('assignee');
  if (status) filters.status = normalizeIssueStatus(status);
  if (priority) filters.priority = priority;
  if (type) filters.type = type;
  if (assignee) filters.assignee = assignee;
  return filters;
}

interface BeadsHydrationResult {
  issues: IssueLike[];
  source: 'beads' | 'database';
  error: string | null;
}

async function hydrateIssuesFromBeads(
  beadsAdapter: BeadsAdapterApi | null,
  project: ProjectLike,
  filters: BeadsListFilters,
  logger: Logger,
): Promise<BeadsHydrationResult> {
  if (!beadsAdapter?.listIssues || !project.filesystem_path) {
    return { issues: [], source: 'database', error: null };
  }
  try {
    const result = await beadsAdapter.listIssues(
      { identifier: project.identifier, filesystem_path: project.filesystem_path },
      filters,
      { forceRefresh: true },
    );
    const issues = (result.items || []).filter((i): i is NormalizedBeadsIssue => Boolean(i?.id || i?.identifier));
    return { issues, source: 'beads', error: null };
  } catch (error) {
    logger.warn(
      { err: error, project_identifier: project.identifier },
      'Failed to hydrate issues from Beads',
    );
    return { issues: [], source: 'database', error: 'Issue data temporarily unavailable from Beads' };
  }
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number.parseInt(decoded, 10);
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function getDataFreshness(
  lastSyncAt: unknown,
  options: { status?: string; error?: string | null; source?: string | null } = {},
): Record<string, unknown> {
  const lastSyncIso = toIsoTimestamp(lastSyncAt);
  const status = options.status || (lastSyncIso ? 'available' : 'unknown');
  const error = options.error || null;
  const source = options.source || null;
  const lastSyncMs = lastSyncAt ? new Date(lastSyncAt as string | number).getTime() : null;
  const isStale =
    status === 'available' && lastSyncMs ? Date.now() - lastSyncMs > STALE_AFTER_MS : false;
  return {
    status: error ? 'error' : status,
    last_sync_at: lastSyncIso,
    error,
    source,
    is_stale: isStale,
    stale_threshold_ms: STALE_AFTER_MS,
  };
}

function getUnavailableFreshness(lastSyncAt: unknown, error: string): Record<string, unknown> {
  return getDataFreshness(lastSyncAt, { error });
}

function getSubresourceEtag(project: ProjectLike, subresource: string, lastSyncAt: unknown): string | null {
  const version = toIsoTimestamp(lastSyncAt) || toIsoTimestamp(project.updated_at ?? project.last_checked_at);
  return version ? `${project.identifier}:${subresource}:${version}` : null;
}

function matchesIssueStatus(issueStatus: unknown, requestedStatus: string | null): boolean {
  if (!requestedStatus) return true;
  const i = String(issueStatus ?? '').toLowerCase();
  const r = requestedStatus.toLowerCase();
  return i === r || normalizeIssueStatus(i) === normalizeIssueStatus(r);
}

function serializeWorkItem(issue: IssueLike): Record<string, unknown> {
  const status = issue.status ?? 'unknown';
  const isBlocked = String(status).toLowerCase() === 'blocked';
  return {
    id: issue.identifier ?? issue.id,
    provider: TRACKER_PROVIDER,
    title: issue.title ?? '',
    status,
    priority: issue.priority ?? null,
    type: issue.issue_type ?? issue.type ?? null,
    labels: [],
    assignee: issue.assignee ?? null,
    blocked: isBlocked,
    dependency_count: 0,
    parent_id: issue.parent_huly_id ?? issue.parent_vibe_id ?? null,
    child_count: toNumber(issue.sub_issue_count),
    updated_at: toIsoTimestamp(issue.updated_at ?? issue.last_sync_at ?? issue.updatedAt),
    created_at: toIsoTimestamp(issue.created_at ?? issue.createdAt),
    url: null,
    metadata: {
      vibe_task_id: issue.vibe_task_id ?? null,
      last_sync_at: toIsoTimestamp(issue.last_sync_at),
    },
  };
}

type ExtendedRouteDb = RouteDb & {
  getProjectSummary?: () => ProjectLike[];
  updateProjectActivity?: (id: string, count: number) => void;
  getRecentSyncs?: (limit: number) => Array<Record<string, unknown>>;
  getProjectFilesystemPath?: (id: string) => string | null;
  getProjectsWithFilesystemPath?: () => ProjectLike[];
  projects?: {
    getProjectLettaInfo?: (id: string) => Record<string, unknown>;
    getProjectsNeedingBeadsRemote?: () => ProjectLike[];
  };
};

type ProjectProvisioner = DoltHubProvisionerApi & {
  provisionProject?: (project: ProjectLike, options: { push: boolean }) => Promise<Record<string, unknown>>;
  dryRun?: boolean;
};

type MutationService = BeadsIssueServiceApi & {
  mutateIssue?: (input: Record<string, unknown>) => Promise<{ applied?: boolean; command?: string }>;
};

function hasAccessibleBeadsDatabase(project: ProjectLike): boolean {
  if (!project.filesystem_path) return false;
  return fs.existsSync(path.join(project.filesystem_path, '.beads'));
}

function isNonProvisionableBeadsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no beads database|not a dolt database|database is not usable|no such file|missing/i.test(message);
}

function getBeadsRemoteBatchProjects(db: ExtendedRouteDb, body: Record<string, unknown>): { projects: ProjectLike[]; missing: string[]; skipped: Array<Record<string, unknown>> } {
  const identifiers = Array.isArray(body.identifiers) ? body.identifiers.map((id) => String(id)) : [];
  const missing: string[] = [];
  const skipped: Array<Record<string, unknown>> = [];
  const candidates = identifiers.length > 0
    ? identifiers.flatMap((identifier) => {
      const canonical = getCanonicalProjectIdentifier(db, identifier);
      const project = getProjectFromDb(db, canonical);
      if (!project) missing.push(identifier);
      return project ? [project] : [];
    })
    : db.getProjectsWithFilesystemPath?.() ?? db.projects?.getProjectsNeedingBeadsRemote?.() ?? [];
  const projects = candidates.filter((project) => {
    if (hasAccessibleBeadsDatabase(project)) return true;
    skipped.push({
      identifier: project.identifier,
      status: 'skipped',
      reason: 'no_accessible_beads_database',
      filesystem_path: project.filesystem_path || null,
    });
    return false;
  });
  return { projects, missing, skipped };
}

async function handleIssueMutation(options: {
  req: Parameters<ParseJsonBody>[0];
  res: Parameters<SendJson>[0];
  pathname: string;
  action: string;
  parseJsonBody: ParseJsonBody;
  sendJson: SendJson;
  sendError: SendError;
  logger: Logger;
  db: ExtendedRouteDb | null;
  beadsIssueService: BeadsIssueServiceApi | null;
}): Promise<void> {
  const { req, res, pathname, action, parseJsonBody, sendJson, sendError, logger, db, beadsIssueService } = options;
  if (!db || !beadsIssueService) { sendError(res, 503, 'Issue mutation service not available'); return; }
  try {
    const issueId = decodeURIComponent(pathname.split('/')[3] || '');
    const issue = db.getIssue?.(issueId);
    if (!issue) { sendError(res, 404, 'Issue not found', { issueId }); return; }
    const body: Record<string, unknown> = await parseJsonBody(req).catch(() => ({}));
    const headers = req.headers || {};
    const headerEtag = Array.isArray(headers['if-match']) ? headers['if-match'][0] : headers['if-match'];
    const expectedEtag = headerEtag || body.if_match || body.ifMatch || null;
    const currentEtag = `${issue.identifier}:${getIssueTimestamp(issue) || 'unknown'}`;
    if (expectedEtag && expectedEtag !== currentEtag) {
      sendJson(res, 409, { error: 'Issue conflict', statusCode: 409, conflict: { reason: 'etag_mismatch', expected: expectedEtag, current: currentEtag, issueId }, timestamp: new Date().toISOString() });
      return;
    }
    const idempotencyKey = body.idempotency_key || body.idempotencyKey || headers['idempotency-key'] || headers['Idempotency-Key'] || null;
    const mutationService = beadsIssueService as MutationService;
    if (!mutationService.mutateIssue) { sendError(res, 503, 'Issue mutation service not available'); return; }
    const result = await mutationService.mutateIssue({ action, issue, body, idempotencyKey });
    const refreshedIssue = db.getIssue?.(issueId) || issue;
    const projectIssues = getProjectIssuesFromDb(db, refreshedIssue.project_identifier || '');
    sendJson(res, 200, { schema_version: 1, mutation: { action, idempotency_key: idempotencyKey, applied: result.applied !== false, command: result.command || null }, issue: serializeAndroidIssue(refreshedIssue, projectIssues, { detail: true }), timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error({ err: error, action }, 'Failed to mutate issue');
    sendError(res, 500, 'Failed to update issue', { error: error instanceof Error ? error.message : 'Issue mutation failed' });
  }
}

export function registerProjectRoutes(app: App, deps: RouteDeps): void {
  const { sendJson, sendError, logger, beadsIssueService, beadsAdapter } = deps;
  const projectRegistry = deps.projectRegistry as (ProjectRegistryApi & { scanProjects?: () => Record<string, unknown> }) | null;
  const db = deps.db as ExtendedRouteDb | null;
  const doltHubProvisioner = deps.doltHubProvisioner as ProjectProvisioner | null;
  const beadsIssueMirror = deps.beadsIssueMirror ?? null;

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/registry/projects' && method === 'GET',
    handle: async ({ res, url }) => {
      if (!projectRegistry?.getProjects) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      try {
        const filters: { status?: string; tech_stack?: string } = {};
        const status = url.searchParams.get('status');
        const techStack = url.searchParams.get('tech_stack');
        if (status) filters.status = status;
        if (techStack) filters.tech_stack = techStack;
        const projects = projectRegistry.getProjects(filters);
        sendJson(res, 200, { total: projects.length, projects: projects.map(serializeProject), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to get registry projects'); sendError(res, 500, 'Failed to fetch projects', { error: error instanceof Error ? error.message : 'Registry project list unavailable' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/projects' && method === 'GET',
    handle: async ({ res, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const filters: { status?: string; tech_stack?: string; mcp_enabled?: boolean } = {};
        const status = url.searchParams.get('status');
        const techStack = url.searchParams.get('tech_stack');
        const mcpEnabled = url.searchParams.get('mcp_enabled');
        if (status && ALLOWED_PROJECT_STATUSES.has(status)) filters.status = status;
        if (techStack) filters.tech_stack = techStack;
        if (mcpEnabled !== null) filters.mcp_enabled = mcpEnabled === 'true';

        const rows = db.getAllProjects?.(filters) ?? db.getProjectSummary?.() ?? [];
        const summaries = rows.map((project) => serializeProjectSummary(project));
        const cursor = url.searchParams.get('cursor');
        const limitParam = url.searchParams.get('limit');
        const timestamp = new Date().toISOString();
        if (cursor !== null || limitParam !== null) {
          const limit = Math.min(Math.max(toNumber(limitParam, DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
          const page = paginate(summaries as Array<Record<string, unknown> & { id: string }>, cursor || undefined, limit);
          sendJson(res, 200, {
            total: page.total_known,
            projects: page.items,
            timestamp,
            page: { next_cursor: page.next_cursor, has_more: page.has_more, total_known: page.total_known },
          });
          return;
        }
        sendJson(res, 200, {
          total: summaries.length,
          projects: summaries,
          timestamp,
          page: { next_cursor: null, has_more: false, total_known: summaries.length },
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to fetch projects');
        sendError(res, 500, 'Failed to fetch projects', { error: error instanceof Error ? error.message : 'Projects unavailable' });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/projects/beads-remote' && method === 'GET',
    handle: async ({ res }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const projects = db.projects?.getProjectsNeedingBeadsRemote?.() ?? [];
        const provisioned = projects.filter((project) => project.beads_remote_status === 'provisioned' && project.beads_remote_url).length;
        const failed = projects.filter((project) => project.beads_remote_status === 'error').length;
        sendJson(res, 200, { schema_version: 1, total: projects.length, summary: { provisioned, failed, needs_provisioning: projects.length - provisioned }, projects: projects.map((project) => ({ identifier: project.identifier, name: project.name, filesystem_path: project.filesystem_path, beads_remote: serializeBeadsRemoteStatus(project) })), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to list Beads remote migration inventory'); sendError(res, 500, 'Failed to list Beads remote migration inventory', { error: 'Beads remote inventory is temporarily unavailable' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/projects/beads-remote/provision' && method === 'POST',
    handle: async ({ req, res }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      if (!doltHubProvisioner?.provisionProject) { sendError(res, 503, 'DoltHub provisioning service not available'); return; }
      const body: Record<string, unknown> = await deps.parseJsonBody(req).catch(() => ({}));
      const push = body.push !== false;
      const continueOnError = body.continue_on_error !== false && body.continueOnError !== false;
      const { projects, missing, skipped } = getBeadsRemoteBatchProjects(db, body);
      const results: Array<Record<string, unknown>> = [];
      const errors: Array<Record<string, unknown>> = missing.map((identifier) => ({ identifier, status: 'error', error: 'Project not found' }));
      for (const project of projects) {
        try {
          const provisioning = await doltHubProvisioner.provisionProject(project, { push });
          const refreshed = db.getProject?.(project.identifier) ?? project;
          results.push({ identifier: project.identifier, status: provisioning.status, provisioning, beads_remote: serializeBeadsRemoteStatus(refreshed) });
        } catch (error) {
          if (isNonProvisionableBeadsError(error)) { skipped.push({ identifier: project.identifier, status: 'skipped', reason: 'unusable_beads_database', filesystem_path: project.filesystem_path || null, error: error instanceof Error ? error.message : 'Beads database is not usable for DoltHub provisioning' }); continue; }
          errors.push({ identifier: project.identifier, status: 'error', error: error instanceof Error ? error.message : 'Beads remote provisioning failed' });
          if (!continueOnError) break;
        }
      }
      sendJson(res, errors.length > 0 && results.length === 0 ? 500 : 200, { schema_version: 1, message: doltHubProvisioner.dryRun ? 'Beads remote batch provisioning dry run complete' : 'Beads remote batch provisioning complete', dry_run: Boolean(doltHubProvisioner.dryRun), push, total_requested: projects.length + missing.length + skipped.length, summary: { succeeded: results.length, failed: errors.length, skipped: skipped.length }, results, errors, skipped, timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const requested = decodeURIComponent(pathname.split('/')[3] || '');
        const projectId = getCanonicalProjectIdentifier(db, requested);
        const project = getProjectFromDb(db, projectId);
        if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
        let issues: IssueLike[] = [];
        let trackerOptions: { data_freshness?: Record<string, unknown> } = {};
        try { issues = getProjectIssuesFromDb(db, projectId); }
        catch (error) { logger.error({ err: error, project_identifier: projectId }, 'Failed to hydrate tracker'); trackerOptions = { data_freshness: getUnavailableFreshness(project.last_sync_at, 'Tracker data is temporarily unavailable') }; }
        sendJson(res, 200, { project: serializeProjectSummary(project, issues, { tracker: trackerOptions }), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to get project detail'); sendError(res, 500, 'Failed to fetch project', { error: error instanceof Error ? error.message : 'Project unavailable' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/beads-remote$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const requested = decodeURIComponent(pathname.split('/')[3] || '');
        const projectId = getCanonicalProjectIdentifier(db, requested);
        const project = getProjectFromDb(db, projectId);
        if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
        sendJson(res, 200, { project_identifier: projectId, beads_remote: serializeBeadsRemoteStatus(project), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to get Beads remote status'); sendError(res, 500, 'Failed to fetch Beads remote status', { error: 'Beads remote status is temporarily unavailable' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'POST' && /^\/api\/projects\/[^/]+\/beads-remote\/provision$/.test(pathname),
    handle: async ({ req, res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      if (!doltHubProvisioner?.provisionProject) { sendError(res, 503, 'DoltHub provisioning service not available'); return; }
      try {
        const requested = decodeURIComponent(pathname.split('/')[3] || '');
        const projectId = getCanonicalProjectIdentifier(db, requested);
        const project = getProjectFromDb(db, projectId) ?? projectRegistry?.getProject?.(requested) ?? null;
        if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
        if (!project.filesystem_path) { sendError(res, 400, 'Project has no filesystem path', { identifier: requested }); return; }
        const body: Record<string, unknown> = await deps.parseJsonBody(req).catch(() => ({}));
        const result = await doltHubProvisioner.provisionProject(project, { push: body.push !== false });
        sendJson(res, 200, { message: result.dry_run ? 'Beads remote provisioning dry run complete' : 'Beads remote provisioned', provisioning: result, beads_remote: serializeBeadsRemoteStatus(db.getProject?.(projectId) ?? project), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to provision Beads remote'); sendError(res, 500, 'Failed to provision Beads remote', { error: error instanceof Error ? error.message : 'Beads remote provisioning failed' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'POST' && /^\/api\/projects\/[^/]+\/ast-sync$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      if (!deps.codePerceptionWatcher?.astInitialSync) { sendError(res, 503, 'AST sync service not available'); return; }
      try {
        const requested = decodeURIComponent(pathname.split('/')[3] || '');
        const projectId = getCanonicalProjectIdentifier(db, requested);
        const project = getProjectFromDb(db, projectId);
        const filesystemPath = project?.filesystem_path ?? db.getProjectFilesystemPath?.(projectId) ?? null;
        if (!project || !filesystemPath) { sendError(res, 404, 'Project not found or has no filesystem path', { identifier: requested }); return; }
        const result = await deps.codePerceptionWatcher.astInitialSync(filesystemPath);
        sendJson(res, 200, { status: 'complete', ...result, timestamp: new Date().toISOString() });
      } catch (error) {
        logger.error({ err: error }, 'Failed to trigger AST sync');
        sendError(res, 500, 'Failed to trigger AST sync', { error: error instanceof Error ? error.message : 'AST sync failed' });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/agents$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      const lettaInfo = db.projects?.getProjectLettaInfo?.(projectId) ?? { letta_agent_id: project.letta_agent_id, letta_folder_id: project.letta_folder_id, letta_source_id: project.letta_source_id, letta_last_sync_at: project.letta_last_sync_at };
      const agentId = typeof lettaInfo.letta_agent_id === 'string' ? lettaInfo.letta_agent_id : null;
      const lastSync = lettaInfo.letta_last_sync_at ?? null;
      const agents = agentId ? [{ id: agentId, name: project.name, role: 'project_pm', active: true, folder_id: lettaInfo.letta_folder_id ?? null, source_id: lettaInfo.letta_source_id ?? null, last_sync_at: toIsoTimestamp(lastSync) }] : [];
      const page = paginateOffset(agents, url);
      sendJson(res, 200, { project_identifier: projectId, agents: page.items, page: page.page, etag: getSubresourceEtag(project, 'agents', lastSync), data_freshness: getDataFreshness(lastSync), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/conversations$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      const page = paginateOffset([], url);
      sendJson(res, 200, { project_identifier: projectId, conversations: page.items, page: page.page, tracker: { provider: 'letta', status: 'not_tracked', capabilities: { conversations: false } }, etag: getSubresourceEtag(project, 'conversations', project.updated_at), data_freshness: getDataFreshness(null, { status: 'unavailable' }), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/work-items$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      try {
        let freshnessSource: 'database' | 'mirror' | 'beads' = 'database';
        let mirrorError: string | null = null;
        if (beadsIssueMirror?.ensureFresh && project.filesystem_path) {
          try {
            const mirrorResult = await beadsIssueMirror.ensureFresh(projectId);
            mirrorError = mirrorResult.error;
            freshnessSource = mirrorResult.source === 'cached' ? 'database' : 'mirror';
          } catch (mirrorErr) {
            logger.warn({ err: mirrorErr, project_identifier: projectId }, 'Mirror ensureFresh failed on work-items; serving fallback data');
          }
        }
        const hydrated = await getProjectIssuesWithBeadsFallback({ db, project, projectIdentifier: projectId, beadsAdapter, logger, filters: getBeadsListFilters(url) });
        if (hydrated.source === 'beads') freshnessSource = 'beads';
        const status = url.searchParams.get('status');
        const priority = url.searchParams.get('priority');
        const filtered = hydrated.issues.filter((issue) => matchesIssueStatus(issue.status, status) && (!priority || String(issue.priority ?? '') === priority));
        const page = paginateOffset(filtered.map(serializeWorkItem), url);
        const cursorOffset = decodeOffsetCursor(url.searchParams.get('cursor'));
        sendJson(res, 200, { project_identifier: projectId, provider: TRACKER_PROVIDER, work_items: page.items.map((item, index) => ({ ...item, cursor: encodeOffsetCursor(cursorOffset + index + 1) })), page: page.page, etag: getSubresourceEtag(project, 'work-items', project.last_sync_at), data_freshness: hydrated.error || mirrorError ? getUnavailableFreshness(project.last_sync_at, 'Work item data is temporarily unavailable') : getDataFreshness(project.last_sync_at, { source: freshnessSource }), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error, project_identifier: projectId }, 'Failed to hydrate work items'); sendJson(res, 200, { project_identifier: projectId, provider: TRACKER_PROVIDER, work_items: [], page: { limit: DEFAULT_PAGE_LIMIT, next_cursor: null, has_more: false, total_known: 0 }, etag: getSubresourceEtag(project, 'work-items', project.last_sync_at), data_freshness: getUnavailableFreshness(project.last_sync_at, 'Work item data is temporarily unavailable'), timestamp: new Date().toISOString() }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/issues$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { projectIdentifier: projectId }); return; }
      const hydrated = await getProjectIssuesWithBeadsFallback({ db, project, projectIdentifier: projectId, beadsAdapter, logger, filters: getBeadsListFilters(url) });
      let filtered = hydrated.issues;
      const status = url.searchParams.get('status');
      const ready = url.searchParams.get('ready');
      const updatedSince = url.searchParams.get('updatedSince') || url.searchParams.get('updated_since');
      if (status) filtered = filtered.filter((issue) => status.split(',').some((s) => matchesIssueStatus(issue.status, s.trim())));
      if (ready === 'true') filtered = filtered.filter((issue) => isIssueReady(issue));
      if (ready === 'false') filtered = filtered.filter((issue) => !isIssueReady(issue));
      if (updatedSince) {
        const since = Number.isFinite(Number(updatedSince)) ? Number(updatedSince) : Date.parse(updatedSince);
        if (Number.isFinite(since)) filtered = filtered.filter((issue) => getIssueUpdatedMs(issue) >= since);
      }
      const sort = url.searchParams.get('sort') || 'priority';
      filtered = [...filtered].sort((a, b) => sort === 'updated' ? getIssueUpdatedMs(b) - getIssueUpdatedMs(a) : String(a.priority || '').localeCompare(String(b.priority || '')));
      const serialized = filtered.map((issue) => serializeAndroidIssue(issue, hydrated.issues));
      const page = paginateOffset(serialized, url);
      sendJson(res, 200, { schema_version: 1, projectId, issues: page.items, page: page.page, etag: getSubresourceEtag(project, 'issues', project.last_sync_at), data_freshness: hydrated.error ? getUnavailableFreshness(project.last_sync_at, hydrated.error) : getDataFreshness(project.last_sync_at, { source: hydrated.source }), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/ready-work$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { projectIdentifier: projectId }); return; }
      const hydrated = await getProjectIssuesWithBeadsFallback({ db, project, projectIdentifier: projectId, beadsAdapter, logger });
      const readyIssues = hydrated.issues.filter((issue) => isIssueReady(issue));
      const page = paginateOffset(readyIssues.map((issue) => serializeAndroidIssue(issue, hydrated.issues)), url);
      sendJson(res, 200, { schema_version: 1, projectId, readyWork: page.items, page: page.page, etag: getSubresourceEtag(project, 'ready-work', project.last_sync_at), data_freshness: hydrated.error ? getUnavailableFreshness(project.last_sync_at, hydrated.error) : getDataFreshness(project.last_sync_at, { source: hydrated.source }), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/issues\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const issueId = decodeURIComponent(pathname.split('/')[3] || '');
      const issue = db.getIssue?.(issueId) ?? beadsIssueService?.getIssue?.(issueId) ?? null;
      if (!issue) { sendError(res, 404, 'Issue not found', { issueId }); return; }
      const projectIssues = getProjectIssuesFromDb(db, issue.project_identifier || '');
      sendJson(res, 200, { schema_version: 1, issue: serializeAndroidIssue(issue, projectIssues, { detail: true }), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => {
      if (method !== 'POST' && method !== 'PATCH') return false;
      const action = pathname.match(/^\/api\/issues\/[^/]+\/([^/]+)$/)?.[1];
      return Boolean(action && new Set(['claim', 'unclaim', 'status', 'notes', 'close', 'reopen']).has(action));
    },
    handle: async ({ req, res, pathname }) => {
      const operation = pathname.split('/')[4] || '';
      const actionMap: Record<string, string> = { claim: 'claim', unclaim: 'unclaim', status: 'update_status', notes: 'add_note', close: 'close', reopen: 'reopen' };
      await handleIssueMutation({ req, res, pathname, action: actionMap[operation] || operation, parseJsonBody: deps.parseJsonBody, sendJson, sendError, logger, db, beadsIssueService });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/activity$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = decodeURIComponent(pathname.split('/')[3] || '');
      const projectId = getCanonicalProjectIdentifier(db, requested);
      const project = getProjectFromDb(db, projectId);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      const syncs = db.getRecentSyncs?.(MAX_PAGE_LIMIT) ?? [];
      const activities = syncs.map((sync) => ({ id: String(sync.id), type: 'sync', status: sync.completed_at ? 'completed' : 'running', project_identifier: projectId, occurred_at: toIsoTimestamp(sync.completed_at || sync.started_at), metadata: { projects_processed: toNumber(sync.projects_processed), projects_failed: toNumber(sync.projects_failed), issues_synced: toNumber(sync.issues_synced), duration_ms: sync.duration_ms || null } }));
      const page = paginateOffset(activities, url);
      const freshnessTime = syncs[0]?.completed_at || syncs[0]?.started_at || null;
      sendJson(res, 200, { project_identifier: projectId, activity: page.items, page: page.page, etag: getSubresourceEtag(project, 'activity', freshnessTime), data_freshness: getDataFreshness(freshnessTime), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/issue-analytics$/.test(pathname),
    handle: async ({ res, pathname, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const requested = decodeURIComponent(pathname.split('/')[3] || '');
        const projectId = getCanonicalProjectIdentifier(db, requested);
        const project = getProjectFromDb(db, projectId);
        if (!project) { sendError(res, 404, 'Project not found', { projectIdentifier: projectId }); return; }
        const range = getAnalyticsRange(url);
        const hydrated = await getProjectIssuesWithBeadsFallback({ db, project, projectIdentifier: projectId, beadsAdapter, logger, filters: getBeadsListFilters(url) });
        const analytics = buildIssueAnalytics(hydrated.issues, range, url);
        sendJson(res, 200, { schema_version: 1, projectId, rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, granularity: range.granularity, timezone: range.timezone, createdBuckets: analytics.createdBuckets, completedBuckets: analytics.completedBuckets, completedTimeline: analytics.completedTimeline, summary: analytics.summary, nextTimelineCursor: analytics.nextTimelineCursor, timelinePage: analytics.timelinePage, completionSource: 'issue_close_metadata', isPartial: true, etag: getSubresourceEtag(project, 'issue-analytics', project.last_sync_at), data_freshness: hydrated.error ? getUnavailableFreshness(project.last_sync_at, hydrated.error) : getDataFreshness(project.last_sync_at, { source: hydrated.source }), generatedAt: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to get issue analytics'); const message = error instanceof Error ? error.message : 'Issue analytics are temporarily unavailable'; sendError(res, /rangeEnd|granularity|time zone|timezone/i.test(message) ? 400 : 500, 'Failed to fetch issue analytics', { error: message }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/registry/projects' && method === 'POST',
    handle: async ({ req, res }) => {
      if (!projectRegistry?.registerProject) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      try {
        const body = await deps.parseJsonBody(req);
        const filesystemPath = typeof body.filesystem_path === 'string' ? body.filesystem_path.trim() : '';
        if (!filesystemPath) { sendError(res, 400, 'filesystem_path is required', { field: 'filesystem_path' }); return; }
        if (!isAbsolutePath(filesystemPath)) { sendError(res, 400, 'filesystem_path must be an absolute path', { field: 'filesystem_path' }); return; }
        const project = projectRegistry.registerProject(filesystemPath);
        if (!project) { sendError(res, 500, 'Failed to register project'); return; }
        const updates: Partial<ProjectRow> = {};
        if (typeof body.name === 'string') updates.name = body.name.trim();
        if (typeof body.git_url === 'string') updates.git_url = body.git_url.trim();
        const updatedProject = projectRegistry.updateProject?.(project.identifier, updates) ?? project;
        sendJson(res, 201, { message: 'Project registered', project: serializeProject(updatedProject), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to register project'); sendError(res, 400, 'Failed to register project', { error: error instanceof Error ? error.message : 'Project registration failed' }); }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'PATCH' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ req, res, pathname }) => {
      if (!projectRegistry?.updateProject) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = decodeURIComponent(pathname.split('/')[4] || '');
      const body = await deps.parseJsonBody(req);
      const updates: Partial<ProjectRow> = {};
      if (body.filesystem_path !== undefined) {
        if (typeof body.filesystem_path !== 'string' || !isAbsolutePath(body.filesystem_path)) { sendError(res, 400, 'filesystem_path must be an absolute path', { field: 'filesystem_path' }); return; }
        updates.filesystem_path = body.filesystem_path.trim();
      }
      if (body.git_url !== undefined) updates.git_url = typeof body.git_url === 'string' ? body.git_url.trim() : String(body.git_url);
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !ALLOWED_PROJECT_STATUSES.has(body.status.trim())) { sendError(res, 400, 'status must be one of: active, archived', { field: 'status' }); return; }
        updates.status = body.status.trim();
      }
      const project = projectRegistry.updateProject(identifier, updates);
      if (!project) { sendError(res, 404, 'Project not found', { identifier }); return; }
      sendJson(res, 200, { message: 'Project updated', project: serializeProject(project), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'DELETE' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry?.deleteProject) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = decodeURIComponent(pathname.split('/')[4] || '');
      if (!projectRegistry.deleteProject(identifier)) { sendError(res, 404, 'Project not found', { identifier }); return; }
      sendJson(res, 200, { message: 'Project deleted', identifier, timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry?.getProject) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = decodeURIComponent(pathname.split('/')[4] || '');
      const project = projectRegistry.getProject(identifier);
      if (!project) { sendError(res, 404, 'Project not found', { identifier }); return; }
      sendJson(res, 200, { ...serializeProject(project), timestamp: new Date().toISOString() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'POST' && /^\/api\/registry\/projects\/[^/]+\/scan$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry?.getProject || !projectRegistry.scanProjects) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = decodeURIComponent(pathname.split('/')[4] || '');
      if (!projectRegistry.getProject(identifier)) { sendError(res, 404, 'Project not found', { identifier }); return; }
      const result = projectRegistry.scanProjects();
      sendJson(res, 200, { message: 'Scan complete', scan: result, project: serializeProject(projectRegistry.getProject(identifier)), timestamp: new Date().toISOString() });
    },
  });

  // GET /api/projects
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/projects' && method === 'GET',
    handle: async ({ res, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const statusFilter = url.searchParams.get('status');
        const techStackFilter = url.searchParams.get('tech_stack');
        const mcpEnabledFilter = url.searchParams.get('mcp_enabled');
        const filters: { status?: string; tech_stack?: string; mcp_enabled?: boolean } = {};
        if (statusFilter && ALLOWED_PROJECT_STATUSES.has(statusFilter)) filters.status = statusFilter;
        if (techStackFilter) filters.tech_stack = techStackFilter;
        if (mcpEnabledFilter !== null) filters.mcp_enabled = mcpEnabledFilter === 'true';
        const rows: ProjectRow[] = db.getAllProjects
          ? db.getAllProjects(filters)
          : (projectRegistry?.getProjects ? projectRegistry.getProjects(filters) : []);
        const projects = rows
          .map((p) => serializeProject(p))
          .filter((p): p is NonNullable<typeof p> => p !== null);
        const cursorParam = url.searchParams.get('cursor');
        const limitParam = url.searchParams.get('limit');
        const paginated = cursorParam !== null || limitParam !== null;
        const timestamp = new Date().toISOString();
        if (paginated) {
          const limit = Math.min(toNumber(limitParam, DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
          const page = paginate(projects, cursorParam || undefined, limit);
          sendJson(res, 200, {
            total: page.total_known,
            projects: page.items,
            timestamp,
            page: { next_cursor: page.next_cursor, has_more: page.has_more, total_known: page.total_known },
          });
        } else {
          sendJson(res, 200, {
            total: projects.length,
            projects,
            timestamp,
            page: { next_cursor: null, has_more: false, total_known: projects.length },
          });
        }
      } catch (error) { logger.error({ err: error }, 'Failed to list projects'); sendError(res, 500, 'Failed to list projects', { error: (error as Error).message }); }
    },
  });

  // GET /api/projects/:id/issues
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/projects/') && pathname.endsWith('/issues') && method === 'GET',
    handle: async ({ res, url, pathname }) => {
      const projectId = pathname.replace('/api/projects/', '').replace('/issues', '');
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const project = db.getProject ? db.getProject(projectId) : (projectRegistry?.getProject ? projectRegistry.getProject(projectId) : null);
        if (!project) { sendError(res, 404, 'Project not found'); return; }
        let issueSource: 'database' | 'mirror' | 'beads' = 'database';
        let hydrationError: string | null = null;
        let mirrorResult: { source: string; error: string | null; changed: number; durationMs: number } | null = null;
        if (beadsIssueMirror?.ensureFresh && project.filesystem_path) {
          try { mirrorResult = await beadsIssueMirror.ensureFresh(projectId); }
          catch (mirrorErr) { logger.warn({ err: mirrorErr, project_identifier: projectId }, 'Mirror ensureFresh failed; serving stale DB rows'); }
          if (mirrorResult) {
            hydrationError = mirrorResult.error;
            issueSource = mirrorResult.source === 'cached' ? 'database' : 'mirror';
          }
        }
        let allIssues: IssueLike[] = db.getProjectIssues ? db.getProjectIssues(projectId) : [];
        if (allIssues.length === 0 && beadsAdapter?.listIssues && project.filesystem_path) {
          const hydrated = await hydrateIssuesFromBeads(beadsAdapter, project, getBeadsListFilters(url), logger);
          if (hydrated.issues.length > 0) { allIssues = hydrated.issues; issueSource = 'beads'; }
          if (hydrated.error) hydrationError = hydrated.error;
        }
        let filtered: IssueLike[] = allIssues;
        const statusFilter = url.searchParams.get('status');
        const priorityFilter = url.searchParams.get('priority');
        const typeFilter = url.searchParams.get('type');
        const readyFilter = url.searchParams.get('ready');
        const q = url.searchParams.get('q');
        const updatedSince = url.searchParams.get('updatedSince') || url.searchParams.get('updated_since');
        const sort = url.searchParams.get('sort') || 'priority';

        if (statusFilter) {
          const statuses = statusFilter.split(',').map((s) => s.trim().toLowerCase());
          filtered = filtered.filter((i) => statuses.includes(normalizeIssueStatus(i.status)));
        }
        if (priorityFilter) {
          const priorities = priorityFilter.split(',').map((p) => p.trim().toLowerCase());
          filtered = filtered.filter((i) => priorities.includes(String(i.priority ?? 'medium').toLowerCase()));
        }
        if (typeFilter) filtered = filtered.filter((i) => (i.type ?? i.issue_type) === typeFilter);
        if (readyFilter === 'true') filtered = filtered.filter((i) => isIssueReady(i));
        if (readyFilter === 'false') filtered = filtered.filter((i) => !isIssueReady(i));
        if (q) {
          const query = q.toLowerCase();
          filtered = filtered.filter((i) =>
            (i.title ?? '').toLowerCase().includes(query) ||
            (i.description ?? '').toLowerCase().includes(query),
          );
        }
        if (updatedSince) {
          const since = toNumber(updatedSince);
          if (since) {
            filtered = filtered.filter((i) => {
              const t = toNumber(i.updatedAt ?? i.modifiedAt ?? i.updated_at);
              return t >= since;
            });
          }
        }

        if (sort === 'updated') {
          filtered.sort((a, b) =>
            toNumber(b.updatedAt ?? b.modifiedAt ?? b.updated_at) -
            toNumber(a.updatedAt ?? a.modifiedAt ?? a.updated_at),
          );
        } else if (sort === 'created') {
          filtered.sort((a, b) => toNumber(b.createdAt ?? b.created_at) - toNumber(a.createdAt ?? a.created_at));
        } else {
          const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
          filtered.sort((a, b) =>
            (priorityOrder[String(a.priority ?? 'none').toLowerCase()] ?? 4) -
            (priorityOrder[String(b.priority ?? 'none').toLowerCase()] ?? 4),
          );
        }

        const serialized = filtered
          .map((issue) => serializeIssue(issue))
          .filter((s): s is NonNullable<typeof s> => s !== null);
        const cursor = url.searchParams.get('cursor');
        const limit = Math.min(toNumber(url.searchParams.get('limit'), DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
        const page = paginate(serialized, cursor || undefined, limit);
        const trackerStats = {
          total: allIssues.length, filtered: serialized.length,
          open: allIssues.filter((i) => normalizeIssueStatus(i.status) === 'open').length,
          inProgress: allIssues.filter((i) => normalizeIssueStatus(i.status) === 'in_progress').length,
          closed: allIssues.filter((i) => normalizeIssueStatus(i.status) === 'closed').length,
          blocked: allIssues.filter((i) => normalizeIssueStatus(i.status) === 'blocked').length,
        };
        const dataFreshness: Record<string, unknown> = { status: hydrationError ? 'stale' : 'fresh', last_sync_at: toIsoTimestamp(project.last_sync_at), source: issueSource };
        if (hydrationError) dataFreshness.error = hydrationError;
        sendJson(res, 200, { projectId, project: serializeProject(project), issues: page.items, tracker_stats: trackerStats, data_freshness: dataFreshness, page: { next_cursor: page.next_cursor, has_more: page.has_more, total_known: page.total_known } });
      } catch (error) { logger.error({ err: error }, 'Failed to list issues'); sendError(res, 500, 'Failed to list issues', { error: (error as Error).message }); }
    },
  });

  // GET /api/projects/:id/work-items
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/projects/') && pathname.endsWith('/work-items') && method === 'GET',
    handle: async ({ res, url, pathname }) => {
      const projectId = pathname.replace('/api/projects/', '').replace('/work-items', '');
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const project = db.getProject ? db.getProject(projectId) : (projectRegistry?.getProject ? projectRegistry.getProject(projectId) : null);
        if (!project) { sendError(res, 404, 'Project not found', { identifier: projectId }); return; }

        const statusFilter = url.searchParams.get('status');
        const priorityFilter = url.searchParams.get('priority');

        let issueSource: 'database' | 'mirror' | 'beads' = 'database';
        let hydrationError: string | null = null;

        if (beadsIssueMirror?.ensureFresh && project.filesystem_path) {
          try {
            const mirrorResult = await beadsIssueMirror.ensureFresh(projectId);
            hydrationError = mirrorResult.error;
            issueSource = mirrorResult.source === 'cached' ? 'database' : 'mirror';
          } catch (mirrorErr) {
            logger.warn({ err: mirrorErr, project_identifier: projectId }, 'Mirror ensureFresh failed on work-items; serving DB rows');
          }
        }

        let allIssues: IssueLike[] = [];
        try {
          allIssues = db.getProjectIssues ? db.getProjectIssues(projectId) : [];
        } catch (dbErr) {
          logger.error({ err: dbErr, project_identifier: projectId }, 'Failed to read project issues for work-items');
          sendJson(res, 200, {
            project_identifier: projectId,
            provider: TRACKER_PROVIDER,
            work_items: [],
            page: { limit: DEFAULT_PAGE_LIMIT, next_cursor: null, has_more: false, total_known: 0 },
            etag: getSubresourceEtag(project, 'work-items', project.last_sync_at),
            data_freshness: getUnavailableFreshness(project.last_sync_at, 'Work item data is temporarily unavailable'),
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (allIssues.length === 0 && beadsAdapter?.listIssues && project.filesystem_path) {
          const filters: BeadsListFilters = {};
          if (statusFilter) filters.status = normalizeIssueStatus(statusFilter);
          const hydrated = await hydrateIssuesFromBeads(beadsAdapter, project, filters, logger);
          if (hydrated.issues.length > 0) {
            allIssues = hydrated.issues;
            issueSource = 'beads';
          }
          if (hydrated.error) hydrationError = hydrated.error;
        }

        const filtered = allIssues.filter((i) => {
          if (!matchesIssueStatus(i.status, statusFilter)) return false;
          if (priorityFilter && String(i.priority ?? '') !== priorityFilter) return false;
          return true;
        });

        const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
        const limit = Math.min(
          Math.max(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_LIMIT, 1),
          MAX_PAGE_LIMIT,
        );
        const offset = decodeOffsetCursor(url.searchParams.get('cursor'));
        const slice = filtered.slice(offset, offset + limit);
        const nextOffset = offset + slice.length;
        const hasMore = nextOffset < filtered.length;

        const workItems = slice.map((issue, index) => ({
          ...serializeWorkItem(issue),
          cursor: encodeOffsetCursor(offset + index + 1),
        }));

        const dataFreshness = hydrationError
          ? getUnavailableFreshness(project.last_sync_at, hydrationError)
          : getDataFreshness(project.last_sync_at, { source: issueSource });

        sendJson(res, 200, {
          project_identifier: projectId,
          provider: TRACKER_PROVIDER,
          work_items: workItems,
          page: {
            limit,
            next_cursor: hasMore ? encodeOffsetCursor(nextOffset) : null,
            has_more: hasMore,
            total_known: filtered.length,
          },
          etag: getSubresourceEtag(project, 'work-items', project.last_sync_at),
          data_freshness: dataFreshness,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to list project work-items');
        sendError(res, 500, 'Failed to fetch project work items', { error: (error as Error).message });
      }
    },
  });

  // GET /api/issues/:id
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/issues/') && !pathname.endsWith('/issues') && method === 'GET',
    handle: async ({ res, pathname }) => {
      const issueId = pathname.replace('/api/issues/', '');
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        let issue: IssueLike | null = db.getIssue ? db.getIssue(issueId) : null;
        if (issue && beadsIssueMirror?.ensureFresh) {
          const projectId = String(issue.project_identifier ?? '');
          if (projectId) {
            try { await beadsIssueMirror.ensureFresh(projectId); }
            catch (mirrorErr) { logger.warn({ err: mirrorErr, issueId }, 'Mirror ensureFresh on detail failed'); }
            issue = (db.getIssue?.(issueId) ?? issue);
          }
        }
        if (!issue && beadsIssueService?.getIssue) {
          issue = beadsIssueService.getIssue(issueId);
        }
        if (!issue) { sendError(res, 404, 'Issue not found'); return; }
        sendJson(res, 200, { issue: serializeIssueDetail(issue), timestamp: new Date().toISOString() });
      } catch (error) { logger.error({ err: error }, 'Failed to get issue'); sendError(res, 500, 'Failed to get issue', { error: (error as Error).message }); }
    },
  });

  // GET /api/projects/:id/ready-work
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/projects/') && pathname.endsWith('/ready-work') && method === 'GET',
    handle: async ({ res, url, pathname }) => {
      const projectId = pathname.replace('/api/projects/', '').replace('/ready-work', '');
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const allIssues: IssueLike[] = db.getProjectIssues ? db.getProjectIssues(projectId) : [];
        const ready = allIssues.filter((i) => isIssueReady(i));
        const serialized = ready
          .map((issue) => serializeIssue(issue))
          .filter((s): s is NonNullable<typeof s> => s !== null);
        const cursor = url.searchParams.get('cursor');
        const limit = Math.min(toNumber(url.searchParams.get('limit'), DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
        const page = paginate(serialized, cursor || undefined, limit);
        sendJson(res, 200, { projectId, ready_work: page.items, page: { next_cursor: page.next_cursor, has_more: page.has_more, total_known: page.total_known } });
      } catch (error) { logger.error({ err: error }, 'Failed to get ready work'); sendError(res, 500, 'Failed to get ready work', { error: (error as Error).message }); }
    },
  });

  // GET /api/projects/:id/issue-analytics
  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/issue-analytics$/.test(pathname),
    handle: async ({ res, url, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const projectId = decodeURIComponent(pathname.split('/')[3]!);
        const project = db.getProject ? db.getProject(projectId) : null;
        if (!project) { sendError(res, 404, 'Project not found', { projectIdentifier: projectId }); return; }
        let range: ReturnType<typeof getAnalyticsRange>;
        try { range = getAnalyticsRange(url); }
        catch (rangeErr) { sendError(res, 400, 'Failed to fetch issue analytics', { error: (rangeErr as Error).message }); return; }
        let mirrorError: string | null = null;
        let issueSource: 'mirror' | 'database' | 'beads' = 'database';
        if (beadsIssueMirror?.ensureFresh && project.filesystem_path) {
          try {
            const r = await beadsIssueMirror.ensureFresh(projectId);
            mirrorError = r.error;
            issueSource = r.source === 'cached' ? 'database' : 'mirror';
          } catch (mirrorErr) { logger.warn({ err: mirrorErr, projectId }, 'Mirror ensureFresh on analytics failed'); }
        }
        let issues: IssueLike[] = db.getProjectIssues ? db.getProjectIssues(projectId) : [];
        if (issues.length === 0 && beadsAdapter?.listIssues && project.filesystem_path) {
          const hydrated = await hydrateIssuesFromBeads(beadsAdapter, project, getBeadsListFilters(url), logger);
          if (hydrated.issues.length > 0) { issues = hydrated.issues; issueSource = 'beads'; }
          if (hydrated.error) mirrorError = hydrated.error;
        }
        const analytics = buildIssueAnalytics(issues, range, url);
        const lastSyncIso = toIsoTimestamp(project.last_sync_at);
        const dataFreshness: Record<string, unknown> = {
          status: mirrorError ? 'stale' : 'fresh',
          last_sync_at: lastSyncIso,
          source: issueSource,
        };
        if (mirrorError) dataFreshness.error = mirrorError;
        sendJson(res, 200, {
          schema_version: 1,
          projectId,
          rangeStart: range.rangeStart,
          rangeEnd: range.rangeEnd,
          granularity: range.granularity,
          timezone: range.timezone,
          createdBuckets: analytics.createdBuckets,
          completedBuckets: analytics.completedBuckets,
          completedTimeline: analytics.completedTimeline,
          summary: analytics.summary,
          nextTimelineCursor: analytics.nextTimelineCursor,
          timelinePage: analytics.timelinePage,
          completionSource: 'issue_close_metadata',
          isPartial: false,
          etag: lastSyncIso ? `${projectId}:issue-analytics:${lastSyncIso}` : null,
          data_freshness: dataFreshness,
          generatedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to get issue analytics');
        sendError(res, 500, 'Failed to fetch issue analytics', { error: (error as Error).message });
      }
    },
  });

  // GET /api/projects/:id
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/projects/') && pathname.split('/').length === 4 && method === 'GET',
    handle: async ({ res, pathname }) => {
      const projectId = pathname.split('/')[3]!;
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const project = db.getProject ? db.getProject(projectId) : (projectRegistry?.getProject ? projectRegistry.getProject(projectId) : null);
        if (!project) { sendError(res, 404, 'Project not found'); return; }
        sendJson(res, 200, { project: serializeProject(project), etag: `${project.identifier}:${project.last_checked_at || 0}` });
      } catch (error) { logger.error({ err: error }, 'Failed to get project'); sendError(res, 500, 'Failed to get project', { error: (error as Error).message }); }
    },
  });

  // POST /api/registry/projects
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/registry/projects' && method === 'POST',
    handle: async ({ req, res }) => {
      try {
        const body = await deps.parseJsonBody(req);
        const { filesystem_path } = body;
        if (!filesystem_path || !isAbsolutePath(filesystem_path)) { sendError(res, 400, 'filesystem_path must be an absolute path'); return; }
        if (!fs.existsSync(filesystem_path as string)) { sendError(res, 400, 'Directory does not exist', { path: filesystem_path }); return; }
        const project = projectRegistry?.registerProject ? projectRegistry.registerProject(filesystem_path as string) : null;
        if (!project) { sendError(res, 500, 'Failed to register project'); return; }
        sendJson(res, 201, serializeProject(project));
      } catch (error) { logger.error({ err: error }, 'Failed to register project'); sendError(res, 500, 'Failed to register project', { error: (error as Error).message }); }
    },
  });

  // GET /api/registry/projects/:id
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/registry/projects/') && pathname.split('/').length === 5 && method === 'GET',
    handle: async ({ res, pathname }) => {
      const projectId = pathname.replace('/api/registry/projects/', '');
      try {
        const project = projectRegistry?.getProject ? projectRegistry.getProject(projectId) : null;
        if (!project) { sendError(res, 404, 'Project not found'); return; }
        sendJson(res, 200, serializeProject(project));
      } catch (error) { logger.error({ err: error }, 'Failed to get project'); sendError(res, 500, 'Failed to get project', { error: (error as Error).message }); }
    },
  });

  // POST /api/projects/:id/beads-remote/provision
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/projects/') && pathname.endsWith('/beads-remote/provision') && method === 'POST',
    handle: async ({ req, res, pathname }) => {
      const projectId = pathname.replace('/api/projects/', '').replace('/beads-remote/provision', '');
      try {
        if (!doltHubProvisioner?.provisionProjectBeadsRemote) { sendError(res, 503, 'DoltHub provisioning not available'); return; }
        const body = await deps.parseJsonBody(req);
        const result = await doltHubProvisioner.provisionProjectBeadsRemote(projectId, { push: body.push !== false });
        sendJson(res, 200, result);
      } catch (error) { logger.error({ err: error }, 'Failed to provision Beads remote'); sendError(res, 500, 'Failed to provision Beads remote', { error: (error as Error).message }); }
    },
  });

  // Issue mutations: claim, unclaim, close, reopen
  const ISSUE_MUTATIONS = ['claim', 'unclaim', 'close', 'reopen'] as const;
  for (const action of ISSUE_MUTATIONS) {
    const methodName = `${action}Issue` as const;
    app.registerRoute({
      match: ({ pathname, method }) => pathname.startsWith('/api/issues/') && pathname.endsWith(`/${action}`) && method === 'POST',
      handle: async ({ req, res, pathname }) => {
        const issueId = pathname.replace('/api/issues/', '').replace(`/${action}`, '');
        if (!beadsAdapter && !beadsIssueService) { sendError(res, 503, 'Issue mutation service not available'); return; }
        try {
          const reqHeaders = (req as { headers?: Record<string, string> }).headers || {};
          const idempotencyKey = reqHeaders['idempotency-key'] || reqHeaders['Idempotency-Key'];
          if (!idempotencyKey) { sendError(res, 400, 'Idempotency-Key header required'); return; }
          const body = await deps.parseJsonBody(req);
          let result: unknown;
          const service = beadsIssueService as Record<string, unknown>;
          if (typeof service[methodName] === 'function') {
            result = await (service[methodName] as (...args: unknown[]) => unknown)(issueId, { ...body, idempotencyKey });
          } else if (beadsAdapter) {
            result = await (beadsAdapter as { _handleBeadsAdapterMutation?: (...args: unknown[]) => unknown })._handleBeadsAdapterMutation?.(action, issueId, body, beadsAdapter, idempotencyKey);
          } else { sendError(res, 503, 'No issue mutation backend available'); return; }
          sendJson(res, 200, result);
        } catch (error) { logger.error({ err: error }, `Failed to ${action} issue`); sendError(res, 500, `Failed to ${action} issue`, { error: (error as Error).message }); }
      },
    });
  }

  // PATCH /api/issues/:id/status
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/issues/') && pathname.endsWith('/status') && method === 'PATCH',
    handle: async ({ req, res, pathname }) => {
      const issueId = pathname.replace('/api/issues/', '').replace('/status', '');
      if (!beadsIssueService?.updateIssueStatus) { sendError(res, 503, 'Issue mutation service not available'); return; }
      try {
        const body = await deps.parseJsonBody(req);
        const reqHeaders2 = (req as { headers?: Record<string, string> }).headers || {}; const idempotencyKey = reqHeaders2['idempotency-key'] || reqHeaders2['Idempotency-Key'];
        if (!idempotencyKey) { sendError(res, 400, 'Idempotency-Key header required'); return; }
        if (!body.status) { sendError(res, 400, 'status field required'); return; }
        const result = await beadsIssueService.updateIssueStatus(issueId, body.status as string, { idempotencyKey, ...body });
        sendJson(res, 200, result);
      } catch (error) { logger.error({ err: error }, 'Failed to update issue status'); sendError(res, 500, 'Failed to update issue status', { error: (error as Error).message }); }
    },
  });

  // POST /api/issues/:id/notes
  app.registerRoute({
    match: ({ pathname, method }) => pathname.startsWith('/api/issues/') && pathname.endsWith('/notes') && method === 'POST',
    handle: async ({ req, res, pathname }) => {
      const issueId = pathname.replace('/api/issues/', '').replace('/notes', '');
      if (!beadsIssueService?.addIssueNote) { sendError(res, 503, 'Issue mutation service not available'); return; }
      try {
        const body = await deps.parseJsonBody(req);
        const reqHeaders = (req as { headers?: Record<string, string> }).headers || {}; const idempotencyKey = reqHeaders['idempotency-key'] || reqHeaders['Idempotency-Key'];
        if (!idempotencyKey) { sendError(res, 400, 'Idempotency-Key header required'); return; }
        if (!body.content) { sendError(res, 400, 'content field required'); return; }
        const result = await beadsIssueService.addIssueNote(issueId, body.content as string, { idempotencyKey, ...body });
        sendJson(res, 200, result);
      } catch (error) { logger.error({ err: error }, 'Failed to add issue note'); sendError(res, 500, 'Failed to add issue note', { error: (error as Error).message }); }
    },
  });
}
