/**
 * AgentsMdRefreshService — on-demand AGENTS.md propagation.
 *
 * Walks the project registry, runs AgentsMdGenerator against each
 * project's filesystem_path/AGENTS.md, returns a per-project change
 * report. Plumbing for both the CLI (`vibesync refresh-agents-md`)
 * and the admin endpoint (`POST /v1/admin/agents-md/refresh`).
 *
 * Existing propagation path (via LettaAgentPersistenceService) only
 * fires on Letta agent persist events; this service is the on-demand
 * trigger operators use after editing global templates.
 */

import path from 'node:path';
import fs from 'node:fs';
import { logger } from './logger';
import { agentsMdGenerator } from './AgentsMdGenerator';

export interface ProjectRefreshInput {
  readonly identifier: string;
  readonly name: string;
  readonly filesystem_path: string;
}

export interface ProjectRefreshResult {
  readonly identifier: string;
  readonly name: string;
  readonly filesystem_path: string;
  readonly status: 'updated' | 'dry-run' | 'skipped' | 'error';
  readonly changes?: { readonly section: string; readonly action: string; readonly reason?: string }[];
  readonly reason?: string;
  readonly error?: string;
}

export interface RefreshSummary {
  readonly total: number;
  readonly updated: number;
  readonly dryRun: number;
  readonly skipped: number;
  readonly errors: number;
  readonly results: readonly ProjectRefreshResult[];
}

export interface AgentsMdRefreshDeps {
  readonly db: {
    getProjects?: (filters?: Record<string, unknown>) => ProjectRefreshInput[];
    getProjectsWithFilesystemPath?: () => ProjectRefreshInput[];
  };
  /**
   * Look up the PM agent id for a project. Optional — when absent, the
   * generator runs with `agentId: ''` so the project-info section's
   * agentId field is blank. The Letta-driven persist path will fill it
   * in later.
   */
  readonly getAgentIdForProject?: (identifier: string) => string | null;
}

function selectProjects(deps: AgentsMdRefreshDeps): ProjectRefreshInput[] {
  // Return every registered project; missing/empty filesystem_path
  // surfaces as a `skipped` result row downstream so operators see
  // the drift instead of having it filtered out silently.
  if (typeof deps.db.getProjects === 'function') {
    return deps.db.getProjects();
  }
  if (typeof deps.db.getProjectsWithFilesystemPath === 'function') {
    return deps.db.getProjectsWithFilesystemPath();
  }
  return [];
}

export interface RefreshOptions {
  readonly projectId?: string;
  readonly dryRun?: boolean;
}

export async function refreshAgentsMd(
  deps: AgentsMdRefreshDeps,
  options: RefreshOptions = {},
): Promise<RefreshSummary> {
  const log = logger.child({ service: 'AgentsMdRefreshService' });
  const all = selectProjects(deps);
  const targets = options.projectId
    ? all.filter((p) => p.identifier === options.projectId)
    : all;

  const results: ProjectRefreshResult[] = [];
  for (const project of targets) {
    const projectPath = project.filesystem_path;
    if (!projectPath || projectPath.trim().length === 0) {
      results.push({
        identifier: project.identifier,
        name: project.name,
        filesystem_path: projectPath ?? '',
        status: 'skipped',
        reason: 'no filesystem_path in registry',
      });
      continue;
    }
    if (!fs.existsSync(projectPath)) {
      results.push({
        identifier: project.identifier,
        name: project.name,
        filesystem_path: projectPath,
        status: 'skipped',
        reason: 'filesystem_path does not exist on this host',
      });
      continue;
    }
    const agentId = deps.getAgentIdForProject?.(project.identifier) ?? '';
    const agentsMdPath = path.join(projectPath, 'AGENTS.md');
    const vars = {
      identifier: project.identifier,
      name: project.name,
      agentId,
      agentName: agentId ? `PM - ${project.name}` : '',
      projectPath,
    };
    try {
      const { changes } = agentsMdGenerator.generate(agentsMdPath, vars, {
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      results.push({
        identifier: project.identifier,
        name: project.name,
        filesystem_path: projectPath,
        status: options.dryRun ? 'dry-run' : 'updated',
        changes: [...changes],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ identifier: project.identifier, err: message }, 'AGENTS.md refresh failed for project');
      results.push({
        identifier: project.identifier,
        name: project.name,
        filesystem_path: projectPath,
        status: 'error',
        error: message,
      });
    }
  }

  const summary: RefreshSummary = {
    total: targets.length,
    updated: results.filter((r) => r.status === 'updated').length,
    dryRun: results.filter((r) => r.status === 'dry-run').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
  log.info(
    {
      total: summary.total,
      updated: summary.updated,
      dryRun: summary.dryRun,
      skipped: summary.skipped,
      errors: summary.errors,
      requestedProjectId: options.projectId,
    },
    'AGENTS.md refresh complete',
  );
  return summary;
}
