import fs from 'fs';
import { fetchWithPool } from '../http';
import { resolveFromAppRoot } from '../runtimePaths';

type Client = Record<string, any>;

export class LettaToolService {
  config: { client: Client; apiURL: string; password: string };
  lifecycleService: { ensureControlAgent: () => Promise<{ agentId: string; toolIds: string[] }> };

  constructor(config: { client: Client; apiURL: string; password: string }, lifecycleService: { ensureControlAgent: () => Promise<{ agentId: string; toolIds: string[] }> }) {
    this.config = config;
    this.lifecycleService = lifecycleService;
  }

  async attachPmTools(agentId: string): Promise<{ total: number; attached: number; skipped: number; errors: { toolId: string; error: string }[] }> {
    const client = this.config.client;
    console.log(`[Letta] Attaching PM tools to agent ${agentId}...`);
    const controlConfig = await this.lifecycleService.ensureControlAgent();
    const toolIds = controlConfig.toolIds;
    console.log(`[Letta] Control agent has ${toolIds.length} tools - ensuring all are attached`);

    let attachedCount = 0; let skippedCount = 0;
    const errors: { toolId: string; error: string }[] = [];

    for (const toolId of toolIds) {
      try {
        await client.agents.tools.attach(agentId, toolId);
        attachedCount++; console.log(`[Letta] Attached tool: ${toolId}`);
        await new Promise(r => setTimeout(r, 200));
      } catch (error) {
        if ((error as Error).message?.includes('already attached')) {
          skippedCount++; console.log(`[Letta] Tool already attached: ${toolId}`);
        } else { errors.push({ toolId, error: (error as Error).message }); console.error(`[Letta] Error attaching tool ${toolId}:`, (error as Error).message); }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log(`[Letta] Tool attachment complete: ${attachedCount} attached, ${skippedCount} already, ${errors.length} errors`);
    return { total: toolIds.length, attached: attachedCount, skipped: skippedCount, errors };
  }

  async syncToolsFromControl(agentId: string, forceSync = false): Promise<{ total: number; attached: number; detached: number; skipped: number; errors: { toolId: string; operation: string; error: string }[] }> {
    const client = this.config.client;
    console.log(`[Letta] Syncing tools from control agent to ${agentId}...`);
    const controlConfig = await this.lifecycleService.ensureControlAgent();
    const targetToolIds = controlConfig.toolIds;
    console.log(`[Letta] Control agent has ${targetToolIds.length} tools`);

    const currentTools = await client.agents.tools.list(agentId) as { id: string }[];
    const currentToolIds = new Set(currentTools.map(t => t.id));
    console.log(`[Letta] PM agent currently has ${currentTools.length} tools`);

    const toAttach = targetToolIds.filter(id => !currentToolIds.has(id));
    const toDetach = forceSync ? [...currentToolIds].filter(id => !targetToolIds.includes(id)) : [];
    const result = { total: targetToolIds.length, attached: 0, detached: 0, skipped: 0, errors: [] as { toolId: string; operation: string; error: string }[] };

    if (toDetach.length > 0) {
      console.log(`[Letta] Detaching ${toDetach.length} tools...`);
      for (const toolId of toDetach) {
        try { await client.agents.tools.detach(agentId, toolId); result.detached++; console.log(`[Letta] Detached: ${toolId}`); }
        catch (error) { result.errors.push({ toolId, operation: 'detach', error: (error as Error).message }); console.error(`[Letta] Failed to detach ${toolId}:`, (error as Error).message); }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (toAttach.length > 0) {
      console.log(`[Letta] Attaching ${toAttach.length} new tools...`);
      for (const toolId of toAttach) {
        try { await client.agents.tools.attach(agentId, toolId); result.attached++; console.log(`[Letta] Attached: ${toolId}`); }
        catch (error) {
          if ((error as Error).message?.includes('already attached')) { result.skipped++; console.log(`[Letta] Already attached: ${toolId}`); }
          else { result.errors.push({ toolId, operation: 'attach', error: (error as Error).message }); console.error(`[Letta] Failed to attach ${toolId}:`, (error as Error).message); }
        }
        await new Promise(r => setTimeout(r, 200));
      }
    } else { console.log('[Letta] No new tools to attach - agent is up to date'); }

    console.log(`[Letta] Tool sync complete: ${result.attached} attached, ${result.detached} detached, ${result.skipped} already, ${result.errors.length} errors`);
    return result;
  }

  async attachMcpTools(agentId: string): Promise<ReturnType<typeof this.attachPmTools>> {
    console.warn('[Letta] attachMcpTools() is deprecated; syncing PM tools from the control agent instead.');
    return this.attachPmTools(agentId);
  }

  async _ensureMcpTool(name: string, url: string): Promise<{ id: string; name: string }> {
    const client = this.config.client;
    try {
      const tools = await client.tools.mcp.list() as { name: string; id: string }[];
      const existing = tools.find(t => t.name === name);
      if (existing) { console.log(`[Letta] MCP tool already exists: ${name}`); return existing; }
      console.log(`[Letta] Creating MCP tool: ${name} at ${url}`);
      const tool = await client.tools.mcp.create({ name, transport: 'http', url }) as { id: string; name: string };
      console.log(`[Letta] MCP tool created: ${tool.id}`);
      return tool;
    } catch (error) { console.error(`[Letta] Error ensuring MCP tool ${name}:`, (error as Error).message); throw error; }
  }

  async ensureSearchFolderPassagesTool(): Promise<string> {
    const toolName = 'search_folder_passages';
    const { apiURL, password } = this.config;

    try {
      const response = await fetchWithPool(`${apiURL}/tools?name=${toolName}`, { method: 'GET', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' } });
      if (response.ok) {
        const tools = await response.json() as unknown[];
        if (Array.isArray(tools) && tools.length > 0) {
          const first = tools[0] as Record<string, unknown> | undefined;
          if (first && typeof first === 'object' && 'id' in first) { console.log(`[Letta] search_folder_passages tool exists: ${first.id}`); return String(first.id); }
        }
      }

      console.log('[Letta] Creating search_folder_passages tool...');
      const toolSourcePath = resolveFromAppRoot('tools', 'search_folder_passages.py');
      let sourceCode: string;
      try { sourceCode = fs.readFileSync(toolSourcePath, 'utf8'); }
      catch (readError) { console.error(`[Letta] Could not read tool source from ${toolSourcePath}:`, (readError as Error).message); throw new Error(`Tool source file not found: ${toolSourcePath}`); }

      const createResponse = await fetchWithPool(`${apiURL}/tools`, {
        method: 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: toolName, description: 'Search folder/source passages using semantic vector similarity. Use this to find relevant content from uploaded project files and documentation.', source_code: sourceCode, source_type: 'python', tags: ['search', 'folder', 'passages', 'semantic'] }),
      });

      if (!createResponse.ok) { const errorText = await createResponse.text(); throw new Error(`Failed to create tool: HTTP ${createResponse.status}: ${errorText}`); }
      const newTool = await createResponse.json() as Record<string, unknown>;
      if (!newTool || typeof newTool !== 'object' || !('id' in newTool)) throw new Error('Failed to create tool: response did not include an id');
      console.log(`[Letta] search_folder_passages tool created: ${newTool.id}`);
      return String(newTool.id);
    } catch (error) { console.error('[Letta] Error ensuring search_folder_passages tool:', (error as Error).message); throw error; }
  }

  async attachSearchFolderPassagesTool(agentId: string): Promise<boolean> {
    try { const toolId = await this.ensureSearchFolderPassagesTool(); await this.config.client.agents.tools.attach(agentId, toolId); console.log(`[Letta] search_folder_passages tool attached to agent ${agentId}`); return true; }
    catch (error) { if ((error as Error).message?.includes('already attached')) { console.log(`[Letta] search_folder_passages already attached to agent ${agentId}`); return true; } console.error('[Letta] Error attaching search_folder_passages:', (error as Error).message); return false; }
  }

  /**
   * Register or look up the `dispatch_molecule` Letta tool (vibesync-qen).
   *
   * The tool wraps `POST /formulas/:name/run` so a PM agent (or a
   * spawned mayor) can fire a vibesync formula from inside a Letta
   * conversation. The source is Python, lives at `tools/dispatch_molecule.py`,
   * and is uploaded verbatim to Letta the first time. Subsequent calls
   * resolve the existing tool by name and return its id.
   *
   * The tool reads `VIBESYNC_API_BASE_URL` (default http://localhost:3000)
   * and an optional `VIBESYNC_ORCHESTRATION_TOKEN` from the agent's tool
   * execution env at call time, so deployment can point it at the real
   * API host without rewriting the source.
   */
  async ensureDispatchMoleculeTool(): Promise<string> {
    const toolName = 'dispatch_molecule';
    const { apiURL, password } = this.config;

    try {
      const response = await fetchWithPool(`${apiURL}/tools?name=${toolName}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        const tools = await response.json() as unknown[];
        if (Array.isArray(tools) && tools.length > 0) {
          const first = tools[0] as Record<string, unknown> | undefined;
          if (first && typeof first === 'object' && 'id' in first) {
            console.log(`[Letta] dispatch_molecule tool exists: ${String(first.id)}`);
            return String(first.id);
          }
        }
      }

      console.log('[Letta] Creating dispatch_molecule tool...');
      const toolSourcePath = resolveFromAppRoot('tools', 'dispatch_molecule.py');
      let sourceCode: string;
      try {
        sourceCode = fs.readFileSync(toolSourcePath, 'utf8');
      } catch (readError) {
        console.error(`[Letta] Could not read tool source from ${toolSourcePath}:`, (readError as Error).message);
        throw new Error(`Tool source file not found: ${toolSourcePath}`);
      }

      const createResponse = await fetchWithPool(`${apiURL}/tools`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: toolName,
          description: 'Dispatch a vibesync formula (multi-agent workflow) and return its molecule id. Call GET /formulas first to read the whenToUse catalog if you are unsure which formula matches the bead.',
          source_code: sourceCode,
          source_type: 'python',
          tags: ['vibesync', 'orchestration', 'formula'],
        }),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create dispatch_molecule tool: HTTP ${createResponse.status}: ${errorText}`);
      }
      const newTool = await createResponse.json() as Record<string, unknown>;
      if (!newTool || typeof newTool !== 'object' || !('id' in newTool)) {
        throw new Error('Failed to create dispatch_molecule tool: response did not include an id');
      }
      console.log(`[Letta] dispatch_molecule tool created: ${String(newTool.id)}`);
      return String(newTool.id);
    } catch (error) {
      console.error('[Letta] Error ensuring dispatch_molecule tool:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Register or look up the `list_formulas` Letta tool (vibesync-3co).
   *
   * Pair tool to `dispatch_molecule`: GETs `/formulas` and returns the
   * catalog so the PM agent can read each formula's `whenToUse` hint
   * before dispatching. Source is Python, lives at
   * `tools/list_formulas.py`, uploaded verbatim on first use.
   */
  async ensureListFormulasTool(): Promise<string> {
    const toolName = 'list_formulas';
    const { apiURL, password } = this.config;

    try {
      const response = await fetchWithPool(`${apiURL}/tools?name=${toolName}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        const tools = await response.json() as unknown[];
        if (Array.isArray(tools) && tools.length > 0) {
          const first = tools[0] as Record<string, unknown> | undefined;
          if (first && typeof first === 'object' && 'id' in first) {
            console.log(`[Letta] list_formulas tool exists: ${String(first.id)}`);
            return String(first.id);
          }
        }
      }

      console.log('[Letta] Creating list_formulas tool...');
      const toolSourcePath = resolveFromAppRoot('tools', 'list_formulas.py');
      let sourceCode: string;
      try {
        sourceCode = fs.readFileSync(toolSourcePath, 'utf8');
      } catch (readError) {
        console.error(`[Letta] Could not read tool source from ${toolSourcePath}:`, (readError as Error).message);
        throw new Error(`Tool source file not found: ${toolSourcePath}`);
      }

      const createResponse = await fetchWithPool(`${apiURL}/tools`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: toolName,
          description: 'List every vibesync formula with its whenToUse hint. Call this before dispatch_molecule when the right formula is not already obvious.',
          source_code: sourceCode,
          source_type: 'python',
          tags: ['vibesync', 'orchestration', 'formula', 'catalog'],
        }),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create list_formulas tool: HTTP ${createResponse.status}: ${errorText}`);
      }
      const newTool = await createResponse.json() as Record<string, unknown>;
      if (!newTool || typeof newTool !== 'object' || !('id' in newTool)) {
        throw new Error('Failed to create list_formulas tool: response did not include an id');
      }
      console.log(`[Letta] list_formulas tool created: ${String(newTool.id)}`);
      return String(newTool.id);
    } catch (error) {
      console.error('[Letta] Error ensuring list_formulas tool:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Attach the `list_formulas` tool to an agent. Same idempotent shape as
   * `attachDispatchMoleculeTool` — returns true if the tool ended up
   * attached (including already-attached); never throws.
   */
  async attachListFormulasTool(agentId: string): Promise<boolean> {
    try {
      const toolId = await this.ensureListFormulasTool();
      await this.config.client.agents.tools.attach(agentId, toolId);
      console.log(`[Letta] list_formulas tool attached to agent ${agentId}`);
      return true;
    } catch (error) {
      if ((error as Error).message?.includes('already attached')) {
        console.log(`[Letta] list_formulas already attached to agent ${agentId}`);
        return true;
      }
      console.error('[Letta] Error attaching list_formulas:', (error as Error).message);
      return false;
    }
  }

  /**
   * Attach the `dispatch_molecule` tool to an agent. Returns true if the
   * tool ended up attached (including the "already attached" case).
   * Surfaces errors via console.error but never throws — same shape as
   * `attachSearchFolderPassagesTool`.
   */
  async attachDispatchMoleculeTool(agentId: string): Promise<boolean> {
    try {
      const toolId = await this.ensureDispatchMoleculeTool();
      await this.config.client.agents.tools.attach(agentId, toolId);
      console.log(`[Letta] dispatch_molecule tool attached to agent ${agentId}`);
      return true;
    } catch (error) {
      if ((error as Error).message?.includes('already attached')) {
        console.log(`[Letta] dispatch_molecule already attached to agent ${agentId}`);
        return true;
      }
      console.error('[Letta] Error attaching dispatch_molecule:', (error as Error).message);
      return false;
    }
  }

  async setAgentIdEnvVar(agentId: string): Promise<boolean> {
    return this.syncPmAgentEnvVars(agentId, { LETTA_AGENT_ID: agentId });
  }

  /**
   * Write the PM agent's `tool_exec_environment_variables` in one shot
   * (vibesync-j1i). Letta's PATCH on this field replaces the whole map,
   * so every caller that touches it must own the full set. The map this
   * builder writes:
   *
   *   LETTA_AGENT_ID         — required, used by every PM-scoped tool
   *   VIBESYNC_API_BASE_URL  — required, where dispatch_molecule /
   *                            list_formulas POST/GET; defaults to
   *                            `http://localhost:${HEALTH_PORT}` when
   *                            VIBESYNC_API_BASE_URL is unset in the
   *                            server process env
   *   VIBESYNC_ORCHESTRATION_TOKEN — optional bearer for the API; omitted
   *                            from the map when unset so the tool sees
   *                            undefined rather than an empty string
   *
   * Callers may pass `extra` to merge additional keys (e.g. tests). The
   * defaults always take precedence over `extra` for the three keys
   * above so a caller cannot accidentally clobber them.
   */
  async syncPmAgentEnvVars(agentId: string, extra: Record<string, string> = {}): Promise<boolean> {
    const { apiURL, password } = this.config;
    const envVars = buildPmAgentEnvVars(agentId, extra);
    try {
      const response = await fetchWithPool(`${apiURL}/agents/${agentId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_exec_environment_variables: envVars }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      const keys = Object.keys(envVars).sort().join(', ');
      console.log(`[Letta] tool_exec env vars synced on agent ${agentId}: ${keys}`);
      return true;
    } catch (error) {
      console.error('[Letta] Error syncing PM agent env vars:', (error as Error).message);
      return false;
    }
  }
}

/**
 * Source of truth for the PM agent's tool_exec_environment_variables.
 * Pure function so tests can pin the shape without a network round-trip.
 * Resolution order for VIBESYNC_API_BASE_URL:
 *   1. process.env.VIBESYNC_API_BASE_URL (deployment override)
 *   2. `http://localhost:${HEALTH_PORT}` where HEALTH_PORT mirrors the
 *      ApiServer default (3099). Reads HEALTH_PORT at call time so the
 *      env reflects however the server actually bound this process.
 */
export function buildPmAgentEnvVars(agentId: string, extra: Record<string, string> = {}): Record<string, string> {
  const port = (process.env['HEALTH_PORT'] ?? '3099').trim() || '3099';
  const apiBaseUrl = (process.env['VIBESYNC_API_BASE_URL'] ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const token = (process.env['VIBESYNC_ORCHESTRATION_TOKEN'] ?? '').trim();
  const out: Record<string, string> = {
    ...extra,
    LETTA_AGENT_ID: agentId,
    VIBESYNC_API_BASE_URL: apiBaseUrl,
  };
  if (token) out['VIBESYNC_ORCHESTRATION_TOKEN'] = token;
  return out;
}
