/**
 * RoleAgentBootstrapper (vibesync-mcz Phase B).
 *
 * Materializes a per-(project, role) persistent Letta Code agent on
 * the local-backend shim's on-disk store, then records its identity
 * in the project_role_agents table (Phase A). On the second and
 * subsequent calls for the same (project, role), it short-circuits
 * and returns the cached binding — the agent is NOT recreated.
 *
 * The bootstrapped agent's `system` field is the verbatim contents
 * of `<packDir>/.letta/agents/<role>.md` (frontmatter + body). The
 * local-backend shim treats the file as the agent's pinned system
 * prompt; subsequent dispatches don't need to inline persona text in
 * the Agent-tool prompt, which is the whole point of this epic.
 *
 * Design notes:
 *   - Idempotent: a second call with the same (project, role) is a
 *     no-op modulo the touchRoleAgent timestamp bump that happens
 *     inside the repository's upsert.
 *   - No HTTP. The local backend's authority is the JSON file under
 *     `<storageDir>/agents/<b64url(id)>.json`. Writing the file is
 *     sufficient for the shim's GET /v1/agents/<id> to pick it up;
 *     a roundtrip through POST /v1/agents would be a second source
 *     of truth and a new failure mode.
 *   - Injectable clock + id generator + fs functions so unit tests
 *     can exercise the path without touching real disk.
 *   - Throws on persona-not-found. A missing persona is a config
 *     error, not a transient runtime degradation — same posture as
 *     `createDefaultPersonaLoader` in LettaCodeSubagentProvider.
 *   - Does NOT delete or overwrite existing on-disk JSON files when
 *     the repo already has a binding. Trust the table; never rewrite
 *     a live agent's system prompt out from under it.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProjectRoleAgentRecord } from '../database/repositories/ProjectRoleAgentRepository.js';

/**
 * Subset of `SyncDatabase` the bootstrapper needs. Lets tests pass a
 * minimal stub without spinning up SQLite.
 */
export interface RoleAgentRepository {
  getRoleAgent(projectIdentifier: string, roleName: string): ProjectRoleAgentRecord | null;
  upsertRoleAgent(
    projectIdentifier: string,
    roleName: string,
    agentId: string,
    lettaBaseUrl: string,
    now?: number,
  ): ProjectRoleAgentRecord;
}

export interface RoleAgentBootstrapInput {
  /** Project identifier, e.g. 'vibesync'. */
  readonly projectIdentifier: string;
  /** Role name, e.g. 'reviewer', 'coder'. Matches the persona filename stem. */
  readonly role: string;
  /**
   * Absolute path to the pack root. The persona is read from
   * `<packDir>/.letta/agents/<role>.md`. Same convention as
   * createDefaultPersonaLoader.
   */
  readonly packDir: string;
  /**
   * Base URL of the local-backend shim that owns the storage dir.
   * Recorded on the row so we can detect cross-backend mismatches
   * later. Today there's exactly one shim and it lives at
   * http://192.168.50.90:8291.
   */
  readonly lettaBaseUrl: string;
  /**
   * Absolute path to the local-backend's on-disk store. Under this
   * directory we write `agents/<b64url(id)>.json` to materialize the
   * agent. In production: `/opt/stacks/letta-code-parallel/migrator/out`.
   */
  readonly storageDir: string;
}

export interface RoleAgentBootstrapperDeps {
  /** Repository used to lookup + persist the (project, role) → agent_id binding. */
  readonly repo: RoleAgentRepository;
  /** Defaults to crypto.randomUUID(). */
  readonly idGenerator?: () => string;
  /** Defaults to Date.now(). */
  readonly now?: () => number;
  /**
   * Defaults to node:fs/promises. Injectable so unit tests don't
   * require a real disk. The shape is the named-export subset we
   * actually call.
   */
  readonly fs?: {
    readFile: typeof readFile;
    writeFile: typeof writeFile;
    mkdir: typeof mkdir;
    access?: typeof access;
  };
  /**
   * Default agent model when the persona frontmatter doesn't pin
   * one. Matches PM-vibesync's model on this backend.
   */
  readonly defaultModel?: string;
}

/**
 * Default model — PM-vibesync runs on this so role agents should too
 * (same backend, same proxy, same approvals.json semantics).
 */
const DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

/**
 * Default model_settings — copied from PM-vibesync's on-disk JSON.
 * Kept narrow on purpose: anything not in this object is whatever
 * the shim's defaults are.
 */
const DEFAULT_MODEL_SETTINGS = {
  parallel_tool_calls: true,
  provider_type: 'anthropic',
  max_output_tokens: 128000,
  max_tokens: 128000,
} as const;

interface OnDiskAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly model_settings: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly system: string;
}

export class RoleAgentBootstrapper {
  private readonly repo: RoleAgentRepository;
  private readonly idGenerator: () => string;
  private readonly now: () => number;
  private readonly fs: Required<NonNullable<RoleAgentBootstrapperDeps['fs']>>;
  private readonly defaultModel: string;

  constructor(deps: RoleAgentBootstrapperDeps) {
    if (!deps.repo) {
      throw new Error('RoleAgentBootstrapper: deps.repo is required');
    }
    this.repo = deps.repo;
    this.idGenerator = deps.idGenerator ?? (() => `agent-${randomUUID()}`);
    this.now = deps.now ?? (() => Date.now());
    this.fs = {
      readFile: deps.fs?.readFile ?? readFile,
      writeFile: deps.fs?.writeFile ?? writeFile,
      mkdir: deps.fs?.mkdir ?? mkdir,
      access: deps.fs?.access ?? access,
    };
    this.defaultModel = deps.defaultModel ?? DEFAULT_MODEL;
  }

  /**
   * Ensure a persistent agent exists for (project, role) and return
   * the binding. First call materializes the agent JSON on disk and
   * persists the row; subsequent calls are no-ops that return the
   * cached row.
   */
  async ensureRoleAgent(input: RoleAgentBootstrapInput): Promise<ProjectRoleAgentRecord> {
    this.validateInput(input);

    // Hit path: repo already knows about this (project, role) — trust
    // it and return without touching disk. Cross-backend drift is
    // surfaced as a thrown error so callers see the mismatch, rather
    // than silently dispatching against the wrong shim.
    const cached = this.repo.getRoleAgent(input.projectIdentifier, input.role);
    if (cached) {
      if (cached.lettaBaseUrl !== input.lettaBaseUrl) {
        throw new Error(
          `RoleAgentBootstrapper: cached binding for ${input.projectIdentifier}/${input.role} ` +
            `points at ${cached.lettaBaseUrl} but caller requested ${input.lettaBaseUrl}; ` +
            `refusing to silently rebind`,
        );
      }
      return cached;
    }

    // Miss path: read persona, mint id, write JSON, persist row.
    const personaContent = await this.readPersona(input.packDir, input.role);
    const agentId = this.idGenerator();
    const agent = this.composeAgent({
      agentId,
      projectIdentifier: input.projectIdentifier,
      role: input.role,
      personaContent,
    });

    await this.writeAgentJson(input.storageDir, agent);

    return this.repo.upsertRoleAgent(
      input.projectIdentifier,
      input.role,
      agentId,
      input.lettaBaseUrl,
      this.now(),
    );
  }

  // ────────────────────────────────────────────────────────────────────

  private validateInput(input: RoleAgentBootstrapInput): void {
    const required: Array<[keyof RoleAgentBootstrapInput, string]> = [
      ['projectIdentifier', 'projectIdentifier'],
      ['role', 'role'],
      ['packDir', 'packDir'],
      ['lettaBaseUrl', 'lettaBaseUrl'],
      ['storageDir', 'storageDir'],
    ];
    for (const [key, label] of required) {
      const v = input[key];
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`RoleAgentBootstrapper.ensureRoleAgent: ${label} is required`);
      }
    }
  }

  private async readPersona(packDir: string, role: string): Promise<string> {
    const path = join(packDir, '.letta', 'agents', `${role}.md`);
    try {
      return await this.fs.readFile(path, 'utf8');
    } catch (err) {
      throw new Error(
        `RoleAgentBootstrapper: persona for role "${role}" not found at ${path}: ${errorMessage(err)}`,
      );
    }
  }

  private composeAgent(args: {
    readonly agentId: string;
    readonly projectIdentifier: string;
    readonly role: string;
    readonly personaContent: string;
  }): OnDiskAgent {
    const name = `${capitalize(args.role)}-${args.projectIdentifier}`;
    return {
      id: args.agentId,
      name,
      description:
        `${capitalize(args.role)} role agent for project ${args.projectIdentifier}. ` +
        `Persistent subagent — accumulates memfs/recall across formula dispatches.`,
      model: this.defaultModel,
      model_settings: { ...DEFAULT_MODEL_SETTINGS },
      tags: ['vibesync', `project:${args.projectIdentifier}`, `role:${args.role}`, 'lc-local-backend'],
      system: args.personaContent,
    };
  }

  private async writeAgentJson(storageDir: string, agent: OnDiskAgent): Promise<void> {
    const agentsDir = join(storageDir, 'agents');
    await this.fs.mkdir(agentsDir, { recursive: true });
    const filename = `${encodeAgentIdBase64Url(agent.id)}.json`;
    const path = join(agentsDir, filename);
    await this.fs.writeFile(path, JSON.stringify(agent, null, 2), 'utf8');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (exported for unit-test reuse)
// ──────────────────────────────────────────────────────────────────────

/**
 * Encode an agent id (e.g. 'agent-<uuid>') as base64url, matching
 * the local-backend shim's on-disk filename convention.
 */
export function encodeAgentIdBase64Url(agentId: string): string {
  return Buffer.from(agentId, 'utf8').toString('base64url');
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
