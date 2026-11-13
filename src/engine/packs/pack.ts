/**
 * Pack — discoverable bundle of roles + formulas + prompt templates +
 * optional health checks, scoped to project/agent/global.
 *
 * Pack shape on disk (mirrors Gas City's internal/builtinpacks/):
 *
 *   <pack-root>/
 *     pack.toml           # name, version, description, dependencies
 *     roles/*.toml        # teammate role configs
 *     formulas/<name>.toml  # workflow templates (parsed by formula/)
 *     prompts/<name>.md     # prompt templates referenced by roles/formulas
 *     doctor/<name>/run.sh  # optional health checks (Gas City's doctor shape)
 *
 * Discovery rules (convention-based, NO central registry):
 *   - project scope: <project>/.vibesync/packs/<name>/
 *   - agent scope:   ~/.letta/agents/<id>/packs/<name>/
 *   - global scope:  ~/.letta/packs/<name>/
 *
 * Roles + formulas inside a pack respect layering invariant #5: no role
 * name is hardcoded in core code. Packs ARE the data the core consumes.
 *
 * See vibesync-lhn.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseFormulasFromToml } from '../formula/index.js';
import type { Formula } from '../formula/index.js';

export type PackScope = 'project' | 'agent' | 'global';

/**
 * One core-memory block carried by a role. Mirrors letta's
 * `Block` shape (label + value, optional limit). Note: nothing provisions
 * these onto role agents today. The Iroh provider ignores them, and the
 * removed bootstrapper never applied them either; a role agent's memory is
 * set up outside vibesync.
 */
export interface MemoryBlock {
  readonly label: string;
  readonly value: string;
  readonly limit?: number;
}

export type MemoryBlocksPolicyMode = 'augment' | 'replace';

export interface MemoryBlocksPolicy {
  readonly mode: MemoryBlocksPolicyMode;
}

export interface RoleConfig {
  /** Role identifier (used in formulas). */
  readonly name: string;
  /** Human-readable description of what the role does. */
  readonly description?: string;
  /** LLM model handle (e.g. "letta/auto"). */
  readonly model?: string;
  /** Path to the system prompt template relative to the pack root. */
  readonly systemPromptTemplate?: string;
  /** Tools this role should have access to (free-form list of identifiers). */
  readonly tools?: readonly string[];
  /**
   * Core memory blocks to seed onto the spawned teammate's Letta
   * agent. Source of truth per layering invariant AGENTS.md§
   * "RuntimeProvider discipline" — teams' init.js is suppressed
   * (skipInit=true) so these are the only writes to the agent's
   * memory at start time.
   */
  readonly memoryBlocks?: readonly MemoryBlock[];
  /** Controls whether role blocks augment existing memory or replace non-role blocks. Defaults to augment. */
  readonly memoryBlocksPolicy?: MemoryBlocksPolicy;
}

export interface PackManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly dependencies?: readonly string[];
}

export interface Pack {
  readonly manifest: PackManifest;
  readonly root: string;
  readonly scope: PackScope;
  readonly roles: readonly RoleConfig[];
  readonly formulas: readonly Formula[];
}

export interface DiscoveryOptions {
  /** Project root for the project-scope sweep. Defaults to process.cwd(). */
  readonly projectRoot?: string;
  /** Agent id for the agent-scope sweep. If omitted, agent scope is skipped. */
  readonly agentId?: string;
  /** Override the home dir lookup (test seam). */
  readonly homeDir?: string;
}

/**
 * Find every pack directory across all configured scopes. Returns
 * Pack records in scope priority order: project > agent > global. A
 * pack name appearing in multiple scopes is returned once per scope
 * — resolution to a single pack is the caller's job.
 */
export function discoverPacks(opts: DiscoveryOptions = {}): Pack[] {
  return scopeRoots(opts).flatMap(({ scope, root }) => packsUnder(root, scope));
}

/** Where each scope keeps its packs, in priority order: project, agent (when an id is given), global. */
function scopeRoots(opts: DiscoveryOptions): { scope: PackScope; root: string }[] {
  const home = opts.homeDir ?? homedir();
  return [
    { scope: 'project', root: join(opts.projectRoot ?? process.cwd(), '.vibesync', 'packs') },
    ...(opts.agentId ? [{ scope: 'agent' as const, root: join(home, '.letta', 'agents', opts.agentId, 'packs') }] : []),
    { scope: 'global', root: join(home, '.letta', 'packs') },
  ];
}

/** The loadable packs directly under `root`; dot- and underscore-prefixed directories are skipped. */
function packsUnder(root: string, scope: PackScope): Pack[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .flatMap((entry) => tryLoadPack(join(root, entry.name), scope) ?? []);
}

/**
 * Load and validate one pack directory. Throws on schema errors;
 * returns null on missing pack.toml (callers can choose to surface).
 */
export function loadPack(packRoot: string, scope: PackScope = 'global'): Pack {
  const manifest = readPackManifest(packRoot);
  const roles = readRoles(packRoot);
  const formulas = readFormulas(packRoot);
  return { manifest, root: packRoot, scope, roles, formulas };
}

function tryLoadPack(packRoot: string, scope: PackScope): Pack | null {
  try {
    if (!existsSync(join(packRoot, 'pack.toml'))) return null;
    return loadPack(packRoot, scope);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[packs] skipping ${packRoot}: ${(err as Error).message}`);
    return null;
  }
}

function readPackManifest(packRoot: string): PackManifest {
  const path = join(packRoot, 'pack.toml');
  if (!existsSync(path)) throw new Error(`pack: missing pack.toml at ${path}`);
  const pack = readPackTable(path);
  const fail = (problem: string): never => { throw new Error(`pack ${path}: ${problem}`); };
  const name = requireNonEmptyString(pack['name'], () => fail('pack.name must be a non-empty string'));
  const version = requireNonEmptyString(pack['version'], () => fail('pack.version must be a non-empty string'));
  const description = optionalString(pack['description']);
  const dependencies = optionalStringArray(pack['dependencies'], () => fail('pack.dependencies must be an array of strings'));
  return {
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
  };
}

/** The `[pack]` table of a pack.toml. */
function readPackTable(path: string): Record<string, unknown> {
  const raw = parseToml(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error(`pack ${path}: pack.toml must be a table`);
  const pack = raw['pack'];
  if (!isRecord(pack)) throw new Error(`pack ${path}: missing or invalid [pack] table`);
  return pack;
}

function readRoles(packRoot: string): RoleConfig[] {
  const dir = join(packRoot, 'roles');
  return tomlFilesIn(dir).map((fileName) => readRoleFile(packRoot, dir, fileName));
}

function readRoleFile(packRoot: string, dir: string, fileName: string): RoleConfig {
  const raw = parseToml(readFileSync(join(dir, fileName), 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error(`pack ${packRoot}: role ${fileName} must be a table`);
  const roleSection = raw['role'];
  if (!isRecord(roleSection)) throw new Error(`pack ${packRoot}: role ${fileName} missing [role] table`);
  return parseRoleFromTables(packRoot, fileName, roleSection, raw);
}

/** The `.toml` files directly in `dir`, in directory order; none when it does not exist. */
function tomlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
    .map((entry) => entry.name);
}

function parseRoleFromTables(
  packRoot: string,
  fileName: string,
  roleTable: Record<string, unknown>,
  topTable: Record<string, unknown> | null,
): RoleConfig {
  const where = `pack ${packRoot}: role ${fileName}`;
  const tools = optionalStringArray(roleTable['tools'], () => { throw new Error(`${where}.tools must be an array of strings`); });
  // [[memory_blocks]] and [[memory_blocks_policy]] live at the top level of the
  // file (TOML arrays of tables), not inside [role]. Fall back to [role] for
  // authors who keep everything in one section.
  const memoryBlocks = readMemoryBlocks(where, topTable?.['memory_blocks'] ?? roleTable['memory_blocks']);
  const memoryBlocksPolicy = readMemoryBlocksPolicy(where, topTable?.['memory_blocks_policy'] ?? roleTable['memory_blocks_policy']);
  return {
    name: nonEmptyStringOr(roleTable['name'], basename(fileName, '.toml')),
    ...optionalStringFields(roleTable, { description: 'description', model: 'model', systemPromptTemplate: 'system_prompt_template' }),
    ...(tools !== undefined ? { tools } : {}),
    ...(memoryBlocks !== undefined ? { memoryBlocks } : {}),
    ...(memoryBlocksPolicy !== undefined ? { memoryBlocksPolicy } : {}),
  };
}

/** The string-valued fields that are present, renamed from their TOML keys; others are left out. */
function optionalStringFields<K extends string>(table: Record<string, unknown>, keys: Record<K, string>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [field, tomlKey] of Object.entries(keys) as [K, string][]) {
    const value = table[tomlKey];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
}

function readMemoryBlocks(where: string, value: unknown): MemoryBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry: unknown, idx) => readMemoryBlock(`${where} memory_blocks[${idx}]`, entry));
}

function readMemoryBlock(where: string, entry: unknown): MemoryBlock {
  if (!isRecord(entry)) throw new Error(`${where} must be a table`);
  const label = requireNonEmptyString(entry['label'], () => { throw new Error(`${where}.label must be a non-empty string`); });
  const value = entry['value'];
  if (typeof value !== 'string') throw new Error(`${where}.value must be a string`);
  const limit = positiveFiniteNumber(entry['limit']);
  return { label, value, ...(limit !== undefined ? { limit } : {}) };
}

/** `[[memory_blocks_policy]]` (first entry) or a single table; mode is augment or replace. */
function readMemoryBlocksPolicy(where: string, value: unknown): MemoryBlocksPolicy | undefined {
  if (value === undefined) return undefined;
  const table: unknown = Array.isArray(value) ? value[0] : value;
  if (!isRecord(table)) throw new Error(`${where} memory_blocks_policy must be a table`);
  const mode = table['mode'];
  if (mode !== 'augment' && mode !== 'replace') {
    throw new Error(`${where} memory_blocks_policy.mode must be "augment" or "replace"`);
  }
  return { mode };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function requireNonEmptyString(value: unknown, onInvalid: () => never): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return onInvalid();
}

/** Undefined unless the value is an array; then every entry must be a string. */
function optionalStringArray(value: unknown, onInvalid: () => never): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.every((v): v is string => typeof v === 'string')) return value;
  return onInvalid();
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFormulas(packRoot: string): Formula[] {
  const dir = join(packRoot, 'formulas');
  return tomlFilesIn(dir).flatMap((fileName) => parseFormulasFromToml(readFileSync(join(dir, fileName), 'utf8')));
}

/**
 * Validate a pack directory without loading it into the runtime.
 * Used by `pack validate <path>` CLI for pack authors.
 */
export function validatePackPath(packRoot: string): { ok: true } | { ok: false; error: string } {
  try {
    if (!statSync(packRoot).isDirectory()) {
      return { ok: false, error: `${packRoot} is not a directory` };
    }
    loadPack(packRoot, 'global');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
