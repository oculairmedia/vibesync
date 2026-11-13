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
  return Object.entries(readFormulaTable(parseToml(toml) as unknown)).map(([name, body]) => {
    if (!isRecord(body)) throw new Error(`formula "${name}": body must be a table`);
    return parseFormulaBody(name, body);
  });
}

/** The `[formula]` table of a parsed TOML document; empty when the document has none. */
function readFormulaTable(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) throw new Error('formula: top-level TOML must be a table');
  const table = document['formula'];
  if (table === undefined) return {};
  if (!isRecord(table)) throw new Error('formula: [formula] must be a table');
  return table;
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
  const delivers = readDelivers(name, body['delivers']);
  return {
    name,
    description: stringOr(body['description'], ''),
    whenToUse: stringOr(body['when_to_use'], ''),
    ...(delivers !== undefined ? { delivers } : {}),
    steps: parseSteps(name, readStepTables(name, body['steps'])),
  };
}

function readDelivers(formulaName: string, value: unknown): FormulaDelivery | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && DELIVERY_KINDS.has(value)) return value as FormulaDelivery;
  throw new Error(`formula "${formulaName}": delivers must be one of ${[...DELIVERY_KINDS].join(', ')} (got ${JSON.stringify(value)})`);
}

function readStepTables(formulaName: string, value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`formula "${formulaName}": steps must be an array of tables`);
  return value.map((entry: unknown, idx) => {
    if (!isRecord(entry)) throw new Error(`formula "${formulaName}": steps[${idx}] must be a table`);
    return entry;
  });
}

/** Steps in declared order; each may only refer back to steps declared before it. */
function parseSteps(formulaName: string, tables: readonly Record<string, unknown>[]): StepSpec[] {
  const declared = new Set<string>();
  return tables.map((table, idx) => {
    const step = parseStep(formulaName, idx, table, declared);
    if (step.loopsBackTo !== undefined && !declared.has(step.loopsBackTo)) {
      throw new Error(`formula "${formulaName}": step "${step.name}".loops_back_to names "${step.loopsBackTo}", which is not an earlier step`);
    }
    declared.add(step.name);
    return step;
  });
}

/**
 * Reads one TOML table's fields. Every error names where the field lives, as
 * `<where>.<field> <problem>`, so a formula author can find it.
 */
class FieldReader {
  constructor(readonly where: string, readonly table: Record<string, unknown>) {}

  has(field: string): boolean {
    return this.table[field] !== undefined;
  }

  fail(field: string, problem: string): never {
    throw new Error(`${this.where}.${field} ${problem}`);
  }

  optionalString(field: string): string | undefined {
    const value = this.table[field];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    return this.fail(field, 'must be a string');
  }

  optionalBoolean(field: string): boolean | undefined {
    const value = this.table[field];
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    return this.fail(field, 'must be true or false');
  }

  nonNegativeInteger(field: string, fallback: number): number {
    return this.optionalNonNegativeInteger(field) ?? fallback;
  }

  optionalNonNegativeInteger(field: string): number | undefined {
    const value = this.table[field];
    if (value === undefined) return undefined;
    if (isIntegerAtLeast(value, 0)) return value;
    return this.fail(field, 'must be a non-negative integer');
  }
}

function parseStep(
  formulaName: string,
  idx: number,
  raw: Record<string, unknown>,
  declaredSoFar: ReadonlySet<string>,
): StepSpec {
  const { role, name } = readStepIdentity(formulaName, idx, raw, declaredSoFar);
  const fields = new FieldReader(`formula "${formulaName}": step "${name}"`, raw);
  // Read in this order so the first error a broken step reports stays the same.
  const promptTemplate = fields.optionalString('prompt_template');
  const dependsOn = readDependsOn(fields, declaredSoFar);
  requireCompletionWait(fields);
  const retry = readRetry(fields, formulaName);
  const turnTimeoutMs = fields.optionalNonNegativeInteger('turn_timeout_ms');
  const planOnly = fields.optionalBoolean('plan_only');
  const loop = readReviewLoop(fields);
  return {
    name,
    role,
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    waitFor: 'completion',
    ...retry,
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    ...(planOnly === true ? { planOnly: true } : {}),
    ...loop,
  };
}

/** The step's role, and its name: the role unless `name` is set (for a second step with the same role). */
function readStepIdentity(
  formulaName: string,
  idx: number,
  raw: Record<string, unknown>,
  declaredSoFar: ReadonlySet<string>,
): { role: string; name: string } {
  const role = raw['role'];
  if (!isNonEmptyString(role)) {
    throw new Error(`formula "${formulaName}": steps[${idx}] is missing role`);
  }
  const name = nonEmptyStringOr(raw['name'], role);
  if (declaredSoFar.has(name)) {
    throw new Error(
      `formula "${formulaName}": step name "${name}" appears more than once; set an explicit name for additional uses of role "${role}"`,
    );
  }
  return { role, name };
}

/**
 * `depends_on` and its alias `needs` (vibesync-efee, bd's spelling): each takes a
 * name or an array, both merge in declared order without duplicates, and every
 * name must be a step declared earlier. Undefined when neither is set.
 */
function readDependsOn(fields: FieldReader, declaredSoFar: ReadonlySet<string>): string[] | undefined {
  if (!fields.has('depends_on') && !fields.has('needs')) return undefined;
  const dependsOn = [...new Set([...readNameList(fields, 'depends_on'), ...readNameList(fields, 'needs')])];
  const undeclared = dependsOn.find((dep) => !declaredSoFar.has(dep));
  if (undeclared !== undefined) {
    throw new Error(`${fields.where} depends_on "${undeclared}" which is not declared earlier in the formula`);
  }
  return dependsOn;
}

function readNameList(fields: FieldReader, field: 'depends_on' | 'needs'): string[] {
  const value = fields.table[field];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) return value;
  return fields.fail(field, 'must be a string or array of strings');
}

function requireCompletionWait(fields: FieldReader): void {
  const waitFor = fields.table['wait_for'];
  if (waitFor !== undefined && waitFor !== 'completion') {
    fields.fail('wait_for', `must be "completion" (got ${JSON.stringify(waitFor)})`);
  }
}

/** The legacy `retries`/`retry_backoff_ms` fields (always set) and the `[steps.retry]` policy (when given). */
function readRetry(fields: FieldReader, formulaName: string): Pick<StepSpec, 'retries' | 'retryBackoffMs' | 'retry'> {
  const retries = fields.nonNegativeInteger('retries', 0);
  const retryBackoffMs = fields.nonNegativeInteger('retry_backoff_ms', DEFAULT_RETRY_BACKOFF_MS);
  const retry = parseRetryPolicy(fields, formulaName);
  return { retries, retryBackoffMs, ...(retry !== undefined ? { retry } : {}) };
}

/** `loops_back_to` and `max_rounds` (vibesync-9lzk.24): a review step that sends work back; 3 rounds unless set. */
function readReviewLoop(fields: FieldReader): Pick<StepSpec, 'loopsBackTo' | 'maxRounds'> {
  const loopsBackTo = fields.table['loops_back_to'];
  if (loopsBackTo !== undefined && !isNonEmptyString(loopsBackTo)) fields.fail('loops_back_to', 'must be a step name');
  const maxRounds = fields.optionalNonNegativeInteger('max_rounds');
  const roundsWithoutLoop = maxRounds !== undefined && loopsBackTo === undefined;
  if (roundsWithoutLoop || maxRounds === 0) fields.fail('max_rounds', 'needs loops_back_to and must be >= 1');
  return isNonEmptyString(loopsBackTo) ? { loopsBackTo, maxRounds: maxRounds ?? 3 } : {};
}

const RETRY_KEYS: ReadonlySet<string> = new Set(['max_attempts', 'on_exhausted', 'backoff_ms']);

/**
 * `[steps.retry]` (vibesync-ynmp). Strict on purpose: a typo'd key or a missing
 * max_attempts would silently mean "no retry", which is the failure you only
 * discover when a flaky step kills a molecule. Mixing it with the legacy
 * `retries` alias is rejected (which one wins would be a guess).
 */
function parseRetryPolicy(step: FieldReader, formulaName: string): RetryPolicy | undefined {
  const table = step.table['retry'];
  if (table === undefined) return undefined;
  const retry = readRetryTable(step, formulaName, table);
  return {
    maxAttempts: readMaxAttempts(retry),
    onExhausted: readOnExhausted(retry),
    backoffMs: retry.nonNegativeInteger('backoff_ms', DEFAULT_RETRY_BACKOFF_MS),
  };
}

/** The `[steps.retry]` table, checked: a table, not mixed with the legacy fields, no unknown keys. */
function readRetryTable(step: FieldReader, formulaName: string, table: unknown): FieldReader {
  const where = `${step.where}.retry`;
  if (!isRecord(table)) throw new Error(`${where} must be a table ([formula.${formulaName}.steps.retry])`);
  if (step.has('retries') || step.has('retry_backoff_ms')) {
    throw new Error(`${where} cannot be combined with the deprecated retries/retry_backoff_ms; migrate them: retries = N -> [steps.retry] max_attempts = N + 1, on_exhausted = "fail", retry_backoff_ms -> backoff_ms`);
  }
  const unknown = Object.keys(table).find((key) => !RETRY_KEYS.has(key));
  if (unknown !== undefined) throw new Error(`${where} has unknown key "${unknown}" (expected max_attempts, on_exhausted, backoff_ms)`);
  return new FieldReader(where, table);
}

function readMaxAttempts(retry: FieldReader): number {
  const value = retry.table['max_attempts'];
  if (isIntegerAtLeast(value, 1)) return value;
  return retry.fail('max_attempts', 'is required and must be an integer >= 1');
}

function readOnExhausted(retry: FieldReader): OnExhausted {
  const value = retry.table['on_exhausted'] ?? 'fail';
  if (value === 'fail' || value === 'soft_fail') return value;
  return retry.fail('on_exhausted', `must be "fail" or "soft_fail" (got ${JSON.stringify(value)})`);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nonEmptyStringOr(value: unknown, fallback: string): string {
  return isNonEmptyString(value) ? value : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
