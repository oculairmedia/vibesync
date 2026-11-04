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
 * `Block` shape (label + value, optional limit) so the seeder can
 * forward into `@letta-ai/letta-client` without translation.
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
  const out: Pack[] = [];
  const projectRoot = opts.projectRoot ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const scopeRoots: { scope: PackScope; root: string }[] = [
    { scope: 'project', root: join(projectRoot, '.vibesync', 'packs') },
  ];
  if (opts.agentId) {
    scopeRoots.push({ scope: 'agent', root: join(home, '.letta', 'agents', opts.agentId, 'packs') });
  }
  scopeRoots.push({ scope: 'global', root: join(home, '.letta', 'packs') });

  for (const { scope, root } of scopeRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const packRoot = join(root, entry.name);
      const loaded = tryLoadPack(packRoot, scope);
      if (loaded) out.push(loaded);
    }
  }
  return out;
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
  if (!existsSync(path)) {
    throw new Error(`pack: missing pack.toml at ${path}`);
  }
  const raw = parseToml(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error(`pack ${path}: pack.toml must be a table`);
  const packSection = raw['pack'];
  if (!isRecord(packSection)) {
    throw new Error(`pack ${path}: missing or invalid [pack] table`);
  }
  const name = packSection['name'];
  const version = packSection['version'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`pack ${path}: pack.name must be a non-empty string`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`pack ${path}: pack.version must be a non-empty string`);
  }
  const description = typeof packSection['description'] === 'string' ? (packSection['description'] as string) : undefined;
  const dependenciesRaw = packSection['dependencies'];
  let dependencies: string[] | undefined;
  if (Array.isArray(dependenciesRaw)) {
    if (!dependenciesRaw.every((v): v is string => typeof v === 'string')) {
      throw new Error(`pack ${path}: pack.dependencies must be an array of strings`);
    }
    dependencies = dependenciesRaw;
  }
  return {
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
  };
}

function readRoles(packRoot: string): RoleConfig[] {
  const dir = join(packRoot, 'roles');
  if (!existsSync(dir)) return [];
  const out: RoleConfig[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const filePath = join(dir, entry.name);
    const raw = parseToml(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`pack ${packRoot}: role ${entry.name} must be a table`);
    }
    const roleSection = raw['role'];
    if (!isRecord(roleSection)) {
      throw new Error(`pack ${packRoot}: role ${entry.name} missing [role] table`);
    }
    out.push(parseRoleFromTables(packRoot, entry.name, roleSection, raw));
  }
  return out;
}

function parseRoleFromTables(
  packRoot: string,
  fileName: string,
  roleTable: Record<string, unknown>,
  topTable: Record<string, unknown> | null,
): RoleConfig {
  const defaultName = basename(fileName, '.toml');
  const name = typeof roleTable['name'] === 'string' && (roleTable['name'] as string).length > 0
    ? (roleTable['name'] as string)
    : defaultName;
  const description = typeof roleTable['description'] === 'string' ? (roleTable['description'] as string) : undefined;
  const model = typeof roleTable['model'] === 'string' ? (roleTable['model'] as string) : undefined;
  const systemPromptTemplate = typeof roleTable['system_prompt_template'] === 'string'
    ? (roleTable['system_prompt_template'] as string)
    : undefined;
  const toolsRaw = roleTable['tools'];
  let tools: string[] | undefined;
  if (Array.isArray(toolsRaw)) {
    if (!toolsRaw.every((v): v is string => typeof v === 'string')) {
      throw new Error(`pack ${packRoot}: role ${fileName}.tools must be an array of strings`);
    }
    tools = toolsRaw;
  }
  // [[memory_blocks]] lives at the top level of the file (TOML array
  // of tables), not inside [role]. Fall back to a nested array under
  // [role] for authors who keep everything in one section.
  const blocksRaw = (topTable?.['memory_blocks'] ?? roleTable['memory_blocks']) as unknown;
  let memoryBlocks: MemoryBlock[] | undefined;
  if (Array.isArray(blocksRaw)) {
    memoryBlocks = blocksRaw.map((b, idx) => {
      if (!isRecord(b)) {
        throw new Error(`pack ${packRoot}: role ${fileName} memory_blocks[${idx}] must be a table`);
      }
      const label = b['label'];
      const value = b['value'];
      if (typeof label !== 'string' || label.length === 0) {
        throw new Error(`pack ${packRoot}: role ${fileName} memory_blocks[${idx}].label must be a non-empty string`);
      }
      if (typeof value !== 'string') {
        throw new Error(`pack ${packRoot}: role ${fileName} memory_blocks[${idx}].value must be a string`);
      }
      const limit = b['limit'];
      const limitValue = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
      return {
        label,
        value,
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
      };
    });
  }
  const policyRaw = (topTable?.['memory_blocks_policy'] ?? roleTable['memory_blocks_policy']) as unknown;
  let memoryBlocksPolicy: MemoryBlocksPolicy | undefined;
  if (policyRaw !== undefined) {
    const policyTable = Array.isArray(policyRaw) ? policyRaw[0] : policyRaw;
    if (!isRecord(policyTable)) {
      throw new Error(`pack ${packRoot}: role ${fileName} memory_blocks_policy must be a table`);
    }
    const mode = policyTable['mode'];
    if (mode !== 'augment' && mode !== 'replace') {
      throw new Error(`pack ${packRoot}: role ${fileName} memory_blocks_policy.mode must be "augment" or "replace"`);
    }
    memoryBlocksPolicy = { mode };
  }
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(systemPromptTemplate !== undefined ? { systemPromptTemplate } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(memoryBlocks !== undefined ? { memoryBlocks } : {}),
    ...(memoryBlocksPolicy !== undefined ? { memoryBlocksPolicy } : {}),
  };
}

function readFormulas(packRoot: string): Formula[] {
  const dir = join(packRoot, 'formulas');
  if (!existsSync(dir)) return [];
  const out: Formula[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const filePath = join(dir, entry.name);
    const raw = readFileSync(filePath, 'utf8');
    const formulas = parseFormulasFromToml(raw);
    out.push(...formulas);
  }
  return out;
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
