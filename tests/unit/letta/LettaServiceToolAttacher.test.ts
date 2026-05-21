import { describe, expect, it, vi } from 'vitest';

import {
  buildDefaultToolAttacher,
  LettaServiceToolAttacher,
} from '../../../src/letta/LettaServiceToolAttacher.js';

describe('LettaServiceToolAttacher', () => {
  it('returns status=attached when the wrapped attach fn returns true', async () => {
    const fn = vi.fn(async () => true);
    const attacher = new LettaServiceToolAttacher({ attachers: { dispatch_molecule: fn } });
    const result = await attacher.attach('agent-1', 'dispatch_molecule');
    expect(result).toEqual({ status: 'attached' });
    expect(fn).toHaveBeenCalledWith('agent-1');
  });

  it('returns status=unknown for tool names not in the registry', async () => {
    const fn = vi.fn(async () => true);
    const attacher = new LettaServiceToolAttacher({ attachers: { dispatch_molecule: fn } });
    const result = await attacher.attach('agent-1', 'read_file');
    expect(result.status).toBe('unknown');
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns status=already_attached when the wrapped fn throws an "already attached" error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('tool already attached to agent');
    });
    const attacher = new LettaServiceToolAttacher({ attachers: { dispatch_molecule: fn } });
    const result = await attacher.attach('agent-1', 'dispatch_molecule');
    expect(result).toEqual({ status: 'already_attached' });
  });

  it('returns status=error when the wrapped fn throws an unrelated error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('letta is down');
    });
    const attacher = new LettaServiceToolAttacher({ attachers: { dispatch_molecule: fn } });
    const result = await attacher.attach('agent-1', 'dispatch_molecule');
    expect(result).toEqual({ status: 'error', error: 'letta is down' });
  });

  it('returns status=error when the wrapped fn returns false (caller signalled failure)', async () => {
    const fn = vi.fn(async () => false);
    const attacher = new LettaServiceToolAttacher({ attachers: { dispatch_molecule: fn } });
    const result = await attacher.attach('agent-1', 'dispatch_molecule');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/attach returned false/);
  });
});

describe('buildDefaultToolAttacher', () => {
  it('wires dispatch_molecule + search_folder_passages to the LettaService methods', async () => {
    const service = {
      attachDispatchMoleculeTool: vi.fn(async (_agentId: string) => true),
      attachSearchFolderPassagesTool: vi.fn(async (_agentId: string) => true),
      attachListFormulasTool: vi.fn(async (_agentId: string) => true),
    };
    const attacher = buildDefaultToolAttacher(service);

    await attacher.attach('agent-1', 'dispatch_molecule');
    await attacher.attach('agent-1', 'search_folder_passages');

    expect(service.attachDispatchMoleculeTool).toHaveBeenCalledWith('agent-1');
    expect(service.attachSearchFolderPassagesTool).toHaveBeenCalledWith('agent-1');
  });

  it('wires list_formulas to LettaService.attachListFormulasTool', async () => {
    const service = {
      attachDispatchMoleculeTool: vi.fn(async (_agentId: string) => true),
      attachSearchFolderPassagesTool: vi.fn(async (_agentId: string) => true),
      attachListFormulasTool: vi.fn(async (_agentId: string) => true),
    };
    const attacher = buildDefaultToolAttacher(service);

    const result = await attacher.attach('agent-1', 'list_formulas');
    expect(result.status).toBe('attached');
    expect(service.attachListFormulasTool).toHaveBeenCalledWith('agent-1');
  });

  it('returns status=unknown for built-in tool names (read_file, list_directory, etc.)', async () => {
    const service = {
      attachDispatchMoleculeTool: vi.fn(async () => true),
      attachSearchFolderPassagesTool: vi.fn(async () => true),
      attachListFormulasTool: vi.fn(async () => true),
    };
    const attacher = buildDefaultToolAttacher(service);

    for (const name of ['read_file', 'list_directory', 'get_project_state']) {
      const result = await attacher.attach('agent-1', name);
      expect(result.status).toBe('unknown');
    }
    expect(service.attachDispatchMoleculeTool).not.toHaveBeenCalled();
    expect(service.attachSearchFolderPassagesTool).not.toHaveBeenCalled();
  });
});
