/**
 * Project registry routes. Consumed by letta-mobile through the Iroh wrapper
 * (ProjectAdminHandlers: project.list/get/create/update/archive/delete,
 * beadsRemoteStatus, provisionBeadsRemote, triggerSync). Issues are not served
 * here: they live in each project's Beads database.
 */
import fs from 'node:fs';
import path from 'node:path';

import { stripUrlCredentials } from '../../utils.js';
import type { ProjectRow } from '../../types/db.js';
import type {
  App,
  DoltHubProvisionerApi,
  Logger,
  ParseJsonBody,
  ProjectRegistryApi,
  RouteDb,
  SendError,
  SendJson,
} from '../../types/api.js';

const ALLOWED_PROJECT_STATUSES = new Set(['active', 'archived']);
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

interface RouteDeps {
  db: RouteDb | null;
  parseJsonBody: ParseJsonBody;
  sendJson: SendJson;
  sendError: SendError;
  logger: Logger;
  projectRegistry: ProjectRegistryApi | null;
  doltHubProvisioner: DoltHubProvisionerApi | null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const date = new Date(value as number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && path.isAbsolute(value.trim());
}

function serializeBeadsRemote(project: ProjectRow): Record<string, unknown> {
  return {
    owner: project.beads_remote_owner || null,
    repo: project.beads_remote_repo || null,
    // SECURITY (vibesync-6kg): remote URLs can carry inline credentials.
    url: stripUrlCredentials(project.beads_remote_url || null),
    name: project.beads_remote_name || null,
    status: project.beads_remote_status || 'not_provisioned',
    visibility: project.beads_remote_visibility || null,
    provisioned_at: toIsoTimestamp(project.beads_remote_provisioned_at),
    last_push_at: toIsoTimestamp(project.beads_remote_last_push_at),
    error: project.beads_remote_last_error || null,
  };
}

/** Registry shape (create/update/get responses). */
function serializeProject(project: ProjectRow): Record<string, unknown> {
  return {
    identifier: project.identifier,
    name: project.name,
    tech_stack: project.tech_stack,
    letta_agent_id: project.letta_agent_id,
    status: project.status,
    last_scan_at: project.last_scan_at,
    filesystem_path: project.filesystem_path,
    // SECURITY (vibesync-6kg): never put a credential on the wire.
    git_url: stripUrlCredentials(project.git_url),
    beads_remote: serializeBeadsRemote(project),
  };
}

/** Catalog shape (list/detail) decoded by mobile's ProjectSummary. */
function serializeProjectSummary(project: ProjectRow): Record<string, unknown> {
  const updatedAt = project.updated_at ?? project.last_checked_at ?? null;
  return {
    id: project.identifier,
    identifier: project.identifier,
    name: project.name,
    status: project.status || 'active',
    tech_stack: project.tech_stack,
    filesystem_path: project.filesystem_path,
    git_url: stripUrlCredentials(project.git_url),
    letta_agent_id: project.letta_agent_id,
    beads_prefix: project.beads_prefix,
    repo: {
      provider: project.git_url ? 'git' : null,
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
    tracker: { provider: 'beads', status: 'available' },
    beads_remote: serializeBeadsRemote(project),
    last_scan_at: toIsoTimestamp(project.last_scan_at),
    last_activity_at: toIsoTimestamp(project.last_checked_at ?? updatedAt),
    updated_at: toIsoTimestamp(updatedAt),
    version: updatedAt ? String(updatedAt) : null,
    etag: updatedAt ? `${project.identifier}:${updatedAt}` : null,
  };
}

function paginate<T extends { id: string }>(items: T[], cursor: string | null, limit: number) {
  let start = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const index = items.findIndex((item) => item.id === decoded || item.id === cursor);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor: last && page.length === limit ? Buffer.from(last.id).toString('base64') : null,
    has_more: start + limit < items.length,
    total_known: items.length,
  };
}

function resolveProject(db: RouteDb, requested: string): ProjectRow | undefined {
  return db.getProject(db.resolveProjectIdentifier(requested) || requested);
}

const ROLE_AGENTS_PATH = /^\/api\/registry\/projects\/[^/]+\/role-agents$/;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const AGENT_ID = /^agent-[0-9a-f-]{8,}$/;

/**
 * `{ roleAgents: [{ roleName, agentId }, ...] }`: each role named once, each
 * agent an `agent-` id. The whole set replaces what the project had.
 */
function parseRoleAgents(body: Record<string, unknown>): { assignments: Array<{ roleName: string; agentId: string }> } | { error: string } {
  const list = body.roleAgents;
  if (!Array.isArray(list)) return { error: 'roleAgents must be an array of { roleName, agentId }' };
  const seen = new Set<string>();
  const assignments: Array<{ roleName: string; agentId: string }> = [];
  for (const item of list) {
    const roleName = typeof item?.roleName === 'string' ? item.roleName.trim() : '';
    const agentId = typeof item?.agentId === 'string' ? item.agentId.trim() : '';
    if (!ROLE_NAME.test(roleName)) return { error: `roleName must match ${ROLE_NAME.source}` };
    if (!AGENT_ID.test(agentId)) return { error: `agentId for ${roleName} must be an agent- id` };
    if (seen.has(roleName)) return { error: `role ${roleName} is listed twice` };
    seen.add(roleName);
    assignments.push({ roleName, agentId });
  }
  return { assignments };
}

function projectIdFromPath(pathname: string, segment: number): string {
  return decodeURIComponent(pathname.split('/')[segment] || '');
}

export function registerProjectRoutes(app: App, deps: RouteDeps): void {
  const { db, sendJson, sendError, logger, projectRegistry, doltHubProvisioner } = deps;
  const now = () => new Date().toISOString();

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/projects' && method === 'GET',
    handle: async ({ res, url }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      try {
        const status = url.searchParams.get('status');
        const techStack = url.searchParams.get('tech_stack');
        const projects = db.getAllProjects()
          .filter((p) => !status || !ALLOWED_PROJECT_STATUSES.has(status) || p.status === status)
          .filter((p) => !techStack || p.tech_stack === techStack)
          .map((p) => serializeProjectSummary(p) as Record<string, unknown> & { id: string });
        const cursor = url.searchParams.get('cursor');
        const limitParam = url.searchParams.get('limit');
        if (cursor === null && limitParam === null) {
          sendJson(res, 200, { total: projects.length, projects, timestamp: now(), page: { next_cursor: null, has_more: false, total_known: projects.length } });
          return;
        }
        const limit = Math.min(Math.max(Number(limitParam) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
        const page = paginate(projects, cursor, limit);
        sendJson(res, 200, { total: page.total_known, projects: page.items, timestamp: now(), page: { next_cursor: page.next_cursor, has_more: page.has_more, total_known: page.total_known } });
      } catch (error) {
        logger.error({ err: error }, 'Failed to fetch projects');
        sendError(res, 500, 'Failed to fetch projects', { error: errorMessage(error, 'Projects unavailable') });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = projectIdFromPath(pathname, 3);
      const project = resolveProject(db, requested);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      sendJson(res, 200, { project: serializeProjectSummary(project), timestamp: now() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/projects\/[^/]+\/beads-remote$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      const requested = projectIdFromPath(pathname, 3);
      const project = resolveProject(db, requested);
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      sendJson(res, 200, { project_identifier: project.identifier, beads_remote: serializeBeadsRemote(project), timestamp: now() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'POST' && /^\/api\/projects\/[^/]+\/beads-remote\/provision$/.test(pathname),
    handle: async ({ req, res, pathname }) => {
      if (!db) { sendError(res, 503, 'Database not available'); return; }
      if (!doltHubProvisioner) { sendError(res, 503, 'DoltHub provisioning service not available'); return; }
      const requested = projectIdFromPath(pathname, 3);
      const project = resolveProject(db, requested) ?? projectRegistry?.getProject(requested) ?? undefined;
      if (!project) { sendError(res, 404, 'Project not found', { identifier: requested }); return; }
      if (!project.filesystem_path || !fs.existsSync(path.join(project.filesystem_path, '.beads'))) {
        sendError(res, 400, 'Project has no Beads database', { identifier: requested });
        return;
      }
      try {
        const body = await deps.parseJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const result = await doltHubProvisioner.provisionProject(project, { push: body.push !== false });
        sendJson(res, 200, {
          message: result.dry_run ? 'Beads remote provisioning dry run complete' : 'Beads remote provisioned',
          provisioning: result,
          beads_remote: serializeBeadsRemote(db.getProject(project.identifier) ?? project),
          timestamp: now(),
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to provision Beads remote');
        sendError(res, 500, 'Failed to provision Beads remote', { error: errorMessage(error, 'Beads remote provisioning failed') });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/registry/projects' && method === 'POST',
    handle: async ({ req, res }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      try {
        const body = await deps.parseJsonBody(req);
        const filesystemPath = typeof body.filesystem_path === 'string' ? body.filesystem_path.trim() : '';
        if (!filesystemPath) { sendError(res, 400, 'filesystem_path is required', { field: 'filesystem_path' }); return; }
        if (!isAbsolutePath(filesystemPath)) { sendError(res, 400, 'filesystem_path must be an absolute path', { field: 'filesystem_path' }); return; }
        const project = projectRegistry.registerProject(filesystemPath);
        if (!project) { sendError(res, 500, 'Failed to register project'); return; }
        const updates: { name?: string; git_url?: string } = {};
        if (typeof body.name === 'string') updates.name = body.name.trim();
        if (typeof body.git_url === 'string') updates.git_url = body.git_url.trim();
        const registered = Object.keys(updates).length > 0 ? projectRegistry.updateProject(project.identifier, updates) ?? project : project;
        sendJson(res, 201, { message: 'Project registered', project: serializeProject(registered), timestamp: now() });
      } catch (error) {
        logger.error({ err: error }, 'Failed to register project');
        sendError(res, 400, 'Failed to register project', { error: errorMessage(error, 'Project registration failed') });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = projectIdFromPath(pathname, 4);
      const project = projectRegistry.getProject(identifier);
      if (!project) { sendError(res, 404, 'Project not found', { identifier }); return; }
      sendJson(res, 200, { ...serializeProject(project), timestamp: now() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'PATCH' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ req, res, pathname }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = projectIdFromPath(pathname, 4);
      try {
        const body = await deps.parseJsonBody(req);
        const updates: { filesystem_path?: string; git_url?: string; status?: string } = {};
        if (body.filesystem_path !== undefined) {
          if (!isAbsolutePath(body.filesystem_path)) { sendError(res, 400, 'filesystem_path must be an absolute path', { field: 'filesystem_path' }); return; }
          updates.filesystem_path = body.filesystem_path.trim();
        }
        if (body.git_url !== undefined) updates.git_url = String(body.git_url).trim();
        if (body.status !== undefined) {
          const status = typeof body.status === 'string' ? body.status.trim() : '';
          if (!ALLOWED_PROJECT_STATUSES.has(status)) { sendError(res, 400, 'status must be one of: active, archived', { field: 'status' }); return; }
          updates.status = status;
        }
        const project = projectRegistry.updateProject(identifier, updates);
        if (!project) { sendError(res, 404, 'Project not found', { identifier }); return; }
        sendJson(res, 200, { message: 'Project updated', project: serializeProject(project), timestamp: now() });
      } catch (error) {
        logger.error({ err: error, identifier }, 'Failed to update project');
        sendError(res, 400, 'Failed to update project', { error: errorMessage(error, 'Project update failed') });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'GET' && ROLE_AGENTS_PATH.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const project = projectRegistry.getProject(projectIdFromPath(pathname, 4));
      if (!project) { sendError(res, 404, 'Project not found', { identifier: projectIdFromPath(pathname, 4) }); return; }
      sendJson(res, 200, { identifier: project.identifier, roleAgents: projectRegistry.listRoleAgents(project.identifier), timestamp: now() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'PUT' && ROLE_AGENTS_PATH.test(pathname),
    handle: async ({ req, res, pathname }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const project = projectRegistry.getProject(projectIdFromPath(pathname, 4));
      if (!project) { sendError(res, 404, 'Project not found', { identifier: projectIdFromPath(pathname, 4) }); return; }
      const parsed = parseRoleAgents(await deps.parseJsonBody(req));
      if ('error' in parsed) { sendError(res, 400, parsed.error, { field: 'roleAgents' }); return; }
      const roleAgents = projectRegistry.setRoleAgents(project.identifier, parsed.assignments);
      sendJson(res, 200, { message: 'Role agents set', identifier: project.identifier, roleAgents, timestamp: now() });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => method === 'DELETE' && /^\/api\/registry\/projects\/[^/]+$/.test(pathname),
    handle: async ({ res, pathname }) => {
      if (!projectRegistry) { sendError(res, 503, 'ProjectRegistry not available'); return; }
      const identifier = projectIdFromPath(pathname, 4);
      if (!projectRegistry.deleteProject(identifier)) { sendError(res, 404, 'Project not found', { identifier }); return; }
      sendJson(res, 200, { message: 'Project deleted', identifier, timestamp: now() });
    },
  });

  // Retired: the Huly/Temporal sync this triggered no longer exists. Kept as an
  // explicit no-op so letta-mobile's project.triggerSync gets a clear answer
  // instead of a 404 until mobile drops the method.
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/sync/trigger' && method === 'POST',
    handle: async ({ res }) => {
      sendJson(res, 410, { status: 'retired', message: 'Project sync is retired; Beads is the source of truth', event_id: null });
    },
  });
}
