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
 *   needs = ["<step>", ...]  # optional alias of depends_on; both merge (vibesync-efee)
 *   retries = 0              # DEPRECATED alias of [steps.retry]: max_attempts = retries + 1, on_exhausted = "fail"
 *   retry_backoff_ms = 1000  # DEPRECATED alias of retry.backoff_ms
 *   turn_timeout_ms = 600000 # optional, non-negative integer (vibesync-lcp-98y8)
 *
 *   [formula.<name>.steps.retry]   # optional, per-step retry policy (vibesync-ynmp)
 *   max_attempts = 3               # required, integer >= 1: total tries including the first
 *   on_exhausted = "soft_fail"     # "fail" (default: abort the molecule) | "soft_fail" (close the
 *                                  # step failed, the molecule continues)
 *   backoff_ms = 1000              # optional, non-negative integer
 *
 * `retry` and the legacy `retries`/`retry_backoff_ms` cannot be mixed on one step.
 * The attempt counter lives on the step bead (gc.retry_attempt), never in memory;
 * see ../retry/policy.ts.
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
import { DEFAULT_RETRY_BACKOFF_MS, type OnExhausted, type RetryPolicy } from '../retry/policy.js';

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
  /**
   * What a successful run must leave behind (vibesync-9lzk.21). When set, the
   * molecule only completes after the dispatcher's DeliveryVerifier confirms
   * the artifact exists; otherwise it fails. Absent = no delivery check.
   */
  readonly delivers?: FormulaDelivery;
  readonly steps: readonly StepSpec[];
}

/** Artifact kinds a formula can require. */
export type FormulaDelivery = 'pull_request';
const DELIVERY_KINDS: ReadonlySet<string> = new Set(['pull_request']);

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
  const deliversRaw = body['delivers'];
  if (deliversRaw !== undefined && (typeof deliversRaw !== 'string' || !DELIVERY_KINDS.has(deliversRaw))) {
    throw new Error(`formula "${name}": delivers must be one of ${[...DELIVERY_KINDS].join(', ')} (got ${JSON.stringify(deliversRaw)})`);
  }
  const stepsRaw = body['steps'];
  if (stepsRaw !== undefined && !Array.isArray(stepsRaw)) {
    throw new Error(`formula "${name}": steps must be an array of tables`);
  }
  const seenNames = new Set<string>();
  const steps: StepSpec[] = [];
  const stepEntries: unknown[] = Array.isArray(stepsRaw) ? stepsRaw : [];
  for (const [idx, stepRaw] of stepEntries.entries()) {
    if (!isRecord(stepRaw)) {
      throw new Error(`formula "${name}": steps[${idx}] must be a table`);
    }
    const step = parseStep(name, idx, stepRaw, seenNames);
    steps.push(step);
    if (step.loopsBackTo !== undefined && !seenNames.has(step.loopsBackTo)) {
      throw new Error(`formula "${name}": step "${step.name}".loops_back_to names "${step.loopsBackTo}", which is not an earlier step`);
    }
    seenNames.add(step.name);
  }
  return { name, description, whenToUse, ...(deliversRaw !== undefined ? { delivers: deliversRaw as FormulaDelivery } : {}), steps };
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
  // `needs` is an alias of `depends_on` (vibesync-efee, bd's spelling); both
  // take a name or an array, and declaring both merges them, de-duplicated.
  const dependsOn = mergeDependencies(formulaName, name, raw);
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
  const retryBackoffMs = readNonNegativeInteger(raw['retry_backoff_ms'], DEFAULT_RETRY_BACKOFF_MS, `formula "${formulaName}": step "${name}".retry_backoff_ms`);
  const retry = parseRetryPolicy(formulaName, name, raw);
  const turnTimeoutMs = raw['turn_timeout_ms'] !== undefined
    ? readNonNegativeInteger(raw['turn_timeout_ms'], undefined as never, `formula "${formulaName}": step "${name}".turn_timeout_ms`)
    : undefined;
  const planOnlyRaw = raw['plan_only'];
  if (planOnlyRaw !== undefined && typeof planOnlyRaw !== 'boolean') {
    throw new Error(`formula "${formulaName}": step "${name}".plan_only must be true or false`);
  }
  const loopsBackTo = raw['loops_back_to'];
  if (loopsBackTo !== undefined && (typeof loopsBackTo !== 'string' || loopsBackTo.length === 0)) {
    throw new Error(`formula "${formulaName}": step "${name}".loops_back_to must be a step name`);
  }
  const maxRounds = raw['max_rounds'] !== undefined
    ? readNonNegativeInteger(raw['max_rounds'], undefined as never, `formula "${formulaName}": step "${name}".max_rounds`)
    : undefined;
  if (maxRounds !== undefined && (loopsBackTo === undefined || maxRounds < 1)) {
    throw new Error(`formula "${formulaName}": step "${name}".max_rounds needs loops_back_to and must be >= 1`);
  }
  const spec: StepSpec = {
    name,
    role,
    ...(typeof promptTemplate === 'string' ? { promptTemplate } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    waitFor: 'completion',
    retries,
    retryBackoffMs,
    ...(retry !== undefined ? { retry } : {}),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    ...(planOnlyRaw === true ? { planOnly: true } : {}),
    ...(typeof loopsBackTo === 'string' ? { loopsBackTo, maxRounds: maxRounds ?? 3 } : {}),
  };
  return spec;
}

const RETRY_KEYS: ReadonlySet<string> = new Set(['max_attempts', 'on_exhausted', 'backoff_ms']);

/**
 * `[steps.retry]` (vibesync-ynmp). Strict on purpose: a typo'd key or a missing
 * max_attempts would silently mean "no retry", which is the failure you only
 * discover when a flaky step kills a molecule. Mixing it with the legacy
 * `retries` alias is rejected (which one wins would be a guess).
 */
function parseRetryPolicy(formulaName: string, stepName: string, raw: Record<string, unknown>): RetryPolicy | undefined {
  const table = raw['retry'];
  if (table === undefined) return undefined;
  const label = `formula "${formulaName}": step "${stepName}".retry`;
  if (!isRecord(table)) throw new Error(`${label} must be a table ([formula.${formulaName}.steps.retry])`);
  if (raw['retries'] !== undefined || raw['retry_backoff_ms'] !== undefined) {
    throw new Error(`${label} cannot be combined with the deprecated retries/retry_backoff_ms; migrate them: retries = N -> [steps.retry] max_attempts = N + 1, on_exhausted = "fail", retry_backoff_ms -> backoff_ms`);
  }
  for (const key of Object.keys(table)) {
    if (!RETRY_KEYS.has(key)) throw new Error(`${label} has unknown key "${key}" (expected max_attempts, on_exhausted, backoff_ms)`);
  }
  const maxAttempts = table['max_attempts'];
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${label}.max_attempts is required and must be an integer >= 1`);
  }
  const onExhausted = table['on_exhausted'] ?? 'fail';
  if (onExhausted !== 'fail' && onExhausted !== 'soft_fail') {
    throw new Error(`${label}.on_exhausted must be "fail" or "soft_fail" (got ${JSON.stringify(onExhausted)})`);
  }
  const backoffMs = readNonNegativeInteger(table['backoff_ms'], DEFAULT_RETRY_BACKOFF_MS, `${label}.backoff_ms`);
  return { maxAttempts, onExhausted: onExhausted as OnExhausted, backoffMs };
}

function readDependencyList(formulaName: string, stepName: string, key: 'depends_on' | 'needs', value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) return value;
  throw new Error(`formula "${formulaName}": step "${stepName}".${key} must be a string or array of strings`);
}

/** depends_on + needs, in declared order, without duplicates; undefined when neither is set. */
function mergeDependencies(formulaName: string, stepName: string, raw: Record<string, unknown>): string[] | undefined {
  if (raw['depends_on'] === undefined && raw['needs'] === undefined) return undefined;
  const merged = [
    ...readDependencyList(formulaName, stepName, 'depends_on', raw['depends_on']),
    ...readDependencyList(formulaName, stepName, 'needs', raw['needs']),
  ];
  return [...new Set(merged)];
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
