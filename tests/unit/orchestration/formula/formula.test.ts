import { describe, expect, it } from 'vitest';

import {
  loadFormulasFromFile,
  parseFormulasFromToml,
} from '../../../../src/orchestration/formula/index.js';

describe('parseFormulasFromToml', () => {
  it('parses a minimal single-step formula', () => {
    const toml = `
[formula.greet]
description = "Say hi"

[[formula.greet.steps]]
role = "greeter"
`;
    const formulas = parseFormulasFromToml(toml);
    expect(formulas).toHaveLength(1);
    expect(formulas[0]!.name).toBe('greet');
    expect(formulas[0]!.steps).toHaveLength(1);
    expect(formulas[0]!.steps[0]!.role).toBe('greeter');
    expect(formulas[0]!.steps[0]!.name).toBe('greeter');
    expect(formulas[0]!.steps[0]!.waitFor).toBe('completion');
    expect(formulas[0]!.steps[0]!.retries).toBe(0);
    expect(formulas[0]!.steps[0]!.retryBackoffMs).toBe(1000);
  });

  it('parses the reference code-review formula', () => {
    const formulas = loadFormulasFromFile('/opt/stacks/vibesync/packs/gastown/formulas/code-review.toml');
    expect(formulas).toHaveLength(1);
    const f = formulas[0]!;
    expect(f.name).toBe('code-review');
    expect(f.steps.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
    expect(f.steps[1]!.dependsOn).toEqual(['reviewer']);
    expect(f.steps[2]!.dependsOn).toEqual(['coder']);
    expect(f.steps[0]!.promptTemplate).toBe('prompts/reviewer-system.md');
  });

  it('returns empty array when no [formula] table is present', () => {
    expect(parseFormulasFromToml('description = "no formula here"')).toEqual([]);
  });

  it('accepts depends_on as a single string OR an array', () => {
    const toml = `
[formula.fan-in]
description = "Tester depends on both"

[[formula.fan-in.steps]]
role = "a"

[[formula.fan-in.steps]]
role = "b"

[[formula.fan-in.steps]]
role = "tester"
depends_on = ["a", "b"]
`;
    const formulas = parseFormulasFromToml(toml);
    expect(formulas[0]!.steps[2]!.dependsOn).toEqual(['a', 'b']);
  });

  it('rejects a step with no role', () => {
    const toml = `
[formula.broken]

[[formula.broken.steps]]
prompt_template = "x"
`;
    expect(() => parseFormulasFromToml(toml)).toThrow(/missing role/);
  });

  it('rejects a forward-reference depends_on', () => {
    const toml = `
[formula.broken]

[[formula.broken.steps]]
role = "a"
depends_on = "b"

[[formula.broken.steps]]
role = "b"
`;
    expect(() => parseFormulasFromToml(toml)).toThrow(/not declared earlier/);
  });

  it('rejects duplicate step names without an explicit name override', () => {
    const toml = `
[formula.dup]

[[formula.dup.steps]]
role = "worker"

[[formula.dup.steps]]
role = "worker"
`;
    expect(() => parseFormulasFromToml(toml)).toThrow(/appears more than once/);
  });

  it('allows duplicate roles when name is explicit', () => {
    const toml = `
[formula.parallel]

[[formula.parallel.steps]]
role = "worker"
name = "worker-a"

[[formula.parallel.steps]]
role = "worker"
name = "worker-b"
`;
    const formulas = parseFormulasFromToml(toml);
    expect(formulas[0]!.steps.map((s) => s.name)).toEqual(['worker-a', 'worker-b']);
  });

  it('rejects wait_for values other than completion', () => {
    const toml = `
[formula.x]
[[formula.x.steps]]
role = "r"
wait_for = "first_token"
`;
    expect(() => parseFormulasFromToml(toml)).toThrow(/wait_for must be "completion"/);
  });

  it('parses per-step retry policy fields', () => {
    const toml = `
[formula.retrying]
[[formula.retrying.steps]]
role = "worker"
retries = 2
retry_backoff_ms = 25
`;
    const formulas = parseFormulasFromToml(toml);
    expect(formulas[0]!.steps[0]).toMatchObject({
      retries: 2,
      retryBackoffMs: 25,
    });
  });

  it('rejects invalid retry policy fields', () => {
    expect(() => parseFormulasFromToml(`
[formula.bad]
[[formula.bad.steps]]
role = "worker"
retries = -1
`)).toThrow(/retries must be a non-negative integer/);

    expect(() => parseFormulasFromToml(`
[formula.bad]
[[formula.bad.steps]]
role = "worker"
retry_backoff_ms = 1.5
`)).toThrow(/retry_backoff_ms must be a non-negative integer/);
  });
});
