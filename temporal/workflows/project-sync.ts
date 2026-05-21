/**
 * Project Sync Workflow — Simplified 2-Phase Pipeline
 *
 * Handles syncing a single project.
 *
 * Phases: init → agent
 *   init:   Discover project in registry, provision/reconcile agent
 *   agent:  Update Letta agent memory with latest project snapshot
 */

import { proxyActivities, executeChild, log, continueAsNew } from '@temporalio/workflow';

import type * as orchestrationActivities from '../activities/orchestration';
import type * as agentProvisioningActivities from '../activities/agent-provisioning';
import { ProvisionSingleAgentWorkflow } from './agent-provisioning';

// ============================================================
// ACTIVITY PROXIES
// ============================================================

const { updateLettaMemory } = proxyActivities<typeof orchestrationActivities>({
  startToCloseTimeout: '120 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 3,
  },
});

const { checkAgentExists, updateProjectAgent } = proxyActivities<
  typeof agentProvisioningActivities
>({
  startToCloseTimeout: '60 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

function extractGitRepoPath(description?: string): string | null {
  if (!description) return null;

  const patterns = [
    /Filesystem:\s*([^\n]+)/i,
    /Path:\s*([^\n]+)/i,
    /Directory:\s*([^\n]+)/i,
    /Location:\s*([^\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    const captured = match?.[1];
    if (captured) {
      const path = captured.trim().replace(/[,;.]$/, '');
      if (path.startsWith('/')) return path;
    }
  }

  return null;
}

// ============================================================
// TYPES
// ============================================================

export interface ProjectSyncResult {
  projectIdentifier: string;
  projectName: string;
  success: boolean;
  lettaUpdated: boolean;
  error?: string;
}

export interface ProjectSyncInput {
  project: { identifier: string; name: string; description?: string };
  batchSize: number;
  enableLetta: boolean;
  dryRun: boolean;

  // Internal continuation state
  _phase?: 'init' | 'agent' | 'done';
  _accumulatedResult?: ProjectSyncResult;
  _gitRepoPath?: string | null;
}

export async function ProjectSyncWorkflow(input: ProjectSyncInput): Promise<ProjectSyncResult> {
  const {
    project,
    enableLetta,
    dryRun,
    _phase = 'init',
    _accumulatedResult,
    _gitRepoPath,
  } = input;

  log.info(`[ProjectSync] Processing: ${project.identifier}`, { phase: _phase });

  const result: ProjectSyncResult = _accumulatedResult || {
    projectIdentifier: project.identifier,
    projectName: project.name,
    success: false,
    lettaUpdated: false,
  };

  let gitRepoPath = _gitRepoPath;

  try {
    // ── INIT: discover project, provision agent ──
    if (_phase === 'init') {
      gitRepoPath = extractGitRepoPath(project.description);

      if (enableLetta && gitRepoPath) {
        try {
          const agentCheck = await checkAgentExists({
            projectIdentifier: project.identifier,
          });

          if (agentCheck.exists) {
            log.info(
              `[ProjectSync] Agent exists for ${project.identifier}, reconciling: ${agentCheck.agentId}`
            );
          } else {
            log.info(`[ProjectSync] Provisioning PM agent for ${project.identifier}...`);
          }

          const provisionResult = await executeChild(ProvisionSingleAgentWorkflow, {
            workflowId: `provision-${project.identifier}-${Date.now()}`,
            args: [
              {
                projectIdentifier: project.identifier,
                projectName: project.name,
                attachTools: true,
              },
            ],
          });

          if (provisionResult.success && provisionResult.agentId) {
            await updateProjectAgent({
              projectIdentifier: project.identifier,
              agentId: provisionResult.agentId,
            });
            log.info(`[ProjectSync] PM agent reconciled: ${provisionResult.agentId}`);
          } else if (!provisionResult.success) {
            log.warn(`[ProjectSync] Agent provisioning failed: ${provisionResult.error}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.warn(`[ProjectSync] Agent provisioning failed, continuing sync: ${errorMsg}`);
        }
      }

      return await continueAsNew<typeof ProjectSyncWorkflow>({
        ...input,
        _phase: 'agent',
        _gitRepoPath: gitRepoPath,
        _accumulatedResult: result,
      });
    }

    // ── AGENT: update Letta agent memory ──
    if (_phase === 'agent') {
      if (enableLetta && !dryRun) {
        try {
          const agentCheck = await checkAgentExists({
            projectIdentifier: project.identifier,
          });

          if (agentCheck.exists && agentCheck.agentId) {
            const memResult = await updateLettaMemory({
              agentId: agentCheck.agentId,
              project: project,
              issues: [],
              ...(gitRepoPath ? { gitRepoPath } : {}),
            });
            result.lettaUpdated = memResult.success;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.warn(`[ProjectSync] Agent memory update failed: ${errorMsg}`);
        }
      }

      result.success = true;

      log.info(`[ProjectSync] Complete: ${project.identifier}`, {
        lettaUpdated: result.lettaUpdated,
      });

      return result;
    }

    throw new Error(`Unknown phase: ${_phase}`);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'ContinueAsNew' ||
        error.message.includes('Workflow continued as new') ||
        error.message.includes('continueAsNew'))
    ) {
      throw error;
    }

    result.error = error instanceof Error ? error.message : String(error);
    log.error(`[ProjectSync] Failed: ${project.identifier}`, {
      error: result.error,
    });
    return result;
  }
}
