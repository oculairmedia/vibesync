import { LettaClient } from '@letta-ai/letta-client';
import { LettaConfig } from './letta/LettaConfig.js';
import { LettaAgentPersistenceService } from './letta/LettaAgentPersistenceService.js';
import { LettaMemoryService } from './letta/LettaMemoryService.js';
import { LettaAgentLifecycleService } from './letta/LettaAgentLifecycleService.js';
import { LettaToolService } from './letta/LettaToolService.js';
import { LettaFolderSourceService } from './letta/LettaFolderSourceService.js';

export class LettaService {
  _config: LettaConfig;
  private _client: LettaClient;
  baseURL: string;
  apiURL: string;
  password: string;
  model: string;
  embedding: string;
  enableSleeptime: boolean;
  sleeptimeFrequency: number;
  lettaDir: string;
  settingsPath: string;
  controlAgentName: string;
  sharedHumanBlockId: string | null;
  _persistence: LettaAgentPersistenceService;
  _memory: LettaMemoryService;
  _lifecycle: LettaAgentLifecycleService;
  _tools: LettaToolService;
  _folders: LettaFolderSourceService;
  _agentState: Record<string, unknown>;
  _folderCache: Map<string, Record<string, unknown>>;
  _sourceCache: Map<string, Record<string, unknown>>;
  _blockHashCache: Map<string, unknown>;
  _controlAgentCache: unknown = null;
  fileService: unknown;

  constructor(baseURL: string, password: string, options: Record<string, unknown> = {}) {
    const client = new LettaClient({ baseUrl: baseURL, token: password });
    const config = new LettaConfig(baseURL, password, { ...options, client });
    const cfg = config as unknown as Record<string, unknown>;

    this._config = config;
    this._client = client;
    this.baseURL = config.baseURL;
    this.apiURL = config.apiURL;
    this.password = config.password;
    this.model = config.model;
    this.embedding = config.embedding;
    this.enableSleeptime = config.enableSleeptime;
    this.sleeptimeFrequency = config.sleeptimeFrequency;
    this.lettaDir = config.lettaDir;
    this.settingsPath = config.settingsPath;
    this.controlAgentName = config.controlAgentName;
    this.sharedHumanBlockId = config.sharedHumanBlockId;

    this._persistence = new LettaAgentPersistenceService(config);
    this._memory = new LettaMemoryService(cfg as { client: Record<string, unknown>; sharedHumanBlockId?: string });
    this._lifecycle = new (LettaAgentLifecycleService as unknown as new (...args: unknown[]) => LettaAgentLifecycleService)(cfg, this._memory, this._persistence);
    this._tools = new (LettaToolService as unknown as new (...args: unknown[]) => LettaToolService)(cfg, this._lifecycle);
    this._folders = new (LettaFolderSourceService as unknown as new (...args: unknown[]) => LettaFolderSourceService)(cfg, this);

    this._agentState = (this._persistence as unknown as { _agentState: Record<string, unknown> })._agentState;
    this._folderCache = (this._folders as unknown as { _folderCache: Map<string, Record<string, unknown>> })._folderCache;
    this._sourceCache = (this._folders as unknown as { _sourceCache: Map<string, Record<string, unknown>> })._sourceCache;
    this._blockHashCache = (this._memory as unknown as { _blockHashCache: Map<string, unknown> })._blockHashCache;
    this._controlAgentCache = (this._lifecycle as unknown as { _controlAgentCache: unknown })._controlAgentCache;
    this.fileService = (this._folders as unknown as { fileService: unknown }).fileService;
  }

  get client(): LettaClient { return this._client; }

  set client(client: LettaClient) {
    this._client = client;
    this._config.client = client;
    const configClient = client as unknown as Record<string, unknown>;
    this._memory.config.client = configClient;
    this._lifecycle.config.client = configClient;
    this._tools.config.client = configClient;
    this._folders.config.client = client as unknown as typeof this._folders.config.client;
  }

  private _syncRuntimeConfig(): void {
    this._config.controlAgentName = this.controlAgentName;
    this._config.sharedHumanBlockId = this.sharedHumanBlockId;
    if (this.sharedHumanBlockId) this._memory.config.sharedHumanBlockId = this.sharedHumanBlockId;
    else delete this._memory.config.sharedHumanBlockId;
    this._lifecycle.config.controlAgentName = this.controlAgentName;
    const lifecycleCache = this._lifecycle as unknown as { _controlAgentCache?: unknown };
    lifecycleCache._controlAgentCache = this._controlAgentCache;
  }

  private _syncControlAgentCache(): void {
    const lifecycleCache = this._lifecycle as unknown as { _controlAgentCache?: unknown };
    this._controlAgentCache = lifecycleCache._controlAgentCache ?? null;
  }

  clearCache(): void { this._folders.clearCache(); this._lifecycle.clearControlAgentCache(); this._controlAgentCache = null; console.log('[Letta] Cache cleared'); }

  async ensureControlAgent() { this._syncRuntimeConfig(); const result = await this._lifecycle.ensureControlAgent(); this._syncControlAgentCache(); return result; }
  async getControlAgentConfig(agentId: string | null = null) { this._syncRuntimeConfig(); const result = await this._lifecycle.getControlAgentConfig(agentId); this._syncControlAgentCache(); return result; }
  async ensureAgent(projectIdentifier: string, projectName: string) {
    this._syncRuntimeConfig();
    const result = await this._lifecycle.ensureAgent(projectIdentifier, projectName);
    this._syncControlAgentCache();
    if (result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string') {
      await this._finalizePmAgent((result as { id: string }).id, projectIdentifier, projectName);
    }
    return result;
  }

  /**
   * Post-spawn wiring shared by every ensureAgent return path
   * (vibesync-rgx). Idempotent — every step ends up in the
   * already-attached / already-set state on re-run. Failures are logged
   * but never throw; an undelivered tool or env var leaves the PM agent
   * usable for everything except formula dispatch, which is a soft
   * regression rather than a fatal one.
   *
   * The persona push (vibesync-3hj) is included here so existing agents
   * (created before the Formula Dispatch Protocol was added to
   * buildPersonaBlock) get the new content on the next ensureAgent
   * call. _updatePersonaBlock is idempotent — it modifies the existing
   * persona block if one exists, otherwise creates+attaches a new one.
   */
  private async _finalizePmAgent(agentId: string, projectIdentifier: string, projectName: string): Promise<void> {
    try { await this._tools.attachDispatchMoleculeTool(agentId); }
    catch (err) { console.warn(`[Letta] _finalizePmAgent: attachDispatchMoleculeTool failed for ${agentId}: ${(err as Error).message}`); }
    try { await this._tools.attachListFormulasTool(agentId); }
    catch (err) { console.warn(`[Letta] _finalizePmAgent: attachListFormulasTool failed for ${agentId}: ${(err as Error).message}`); }
    try { await this._tools.syncPmAgentEnvVars(agentId); }
    catch (err) { console.warn(`[Letta] _finalizePmAgent: syncPmAgentEnvVars failed for ${agentId}: ${(err as Error).message}`); }
    try {
      const persona = this._lifecycle._buildPersonaBlock(projectIdentifier, projectName);
      await this._memory._updatePersonaBlock(agentId, persona);
    } catch (err) { console.warn(`[Letta] _finalizePmAgent: persona update failed for ${agentId}: ${(err as Error).message}`); }
  }
  async getAgent(agentId: string) { this._syncRuntimeConfig(); return this._lifecycle.getAgent(agentId); }
  async listAgents(filters: Record<string, unknown> = {}) { this._syncRuntimeConfig(); return this._lifecycle.listAgents(filters); }
  _buildPersonaBlock(projectIdentifier: string, projectName: string) { return this._lifecycle._buildPersonaBlock(projectIdentifier, projectName); }

  _loadAgentState() { return (this._persistence as unknown as { _loadAgentState: () => unknown })._loadAgentState(); }
  _saveAgentState() { return (this._persistence as unknown as { _saveAgentState: () => unknown })._saveAgentState(); }
  getPersistedAgentId(projectIdentifier: string) { return this._persistence.getPersistedAgentId(projectIdentifier); }
  saveAgentId(projectIdentifier: string, agentId: string) { return this._persistence.saveAgentId(projectIdentifier, agentId); }
  saveAgentIdToProjectFolder(projectPath: string, agentId: string, projectInfo?: Record<string, unknown>) { return (this._persistence as unknown as { saveAgentIdToProjectFolder: (p: string, a: string, i?: Record<string, unknown>) => unknown }).saveAgentIdToProjectFolder(projectPath, agentId, projectInfo); }
  updateAgentsMdWithProjectInfo(projectPath: string, agentId: string, projectInfo: Record<string, unknown>) { return (this._persistence as unknown as { updateAgentsMdWithProjectInfo: (p: string, a: string, i: Record<string, unknown>) => unknown }).updateAgentsMdWithProjectInfo(projectPath, agentId, projectInfo); }

  async attachPmTools(agentId: string) { this._syncRuntimeConfig(); return this._tools.attachPmTools(agentId); }
  async syncToolsFromControl(agentId: string, forceSync?: boolean) { this._syncRuntimeConfig(); return this._tools.syncToolsFromControl(agentId, forceSync); }
  async attachMcpTools(agentId: string) { this._syncRuntimeConfig(); return this._tools.attachMcpTools(agentId); }
  async _ensureMcpTool(name: string, url: string) { return this._tools._ensureMcpTool(name, url); }
  async ensureSearchFolderPassagesTool() { return this._tools.ensureSearchFolderPassagesTool(); }
  async attachSearchFolderPassagesTool(agentId: string) { return this._tools.attachSearchFolderPassagesTool(agentId); }
  async ensureDispatchMoleculeTool() { return this._tools.ensureDispatchMoleculeTool(); }
  async attachDispatchMoleculeTool(agentId: string) { return this._tools.attachDispatchMoleculeTool(agentId); }
  async ensureListFormulasTool() { return this._tools.ensureListFormulasTool(); }
  async attachListFormulasTool(agentId: string) { return this._tools.attachListFormulasTool(agentId); }
  async setAgentIdEnvVar(agentId: string) { return this._tools.setAgentIdEnvVar(agentId); }
  async syncPmAgentEnvVars(agentId: string, extra: Record<string, string> = {}) { return this._tools.syncPmAgentEnvVars(agentId, extra); }

  async _updatePersonaBlock(agentId: string, personaContent: string) { this._syncRuntimeConfig(); return (this._memory as unknown as { _updatePersonaBlock: (a: string, c: string) => Promise<void> })._updatePersonaBlock(agentId, personaContent); }
  async _ensureTemplateBlocks(agentId: string, opts: Record<string, unknown>) { this._syncRuntimeConfig(); return (this._memory as unknown as { _ensureTemplateBlocks: (a: string, o: Record<string, unknown>) => Promise<void> })._ensureTemplateBlocks(agentId, opts); }
  async _attachSharedHumanBlock(agentId: string) { this._syncRuntimeConfig(); return (this._memory as unknown as { _attachSharedHumanBlock: (a: string) => Promise<void> })._attachSharedHumanBlock(agentId); }
  async upsertMemoryBlocks(agentId: string, blocks: { label: string; value: unknown }[]) { return this._memory.upsertMemoryBlocks(agentId, blocks); }
  _hashContent(content: string) { return this._memory._hashContent(content); }
  async initializeScratchpad(agentId: string) { return this._memory.initializeScratchpad(agentId); }

  async ensureFolder(projectIdentifier: string, filesystemPath?: string | null) { return this._folders.ensureFolder(projectIdentifier, filesystemPath); }
  async attachFolderToAgent(agentId: string, folderId: string) { return this._folders.attachFolderToAgent(agentId, folderId); }
  async listFolderFiles(folderId: string) { return this._folders.listFolderFiles(folderId); }
  async closeAllFiles(agentId: string) { return this._folders.closeAllFiles(agentId); }
  async ensureSource(sourceName: string, folderId?: string | null) { return this._folders.ensureSource(sourceName, folderId); }
  async discoverProjectFiles(projectPath: string, options?: { docsOnly?: boolean; maxFiles?: number }) { return this._folders.discoverProjectFiles(projectPath, options); }
  async discoverProjectFilesLegacy(projectPath: string) { return this._folders.discoverProjectFilesLegacy(projectPath); }
  async uploadProjectFiles(folderId: string, projectPath: string, files: string[], maxFiles?: number) { return this._folders.uploadProjectFiles(folderId, projectPath, files, maxFiles); }
  computeFileHash(filePath: string) { return this._folders.computeFileHash(filePath); }
  async deleteFile(folderId: string, fileId: string) { return this._folders.deleteFile(folderId, fileId); }
  async syncProjectFilesIncremental(folderId: string, projectPath: string, files: string[], db: Record<string, unknown>, projectIdentifier: string) { return (this._folders as unknown as { syncProjectFilesIncremental: (f: string, p: string, fl: string[], d: Record<string, unknown>, pi: string) => Promise<unknown> }).syncProjectFilesIncremental(folderId, projectPath, files, db, projectIdentifier); }
  async uploadReadme(sourceId: string, readmePath: string, projectIdentifier: string) { return this._folders.uploadReadme(sourceId, readmePath, projectIdentifier); }
  async attachSourceToAgent(agentId: string, sourceId: string) { return this._folders.attachSourceToAgent(agentId, sourceId); }
}

export function createLettaService(): LettaService {
  const baseURL = process.env.LETTA_BASE_URL!;
  const password = process.env.LETTA_PASSWORD!;
  if (!baseURL || !password) throw new Error('LETTA_BASE_URL and LETTA_PASSWORD must be set');
  return new LettaService(baseURL, password, { model: process.env.LETTA_MODEL, embedding: process.env.LETTA_EMBEDDING });
}

export { buildProjectMeta, buildBoardConfig, buildBoardMetrics, buildHotspots, buildBacklogSummary, buildRecentActivity, buildComponentsSummary, buildChangeLog, buildScratchpad, buildExpression } from './LettaMemoryBuilders.js';
export { LettaFileService } from './LettaFileService.js';
