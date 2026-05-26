import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithPool } = vi.hoisted(() => ({ fetchWithPool: vi.fn() }));

vi.mock('../../../src/http', () => ({ fetchWithPool }));

import { LettaToolService, buildPmAgentEnvVars } from '../../../src/letta/LettaToolService.js';

function makeService(): LettaToolService {
  return new LettaToolService(
    { client: {} as never, apiURL: 'http://letta.example.com/v1', password: 'secret' },
    { ensureControlAgent: async () => ({ agentId: 'ctl', toolIds: [] }) },
  );
}

describe('buildPmAgentEnvVars (vibesync-j1i)', () => {
  beforeEach(() => {
    delete process.env['VIBESYNC_API_BASE_URL'];
    delete process.env['VIBESYNC_ORCHESTRATION_TOKEN'];
    delete process.env['HEALTH_PORT'];
  });

  it('defaults VIBESYNC_API_BASE_URL to http://localhost:3099 when neither override is set', () => {
    const env = buildPmAgentEnvVars('agent-1');
    expect(env).toEqual({
      LETTA_AGENT_ID: 'agent-1',
      VIBESYNC_API_BASE_URL: 'http://localhost:3099',
    });
  });

  it('uses HEALTH_PORT for the default API base when VIBESYNC_API_BASE_URL is unset', () => {
    process.env['HEALTH_PORT'] = '4001';
    const env = buildPmAgentEnvVars('agent-1');
    expect(env['VIBESYNC_API_BASE_URL']).toBe('http://localhost:4001');
  });

  it('honors VIBESYNC_API_BASE_URL when provided and strips trailing slashes', () => {
    process.env['VIBESYNC_API_BASE_URL'] = 'https://api.example.com///';
    const env = buildPmAgentEnvVars('agent-1');
    expect(env['VIBESYNC_API_BASE_URL']).toBe('https://api.example.com');
  });

  it('includes VIBESYNC_ORCHESTRATION_TOKEN only when set and non-empty', () => {
    process.env['VIBESYNC_ORCHESTRATION_TOKEN'] = 'tok-xyz';
    expect(buildPmAgentEnvVars('agent-1')['VIBESYNC_ORCHESTRATION_TOKEN']).toBe('tok-xyz');

    process.env['VIBESYNC_ORCHESTRATION_TOKEN'] = '   ';
    expect('VIBESYNC_ORCHESTRATION_TOKEN' in buildPmAgentEnvVars('agent-1')).toBe(false);

    delete process.env['VIBESYNC_ORCHESTRATION_TOKEN'];
    expect('VIBESYNC_ORCHESTRATION_TOKEN' in buildPmAgentEnvVars('agent-1')).toBe(false);
  });

  it('merges caller-supplied extras but never lets them override the three managed keys', () => {
    process.env['VIBESYNC_API_BASE_URL'] = 'https://primary';
    process.env['VIBESYNC_ORCHESTRATION_TOKEN'] = 'tok';
    const env = buildPmAgentEnvVars('agent-1', {
      LETTA_AGENT_ID: 'WRONG',
      VIBESYNC_API_BASE_URL: 'http://wrong',
      EXTRA_KEY: 'kept',
    });
    expect(env).toEqual({
      LETTA_AGENT_ID: 'agent-1',
      VIBESYNC_API_BASE_URL: 'https://primary',
      VIBESYNC_ORCHESTRATION_TOKEN: 'tok',
      EXTRA_KEY: 'kept',
    });
  });
});

describe('LettaToolService.syncPmAgentEnvVars (vibesync-j1i)', () => {
  beforeEach(() => {
    fetchWithPool.mockReset();
    delete process.env['VIBESYNC_API_BASE_URL'];
    delete process.env['VIBESYNC_ORCHESTRATION_TOKEN'];
    delete process.env['HEALTH_PORT'];
  });

  it('PATCHes the agent with the full env map and returns true on success', async () => {
    process.env['VIBESYNC_API_BASE_URL'] = 'https://api.example.com';
    process.env['VIBESYNC_ORCHESTRATION_TOKEN'] = 'tok-xyz';
    fetchWithPool.mockResolvedValueOnce({ ok: true });

    const result = await makeService().syncPmAgentEnvVars('agent-1');

    expect(result).toBe(true);
    expect(fetchWithPool).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithPool.mock.calls[0]!;
    expect(url).toBe('http://letta.example.com/v1/agents/agent-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(JSON.parse(init.body)).toEqual({
      tool_exec_environment_variables: {
        LETTA_AGENT_ID: 'agent-1',
        VIBESYNC_API_BASE_URL: 'https://api.example.com',
        VIBESYNC_ORCHESTRATION_TOKEN: 'tok-xyz',
      },
    });
  });

  it('omits VIBESYNC_ORCHESTRATION_TOKEN from the PATCH body when unset', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: true });
    await makeService().syncPmAgentEnvVars('agent-1');
    const body = JSON.parse(fetchWithPool.mock.calls[0]![1].body);
    expect('VIBESYNC_ORCHESTRATION_TOKEN' in body.tool_exec_environment_variables).toBe(false);
  });

  it('returns false on API failure rather than throwing', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const result = await makeService().syncPmAgentEnvVars('agent-1');
    expect(result).toBe(false);
  });

  it('setAgentIdEnvVar is now a back-compat wrapper that calls syncPmAgentEnvVars', async () => {
    fetchWithPool.mockResolvedValueOnce({ ok: true });
    const result = await makeService().setAgentIdEnvVar('agent-1');
    expect(result).toBe(true);
    const body = JSON.parse(fetchWithPool.mock.calls[0]![1].body);
    expect(body.tool_exec_environment_variables.LETTA_AGENT_ID).toBe('agent-1');
    expect(body.tool_exec_environment_variables.VIBESYNC_API_BASE_URL).toBe('http://localhost:3099');
  });
});
