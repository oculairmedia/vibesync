import { describe, expect, it } from 'vitest';

import {
  listAllAgents,
  runSyncPmPersona,
  selectTargets,
  type AgentSummary,
  type SyncLettaService,
} from '../../../../scripts/admin/sync-pm-persona.js';

function logs() {
  return {
    lines: [] as string[],
    warns: [] as string[],
    errors: [] as string[],
    log(message?: unknown) { this.lines.push(String(message)); },
    warn(message?: unknown) { this.warns.push(String(message)); },
    error(message?: unknown) { this.errors.push(String(message)); },
  };
}

function service(agents: AgentSummary[]): SyncLettaService & { updated: Array<{ id: string; persona: string }>; personaById: Map<string, string> } {
  const personaById = new Map<string, string>();
  return {
    controlAgentName: 'PM Control',
    updated: [],
    personaById,
    async listAgents() { return agents; },
    async _updatePersonaBlock(id: string, persona: string) { this.updated.push({ id, persona }); personaById.set(id, persona); },
    async getAgent(id: string) { return { id, memory: { blocks: [{ label: 'persona', value: personaById.get(id) }] } }; },
  };
}

const PM = { id: 'agent-pm', name: 'PM - VibeSync', tags: ['vibesync', 'project:vibesync'] };
const OTHER_PM = { id: 'agent-other', name: 'PM - Other', tags: ['vibesync', 'project:other'] };
const ROLE = { id: 'agent-role', name: 'coder', tags: ['vibesync', 'project:vibesync', 'role:coder'] };
const CONTROL = { id: 'agent-control', name: 'PM Control', tags: ['vibesync'] };

describe('selectTargets', () => {
  it('selects project PM agents and excludes role agents by default', () => {
    const targets = selectTargets([PM, ROLE, CONTROL], 'PM Control', false);
    expect(targets.map((t) => t.id)).toEqual(['agent-pm']);
    expect(targets[0]!.projectIdentifier).toBe('vibesync');
  });

  it('--include-control includes the configured control agent', () => {
    const targets = selectTargets([PM, CONTROL], 'PM Control', true);
    expect(targets.map((t) => t.id)).toEqual(['agent-pm', 'agent-control']);
    expect(targets.find((t) => t.id === 'agent-control')?.projectIdentifier).toBe('CONTROL');
  });
});

describe('runSyncPmPersona', () => {
  it('default dry-run reports selected targets but makes no Letta mutations', async () => {
    const letta = service([PM, OTHER_PM, ROLE, CONTROL]);
    const log = logs();
    const result = await runSyncPmPersona({ apply: false, includeControl: false, letta, log });
    expect(result.targets.map((t) => t.id)).toEqual(['agent-pm', 'agent-other']);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(letta.updated).toHaveLength(0);
    expect(log.lines.some((line) => line.includes('mode: dry-run'))).toBe(true);
    expect(log.lines.filter((line) => line.includes('[dry]'))).toHaveLength(2);
  });

  it('--apply updates each selected PM persona and verifies the mutation', async () => {
    const letta = service([PM, OTHER_PM, ROLE, CONTROL]);
    const result = await runSyncPmPersona({ apply: true, includeControl: false, letta, log: logs() });
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect(letta.updated.map((u) => u.id)).toEqual(['agent-pm', 'agent-other']);
    expect(letta.updated[0]!.persona).toContain('OWNS the VibeSync project (vibesync)');
    expect(letta.updated[1]!.persona).toContain('OWNS the Other project (other)');
  });

  it('--include-control applies the control persona too', async () => {
    const letta = service([PM, CONTROL]);
    const result = await runSyncPmPersona({ apply: true, includeControl: true, letta, log: logs() });
    expect(result.updated).toBe(2);
    expect(letta.updated.map((u) => u.id)).toEqual(['agent-pm', 'agent-control']);
    expect(letta.updated.find((u) => u.id === 'agent-control')!.persona).toContain('OWNS the PM Control Template project (CONTROL)');
  });

  it('does not count swallowed Letta update failures as successful updates', async () => {
    const letta = service([PM]);
    letta._updatePersonaBlock = async () => { /* simulates LettaMemoryService swallowing an internal failure */ };
    const log = logs();
    const result = await runSyncPmPersona({ apply: true, includeControl: false, letta, log });
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(log.errors[0]).toContain('persona block verification failed');
  });
});

describe('listAllAgents', () => {
  it('paginates through Letta agent pages with a supported 200-agent limit', async () => {
    const calls: Record<string, unknown>[] = [];
    const letta = {
      async listAgents(filters: Record<string, unknown>) {
        calls.push(filters);
        if (!filters['after']) return { agents: [{ id: 'a' }], nextCursor: 'cursor-1' };
        return { agents: [{ id: 'b' }], nextCursor: null };
      },
    };
    const agents = await listAllAgents(letta, logs());
    expect(agents.map((a) => a.id)).toEqual(['a', 'b']);
    expect(calls).toEqual([
      { limit: 200, include: 'agent.tags' },
      { limit: 200, include: 'agent.tags', after: 'cursor-1' },
    ]);
  });

  it('warns when an unpaginated full 200-agent page suggests possible truncation', async () => {
    const log = logs();
    const agents = Array.from({ length: 200 }, (_, i) => ({ id: `a-${i}` }));
    await listAllAgents({ async listAgents() { return agents; } }, log);
    expect(log.warns[0]).toContain('may have reached a Letta API page/limit boundary');
  });

  it('warns at the legacy 500-agent boundary for compatibility with older clients', async () => {
    const log = logs();
    const agents = Array.from({ length: 500 }, (_, i) => ({ id: `a-${i}` }));
    await listAllAgents({ async listAgents() { return { agents, nextCursor: null }; } }, log);
    expect(log.warns[0]).toContain('fetched 500 agents');
  });
});
