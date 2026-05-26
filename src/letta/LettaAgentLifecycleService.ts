import { fetchWithPool } from '../http';
import { buildPersonaBlock } from './pm-agent-persona.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { LettaMemoryService } from './LettaMemoryService.js';

type Client = Record<string, any>;

export class LettaAgentLifecycleService {
  config: { client: Client; apiURL: string; password: string; model: string; embedding: string; controlAgentName: string; enableSleeptime?: boolean; sleeptimeFrequency?: number };
  memoryService: LettaMemoryService;
  persistenceService: { getPersistedAgentId: (id: string) => string | null; saveAgentId: (proj: string, id: string) => void; _agentState: { agents?: Record<string, string> } };
  private _controlAgentCache: { agentId: string; agentName: string; toolIds: string[]; persona: string | null } | null = null;

  constructor(config: { client: Client; apiURL: string; password: string; model: string; embedding: string; controlAgentName: string; enableSleeptime?: boolean; sleeptimeFrequency?: number }, memoryService: LettaMemoryService, persistenceService: { getPersistedAgentId: (id: string) => string | null; saveAgentId: (proj: string, id: string) => void; _agentState: { agents?: Record<string, string> } }) {
    this.config = config;
    this.memoryService = memoryService;
    this.persistenceService = persistenceService;
  }

  static buildAgentDescription(projectName: string): string {
    return `PM agent for ${projectName} — manages issues, syncs code context, and coordinates development tasks.`;
  }

  async _ensureDescription(agent: { id: string; name?: string; description?: string }, projectName: string): Promise<void> {
    if (agent.description) return;
    const description = LettaAgentLifecycleService.buildAgentDescription(projectName);
    try { await this.config.client.agents.modify(agent.id, { description }); console.log(`[Letta] Backfilled description for ${agent.name}`); }
    catch (error) { console.warn(`[Letta] Failed to backfill description for ${agent.name}: ${(error as Error).message}`); }
  }

  clearControlAgentCache(): void { this._controlAgentCache = null; }

  async ensureControlAgent(): Promise<{ agentId: string; agentName: string; toolIds: string[]; persona: string | null }> {
    const { client, apiURL, password, model, embedding, controlAgentName } = this.config;
    try {
      if (this._controlAgentCache) return this._controlAgentCache;
      console.log(`[Letta] Looking for control agent: ${controlAgentName}`);
      const agents = await client.agents.list() as { id: string; name: string; [key: string]: unknown }[];
      let controlAgent = agents.find(a => a.name === controlAgentName);

      if (!controlAgent) {
        console.log(`[Letta] Control agent not found, creating: ${controlAgentName}`);
        const persona = this._buildPersonaBlock('CONTROL', 'PM Control Template');
        const response = await fetchWithPool(`${apiURL}/agents`, {
          method: 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: controlAgentName, agent_type: 'letta_v1_agent', model, embedding, enable_sleeptime: false }),
        });
        if (!response.ok) { const errorText = await response.text(); throw new Error(`Failed to create control agent: HTTP ${response.status}: ${errorText}`); }
        controlAgent = await response.json() as { id: string; name: string };
        console.log(`[Letta] Control agent created: ${controlAgent.id}`);
        await this.memoryService._updatePersonaBlock(controlAgent.id, persona);
        await this.memoryService._attachSharedHumanBlock(controlAgent.id);
        const defaultTools = ['tool-bb40505b-8a76-441a-a23b-b6788770a865','tool-fbf98f0f-1495-42fa-ba4c-a85ac44bfbad','tool-bfb4142c-2427-4b53-a194-079840c10e3a','tool-08ffccab-5e2b-46c2-9422-d41e66defbe3','tool-15c412cf-fcea-4406-ad1d-eb8e71bb156e','tool-0743e6cb-9ad8-43a1-b374-661c16e39dcc','tool-230e983a-1694-4ab6-99dd-ca24c13e449a'];
        for (const toolId of defaultTools) await client.agents.tools.attach(controlAgent.id, toolId);
        console.log(`[Letta] Control agent configured with ${defaultTools.length} default tools`);
      }
      const config = await this.getControlAgentConfig(controlAgent.id);
      this._controlAgentCache = config;
      return config;
    } catch (error) { console.error('[Letta] Error ensuring control agent:', (error as Error).message); throw error; }
  }

  async getControlAgentConfig(agentId: string | null = null): Promise<{ agentId: string; agentName: string; toolIds: string[]; persona: string | null }> {
    const { client, controlAgentName } = this.config;
    try {
      let controlAgent: { id: string; name: string; memory: { blocks: { label: string; value: string | null }[] } };
      if (agentId) controlAgent = await client.agents.retrieve(agentId) as typeof controlAgent;
      else {
        const agents = await client.agents.list() as typeof controlAgent[];
        const found = agents.find(a => a.name === controlAgentName);
        if (!found) throw new Error(`Control agent not found: ${controlAgentName}`);
        controlAgent = found;
      }
      const tools = await client.agents.tools.list(controlAgent.id) as { id: string }[];
      const toolIds = tools.map(t => t.id);
      const personaBlock = controlAgent.memory.blocks.find(b => b.label === 'persona');
      const persona = personaBlock ? personaBlock.value : null;
      console.log(`[Letta] Control agent config: ${toolIds.length} tools, persona: ${persona ? 'yes' : 'no'}`);
      return { agentId: controlAgent.id, agentName: controlAgent.name, toolIds, persona };
    } catch (error) { console.error('[Letta] Error getting control agent config:', (error as Error).message); throw error; }
  }

  async ensureAgent(projectIdentifier: string, projectName: string): Promise<any> {
    const { client: _client, apiURL, password, model, embedding, enableSleeptime, sleeptimeFrequency } = this.config;
    const sanitizedName = projectName.replace(/[/\\:*?"<>|]/g, '-');
    const agentName = `PM - ${sanitizedName}`;
    console.log(`[Letta] Ensuring agent exists: ${agentName}`);

    try {
      const qp = new URLSearchParams({ name: agentName, limit: '100', include: 'agent.tags' });
      qp.append('tags', 'vibesync'); qp.append('tags', `project:${projectIdentifier}`); qp.append('match_all_tags', 'true');
      const response = await fetchWithPool(`${apiURL}/agents?${qp}`, { method: 'GET', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const allAgents = await response.json() as { id: string; name: string; created_at?: string; [key: string]: unknown }[];
      console.log(`[Letta] Found ${allAgents.length} agents matching name and tags`);

      const agents = allAgents.filter(a => a.name === agentName);
      const controlAgentId = this._controlAgentCache?.agentId;
      const pmAgents = agents.filter(a => a.id !== controlAgentId);
      console.log(`[Letta] Found ${pmAgents.length} existing primary agents matching name`);

      const persistedAgentId = this.persistenceService.getPersistedAgentId(projectIdentifier);
      if (persistedAgentId) {
        console.log(`[Letta] Found persisted agent ID in local state: ${persistedAgentId}`);
        const persistedAgent = pmAgents.find(a => a.id === persistedAgentId);
        if (persistedAgent) {
          console.log(`[Letta] Resumed agent from local state: ${persistedAgent.name} (${persistedAgent.id})`);
          await this.memoryService._ensureTemplateBlocks(persistedAgent.id, { agentName: persistedAgent.name });
          await this._ensureDescription(persistedAgent, projectName);
          return persistedAgent;
        }
        console.warn(`[Letta] Persisted agent ${persistedAgentId} not found in Letta, searching for alternative...`);
      }

      if (pmAgents.length > 0) {
        if (pmAgents.length > 1) {
          console.warn(`[Letta] DUPLICATE AGENTS DETECTED: Found ${pmAgents.length} agents with name "${agentName}"!`);
          pmAgents.forEach((agent, idx) => { console.warn(`[Letta]   ${idx + 1}. ${agent.id} (created: ${agent.created_at || 'unknown'})`); });
          const sorted = pmAgents.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
          const existing = sorted[0]!;
          console.warn(`[Letta] Using most recent agent: ${existing.id}`);
          this.persistenceService.saveAgentId(projectIdentifier, existing.id);
          await this.memoryService._ensureTemplateBlocks(existing.id, { agentName: existing.name });
          await this._ensureDescription(existing, projectName);
          return existing;
        }

        const existing = pmAgents[0]!;
        console.log(`[Letta] Found existing PM agent by name: ${existing.id}`);
        const currentMapping = Object.entries(this.persistenceService._agentState.agents || {}).find(([, id]) => id === existing.id && projectsMatch(id, projectIdentifier));

        if (currentMapping) {
          console.warn(`[Letta] Agent ${existing.id} is already mapped to project ${currentMapping[0]}!`);
          console.warn('[Letta] This agent cannot be reused. Creating new agent instead.');
        } else {
          this.persistenceService.saveAgentId(projectIdentifier, existing.id);
          console.log('[Letta] Agent ID persisted to local state');
          await this.memoryService._ensureTemplateBlocks(existing.id, { agentName: existing.name });
          await this._ensureDescription(existing, projectName);
          return existing;
        }
      }

      console.log(`[Letta] Creating new agent: ${agentName}`);
      const persona = this._buildPersonaBlock(projectIdentifier, projectName);
      let agent: { id: string; name?: string; [key: string]: unknown } | undefined;
      let retries = 0; const maxRetries = 3;

      while (retries <= maxRetries) {
        try {
          const createResp = await fetchWithPool(`${apiURL}/agents`, { method: 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: agentName, description: LettaAgentLifecycleService.buildAgentDescription(projectName), agent_type: 'letta_v1_agent', model, embedding, enable_sleeptime: enableSleeptime, sleeptime_agent_frequency: sleeptimeFrequency, tags: ['vibesync', `project:${projectIdentifier}`] }) });
          if (!createResp.ok) throw new Error(`HTTP ${createResp.status}: ${await createResp.text()}`);
          agent = await createResp.json() as typeof agent;
          break;
        } catch (createError) {
          const isRateLimit = (createError as Error).message?.includes('500') || (createError as Error).message?.includes('429');
          if (isRateLimit && retries < maxRetries) {
            retries++; const delay = Math.min(1000 * Math.pow(2, retries), 10000);
            console.warn(`[Letta] Rate limit hit, retrying in ${delay}ms (attempt ${retries}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, delay));
            const cqp = new URLSearchParams({ name: agentName, limit: '10', include: 'agent.tags' });
            cqp.append('tags', 'vibesync'); cqp.append('tags', `project:${projectIdentifier}`); cqp.append('match_all_tags', 'true');
            const checkResp = await fetchWithPool(`${apiURL}/agents?${cqp}`, { method: 'GET', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' } });
            if (checkResp.ok) {
              const existing = await checkResp.json() as { id: string; name: string }[];
              const matching = existing.filter(a => a.name === agentName);
              if (matching.length > 0) { console.log(`[Letta] Agent was created successfully: ${matching[0]!.id}`); agent = matching[0]!; break; }
            }
          } else throw createError;
        }
      }
      if (!agent) throw new Error('Failed to create agent after retries');

      console.log(`[Letta] Agent created successfully: ${agent.id}`);
      this.persistenceService.saveAgentId(projectIdentifier, agent.id);
      const controlConfig = await this.ensureControlAgent();
      const personaToUse = controlConfig.persona || persona;
      await this.memoryService._updatePersonaBlock(agent.id, personaToUse);
      await this.memoryService._ensureTemplateBlocks(agent.id, { agentName: agent.name || agentName });
      return agent;
    } catch (error) { console.error('[Letta] Error ensuring agent:', (error as Error).message); throw error; }
  }

  _buildPersonaBlock(projectIdentifier: string, projectName: string): string {
    return buildPersonaBlock(projectIdentifier, projectName);
  }

  async getAgent(agentId: string): Promise<unknown> {
    try { return await this.config.client.agents.retrieve(agentId); }
    catch (error) { console.error(`[Letta] Error getting agent ${agentId}:`, (error as Error).message); throw error; }
  }

  async listAgents(filters: Record<string, unknown> = {}): Promise<unknown> {
    try { return await this.config.client.agents.list(filters); }
    catch (error) { console.error('[Letta] Error listing agents:', (error as Error).message); throw error; }
  }
}

function projectsMatch(id: string, projectIdentifier: string): boolean { return id !== projectIdentifier; }
