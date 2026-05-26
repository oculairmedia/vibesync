/**
 * Agent Provisioning Activities
 *
 * Activities for agent provisioning workflow using official Letta SDK.
 * Each activity is atomic and retryable.
 */

import { ApplicationFailure } from '@temporalio/activity';
import { LettaClient } from '@letta-ai/letta-client';
import path from 'path';
import { createSyncDatabase } from '../../src/database.js';
import { agentsMdGenerator } from '../../src/AgentsMdGenerator.js';

// Configuration
const LETTA_API_BASE = process.env.LETTA_API_URL || 'http://192.168.50.90:8289';
const LETTA_PASSWORD = process.env.LETTA_PASSWORD || '';
const LETTA_MODEL = process.env.LETTA_MODEL || 'letta/letta-free';
const LETTA_EMBEDDING = process.env.LETTA_EMBEDDING || 'letta/letta-free';

// Initialize Letta client
const lettaClient = new LettaClient({
  baseUrl: LETTA_API_BASE,
  token: LETTA_PASSWORD,
});

// ============================================================================
// Types
// ============================================================================

export interface AgentInfo {
  projectIdentifier: string;
  projectName: string;
  existingAgentId?: string;
}

export interface ProvisionResult {
  agentId: string;
  created: boolean;
}

export interface ToolAttachmentResult {
  attached: number;
  skipped: number;
  errors: Array<{ toolId: string; error: string }>;
}

export interface CheckpointData {
  batchNumber: number;
  totalBatches: number;
  processed: number;
  succeeded: number;
  failed: number;
}

async function syncAgentMemoryFromControl(agentId: string): Promise<number> {
  const controlAgentName =
    process.env.LETTA_CONTROL_AGENT_NAME || process.env.LETTA_CONTROL_AGENT || 'Meridian';

  const controlAgents = await lettaClient.agents.list({ name: controlAgentName, limit: 1 });
  if (controlAgents.length === 0) {
    return 0;
  }
  const controlAgentId = controlAgents[0].id;
  if (!controlAgentId) {
    return 0;
  }

  const controlBlocks = await lettaClient.agents.blocks.list(controlAgentId, { limit: 100 });
  const controlBlockByLabel = new Map(controlBlocks.map(b => [b.label, b]));
  const targetBlocks = await lettaClient.agents.blocks.list(agentId, { limit: 100 });
  const targetBlockByLabel = new Map(targetBlocks.map(b => [b.label, b]));

  const labelsToSync = ['persona', 'expression'];
  let synced = 0;

  for (const label of labelsToSync) {
    const controlBlock = controlBlockByLabel.get(label);
    if (!controlBlock || typeof controlBlock.value !== 'string') {
      continue;
    }

    const existingTarget = targetBlockByLabel.get(label);
    if (existingTarget) {
      if (existingTarget.value !== controlBlock.value && existingTarget.id) {
        await lettaClient.blocks.modify(existingTarget.id, { value: controlBlock.value });
        synced++;
      }
      continue;
    }

    const newBlock = await lettaClient.blocks.create({
      label,
      value: controlBlock.value,
      limit: label === 'persona' ? 20000 : undefined,
    });
    if (newBlock.id) {
      await lettaClient.agents.blocks.attach(agentId, newBlock.id);
      synced++;
    }
  }

  return synced;
}

// ============================================================================
// Activity: Fetch Agents to Provision
// ============================================================================

/**
 * Fetch list of projects/agents that need provisioning
 *
 * @param projectIdentifiers - Optional list of specific projects to provision
 * @returns Array of agent info objects
 */
export async function fetchAgentsToProvision(projectIdentifiers?: string[]): Promise<AgentInfo[]> {
  console.log('[Activity:FetchAgents] Fetching agents to provision...');

  try {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'logs', 'sync-state.db');
    const db = createSyncDatabase(dbPath);

    let registryProjects: Array<{ identifier: string; name: string }>;
    try {
      const rows = db.getAllProjects();
      registryProjects = rows
        .filter((r: any) => r.status === 'active')
        .map((r: any) => ({ identifier: r.identifier, name: r.name || r.identifier }));
    } finally {
      db.close();
    }

    console.log(`[Activity:FetchAgents] Found ${registryProjects.length} registry projects`);

    let projects = registryProjects;
    if (projectIdentifiers && projectIdentifiers.length > 0) {
      projects = registryProjects.filter((p: any) => projectIdentifiers.includes(p.identifier));
    }

    // Get existing Letta agents with vibesync tag
    // Using matchAllTags ensures we only get agents that belong to our sync system
    const existingAgents = await lettaClient.agents.list({
      tags: ['vibesync'],
      limit: 500,
    });

    // Build map of project identifier -> agent ID
    // Parse the project:IDENTIFIER tag to get the project mapping
    const agentByProject = new Map<string, string>();
    const agentByName = new Map<string, string>();

    for (const agent of existingAgents) {
      if (!agent.id || !agent.name) continue;

      // Store by name for fallback matching (accept both legacy 'Huly - ' and new 'PM - ')
      if (agent.name.startsWith('PM - ') || agent.name.startsWith('Huly - ')) {
        agentByName.set(agent.name, agent.id);
      }

      // Extract project identifier from tags
      const projectTag = agent.tags?.find(t => t.startsWith('project:'));
      if (projectTag) {
        const projectId = projectTag.replace('project:', '');
        agentByProject.set(projectId, agent.id);
      }
    }

    console.log(
      `[Activity:FetchAgents] Found ${existingAgents.length} existing vibesync agents`
    );

    // Build list of agents to provision
    const agentsToProvision: AgentInfo[] = [];

    for (const project of projects) {
      const sanitizedName = project.name.replace(/[/\\:*?"<>|]/g, '-');
      const agentName = `PM - ${sanitizedName}`;
      const legacyAgentName = `Huly - ${sanitizedName}`;

      // Prefer project ID match, fallback to name match (new then legacy)
      const existingAgentId =
        agentByProject.get(project.identifier) ||
        agentByName.get(agentName) ||
        agentByName.get(legacyAgentName);

      agentsToProvision.push({
        projectIdentifier: project.identifier,
        projectName: project.name,
        existingAgentId,
      });
    }

    console.log(`[Activity:FetchAgents] Found ${agentsToProvision.length} agents to provision`);
    return agentsToProvision;
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    throw ApplicationFailure.retryable(
      `Failed to fetch agents: ${error instanceof Error ? error.message : String(error)}`,
      'FetchError'
    );
  }
}

// ============================================================================
// Activity: Provision Single Agent
// ============================================================================

/**
 * Provision a single agent for a project
 *
 * Creates the agent if it doesn't exist, or returns existing agent.
 *
 * @param projectIdentifier - Huly project identifier
 * @param projectName - Huly project name
 * @returns Provision result with agent ID and creation status
 */
export async function provisionSingleAgent(
  projectIdentifier: string,
  projectName: string
): Promise<ProvisionResult> {
  console.log(`[Activity:ProvisionAgent] Provisioning agent for ${projectIdentifier}...`);

  const sanitizedName = projectName.replace(/[/\\:*?"<>|]/g, '-');
  const agentName = `PM - ${sanitizedName}`;

  try {
    // First check if agent already exists using precise tag matching
    // This mirrors the deduplication logic in LettaService.ensureAgent()
    const existingAgents = await lettaClient.agents.list({
      name: agentName,
      tags: ['vibesync', `project:${projectIdentifier}`],
      matchAllTags: true, // Must have BOTH tags - critical for deduplication
      limit: 100,
    });

    // Double-check exact name match (server may do partial matching)
    const matchingAgents = existingAgents.filter(a => a.name === agentName);

    if (matchingAgents.length > 0) {
      // DUPLICATE DETECTION: Handle multiple agents with same name
      if (matchingAgents.length > 1) {
        console.warn(
          `[Activity:ProvisionAgent] ⚠️ DUPLICATE AGENTS DETECTED: Found ${matchingAgents.length} agents with name "${agentName}"!`
        );
        matchingAgents.forEach((agent, idx) => {
          console.warn(
            `[Activity:ProvisionAgent]   ${idx + 1}. ${agent.id} (created: ${agent.createdAt || 'unknown'})`
          );
        });

        // Use the most recently created agent
        const sortedAgents = [...matchingAgents].sort(
          (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        );
        const selectedAgent = sortedAgents[0];
        console.warn(`[Activity:ProvisionAgent] Using most recent agent: ${selectedAgent.id}`);

        try {
          const syncedBlocks = await syncAgentMemoryFromControl(selectedAgent.id);
          if (syncedBlocks > 0) {
            console.log(
              `[Activity:ProvisionAgent] Synced ${syncedBlocks} memory blocks for ${selectedAgent.id}`
            );
          }
        } catch (syncError) {
          const message = syncError instanceof Error ? syncError.message : String(syncError);
          console.warn(
            `[Activity:ProvisionAgent] Memory block sync skipped for ${selectedAgent.id}: ${message}`
          );
        }

        return {
          agentId: selectedAgent.id,
          created: false,
        };
      }

      console.log(`[Activity:ProvisionAgent] Agent already exists: ${matchingAgents[0].id}`);

      try {
        const syncedBlocks = await syncAgentMemoryFromControl(matchingAgents[0].id);
        if (syncedBlocks > 0) {
          console.log(
            `[Activity:ProvisionAgent] Synced ${syncedBlocks} memory blocks for ${matchingAgents[0].id}`
          );
        }
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : String(syncError);
        console.warn(
          `[Activity:ProvisionAgent] Memory block sync skipped for ${matchingAgents[0].id}: ${message}`
        );
      }

      return {
        agentId: matchingAgents[0].id,
        created: false,
      };
    }

    // Create new agent
    console.log(`[Activity:ProvisionAgent] Creating new agent: ${agentName}`);

    const agent = await lettaClient.agents.create({
      name: agentName,
      agentType: 'letta_v1_agent',
      model: LETTA_MODEL,
      embedding: LETTA_EMBEDDING,
      tags: ['vibesync', `project:${projectIdentifier}`],
    });

    console.log(`[Activity:ProvisionAgent] Agent created: ${agent.id}`);

    try {
      const syncedBlocks = await syncAgentMemoryFromControl(agent.id);
      if (syncedBlocks > 0) {
        console.log(
          `[Activity:ProvisionAgent] Synced ${syncedBlocks} memory blocks for ${agent.id}`
        );
      }
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      console.warn(
        `[Activity:ProvisionAgent] Memory block sync skipped for ${agent.id}: ${message}`
      );
    }

    return {
      agentId: agent.id,
      created: true,
    };
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    // Rate limit errors are retryable
    if (message.includes('429') || message.includes('rate limit')) {
      throw ApplicationFailure.retryable(`Rate limit hit: ${message}`, 'RateLimitError');
    }

    // Server errors are retryable
    if (message.includes('500') || message.includes('502') || message.includes('503')) {
      throw ApplicationFailure.retryable(`Server error: ${message}`, 'LettaServerError');
    }

    // Not found errors are non-retryable
    if (message.includes('404')) {
      throw ApplicationFailure.nonRetryable(`Not found: ${message}`, 'LettaNotFoundError');
    }

    throw ApplicationFailure.retryable(`Failed to provision agent: ${message}`, 'ProvisionError');
  }
}

// ============================================================================
// Activity: Attach Tools to Agent
// ============================================================================

/**
 * Attach PM tools to an agent
 *
 * Gets tools from control agent and attaches them to the target agent.
 *
 * @param agentId - Target agent ID
 * @returns Tool attachment result
 */
export async function attachToolsToAgent(agentId: string): Promise<ToolAttachmentResult> {
  console.log(`[Activity:AttachTools] Attaching tools to agent ${agentId}...`);

  const result: ToolAttachmentResult = {
    attached: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // Get control agent (the agent that has the correct tool configuration)
    const controlAgentName = process.env.LETTA_CONTROL_AGENT_NAME || 'Meridian';
    const controlAgents = await lettaClient.agents.list({ name: controlAgentName, limit: 1 });

    if (controlAgents.length === 0) {
      console.log(`[Activity:AttachTools] No control agent found, skipping tool attachment`);
      return result;
    }

    const controlAgent = controlAgents[0];

    // Get control agent's tools
    const controlTools = await lettaClient.agents.tools.list(controlAgent.id);
    const controlToolIds = controlTools
      .map(t => t.id)
      .filter((id): id is string => id !== undefined);

    console.log(`[Activity:AttachTools] Control agent has ${controlToolIds.length} tools`);

    // Get target agent's existing tools
    const existingTools = await lettaClient.agents.tools.list(agentId);
    const existingToolIds = new Set(
      existingTools.map(t => t.id).filter((id): id is string => id !== undefined)
    );
    const controlToolIdSet = new Set(controlToolIds);

    // Detach stale tools that are no longer on control agent
    const staleTools = [...existingToolIds].filter(toolId => !controlToolIdSet.has(toolId));
    for (const toolId of staleTools) {
      try {
        await lettaClient.agents.tools.detach(agentId, toolId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({ toolId, error: errorMessage });
      }
    }

    // Attach missing tools
    for (const toolId of controlToolIds) {
      if (existingToolIds.has(toolId)) {
        result.skipped++;
        continue;
      }

      try {
        await lettaClient.agents.tools.attach(agentId, toolId);
        result.attached++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({ toolId, error: errorMessage });
      }
    }

    console.log(
      `[Activity:AttachTools] Attached ${result.attached} tools, detached ${staleTools.length}, skipped ${result.skipped}`
    );

    return result;
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    throw ApplicationFailure.retryable(
      `Failed to attach tools: ${error instanceof Error ? error.message : String(error)}`,
      'ToolAttachmentError'
    );
  }
}

// ============================================================================
// Activity: Record Provisioning Result
// ============================================================================

/**
 * Record a checkpoint of provisioning progress
 *
 * This can be used to persist state for resume capability.
 *
 * @param data - Checkpoint data
 */
export async function recordProvisioningResult(data: CheckpointData): Promise<void> {
  console.log(
    `[Activity:Checkpoint] Batch ${data.batchNumber}/${data.totalBatches} - ` +
      `Processed: ${data.processed}, Succeeded: ${data.succeeded}, Failed: ${data.failed}`
  );

  // In a production implementation, this would persist to database
  // For now, we just log it (Temporal provides the durability)
}

// ============================================================================
// Activity: Cleanup Failed Provision
// ============================================================================

/**
 * Cleanup a failed provision
 *
 * Removes partially created agents that failed during provisioning.
 *
 * @param projectIdentifier - Project identifier to cleanup
 */
export async function cleanupFailedProvision(projectIdentifier: string): Promise<void> {
  console.log(`[Activity:Cleanup] Cleaning up failed provision for ${projectIdentifier}...`);

  try {
    // Find agents for this project using tags
    const allAgents = await lettaClient.agents.list({
      tags: ['vibesync', `project:${projectIdentifier}`],
      matchAllTags: true,
      limit: 100,
    });

    if (allAgents.length === 0) {
      console.log(`[Activity:Cleanup] No agents found for ${projectIdentifier}`);
      return;
    }

    // Delete matching agents
    for (const agent of allAgents) {
      console.log(`[Activity:Cleanup] Deleting agent ${agent.id}...`);
      await lettaClient.agents.delete(agent.id);
    }

    console.log(`[Activity:Cleanup] Cleaned up ${allAgents.length} agents`);
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    throw ApplicationFailure.retryable(
      `Failed to cleanup: ${error instanceof Error ? error.message : String(error)}`,
      'CleanupError'
    );
  }
}

// ============================================================================
// Activity: Get Provisioning Status
// ============================================================================

/**
 * Get current provisioning status from persisted state
 *
 * Used for resume capability.
 */
export async function getProvisioningStatus(): Promise<{
  lastCheckpoint?: CheckpointData;
  completedProjects: string[];
}> {
  // In a production implementation, this would read from database
  // For now, return empty state
  return {
    completedProjects: [],
  };
}

// ============================================================================
// Activity: Update Project AGENTS.md
// ============================================================================

export interface UpdateAgentsMdInput {
  projectIdentifier: string;
  projectName: string;
  agentId: string;
}

export interface UpdateAgentsMdResult {
  success: boolean;
  projectPath?: string;
  sections?: Array<{ section: string; action: string }>;
  error?: string;
}

/**
 * Resolve the project's filesystem path and regenerate AGENTS.md with
 * current managed sections (project-info, reporting-hierarchy,
 * session-completion, bookstack-docs, codebase-context).
 *
 * This ensures existing agents get up-to-date issue-tracking instructions and other
 * managed content even when the agent was not newly created.
 *
 * Idempotent — safe to call on every provisioning run.
 */
export async function updateProjectAgentsMd(
  input: UpdateAgentsMdInput
): Promise<UpdateAgentsMdResult> {
  const { projectIdentifier, projectName, agentId } = input;
  console.log(
    `[Activity:UpdateAgentsMd] Updating AGENTS.md for ${projectIdentifier} (agent ${agentId})...`
  );

  try {
    const { resolveGitRepoPath } = await import('./orchestration-git');
    const projectPath = await resolveGitRepoPath({ projectIdentifier });

    if (!projectPath) {
      console.log(
        `[Activity:UpdateAgentsMd] No filesystem path for ${projectIdentifier}, skipping`
      );
      return { success: true, error: 'no_project_path' };
    }

    const agentsMdPath = path.join(projectPath, 'AGENTS.md');
    const agentName = `PM - ${projectName}`;

    const vars = {
      identifier: projectIdentifier,
      name: projectName,
      agentId,
      agentName,
      projectPath,
    };

    const { changes } = agentsMdGenerator.generate(agentsMdPath, vars, {
      sections: [
        'project-info',
        'reporting-hierarchy',
        'beads-instructions',
        'bookstack-docs',
        'session-completion',
        'codebase-context',
      ],
    });

    console.log(
      `[Activity:UpdateAgentsMd] ✓ ${projectIdentifier}: ${changes.map((c: { section: string; action: string }) => `${c.section}:${c.action}`).join(', ')}`
    );

    return { success: true, projectPath, sections: changes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Permission errors are non-fatal — agent state is still in the DB
    if (message.includes('EACCES') || message.includes('permission denied')) {
      console.warn(
        `[Activity:UpdateAgentsMd] ⚠️ Permission denied for ${projectIdentifier}: ${message}`
      );
      return { success: false, error: message };
    }

    // Other errors are retryable
    throw ApplicationFailure.retryable(
      `Failed to update AGENTS.md for ${projectIdentifier}: ${message}`,
      'AgentsMdUpdateError'
    );
  }
}

// ============================================================================
// Activity: Check Agent Exists
// ============================================================================

export interface CheckAgentExistsInput {
  projectIdentifier: string;
}

export interface CheckAgentExistsResult {
  exists: boolean;
  agentId?: string;
  source?: 'database' | 'letta';
}

/**
 * Check if a PM agent exists for a project
 *
 * First checks the sync database, then falls back to querying Letta API.
 * This is idempotent and safe to call multiple times.
 */
export async function checkAgentExists(
  input: CheckAgentExistsInput
): Promise<CheckAgentExistsResult> {
  const { projectIdentifier } = input;
  console.log(`[Activity:CheckAgent] Checking if agent exists for ${projectIdentifier}...`);

  try {
    // First check the sync database
    const dbPath = process.env.DB_PATH || '/opt/stacks/vibesync/logs/sync-state.db';
    const db = createSyncDatabase(dbPath);

    try {
      const lettaInfo = db.getProjectLettaInfo(projectIdentifier) as { letta_agent_id?: string } | null;
      if (lettaInfo?.letta_agent_id) {
        console.log(`[Activity:CheckAgent] Found agent in database: ${lettaInfo.letta_agent_id}`);
        return {
          exists: true,
          agentId: lettaInfo.letta_agent_id,
          source: 'database',
        };
      }
    } finally {
      db.close();
    }

    // Fall back to querying Letta API directly
    const existingAgents = await lettaClient.agents.list({
      tags: ['vibesync', `project:${projectIdentifier}`],
      matchAllTags: true,
      limit: 10,
    });

    if (existingAgents.length > 0) {
      const agentId = existingAgents[0].id;
      console.log(`[Activity:CheckAgent] Found agent in Letta: ${agentId}`);
      return {
        exists: true,
        agentId,
        source: 'letta',
      };
    }

    console.log(`[Activity:CheckAgent] No agent found for ${projectIdentifier}`);
    return { exists: false };
  } catch (error) {
    // On error, assume agent doesn't exist (will trigger provisioning)
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Activity:CheckAgent] Error checking agent: ${message}`);
    return { exists: false };
  }
}

// ============================================================================
// Activity: Update Project Agent
// ============================================================================

export interface UpdateProjectAgentInput {
  projectIdentifier: string;
  agentId: string;
}

export interface UpdateProjectAgentResult {
  success: boolean;
  error?: string;
}

/**
 * Update the sync database with agent info after provisioning
 *
 * This is idempotent - calling multiple times with the same agent ID is safe.
 */
export async function updateProjectAgent(
  input: UpdateProjectAgentInput
): Promise<UpdateProjectAgentResult> {
  const { projectIdentifier, agentId } = input;
  console.log(
    `[Activity:UpdateAgent] Updating database for ${projectIdentifier} with agent ${agentId}...`
  );

  try {
    const dbPath = process.env.DB_PATH || '/opt/stacks/vibesync/logs/sync-state.db';
    const db = createSyncDatabase(dbPath);

    try {
      db.setProjectLettaAgent(projectIdentifier, { agentId });
      db.setProjectLettaSyncAt(projectIdentifier, Date.now());
      console.log(`[Activity:UpdateAgent] Database updated successfully`);
      return { success: true };
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Activity:UpdateAgent] Failed to update database: ${message}`);
    return { success: false, error: message };
  }
}
