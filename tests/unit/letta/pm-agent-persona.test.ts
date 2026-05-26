import { describe, expect, it } from 'vitest';

import { buildPersonaBlock } from '../../../src/letta/pm-agent-persona.js';

describe('buildPersonaBlock (vibesync-3hj)', () => {
  it('includes the project identifier and name verbatim', () => {
    const text = buildPersonaBlock('vibesync', 'Vibesync');
    expect(text).toContain('Vibesync');
    expect(text).toContain('vibesync');
  });

  it('teaches the formula dispatch protocol (list_formulas → dispatch_molecule with motivating_bead_id)', () => {
    const text = buildPersonaBlock('vibesync', 'Vibesync');
    expect(text).toContain('Formula Dispatch Protocol');
    expect(text).toContain('list_formulas');
    expect(text).toContain('dispatch_molecule');
    expect(text).toContain('whenToUse');
    expect(text).toContain('motivating_bead_id');
    // Catalog-first discipline: the persona must not just list the tools,
    // it must say "read the catalog first".
    expect(text).toMatch(/Call `list_formulas`/i);
  });

  it('explicitly warns against dispatching without reading the catalog and against double-dispatching the same bead', () => {
    const text = buildPersonaBlock('vibesync', 'Vibesync');
    expect(text).toMatch(/Do NOT call `dispatch_molecule` without first reading the catalog/i);
    expect(text).toMatch(/Do NOT dispatch the same formula twice for the same bead/i);
  });

  it('tells the PM to fall back to manual delegation if the orchestration plane is offline', () => {
    const text = buildPersonaBlock('vibesync', 'Vibesync');
    expect(text).toMatch(/orchestration plane is offline/i);
    expect(text).toMatch(/manual delegation/i);
  });
});
