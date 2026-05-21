import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/http', () => ({
  fetchWithPool: vi.fn(),
}));

vi.mock('fs', () => {
  const mock = {
    readFileSync: vi.fn(() => 'def list_formulas() -> dict: pass'),
    existsSync: vi.fn(() => true),
  };
  return { default: mock, ...mock };
});

import { fetchWithPool } from '../../../src/http';
import { LettaToolService } from '../../../src/letta/LettaToolService';

const mockedFetch = fetchWithPool as unknown as ReturnType<typeof vi.fn>;

function newClient(): {
  agents: {
    tools: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  };
} {
  return {
    agents: {
      tools: { attach: vi.fn(async () => undefined), detach: vi.fn(), list: vi.fn() },
    },
  };
}

function newService(client = newClient()): { svc: LettaToolService; client: ReturnType<typeof newClient> } {
  const lifecycle = { ensureControlAgent: vi.fn(async () => ({ agentId: 'ctl', toolIds: [] })) };
  const svc = new LettaToolService(
    { client: client as never, apiURL: 'https://letta.test/v1', password: 'sekret' },
    lifecycle,
  );
  return { svc, client };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('ensureListFormulasTool (vibesync-3co)', () => {
  it('returns existing tool id when already registered', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'tool-list-already', name: 'list_formulas' }],
    } as unknown as Response);

    const { svc } = newService();
    const id = await svc.ensureListFormulasTool();

    expect(id).toBe('tool-list-already');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://letta.test/v1/tools?name=list_formulas',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sekret' }),
      }),
    );
  });

  it('creates the tool when not registered, with python source + catalog tag', async () => {
    mockedFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'tool-list-fresh', name: 'list_formulas' }),
      } as unknown as Response);

    const { svc } = newService();
    const id = await svc.ensureListFormulasTool();

    expect(id).toBe('tool-list-fresh');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const createCall = mockedFetch.mock.calls[1]!;
    expect(createCall[0]).toBe('https://letta.test/v1/tools');
    const body = JSON.parse(createCall[1].body as string) as Record<string, unknown>;
    expect(body.name).toBe('list_formulas');
    expect(body.source_type).toBe('python');
    expect(typeof body.source_code).toBe('string');
    expect((body.source_code as string).length).toBeGreaterThan(0);
    expect(body.tags).toEqual(['vibesync', 'orchestration', 'formula', 'catalog']);
    expect(body.description).toMatch(/whenToUse/);
  });

  it('throws when create returns non-OK with the upstream error body', async () => {
    mockedFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'boom',
      } as unknown as Response);

    const { svc } = newService();
    await expect(svc.ensureListFormulasTool()).rejects.toThrow(/HTTP 500: boom/);
  });

  it('throws when create response is missing id', async () => {
    mockedFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'list_formulas' }),
      } as unknown as Response);

    const { svc } = newService();
    await expect(svc.ensureListFormulasTool()).rejects.toThrow(/did not include an id/);
  });
});

describe('attachListFormulasTool (vibesync-3co)', () => {
  it('attaches the resolved tool id to the given agent and returns true', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'tool-list', name: 'list_formulas' }],
    } as unknown as Response);

    const { svc, client } = newService();
    const ok = await svc.attachListFormulasTool('agent-pm-vibesync');

    expect(ok).toBe(true);
    expect(client.agents.tools.attach).toHaveBeenCalledWith('agent-pm-vibesync', 'tool-list');
  });

  it('treats "already attached" as success', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'tool-list', name: 'list_formulas' }],
    } as unknown as Response);

    const client = newClient();
    client.agents.tools.attach = vi.fn(async () => {
      throw new Error('tool already attached to agent');
    });
    const { svc } = newService(client);

    const ok = await svc.attachListFormulasTool('agent-pm-vibesync');
    expect(ok).toBe(true);
  });

  it('returns false on unrecoverable error', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'gone',
    } as unknown as Response);

    const { svc } = newService();
    const ok = await svc.attachListFormulasTool('agent-pm-vibesync');
    expect(ok).toBe(false);
  });
});
