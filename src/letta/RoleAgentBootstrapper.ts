/**
 * RoleAgentBootstrapper (vibesync-mcz Phase B, refactored for
 * vibesync-1ix to use @letta-ai/letta-code-sdk for provisioning).
 *
 * Materializes a per-(project, role) persistent Letta Code agent on
 * the local-backend shim's on-disk store, then records its identity
 * in the project_role_agents table (Phase A). On the second and
 * subsequent calls for the same (project, role), it short-circuits
 * and returns the cached binding — the agent is NOT recreated.
 *
 * Design notes (post 1ix refactor):
 *   - Idempotent: a second call with the same (project, role) is a
 *     no-op modulo the touchRoleAgent timestamp bump that happens
 *     inside the repository's upsert.
 *   - Provisioning goes through @letta-ai/letta-code-sdk's createAgent,
 *     which spawns letta-code as a subprocess. The subprocess writes
 *     the agent's on-disk JSON to the location pointed at by
 *     LETTA_LOCAL_BACKEND_DIR — the SAME directory the shim reads.
 *     That's how created agents become observable to the shim.
 *   - We do NOT touch the on-disk JSON ourselves. The shape of that
 *     file is the SDK's concern (Parnas: information hiding). We pass
 *     persona/model/tags/memfs; the SDK owns the rest.
 *   - storageDir is now a contract assertion: it must equal
 *     process.env.LETTA_LOCAL_BACKEND_DIR. Mismatch is a config error,
 *     not a recoverable runtime condition — fail loudly at boot.
 *   - Concurrent ensureRoleAgent calls for the SAME (project, role)
 *     are coalesced via an in-flight lock. Without it, two simultaneous
 *     misses would both spawn the SDK subprocess and create two agents
 *     (last write wins via upsert; orphan stays on disk).
 *   - Drift guard: a cached row pointing at an agent the SDK can't
 *     find on disk is a config incident, not transient. Today we
 *     surface it as a thrown error rather than silently re-creating —
 *     silent re-creation hides corruption.
 *   - Injectable sdk + clock + id generator so unit tests can exercise
 *     the path without spawning a real letta-code subprocess.
 *   - Throws on persona-not-found. Same posture as createDefaultPersonaLoader
 *     in LettaCodeSubagentProvider.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createAgent as sdkCreateAgent,
  type CreateAgentOptions,
} from '@letta-ai/letta-code-sdk';

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
   * Absolute path to the local-backend's on-disk store. Used as a
   * contract assertion against process.env.LETTA_LOCAL_BACKEND_DIR
   * — the SDK subprocess reads that env var to find the store. If
   * the two disagree, the SDK would write to the wrong place; we
   * refuse rather than silently corrupt routing. In production:
   * `/opt/stacks/letta-code-parallel/migrator/out`.
   */
  readonly storageDir: string;
}

/**
 * Narrow SDK boundary. The default impl delegates to
 * @letta-ai/letta-code-sdk; tests inject a stub. Keeping the boundary
 * narrow means we depend on the SDK's contract, not its module.
 */
export interface RoleAgentSdkAdapter {
  /** Create a fresh agent. Returns the new agent's id. */
  createAgent(options: CreateAgentOptions): Promise<string>;
  /**
   * Optional existence probe. When provided, the bootstrapper uses it
   * to validate cached bindings — a cached row pointing at an agent
   * the SDK can't find is a config incident and throws. If absent, we
   * trust the cached row (today's behavior).
   */
  agentExists?(agentId: string): Promise<boolean>;
}

export interface RoleAgentBootstrapperDeps {
  /** Repository used to lookup + persist the (project, role) → agent_id binding. */
  readonly repo: RoleAgentRepository;
  /**
   * SDK adapter for provisioning. Defaults to a thin wrapper around
   * @letta-ai/letta-code-sdk's createAgent. Tests should pass a stub.
   */
  readonly sdk?: RoleAgentSdkAdapter;
  /** Defaults to Date.now(). */
  readonly now?: () => number;
  /**
   * Persona-file reader. Defaults to node:fs/promises.readFile. The
   * persona file is OURS (under packs/), not the SDK's — so we still
   * own this I/O. Injectable so unit tests skip disk.
   */
  readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  /**
   * Default agent model when the persona frontmatter doesn't pin
   * one. Matches PM-vibesync's model on this backend.
   */
  readonly defaultModel?: string;
  /**
   * Defaults to () => process.env.LETTA_LOCAL_BACKEND_DIR. Injectable
   * so tests can simulate boot-time env without process-global mutation.
   */
  readonly envBackendDir?: () => string | undefined;
}

/**
 * Default model — PM-vibesync runs on this so role agents should too
 * (same backend, same proxy, same approvals.json semantics).
 */
const DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

export class RoleAgentBootstrapper {
  private readonly repo: RoleAgentRepository;
  private readonly sdk: RoleAgentSdkAdapter;
  private readonly now: () => number;
  private readonly readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly defaultModel: string;
  private readonly envBackendDir: () => string | undefined;

  /**
   * In-flight lock keyed by `${project}::${role}`. Coalesces concurrent
   * miss-path calls so the SDK subprocess is only spawned once per
   * binding.
   */
  private readonly inflight = new Map<string, Promise<ProjectRoleAgentRecord>>();

  constructor(deps: RoleAgentBootstrapperDeps) {
    if (!deps.repo) {
      throw new Error('RoleAgentBootstrapper: deps.repo is required');
    }
    this.repo = deps.repo;
    this.sdk = deps.sdk ?? createDefaultSdkAdapter();
    this.now = deps.now ?? (() => Date.now());
    this.readFile = deps.readFile ?? ((p, enc) => readFile(p, enc));
    this.defaultModel = deps.defaultModel ?? DEFAULT_MODEL;
    this.envBackendDir =
      deps.envBackendDir ?? (() => process.env['LETTA_LOCAL_BACKEND_DIR']);
  }

  /**
   * Ensure a persistent agent exists for (project, role) and return
   * the binding. First call materializes the agent via SDK createAgent
   * and persists the row; subsequent calls are no-ops that return the
   * cached row.
   */
  async ensureRoleAgent(input: RoleAgentBootstrapInput): Promise<ProjectRoleAgentRecord> {
    this.validateInput(input);
    this.assertEnvMatchesStorageDir(input.storageDir);

    // Hit path: repo already knows about this (project, role).
    const cached = this.repo.getRoleAgent(input.projectIdentifier, input.role);
    if (cached) {
      if (cached.lettaBaseUrl !== input.lettaBaseUrl) {
        throw new Error(
          `RoleAgentBootstrapper: cached binding for ${input.projectIdentifier}/${input.role} ` +
            `points at ${cached.lettaBaseUrl} but caller requested ${input.lettaBaseUrl}; ` +
            `refusing to silently rebind`,
        );
      }
      // Optional drift guard: if the SDK exposes an existence probe,
      // verify the cached agent_id still resolves. A miss here is a
      // config incident — fail loudly, don't silently re-create.
      if (this.sdk.agentExists) {
        const exists = await this.sdk.agentExists(cached.agentId);
        if (!exists) {
          throw new Error(
            `RoleAgentBootstrapper: cached binding for ${input.projectIdentifier}/${input.role} ` +
              `points at agent ${cached.agentId} which the SDK reports as nonexistent; ` +
              `refusing to silently re-create — investigate backend storage drift`,
          );
        }
      }
      return cached;
    }

    // Miss path: coalesce concurrent callers, then create.
    const key = `${input.projectIdentifier}::${input.role}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.provision(input).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  // ────────────────────────────────────────────────────────────────────

  private async provision(input: RoleAgentBootstrapInput): Promise<ProjectRoleAgentRecord> {
    const personaContent = await this.readPersona(input.packDir, input.role);

    const options: CreateAgentOptions = {
      // Use the full persona file (frontmatter + body) as the system
      // prompt. This mirrors the pre-1ix on-disk shape where the
      // markdown's verbatim contents lived in the `system` field.
      systemPrompt: personaContent,
      // memfs: persistent git-backed memory for the role agent so its
      // notes accumulate across formula dispatches.
      memfs: true,
      // Model + tags carry forward from the previous hand-rolled JSON
      // so identity and routing behavior are unchanged.
      model: this.defaultModel,
      tags: [
        'vibesync',
        `project:${input.projectIdentifier}`,
        `role:${input.role}`,
        'lc-local-backend',
      ],
    };

    const agentId = await this.sdk.createAgent(options);
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error(
        `RoleAgentBootstrapper: SDK createAgent returned an invalid agent id ` +
          `(${JSON.stringify(agentId)}) for ${input.projectIdentifier}/${input.role}`,
      );
    }

    return this.repo.upsertRoleAgent(
      input.projectIdentifier,
      input.role,
      agentId,
      input.lettaBaseUrl,
      this.now(),
    );
  }

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

  /**
   * Contract: the storage dir the caller routes to must match the
   * LETTA_LOCAL_BACKEND_DIR the SDK subprocess will see. Without this
   * assertion, a misconfigured boot could route to /foo/migrator/out
   * while the SDK writes to /bar — created agents would be invisible
   * to the shim and dispatch would fail mysteriously.
   */
  private assertEnvMatchesStorageDir(storageDir: string): void {
    const env = this.envBackendDir();
    if (!env) {
      throw new Error(
        `RoleAgentBootstrapper: LETTA_LOCAL_BACKEND_DIR is not set in the environment; ` +
          `it must be set to ${storageDir} so the SDK subprocess writes to the same store the shim reads`,
      );
    }
    if (env !== storageDir) {
      throw new Error(
        `RoleAgentBootstrapper: LETTA_LOCAL_BACKEND_DIR=${env} does not match input.storageDir=${storageDir}; ` +
          `refusing to provision into a different store than the caller routes against`,
      );
    }
  }

  private async readPersona(packDir: string, role: string): Promise<string> {
    const path = join(packDir, '.letta', 'agents', `${role}.md`);
    try {
      return await this.readFile(path, 'utf8');
    } catch (err) {
      throw new Error(
        `RoleAgentBootstrapper: persona for role "${role}" not found at ${path}: ${errorMessage(err)}`,
      );
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Default SDK adapter
// ──────────────────────────────────────────────────────────────────────

function createDefaultSdkAdapter(): RoleAgentSdkAdapter {
  return {
    async createAgent(options: CreateAgentOptions): Promise<string> {
      return sdkCreateAgent(options);
    },
    // agentExists intentionally omitted: the SDK v0.1.14 does not
    // expose a synchronous existence probe, and listMessagesDirect
    // spawns another subprocess per check — too expensive for the
    // hit path. When the SDK adds a cheap existence check, wire it
    // here and the bootstrapper's drift guard activates automatically.
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (exported for unit-test reuse)
// ──────────────────────────────────────────────────────────────────────

/**
 * Encode an agent id (e.g. 'agent-<uuid>') as base64url, matching
 * the local-backend shim's on-disk filename convention.
 *
 * Preserved as an exported helper so the persistent-role-agent-routing
 * integration test (and any other observer) can compute the expected
 * on-disk filename without re-implementing the encoding.
 */
export function encodeAgentIdBase64Url(agentId: string): string {
  return Buffer.from(agentId, 'utf8').toString('base64url');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
