/**
 * Unit Tests for LettaService
 *
 * Comprehensive test coverage for:
 * - ensureAgent() - agent creation/retrieval
 * - ensureControlAgent() - control agent management
 * - attachPmTools() - tool attachment
 * - syncToolsFromControl() - tool synchronization
 * - ensureFolder() - folder creation with caching
 * - ensureSource() - source creation with caching
 * - getPersistedAgentId() / saveAgentId() - persistence
 * - clearCache() - cache management
 * - upsertMemoryBlocks() - memory block management
 * - Error scenarios (rate limits, 404s, 409 conflicts)
 * - Caching behavior (cache hits vs misses)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LettaService, createLettaService } from '../../src/LettaService';

// Mock external dependencies
vi.mock('@letta-ai/letta-client', () => {
  class MockLettaClient {
    constructor() {
      this.agents = {
        list: vi.fn(),
        retrieve: vi.fn(),
        tools: {
          list: vi.fn(),
          attach: vi.fn(),
          detach: vi.fn(),
        },
        blocks: {
          list: vi.fn(),
          attach: vi.fn(),
        },
        folders: {
          list: vi.fn(),
          attach: vi.fn(),
        },
        sources: {
          list: vi.fn(),
          attach: vi.fn(),
        },
        files: {
          closeAll: vi.fn(),
        },
      };
      this.blocks = {
        create: vi.fn(),
        modify: vi.fn(),
      };
      this.folders = {
        list: vi.fn(),
        create: vi.fn(),
        files: {
          upload: vi.fn(),
        },
      };
      this.sources = {
        list: vi.fn(),
        create: vi.fn(),
        files: {
          list: vi.fn(),
          upload: vi.fn(),
        },
      };
      this.tools = {
        mcp: {
          list: vi.fn(),
          create: vi.fn(),
        },
      };
    }
  }

  return { LettaClient: MockLettaClient };
});

vi.mock('../../src/http', () => ({
  fetchWithPool: vi.fn(),
}));

vi.mock('../../src/LettaMemoryBuilders', () => ({
  buildScratchpad: vi.fn(() => ({
    notes: [],
    observations: [],
    action_items: [],
    context: {},
    usage_guide: 'Test scratchpad',
  })),
  buildExpression: vi.fn(() => 'Test expression block content'),
}));

vi.mock('fs', () => {
  // Share instances so default import and dynamic import use same mocks
  const mockFs = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    createReadStream: vi.fn(),
  };
  return { default: mockFs, ...mockFs };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../src/AgentsMdGenerator', () => ({
  agentsMdGenerator: {
    generate: vi.fn(() => ({ changes: [{ section: 'project-info', action: 'updated' }] })),
  },
}));

import { LettaClient } from '@letta-ai/letta-client';
import { fetchWithPool } from '../../src/http';
import { buildScratchpad, buildExpression } from '../../src/LettaMemoryBuilders';
import { agentsMdGenerator } from '../../src/AgentsMdGenerator';
import { execSync } from 'child_process';
import fs from 'fs';

describe('LettaService', () => {
  let service;
  let mockClient;
  let consoleSpy;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Get the mock client instance
    mockClient = new LettaClient();

    // Create service instance
    service = new LettaService('http://localhost:8283', 'test-password', {
      model: 'anthropic/sonnet-4-5',
      embedding: 'letta/letta-free',
    });

    // Replace the client with our mock
    service.client = mockClient;

    // Suppress console output during tests
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };

    // Mock fs.existsSync to return false by default (no existing settings)
    fs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // Constructor Tests
  // ============================================================
  describe('constructor', () => {
    it('should initialize with correct defaults', () => {
      const svc = new LettaService('http://localhost:8283', 'password');

      expect(svc.baseURL).toBe('http://localhost:8283');
      expect(svc.apiURL).toBe('http://localhost:8283/v1');
      expect(svc.password).toBe('password');
      expect(svc.model).toBe('anthropic/sonnet-4-5');
      expect(svc.embedding).toBe('letta/letta-free');
    });

    it('should not append /v1 if already present', () => {
      const svc = new LettaService('http://localhost:8283/v1', 'password');

      expect(svc.apiURL).toBe('http://localhost:8283/v1');
    });

    it('should use provided options over defaults', () => {
      const svc = new LettaService('http://localhost:8283', 'password', {
        model: 'custom-model',
        embedding: 'custom-embedding',
        controlAgentName: 'Custom-Control',
      });

      expect(svc.model).toBe('custom-model');
      expect(svc.embedding).toBe('custom-embedding');
      expect(svc.controlAgentName).toBe('Custom-Control');
    });
  });

  // ============================================================
  // clearCache Tests
  // ============================================================
  describe('clearCache', () => {
    it('should clear folder and source caches', () => {
      // Populate caches
      service._folderCache.set('test-folder', { id: 'folder-1' });
      service._sourceCache.set('test-source', { id: 'source-1' });
      service._controlAgentCache = { agentId: 'control-1' };

      service.clearCache();

      expect(service._folderCache.size).toBe(0);
      expect(service._sourceCache.size).toBe(0);
      expect(service._controlAgentCache).toBeNull();
    });

    it('should retain block hash cache', () => {
      service._blockHashCache.set('agent-1', new Map([['label', 'hash']]));

      service.clearCache();

      expect(service._blockHashCache.size).toBe(1);
    });
  });

  // ============================================================
  // getPersistedAgentId / saveAgentId Tests
  // ============================================================
  describe('getPersistedAgentId', () => {
    it('should return null when no agent is persisted', () => {
      const result = service.getPersistedAgentId('TEST');

      expect(result).toBeNull();
    });

    it('should return persisted agent ID', () => {
      service._agentState.agents['TEST'] = 'agent-123';

      const result = service.getPersistedAgentId('TEST');

      expect(result).toBe('agent-123');
    });
  });

  describe('saveAgentId', () => {
    it('should save agent ID to state', () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => {});

      service.saveAgentId('TEST', 'agent-456');

      expect(service._agentState.agents['TEST']).toBe('agent-456');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should create directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {});
      fs.writeFileSync.mockImplementation(() => {});

      service.saveAgentId('TEST', 'agent-789');

      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  // ============================================================
  // ensureControlAgent Tests
  // ============================================================
  describe('ensureControlAgent', () => {
    it('should return cached control agent if available', async () => {
      const cachedConfig = {
        agentId: 'control-123',
        agentName: 'PM-Control',
        toolIds: ['tool-1', 'tool-2'],
        persona: 'Test persona',
      };
      service._controlAgentCache = cachedConfig;

      const result = await service.ensureControlAgent();

      expect(result).toEqual(cachedConfig);
      expect(mockClient.agents.list).not.toHaveBeenCalled();
    });

    it('should find existing control agent by name', async () => {
      const existingAgent = {
        id: 'control-456',
        name: 'PM-Control',
        memory: { blocks: [{ label: 'persona', value: 'Test persona' }] },
      };

      service.controlAgentName = existingAgent.name;

      mockClient.agents.list.mockResolvedValue([existingAgent]);
      mockClient.agents.retrieve.mockResolvedValue(existingAgent);
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }, { id: 'tool-2' }]);

      const result = await service.ensureControlAgent();

      expect(result.agentId).toBe('control-456');
      expect(result.toolIds).toEqual(['tool-1', 'tool-2']);
      expect(service._controlAgentCache).toEqual(result);
    });

    it('should create control agent if not found', async () => {
      mockClient.agents.list.mockResolvedValue([]);

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'new-control-789',
          name: 'PM-Control',
          memory: { blocks: [] },
        }),
      });

      mockClient.agents.retrieve.mockResolvedValue({
        id: 'new-control-789',
        name: 'PM-Control',
        memory: { blocks: [{ label: 'persona', value: 'Created persona' }] },
      });
      mockClient.agents.tools.list.mockResolvedValue([]);
      mockClient.agents.tools.attach.mockResolvedValue({});
      mockClient.blocks.create.mockResolvedValue({ id: 'block-1' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      const result = await service.ensureControlAgent();

      expect(result.agentId).toBe('new-control-789');
      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error on API failure', async () => {
      mockClient.agents.list.mockRejectedValue(new Error('API Error'));

      await expect(service.ensureControlAgent()).rejects.toThrow('API Error');
    });
  });

  // ============================================================
  // ensureAgent Tests
  // ============================================================
  describe('ensureAgent', () => {
    beforeEach(() => {
      service._controlAgentCache = {
        agentId: 'control-123',
        toolIds: ['tool-1'],
        persona: 'Control persona',
      };
      // _ensureTemplateBlocks is called for existing agents — provide default mocks
      mockClient.agents.blocks.list.mockResolvedValue([
        { id: 'scratch-1', label: 'scratchpad', value: '{}' },
      ]);
      mockClient.agents.blocks.attach.mockResolvedValue({});
    });

    it('should return existing agent from Letta by name', async () => {
      const existingAgent = {
        id: 'agent-existing',
        name: 'PM - Test Project',
        created_at: '2025-01-01T00:00:00Z',
      };

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [existingAgent],
      });

      const result = await service.ensureAgent('TEST', 'Test Project');

      expect(result.id).toBe('agent-existing');
      expect(service._agentState.agents['TEST']).toBe('agent-existing');
    });

    it('finalizePmAgent attaches dispatch_molecule + list_formulas and syncs env vars after ensureAgent (vibesync-rgx)', async () => {
      const agent = { id: 'agent-final', name: 'PM - X' };
      fetchWithPool.mockResolvedValue({ ok: true, json: async () => [{ id: 'tool-dispatch', name: 'dispatch_molecule' }] });
      // First fetchWithPool call inside ensureAgent (list-by-name) needs to
      // return the existing agent so we land in the resume path.
      fetchWithPool.mockResolvedValueOnce({ ok: true, json: async () => [agent] });

      const attachDispatchSpy = vi.spyOn(service._tools, 'attachDispatchMoleculeTool');
      const attachListSpy = vi.spyOn(service._tools, 'attachListFormulasTool');
      const envSpy = vi.spyOn(service._tools, 'syncPmAgentEnvVars');

      await service.ensureAgent('X', 'X');

      expect(attachDispatchSpy).toHaveBeenCalledWith('agent-final');
      expect(attachListSpy).toHaveBeenCalledWith('agent-final');
      expect(envSpy).toHaveBeenCalledWith('agent-final');
    });

    it('finalizePmAgent failures are non-fatal — ensureAgent still returns the agent (vibesync-rgx)', async () => {
      const agent = { id: 'agent-soft-fail', name: 'PM - X' };
      fetchWithPool.mockResolvedValue({ ok: true, json: async () => [agent] });

      vi.spyOn(service._tools, 'attachDispatchMoleculeTool').mockRejectedValueOnce(new Error('letta down'));
      vi.spyOn(service._tools, 'syncPmAgentEnvVars').mockRejectedValueOnce(new Error('letta down'));

      const result = await service.ensureAgent('X', 'X');
      expect(result.id).toBe('agent-soft-fail');
    });

    it('should return persisted agent if found in Letta', async () => {
      service._agentState.agents['TEST'] = 'agent-persisted';

      const persistedAgent = {
        id: 'agent-persisted',
        name: 'PM - Test Project',
      };

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [persistedAgent],
      });

      const result = await service.ensureAgent('TEST', 'Test Project');

      expect(result.id).toBe('agent-persisted');
    });

    it('should create new agent if none exists', async () => {
      fetchWithPool
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [], // No existing agents
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'new-agent-123',
            name: 'PM - New Project',
          }),
        });

      mockClient.agents.list.mockResolvedValue([]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [{ label: 'persona', value: 'Control persona' }] },
      });
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }]);
      mockClient.blocks.create.mockResolvedValue({ id: 'block-1' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      const result = await service.ensureAgent('NEW', 'New Project');

      expect(result.id).toBe('new-agent-123');
      expect(service._agentState.agents['NEW']).toBe('new-agent-123');
    });

    it('should handle duplicate agents by using most recent', async () => {
      const duplicateAgents = [
        { id: 'agent-old', name: 'PM - Test Project', created_at: '2025-01-01T00:00:00Z' },
        { id: 'agent-new', name: 'PM - Test Project', created_at: '2025-01-20T00:00:00Z' },
      ];

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => duplicateAgents,
      });

      const result = await service.ensureAgent('TEST', 'Test Project');

      expect(result.id).toBe('agent-new');
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining('DUPLICATE AGENTS DETECTED')
      );
    });

    it('should retry on rate limit errors', async () => {
      fetchWithPool
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [], // No existing agents
        })
        .mockRejectedValueOnce(new Error('HTTP 500: Rate limit'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [], // Check if agent was created
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'retry-agent',
            name: 'PM - Retry Project',
          }),
        });

      mockClient.agents.list.mockResolvedValue([]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [{ label: 'persona', value: 'Control persona' }] },
      });
      mockClient.agents.tools.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'block-1' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      const result = await service.ensureAgent('RETRY', 'Retry Project');

      expect(result.id).toBe('retry-agent');
      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit'));
    });

    it('should sanitize project name for agent name', async () => {
      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      // Will fail to create but we can check the name sanitization
      fetchWithPool.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });
      fetchWithPool.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'sanitized-agent',
          name: 'PM - Test-Project-Name',
        }),
      });

      mockClient.agents.list.mockResolvedValue([]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'block-1' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service.ensureAgent('TEST', 'Test/Project:Name');

      // Check that the POST was called with sanitized name
      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/agents'),
        expect.objectContaining({
          body: expect.stringContaining('PM - Test-Project-Name'),
        })
      );
    });
  });

  // ============================================================
  // attachPmTools Tests
  // ============================================================
  describe('attachPmTools', () => {
    beforeEach(() => {
      service._controlAgentCache = {
        agentId: 'control-123',
        toolIds: ['tool-1', 'tool-2', 'tool-3'],
        persona: 'Control persona',
      };
    });

    it('should attach all tools from control agent', async () => {
      mockClient.agents.list.mockResolvedValue([
        { id: 'control-123', name: 'PM-Control', memory: { blocks: [] } },
      ]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list.mockResolvedValue([
        { id: 'tool-1' },
        { id: 'tool-2' },
        { id: 'tool-3' },
      ]);
      mockClient.agents.tools.attach.mockResolvedValue({});

      const result = await service.attachPmTools('agent-123');

      expect(result.total).toBe(3);
      expect(result.attached).toBe(3);
      expect(mockClient.agents.tools.attach).toHaveBeenCalledTimes(3);
    });

    it('should skip already attached tools', async () => {
      service._controlAgentCache.toolIds = ['tool-1', 'tool-2'];
      mockClient.agents.list.mockResolvedValue([
        { id: 'control-123', name: 'PM-Control', memory: { blocks: [] } },
      ]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }, { id: 'tool-2' }]);
      mockClient.agents.tools.attach
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('already attached'));

      const result = await service.attachPmTools('agent-123');

      expect(result.attached).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should track errors during attachment', async () => {
      service._controlAgentCache.toolIds = ['tool-1'];
      mockClient.agents.list.mockResolvedValue([
        { id: 'control-123', name: 'PM-Control', memory: { blocks: [] } },
      ]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }]);
      mockClient.agents.tools.attach.mockRejectedValue(new Error('Network error'));

      const result = await service.attachPmTools('agent-123');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe('Network error');
    });
  });

  // ============================================================
  // syncToolsFromControl Tests
  // ============================================================
  describe('syncToolsFromControl', () => {
    beforeEach(() => {
      service._controlAgentCache = {
        agentId: 'control-123',
        toolIds: ['tool-1', 'tool-2'],
        persona: 'Control persona',
      };
    });

    it('should attach missing tools', async () => {
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }]);
      mockClient.agents.tools.attach.mockResolvedValue({});

      const result = await service.syncToolsFromControl('pm-agent-123');

      expect(result.attached).toBe(1);
      expect(mockClient.agents.tools.attach).toHaveBeenCalledWith('pm-agent-123', 'tool-2');
    });

    it('should detach extra tools when forceSync is true', async () => {
      mockClient.agents.tools.list.mockResolvedValue([{ id: 'tool-1' }, { id: 'tool-extra' }]);
      mockClient.agents.tools.detach.mockResolvedValue({});

      const result = await service.syncToolsFromControl('pm-agent-123', true);

      expect(result.detached).toBe(1);
      expect(mockClient.agents.tools.detach).toHaveBeenCalledWith('pm-agent-123', 'tool-extra');
    });

    it('should not detach tools when forceSync is false', async () => {
      mockClient.agents.list.mockResolvedValue([
        { id: 'control-123', name: 'PM-Control', memory: { blocks: [] } },
      ]);
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'control-123',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list
        .mockResolvedValueOnce([{ id: 'tool-1' }])
        .mockResolvedValueOnce([{ id: 'tool-1' }, { id: 'tool-extra' }]);

      const result = await service.syncToolsFromControl('pm-agent-123', false);

      expect(result.detached).toBe(0);
      expect(mockClient.agents.tools.detach).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // ensureFolder Tests
  // ============================================================
  describe('ensureFolder', () => {
    it('should return cached folder if available', async () => {
      const cachedFolder = { id: 'folder-cached', name: 'PM-TEST' };
      service._folderCache.set('PM-TEST', cachedFolder);

      const result = await service.ensureFolder('TEST');

      expect(result).toEqual(cachedFolder);
      expect(mockClient.folders.list).not.toHaveBeenCalled();
    });

    it('should find existing folder by name', async () => {
      const existingFolder = { id: 'folder-existing', name: 'PM-TEST' };
      mockClient.folders.list.mockResolvedValue([existingFolder]);

      const result = await service.ensureFolder('TEST');

      expect(result.id).toBe('folder-existing');
      expect(service._folderCache.get('PM-TEST')).toEqual(existingFolder);
    });

    it('should create new folder if not found', async () => {
      mockClient.folders.list.mockResolvedValue([]);
      mockClient.folders.create.mockResolvedValue({
        id: 'folder-new',
        name: 'PM-NEW',
      });

      const result = await service.ensureFolder('NEW');

      expect(result.id).toBe('folder-new');
      expect(mockClient.folders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'PM-NEW',
          embedding: 'letta/letta-free',
        })
      );
    });

    it('should include filesystem path in metadata if provided', async () => {
      mockClient.folders.list.mockResolvedValue([]);
      mockClient.folders.create.mockResolvedValue({
        id: 'folder-with-path',
        name: 'PM-PATH',
      });

      await service.ensureFolder('PATH', '/opt/projects/test');

      expect(mockClient.folders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { filesystem_path: '/opt/projects/test' },
        })
      );
    });
  });

  // ============================================================
  // ensureSource Tests
  // ============================================================
  describe('ensureSource', () => {
    it('should return cached source if available', async () => {
      const cachedSource = { id: 'source-cached', name: 'README' };
      service._sourceCache.set('README', cachedSource);

      const result = await service.ensureSource('README');

      expect(result).toEqual(cachedSource);
      expect(mockClient.sources.list).not.toHaveBeenCalled();
    });

    it('should find existing source by name', async () => {
      const existingSource = { id: 'source-existing', name: 'README' };
      mockClient.sources.list.mockResolvedValue([existingSource]);

      const result = await service.ensureSource('README');

      expect(result.id).toBe('source-existing');
      expect(service._sourceCache.get('README')).toEqual(existingSource);
    });

    it('should create new source if not found', async () => {
      mockClient.sources.list.mockResolvedValue([]);
      mockClient.sources.create.mockResolvedValue({
        id: 'source-new',
        name: 'NEW-SOURCE',
      });

      const result = await service.ensureSource('NEW-SOURCE');

      expect(result.id).toBe('source-new');
      expect(mockClient.sources.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'NEW-SOURCE',
          embedding: 'letta/letta-free',
        })
      );
    });

    it('should handle 409 conflict by fetching existing source', async () => {
      mockClient.sources.list.mockResolvedValue([]);
      mockClient.sources.create.mockRejectedValue(new Error('409 Conflict'));

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'source-conflict', name: 'CONFLICT-SOURCE' }],
      });

      const result = await service.ensureSource('CONFLICT-SOURCE');

      expect(result.id).toBe('source-conflict');
    });

    it('should return placeholder on unrecoverable 409', async () => {
      mockClient.sources.list.mockResolvedValue([]);
      mockClient.sources.create.mockRejectedValue(new Error('409 Conflict'));

      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [], // Source not found via REST either
      });

      // Mock SDK list to also return empty
      mockClient.sources.list.mockResolvedValue([]);

      const result = await service.ensureSource('MISSING-SOURCE');

      expect(result._placeholder).toBe(true);
      expect(result.id).toBeNull();
    });
  });

  // ============================================================
  // upsertMemoryBlocks Tests
  // ============================================================
  describe('upsertMemoryBlocks', () => {
    it('should skip API calls when all blocks match cache', async () => {
      const blocks = [{ label: 'test-block', value: 'test content' }];

      // Pre-populate cache with matching hash
      const hash = service._hashContent('test content');
      service._blockHashCache.set('agent-123', new Map([['test-block', hash]]));

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(mockClient.agents.blocks.list).not.toHaveBeenCalled();
    });

    it('should update existing blocks when content changes', async () => {
      const blocks = [{ label: 'existing-block', value: 'new content' }];

      mockClient.agents.blocks.list.mockResolvedValue([
        { id: 'block-1', label: 'existing-block', value: 'old content' },
      ]);
      mockClient.blocks.modify.mockResolvedValue({});

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(mockClient.blocks.modify).toHaveBeenCalledWith('block-1', { value: 'new content' });
    });

    it('should create and attach new blocks', async () => {
      const blocks = [{ label: 'new-block', value: 'new content' }];

      mockClient.agents.blocks.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'created-block' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(mockClient.blocks.create).toHaveBeenCalledWith({
        label: 'new-block',
        value: 'new content',
      });
      expect(mockClient.agents.blocks.attach).toHaveBeenCalledWith('agent-123', 'created-block');
    });

    it('should truncate blocks exceeding size limit', async () => {
      const largeContent = 'x'.repeat(60000); // Exceeds 50000 char limit
      const blocks = [{ label: 'large-block', value: largeContent }];

      mockClient.agents.blocks.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'truncated-block' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds size limit'));
      expect(mockClient.blocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.stringContaining('[truncated]'),
        })
      );
    });

    it('should skip unchanged blocks', async () => {
      const blocks = [{ label: 'unchanged-block', value: 'same content' }];

      mockClient.agents.blocks.list.mockResolvedValue([
        { id: 'block-1', label: 'unchanged-block', value: 'same content' },
      ]);

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(mockClient.blocks.modify).not.toHaveBeenCalled();
      expect(mockClient.blocks.create).not.toHaveBeenCalled();
    });

    it('should serialize object values to JSON', async () => {
      const blocks = [{ label: 'object-block', value: { key: 'value', nested: { a: 1 } } }];

      mockClient.agents.blocks.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'json-block' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service.upsertMemoryBlocks('agent-123', blocks);

      expect(mockClient.blocks.create).toHaveBeenCalledWith({
        label: 'object-block',
        value: JSON.stringify({ key: 'value', nested: { a: 1 } }, null, 2),
      });
    });
  });

  // ============================================================
  // initializeScratchpad Tests
  // ============================================================
  describe('initializeScratchpad', () => {
    it('should skip if scratchpad already exists', async () => {
      mockClient.agents.blocks.list.mockResolvedValue([
        { id: 'existing-scratchpad', label: 'scratchpad', value: '{}' },
      ]);

      await service.initializeScratchpad('agent-123');

      expect(mockClient.blocks.create).not.toHaveBeenCalled();
    });

    it('should create and attach scratchpad if not exists', async () => {
      mockClient.agents.blocks.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'new-scratchpad' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service.initializeScratchpad('agent-123');

      expect(mockClient.blocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'scratchpad',
        })
      );
      expect(mockClient.agents.blocks.attach).toHaveBeenCalledWith('agent-123', 'new-scratchpad');
    });
  });

  // ============================================================
  // getAgent / listAgents Tests
  // ============================================================
  describe('getAgent', () => {
    it('should retrieve agent by ID', async () => {
      const agent = { id: 'agent-123', name: 'Test Agent' };
      mockClient.agents.retrieve.mockResolvedValue(agent);

      const result = await service.getAgent('agent-123');

      expect(result).toEqual(agent);
      expect(mockClient.agents.retrieve).toHaveBeenCalledWith('agent-123');
    });

    it('should throw on error', async () => {
      mockClient.agents.retrieve.mockRejectedValue(new Error('Not found'));

      await expect(service.getAgent('invalid')).rejects.toThrow('Not found');
    });
  });

  describe('listAgents', () => {
    it('should list agents with filters', async () => {
      const agents = [{ id: 'agent-1' }, { id: 'agent-2' }];
      mockClient.agents.list.mockResolvedValue(agents);

      const result = await service.listAgents({ name: 'Test' });

      expect(result).toEqual(agents);
      expect(mockClient.agents.list).toHaveBeenCalledWith({ name: 'Test' });
    });
  });

  // ============================================================
  // attachFolderToAgent Tests
  // ============================================================
  describe('attachFolderToAgent', () => {
    it('should skip if folder already attached', async () => {
      mockClient.agents.folders.list.mockResolvedValue([{ id: 'folder-123' }]);

      await service.attachFolderToAgent('agent-123', 'folder-123');

      expect(mockClient.agents.folders.attach).not.toHaveBeenCalled();
    });

    it('should attach folder if not already attached', async () => {
      mockClient.agents.folders.list.mockResolvedValue([]);
      mockClient.agents.folders.attach.mockResolvedValue({});

      await service.attachFolderToAgent('agent-123', 'folder-456');

      expect(mockClient.agents.folders.attach).toHaveBeenCalledWith('agent-123', 'folder-456');
    });
  });

  // ============================================================
  // attachSourceToAgent Tests
  // ============================================================
  describe('attachSourceToAgent', () => {
    it('should skip if source already attached', async () => {
      mockClient.agents.sources.list.mockResolvedValue([{ id: 'source-123' }]);

      await service.attachSourceToAgent('agent-123', 'source-123');

      expect(mockClient.agents.sources.attach).not.toHaveBeenCalled();
    });

    it('should attach source if not already attached', async () => {
      mockClient.agents.sources.list.mockResolvedValue([]);
      mockClient.agents.sources.attach.mockResolvedValue({});

      await service.attachSourceToAgent('agent-123', 'source-456');

      expect(mockClient.agents.sources.attach).toHaveBeenCalledWith('agent-123', 'source-456');
    });
  });

  // ============================================================
  // listFolderFiles / closeAllFiles Tests
  // ============================================================
  describe('listFolderFiles', () => {
    it('should return files from folder', async () => {
      const files = [{ id: 'file-1' }, { id: 'file-2' }];
      mockClient.sources.files.list.mockResolvedValue(files);

      const result = await service.listFolderFiles('folder-123');

      expect(result).toEqual(files);
    });

    it('should return empty array on error', async () => {
      mockClient.sources.files.list.mockRejectedValue(new Error('Error'));

      const result = await service.listFolderFiles('folder-123');

      expect(result).toEqual([]);
    });
  });

  describe('closeAllFiles', () => {
    it('should close all files for agent', async () => {
      mockClient.agents.files.closeAll.mockResolvedValue({});

      await service.closeAllFiles('agent-123');

      expect(mockClient.agents.files.closeAll).toHaveBeenCalledWith('agent-123');
    });
  });

  // ============================================================
  // _hashContent Tests
  // ============================================================
  describe('_hashContent', () => {
    it('should return 0 for empty content', () => {
      expect(service._hashContent('')).toBe(0);
      expect(service._hashContent(null)).toBe(0);
    });

    it('should return consistent hash for same content', () => {
      const hash1 = service._hashContent('test content');
      const hash2 = service._hashContent('test content');

      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different content', () => {
      const hash1 = service._hashContent('content A');
      const hash2 = service._hashContent('content B');

      expect(hash1).not.toBe(hash2);
    });
  });

  // ============================================================
  // createLettaService Factory Tests
  // ============================================================
  describe('createLettaService', () => {
    it('should throw if LETTA_BASE_URL is not set', () => {
      const originalEnv = process.env.LETTA_BASE_URL;
      delete process.env.LETTA_BASE_URL;

      expect(() => createLettaService()).toThrow('LETTA_BASE_URL and LETTA_PASSWORD must be set');

      process.env.LETTA_BASE_URL = originalEnv;
    });

    it('should throw if LETTA_PASSWORD is not set', () => {
      const originalBaseUrl = process.env.LETTA_BASE_URL;
      const originalPassword = process.env.LETTA_PASSWORD;

      process.env.LETTA_BASE_URL = 'http://localhost:8283';
      delete process.env.LETTA_PASSWORD;

      expect(() => createLettaService()).toThrow('LETTA_BASE_URL and LETTA_PASSWORD must be set');

      process.env.LETTA_BASE_URL = originalBaseUrl;
      process.env.LETTA_PASSWORD = originalPassword;
    });

    it('should create service with environment variables', () => {
      const originalBaseUrl = process.env.LETTA_BASE_URL;
      const originalPassword = process.env.LETTA_PASSWORD;

      process.env.LETTA_BASE_URL = 'http://test:8283';
      process.env.LETTA_PASSWORD = 'test-pass';

      const svc = createLettaService();

      expect(svc).toBeInstanceOf(LettaService);
      expect(svc.baseURL).toBe('http://test:8283');

      process.env.LETTA_BASE_URL = originalBaseUrl;
      process.env.LETTA_PASSWORD = originalPassword;
    });
  });

  // ============================================================
  // Error Handling Tests
  // ============================================================
  describe('Error Handling', () => {
    it('should handle 404 errors gracefully in getControlAgentConfig', async () => {
      mockClient.agents.retrieve.mockRejectedValue(new Error('404 Not Found'));

      await expect(service.getControlAgentConfig('invalid-id')).rejects.toThrow('404 Not Found');
    });

    it('should handle network errors in ensureAgent', async () => {
      fetchWithPool.mockRejectedValue(new Error('Network Error'));

      await expect(service.ensureAgent('TEST', 'Test')).rejects.toThrow('Network Error');
    });

    it('should handle API errors in upsertMemoryBlocks', async () => {
      mockClient.agents.blocks.list.mockRejectedValue(new Error('API Error'));

      await expect(
        service.upsertMemoryBlocks('agent-123', [{ label: 'test', value: 'test' }])
      ).rejects.toThrow('API Error');
    });
  });

  // ============================================================
  // _ensureMcpTool Tests
  // ============================================================
  describe('_ensureMcpTool', () => {
    it('should return existing tool', async () => {
      mockClient.tools.mcp.list.mockResolvedValue([{ id: 'tool-1', name: 'test-tool' }]);

      const result = await service._ensureMcpTool('test-tool', 'http://example.com');

      expect(result.id).toBe('tool-1');
      expect(mockClient.tools.mcp.create).not.toHaveBeenCalled();
    });

    it('should create new tool if not found', async () => {
      mockClient.tools.mcp.list.mockResolvedValue([]);
      mockClient.tools.mcp.create.mockResolvedValue({ id: 'new-tool', name: 'test-tool' });

      const result = await service._ensureMcpTool('test-tool', 'http://example.com');

      expect(result.id).toBe('new-tool');
      expect(mockClient.tools.mcp.create).toHaveBeenCalledWith({
        name: 'test-tool',
        transport: 'http',
        url: 'http://example.com',
      });
    });

    it('should throw on error', async () => {
      mockClient.tools.mcp.list.mockRejectedValue(new Error('MCP error'));

      await expect(service._ensureMcpTool('test', 'http://x.com')).rejects.toThrow('MCP error');
    });
  });

  // ============================================================
  // ensureSearchFolderPassagesTool Tests
  // ============================================================
  describe('ensureSearchFolderPassagesTool', () => {
    it('should return existing tool ID', async () => {
      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'sfp-tool-1' }],
      });

      const result = await service.ensureSearchFolderPassagesTool();

      expect(result).toBe('sfp-tool-1');
    });

    it('should create tool if not found', async () => {
      fetchWithPool
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'sfp-new-tool' }),
        });

      fs.readFileSync.mockReturnValue('def search_folder_passages(): pass');

      const result = await service.ensureSearchFolderPassagesTool();

      expect(result).toBe('sfp-new-tool');
    });

    it('should throw when tool source file not found', async () => {
      fetchWithPool.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });
      fs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      await expect(service.ensureSearchFolderPassagesTool()).rejects.toThrow(
        'Tool source file not found'
      );
    });

    it('should throw on create API failure', async () => {
      fetchWithPool
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Server Error',
        });

      fs.readFileSync.mockReturnValue('source code');

      await expect(service.ensureSearchFolderPassagesTool()).rejects.toThrow(
        'Failed to create tool'
      );
    });

    it('should handle search API failure gracefully', async () => {
      fetchWithPool.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
      fetchWithPool.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'created-tool' }),
      });
      fs.readFileSync.mockReturnValue('source');

      const result = await service.ensureSearchFolderPassagesTool();

      expect(result).toBe('created-tool');
    });
  });

  // ============================================================
  // attachSearchFolderPassagesTool Tests
  // ============================================================
  describe('attachSearchFolderPassagesTool', () => {
    it('should attach tool successfully', async () => {
      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'sfp-tool-1' }],
      });
      mockClient.agents.tools.attach.mockResolvedValue({});

      const result = await service.attachSearchFolderPassagesTool('agent-123');

      expect(result).toBe(true);
    });

    it('should return true if already attached', async () => {
      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'sfp-tool-1' }],
      });
      mockClient.agents.tools.attach.mockRejectedValue(new Error('already attached'));

      const result = await service.attachSearchFolderPassagesTool('agent-123');

      expect(result).toBe(true);
    });

    it('should return false on other errors', async () => {
      fetchWithPool.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'sfp-tool-1' }],
      });
      mockClient.agents.tools.attach.mockRejectedValue(new Error('network failure'));

      const result = await service.attachSearchFolderPassagesTool('agent-123');

      expect(result).toBe(false);
    });
  });

  // ============================================================
  // setAgentIdEnvVar Tests
  // ============================================================
  describe('setAgentIdEnvVar', () => {
    it('should set env var successfully', async () => {
      fetchWithPool.mockResolvedValue({ ok: true });

      const result = await service.setAgentIdEnvVar('agent-123');

      expect(result).toBe(true);
      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agent-123'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('LETTA_AGENT_ID'),
        })
      );
    });

    it('should return false on API error', async () => {
      fetchWithPool.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Error',
      });

      const result = await service.setAgentIdEnvVar('agent-123');

      expect(result).toBe(false);
    });
  });

  // ============================================================
  // _updatePersonaBlock Tests
  // ============================================================
  describe('_updatePersonaBlock', () => {
    it('should update existing persona block', async () => {
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'agent-123',
        memory: { blocks: [{ id: 'block-1', label: 'persona', value: 'old' }] },
      });
      mockClient.blocks.modify.mockResolvedValue({});

      await service._updatePersonaBlock('agent-123', 'new persona');

      expect(mockClient.blocks.modify).toHaveBeenCalledWith('block-1', { value: 'new persona' });
    });

    it('should create and attach persona if not exists', async () => {
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'agent-123',
        memory: { blocks: [] },
      });
      mockClient.blocks.create.mockResolvedValue({ id: 'new-block' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service._updatePersonaBlock('agent-123', 'new persona');

      expect(mockClient.blocks.create).toHaveBeenCalledWith({
        label: 'persona',
        value: 'new persona',
        limit: 20000,
      });
      expect(mockClient.agents.blocks.attach).toHaveBeenCalledWith('agent-123', 'new-block');
    });

    it('should handle errors gracefully without throwing', async () => {
      mockClient.agents.retrieve.mockRejectedValue(new Error('fail'));

      await service._updatePersonaBlock('agent-123', 'persona');

      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  // ============================================================
  // _attachSharedHumanBlock Tests
  // ============================================================
  describe('_attachSharedHumanBlock', () => {
    it('should attach shared human block when configured', async () => {
      service.sharedHumanBlockId = 'block-test-human-id';
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service._attachSharedHumanBlock('agent-123');

      expect(mockClient.agents.blocks.attach).toHaveBeenCalledWith(
        'agent-123',
        'block-test-human-id'
      );
    });

    it('should skip when sharedHumanBlockId is null', async () => {
      service.sharedHumanBlockId = null;

      await service._attachSharedHumanBlock('agent-123');

      expect(mockClient.agents.blocks.attach).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully without throwing', async () => {
      service.sharedHumanBlockId = 'block-test-human-id';
      mockClient.agents.blocks.attach.mockRejectedValue(new Error('fail'));

      await service._attachSharedHumanBlock('agent-123');

      expect(consoleSpy.warn).toHaveBeenCalled();
    });
  });

  // ============================================================
  // _ensureTemplateBlocks Tests
  // ============================================================
  describe('_ensureTemplateBlocks', () => {
    it('should upsert expression block, attach human block, and init scratchpad', async () => {
      service.sharedHumanBlockId = 'block-human-123';
      mockClient.agents.blocks.list.mockResolvedValue([]);
      mockClient.blocks.create.mockResolvedValue({ id: 'new-block' });
      mockClient.agents.blocks.attach.mockResolvedValue({});

      await service._ensureTemplateBlocks('agent-123');

      expect(mockClient.agents.blocks.list).toHaveBeenCalled();
      expect(buildExpression).toHaveBeenCalledWith('pm');
    });

    it('should skip expression upsert when hash matches cache', async () => {
      const expressionContent = 'Test expression block content';
      const hash = service._hashContent(expressionContent);
      service._blockHashCache.set('agent-123', new Map([['expression', hash]]));

      service.sharedHumanBlockId = null;
      mockClient.agents.blocks.list.mockResolvedValue([
        { id: 'scratch-1', label: 'scratchpad', value: '{}' },
      ]);

      await service._ensureTemplateBlocks('agent-123');

      expect(mockClient.blocks.modify).not.toHaveBeenCalled();
      expect(mockClient.blocks.create).not.toHaveBeenCalled();
    });

    it('should not throw on failure — logs warning instead', async () => {
      mockClient.agents.blocks.list.mockRejectedValue(new Error('API down'));

      await service._ensureTemplateBlocks('agent-123');

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining('Template block update failed')
      );
    });
  });

  // ============================================================
  // attachMcpTools (legacy) Tests
  // ============================================================
  describe('attachMcpTools', () => {
    it('should redirect to attachPmTools', async () => {
      service._controlAgentCache = {
        agentId: 'control-123',
        toolIds: ['tool-1'],
        persona: 'persona',
      };
      mockClient.agents.tools.attach.mockResolvedValue({});

      const result = await service.attachMcpTools('agent-123', 'http://huly', 'http://vibe');

      expect(result.total).toBe(1);
    });
  });

  // ============================================================
  // getControlAgentConfig Tests (additional branches)
  // ============================================================
  describe('getControlAgentConfig', () => {
    it('should find control agent by name when no agentId provided', async () => {
      mockClient.agents.list.mockResolvedValue([
        {
          id: 'found-control',
          name: service.controlAgentName,
          memory: { blocks: [{ label: 'persona', value: 'p' }] },
        },
      ]);
      mockClient.agents.tools.list.mockResolvedValue([{ id: 't1' }]);

      const result = await service.getControlAgentConfig();

      expect(result.agentId).toBe('found-control');
      expect(result.toolIds).toEqual(['t1']);
      expect(result.persona).toBe('p');
    });

    it('should throw when control agent not found by name', async () => {
      mockClient.agents.list.mockResolvedValue([]);

      await expect(service.getControlAgentConfig()).rejects.toThrow('Control agent not found');
    });

    it('should return null persona when no persona block exists', async () => {
      mockClient.agents.retrieve.mockResolvedValue({
        id: 'ctrl-1',
        name: 'PM-Control',
        memory: { blocks: [] },
      });
      mockClient.agents.tools.list.mockResolvedValue([]);

      const result = await service.getControlAgentConfig('ctrl-1');

      expect(result.persona).toBeNull();
    });
  });

  // ============================================================
  // saveAgentIdToProjectFolder Tests
  // ============================================================
  describe('saveAgentIdToProjectFolder', () => {
    it('should create .letta dir and save settings', () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockImplementation(() => {});
      fs.mkdirSync.mockImplementation(() => {});

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123');

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('settings.local.json'),
        expect.stringContaining('agent-123')
      );
    });

    it('should skip mkdir if .letta dir exists', () => {
      fs.existsSync.mockImplementation(p => {
        if (typeof p === 'string' && p.endsWith('.letta')) return true;
        if (typeof p === 'string' && p.endsWith('.gitignore')) return true;
        return false;
      });
      fs.writeFileSync.mockImplementation(() => {});

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should create .gitignore if not exists', () => {
      fs.existsSync.mockImplementation(p => {
        if (typeof p === 'string' && p.endsWith('.letta')) return true;
        if (typeof p === 'string' && p.endsWith('.gitignore')) return false;
        return false;
      });
      fs.writeFileSync.mockImplementation(() => {});

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('should call updateAgentsMdWithProjectInfo when projectInfo provided', () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => {});

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123', {
        identifier: 'TST',
        name: 'Test Project',
      });

      expect(agentsMdGenerator.generate).toHaveBeenCalled();
    });

    it('should handle EACCES error gracefully', () => {
      const error = new Error('Permission denied');
      error.code = 'EACCES';
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw error;
      });

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123');

      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    });

    it('should handle non-EACCES errors', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      service.saveAgentIdToProjectFolder('/opt/project', 'agent-123');

      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  // ============================================================
  // updateAgentsMdWithProjectInfo Tests
  // ============================================================
  describe('updateAgentsMdWithProjectInfo', () => {
    it('should call agentsMdGenerator.generate with correct params', () => {
      service.updateAgentsMdWithProjectInfo('/opt/project', 'agent-123', {
        identifier: 'TST',
        name: 'Test',
      });

      expect(agentsMdGenerator.generate).toHaveBeenCalledWith(
        expect.stringContaining('AGENTS.md'),
        expect.objectContaining({
          identifier: 'TST',
          name: 'Test',
          agentId: 'agent-123',
          agentName: 'PM - Test',
          projectPath: '/opt/project',
        }),
        expect.objectContaining({
          sections: expect.arrayContaining(['project-info', 'reporting-hierarchy']),
        })
      );
    });

    it('should handle errors gracefully', () => {
      agentsMdGenerator.generate.mockImplementation(() => {
        throw new Error('generate failed');
      });

      service.updateAgentsMdWithProjectInfo('/opt/project', 'agent-123', {
        identifier: 'TST',
        name: 'Test',
      });

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not update AGENTS.md')
      );
    });
  });

  // ============================================================
  // computeFileHash Tests
  // ============================================================
  describe('computeFileHash', () => {
    it('should compute MD5 hash of file content', () => {
      fs.readFileSync.mockReturnValue(Buffer.from('hello world'));

      const hash = service.computeFileHash('/some/file.txt');

      expect(typeof hash).toBe('string');
      expect(hash).toHaveLength(32);
    });
  });

  // ============================================================
  // deleteFile Tests
  // ============================================================
  describe('deleteFile', () => {
    it('should call fetchWithPool with DELETE', async () => {
      fetchWithPool.mockResolvedValue({ ok: true });

      await service.deleteFile('folder-1', 'file-1');

      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/sources/folder-1/file-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  // ============================================================
  // _buildPersonaBlock Tests
  // ============================================================
  describe('_buildPersonaBlock', () => {
    it('should include project identifier and name', () => {
      const persona = service._buildPersonaBlock('MYPROJ', 'My Project');

      expect(persona).toContain('MYPROJ');
      expect(persona).toContain('My Project');
      expect(persona).toContain('Meridian');
      expect(persona).toContain('Emmanuel');
    });
  });

  // ============================================================
  // discoverProjectFiles Tests
  // ============================================================
  describe('discoverProjectFiles', () => {
    it('should return empty array if project path does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await service.discoverProjectFiles('/nonexistent');

      expect(result).toEqual([]);
    });

    it('should discover priority files in docsOnly mode', async () => {
      fs.existsSync.mockImplementation(p => {
        if (p === '/test/project') return true;
        if (typeof p === 'string' && p.endsWith('README.md')) return true;
        if (typeof p === 'string' && p.endsWith('AGENTS.md')) return true;
        if (typeof p === 'string' && p.endsWith('package.json')) return true;
        return false;
      });

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: true });

      expect(result).toContain('README.md');
      expect(result).toContain('AGENTS.md');
      expect(result).toContain('package.json');
    });

    it('should scan documentation directories for .md files', async () => {
      fs.existsSync.mockImplementation(p => {
        if (p === '/test/project') return true;
        if (typeof p === 'string' && p.endsWith('/docs')) return true;
        return false;
      });
      fs.statSync.mockReturnValue({ isDirectory: () => true });
      fs.readdirSync.mockReturnValue([
        { name: 'guide.md', isDirectory: () => false, isFile: () => true },
        { name: 'api.md', isDirectory: () => false, isFile: () => true },
        { name: 'image.png', isDirectory: () => false, isFile: () => true },
      ]);

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: true });

      expect(result).toContain('docs/guide.md');
      expect(result).toContain('docs/api.md');
      expect(result).not.toContain('docs/image.png');
    });

    it('should scan nested documentation directories', async () => {
      fs.existsSync.mockImplementation(p => {
        if (p === '/test/project') return true;
        if (typeof p === 'string' && p.endsWith('/docs')) return true;
        return false;
      });
      fs.statSync.mockReturnValue({ isDirectory: () => true });
      fs.readdirSync.mockImplementation(p => {
        if (typeof p === 'string' && p.endsWith('/docs')) {
          return [{ name: 'sub', isDirectory: () => true, isFile: () => false }];
        }
        return [{ name: 'nested.md', isDirectory: () => false, isFile: () => true }];
      });

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: true });

      expect(result).toContain('docs/sub/nested.md');
    });

    it('should include source files when docsOnly is false', async () => {
      fs.existsSync.mockImplementation(p => {
        if (p === '/test/project') return true;
        return false;
      });
      execSync.mockReturnValue('src/index.js\nsrc/app.ts\nnode_modules/pkg/index.js\n');

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: false });

      expect(result).toContain('src/index.js');
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('node_modules/pkg/index.js');
    });

    it('should handle git ls-files failure in non-docsOnly mode', async () => {
      fs.existsSync.mockImplementation(p => p === '/test/project');
      execSync.mockImplementation(() => {
        throw new Error('not a git repo');
      });

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: false });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should deduplicate files', async () => {
      fs.existsSync.mockImplementation(p => {
        if (p === '/test/project') return true;
        if (typeof p === 'string' && p.endsWith('README.md')) return true;
        return false;
      });
      execSync.mockReturnValue('README.md\nsrc/index.js\n');

      const result = await service.discoverProjectFiles('/test/project', { docsOnly: false });

      const readmeCount = result.filter(f => f === 'README.md').length;
      expect(readmeCount).toBe(1);
    });

    it('should handle top-level error', async () => {
      fs.existsSync.mockImplementation(() => {
        throw new Error('filesystem error');
      });

      const result = await service.discoverProjectFiles('/test/project');

      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // discoverProjectFilesLegacy Tests
  // ============================================================
  describe('discoverProjectFilesLegacy', () => {
    it('should return empty array if project path does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await service.discoverProjectFilesLegacy('/nonexistent');

      expect(result).toEqual([]);
    });

    it('should discover files using git ls-files', async () => {
      fs.existsSync.mockReturnValue(true);
      execSync.mockReturnValue('README.md\nsrc/index.js\npackage.json\nimage.png\n');

      const result = await service.discoverProjectFilesLegacy('/test/project');

      expect(result).toContain('README.md');
      expect(result).toContain('src/index.js');
      expect(result).toContain('package.json');
      expect(result).not.toContain('image.png');
    });

    it('should fallback to filesystem scan when git fails', async () => {
      fs.existsSync.mockReturnValue(true);
      execSync.mockImplementation(() => {
        throw new Error('not a git repo');
      });
      fs.readdirSync.mockReturnValue([
        { name: 'readme.md', isDirectory: () => false },
        { name: 'src', isDirectory: () => true },
        { name: 'node_modules', isDirectory: () => true },
      ]);

      const result = await service.discoverProjectFilesLegacy('/test/project');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle top-level error', async () => {
      fs.existsSync.mockImplementation(() => {
        throw new Error('error');
      });

      const result = await service.discoverProjectFilesLegacy('/test/project');

      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // uploadProjectFiles Tests
  // ============================================================
  describe('uploadProjectFiles', () => {
    it('should upload files to folder', async () => {
      fs.statSync.mockReturnValue({ size: 1000 });
      fs.readFileSync.mockReturnValue(Buffer.from('file content'));
      mockClient.folders.files.upload.mockResolvedValue({ id: 'file-1' });

      const result = await service.uploadProjectFiles(
        'folder-1',
        '/test/project',
        ['README.md', 'src/index.js'],
        50
      );

      expect(result).toHaveLength(2);
      expect(mockClient.folders.files.upload).toHaveBeenCalledTimes(2);
    });

    it('should skip files larger than 1MB', async () => {
      fs.statSync.mockImplementation(p => {
        if (typeof p === 'string' && p.includes('big')) return { size: 2 * 1024 * 1024 };
        return { size: 100 };
      });
      fs.readFileSync.mockReturnValue(Buffer.from('small'));
      mockClient.folders.files.upload.mockResolvedValue({ id: 'file-1' });

      const result = await service.uploadProjectFiles(
        'folder-1',
        '/test/project',
        ['big.bin', 'small.md'],
        50
      );

      expect(result).toHaveLength(1);
    });

    it('should respect maxFiles limit', async () => {
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));
      mockClient.folders.files.upload.mockResolvedValue({ id: 'f' });

      const files = Array.from({ length: 10 }, (_, i) => `file${i}.md`);
      const result = await service.uploadProjectFiles('folder-1', '/test', files, 3);

      expect(result).toHaveLength(3);
    });

    it('should handle upload errors per file gracefully', async () => {
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));
      mockClient.folders.files.upload
        .mockRejectedValueOnce(new Error('upload failed'))
        .mockResolvedValueOnce({ id: 'file-2' });

      const result = await service.uploadProjectFiles(
        'folder-1',
        '/test/project',
        ['fail.md', 'ok.md'],
        50
      );

      expect(result).toHaveLength(1);
    });

    it('should map file extensions to MIME types', async () => {
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));
      mockClient.folders.files.upload.mockResolvedValue({ id: 'f' });

      await service.uploadProjectFiles('folder-1', '/test', ['style.css'], 50);

      expect(mockClient.folders.files.upload).toHaveBeenCalled();
    });

    it('should handle all files failing gracefully', async () => {
      fs.statSync.mockImplementation(() => {
        throw new Error('stat error');
      });

      const result = await service.uploadProjectFiles('folder-1', '/test', ['file.md'], 50);

      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // uploadReadme Tests
  // ============================================================
  describe('uploadReadme', () => {
    it('should return null when sourceId is null', async () => {
      const result = await service.uploadReadme(null, '/test/README.md', 'TST');

      expect(result).toBeNull();
    });

    it('should return null when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await service.uploadReadme('source-1', '/nonexistent/README.md', 'TST');

      expect(result).toBeNull();
    });

    it('should upload README successfully', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.createReadStream.mockReturnValue({ pipe: vi.fn() });
      mockClient.sources.files.upload.mockResolvedValue({ id: 'readme-file-1' });

      const result = await service.uploadReadme('source-1', '/test/README.md', 'TST');

      expect(result.id).toBe('readme-file-1');
      expect(mockClient.sources.files.upload).toHaveBeenCalledWith(
        expect.anything(),
        'source-1',
        expect.objectContaining({
          name: 'TST-README.md',
          duplicateHandling: 'replace',
        })
      );
    });

    it('should throw on upload error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.createReadStream.mockReturnValue({});
      mockClient.sources.files.upload.mockRejectedValue(new Error('upload failed'));

      await expect(service.uploadReadme('source-1', '/test/README.md', 'TST')).rejects.toThrow(
        'upload failed'
      );
    });
  });

  // ============================================================
  // syncProjectFilesIncremental Tests
  // ============================================================
  describe('syncProjectFilesIncremental', () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        getProjectFiles: vi.fn().mockReturnValue([]),
        getOrphanedFiles: vi.fn().mockReturnValue([]),
        deleteProjectFile: vi.fn(),
        upsertProjectFile: vi.fn(),
      };
    });

    it('should skip unchanged files', async () => {
      const hash = service.computeFileHash.__proto__ ? undefined : undefined;
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));

      mockDb.getProjectFiles.mockReturnValue([
        {
          relative_path: 'file.md',
          content_hash: service.computeFileHash('/dummy'),
          letta_file_id: 'f1',
        },
      ]);
      mockDb.getOrphanedFiles.mockReturnValue([]);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['file.md'],
        mockDb,
        'TST'
      );

      expect(stats.skipped).toBe(1);
      expect(stats.uploaded).toBe(0);
    });

    it('should delete orphaned files', async () => {
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([
        { relative_path: 'old.md', letta_file_id: 'old-f1' },
      ]);
      fetchWithPool.mockResolvedValue({ ok: true });

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        [],
        mockDb,
        'TST'
      );

      expect(stats.deleted).toBe(1);
      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/sources/folder-1/old-f1'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(mockDb.deleteProjectFile).toHaveBeenCalledWith('TST', 'old.md');
    });

    it('should delete orphaned files without letta_file_id', async () => {
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([
        { relative_path: 'orphan.md', letta_file_id: null },
      ]);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        [],
        mockDb,
        'TST'
      );

      expect(stats.deleted).toBe(0);
      expect(mockDb.deleteProjectFile).toHaveBeenCalledWith('TST', 'orphan.md');
    });

    it('should upload new files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('new content'));
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([]);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'uploaded-file-1' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['new.md'],
        mockDb,
        'TST'
      );

      expect(stats.uploaded).toBe(1);
      expect(mockDb.upsertProjectFile).toHaveBeenCalledWith(
        expect.objectContaining({
          project_identifier: 'TST',
          relative_path: 'new.md',
          letta_file_id: 'uploaded-file-1',
        })
      );

      vi.unstubAllGlobals();
    });

    it('should replace existing tracked files that changed', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('changed content'));
      mockDb.getProjectFiles.mockReturnValue([
        { relative_path: 'changed.md', content_hash: 'old-hash', letta_file_id: 'old-f1' },
      ]);
      mockDb.getOrphanedFiles.mockReturnValue([]);
      fetchWithPool.mockResolvedValue({ ok: true });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'new-f1' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['changed.md'],
        mockDb,
        'TST'
      );

      expect(stats.uploaded).toBe(1);
      expect(fetchWithPool).toHaveBeenCalledWith(
        expect.stringContaining('/sources/folder-1/old-f1'),
        expect.objectContaining({ method: 'DELETE' })
      );

      vi.unstubAllGlobals();
    });

    it('should skip nonexistent files', async () => {
      fs.existsSync.mockReturnValue(false);
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([]);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['missing.md'],
        mockDb,
        'TST'
      );

      expect(stats.uploaded).toBe(0);
    });

    it('should skip large files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 600000 });
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([]);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['huge.bin'],
        mockDb,
        'TST'
      );

      expect(stats.uploaded).toBe(0);
    });

    it('should handle per-file upload errors', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ size: 100 });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([]);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        ['fail.md'],
        mockDb,
        'TST'
      );

      expect(stats.errors).toBe(1);

      vi.unstubAllGlobals();
    });

    it('should handle orphan deletion errors gracefully', async () => {
      mockDb.getProjectFiles.mockReturnValue([]);
      mockDb.getOrphanedFiles.mockReturnValue([
        { relative_path: 'orphan.md', letta_file_id: 'orphan-f1' },
      ]);
      fetchWithPool.mockRejectedValue(new Error('delete failed'));

      const stats = await service.syncProjectFilesIncremental(
        'folder-1',
        '/test',
        [],
        mockDb,
        'TST'
      );

      expect(stats.deleted).toBe(0);
      expect(mockDb.deleteProjectFile).toHaveBeenCalled();
    });

    it('should throw on top-level error', async () => {
      mockDb.getProjectFiles.mockImplementation(() => {
        throw new Error('db error');
      });

      await expect(
        service.syncProjectFilesIncremental('folder-1', '/test', [], mockDb, 'TST')
      ).rejects.toThrow('db error');
    });
  });

  // ============================================================
  // _loadAgentState Tests (additional branches)
  // ============================================================
  describe('_loadAgentState', () => {
    it('should load state from file when exists', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(
        JSON.stringify({ version: '1.0.0', agents: { TEST: 'agent-1' } })
      );

      const state = service._loadAgentState();

      expect(state.agents.TEST).toBe('agent-1');
    });

    it('should return default state on parse error', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json');

      const state = service._loadAgentState();

      expect(state.version).toBe('1.0.0');
      expect(state.agents).toEqual({});
    });

    it('should return default state when file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      const state = service._loadAgentState();

      expect(state.version).toBe('1.0.0');
    });
  });

  // ============================================================
  // _saveAgentState Tests (error branch)
  // ============================================================
  describe('_saveAgentState', () => {
    it('should handle write errors gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('write failed');
      });

      service._saveAgentState();

      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('Error saving agent state'),
        'write failed'
      );
    });
  });

  // ============================================================
  // ensureControlAgent - creation error branch
  // ============================================================
  describe('ensureControlAgent - error branches', () => {
    it('should throw when control agent creation fails', async () => {
      mockClient.agents.list.mockResolvedValue([]);
      fetchWithPool.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      await expect(service.ensureControlAgent()).rejects.toThrow('Failed to create control agent');
    });
  });
});
