/**
 * Formula — TOML workflow templates parsed into typed StepSpec arrays.
 *
 * A formula is a declarative description of a multi-agent workflow:
 * which role runs at each step, what prompt template they use, what
 * the dependencies are. The daemon materializes a formula as a
 * molecule (root bead + step beads) and dispatches the steps in
 * dependency order.
 *
 * Field names match Gas City's `internal/formula/` for conceptual
 * portability. See docs/architecture/gastown-orchestration.md.
 *
 * Schema (TOML):
 *
 *   [formula.<name>]
 *   description = "..."
 *   when_to_use = "..."      # optional, agent-facing catalog hint
 *
 *   [[formula.<name>.steps]]
 *   role = "<role>"
 *   prompt_template = "<path-relative-to-formula>"
 *   wait_for = "completion"  # optional, default
 *   depends_on = "<step>"    # optional, single name OR array
 *   retries = 0              # optional, non-negative integer
 *   retry_backoff_ms = 1000  # optional, non-negative integer
 *
 * The `when_to_use` field (vibesync-cy4) is the catalog hint a PM /
 * mayor agent reads via `GET /formulas` to pick the right formula for
 * a given bead. It is OPTIONAL — formulas without it still parse, but
 * are harder for an autonomous picker to choose. Keep it short, in
 * imperative form: "when ...", not "this formula ...".
 *
 * See vibesync-k6h, vibesync-cy4.
 */

import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { StepSpec } from '../molecule/index.js';

/**
 * One parsed formula: name + ordered step specs + metadata.
 */
export interface Formula {
  readonly name: string;
  readonly description: string;
  /**
   * Agent-facing catalog hint that answers "when should this formula
   * run?". Surfaced through GET /formulas and the dispatch_molecule
   * tool's catalog so an autonomous PM agent can pick by matching its
   * bead context to this text. Empty string when the TOML omits
   * `when_to_use`. See vibesync-cy4.
   */
  readonly whenToUse: string;
  readonly steps: readonly StepSpec[];
}

/**
 * Parse a TOML string and return the formulas defined under
 * `[formula.<name>]` tables. The same file may contain multiple
 * formulas; each parsed independently.
 *
 * Throws on schema violations (missing role, unknown depends_on, etc.).
 */
export function parseFormulasFromToml(toml: string): Formula[] {
  const raw = parseToml(toml) as unknown;
  if (!isRecord(raw)) {
    throw new Error('formula: top-level TOML must be a table');
  }
  const formulaTable = raw['formula'];
  if (formulaTable === undefined) return [];
  if (!isRecord(formulaTable)) {
    throw new Error('formula: [formula] must be a table');
  }
  const out: Formula[] = [];
  for (const [name, body] of Object.entries(formulaTable)) {
    if (!isRecord(body)) {
      throw new Error(`formula "${name}": body must be a table`);
    }
    out.push(parseFormulaBody(name, body));
  }
  return out;
}

/**
 * Parse a single TOML formula file. Convenience wrapper around
 * parseFormulasFromToml + file read.
 */
export function loadFormulasFromFile(path: string): Formula[] {
  const raw = readFileSync(path, 'utf8');
  return parseFormulasFromToml(raw);
}

function parseFormulaBody(name: string, body: Record<string, unknown>): Formula {
  const description = typeof body['description'] === 'string' ? body['description'] : '';
  const whenToUse = typeof body['when_to_use'] === 'string' ? body['when_to_use'] : '';
  const stepsRaw = body['steps'];
  if (stepsRaw !== undefined && !Array.isArray(stepsRaw)) {
    throw new Error(`formula "${name}": steps must be an array of tables`);
  }
  const seenNames = new Set<string>();
  const steps: StepSpec[] = [];
  for (const [idx, stepRaw] of (stepsRaw ?? []).entries()) {
    if (!isRecord(stepRaw)) {
      throw new Error(`formula "${name}": steps[${idx}] must be a table`);
    }
    const step = parseStep(name, idx, stepRaw, seenNames);
    steps.push(step);
    seenNames.add(step.name);
  }
  return { name, description, whenToUse, steps };
}

function parseStep(
  formulaName: string,
  idx: number,
  raw: Record<string, unknown>,
  declaredSoFar: ReadonlySet<string>,
): StepSpec {
  const role = raw['role'];
  if (typeof role !== 'string' || role.length === 0) {
    throw new Error(`formula "${formulaName}": steps[${idx}] is missing role`);
  }
  // Step name defaults to role; explicit `name` allowed for multiple
  // steps with the same role.
  const explicitName = raw['name'];
  const name = typeof explicitName === 'string' && explicitName.length > 0 ? explicitName : role;
  if (declaredSoFar.has(name)) {
    throw new Error(
      `formula "${formulaName}": step name "${name}" appears more than once; set an explicit name for additional uses of role "${role}"`,
    );
  }
  const promptTemplate = raw['prompt_template'];
  if (promptTemplate !== undefined && typeof promptTemplate !== 'string') {
    throw new Error(`formula "${formulaName}": step "${name}".prompt_template must be a string`);
  }
  const dependsOnRaw = raw['depends_on'];
  let dependsOn: string[] | undefined;
  if (typeof dependsOnRaw === 'string') dependsOn = [dependsOnRaw];
  else if (Array.isArray(dependsOnRaw)) {
    if (!dependsOnRaw.every((v): v is string => typeof v === 'string')) {
      throw new Error(
        `formula "${formulaName}": step "${name}".depends_on must be a string or array of strings`,
      );
    }
    dependsOn = dependsOnRaw;
  } else if (dependsOnRaw !== undefined) {
    throw new Error(
      `formula "${formulaName}": step "${name}".depends_on must be a string or array of strings`,
    );
  }
  // Verify all depends_on names are previously-declared steps.
  for (const dep of dependsOn ?? []) {
    if (!declaredSoFar.has(dep)) {
      throw new Error(
        `formula "${formulaName}": step "${name}" depends_on "${dep}" which is not declared earlier in the formula`,
      );
    }
  }
  const waitForRaw = raw['wait_for'];
  if (waitForRaw !== undefined && waitForRaw !== 'completion') {
    throw new Error(
      `formula "${formulaName}": step "${name}".wait_for must be "completion" (got ${JSON.stringify(waitForRaw)})`,
    );
  }
  const retries = readNonNegativeInteger(raw['retries'], 0, `formula "${formulaName}": step "${name}".retries`);
  const retryBackoffMs = readNonNegativeInteger(raw['retry_backoff_ms'], 1000, `formula "${formulaName}": step "${name}".retry_backoff_ms`);
  const spec: StepSpec = {
    name,
    role,
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    waitFor: 'completion',
    retries,
    retryBackoffMs,
  };
  return spec;
}

function readNonNegativeInteger(value: unknown, defaultValue: number, label: string): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
