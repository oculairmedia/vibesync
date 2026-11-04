import type Database from 'better-sqlite3';

/**
 * One row from the project_role_agents table (vibesync-mcz Phase A).
 *
 * Represents a single persistent Letta Code subagent that is bound to
 * a (project, role) pair. The provider uses `agentId` to dispatch
 * against the same long-lived agent on every run, instead of spawning
 * a fresh general-purpose subagent each time.
 */
export interface ProjectRoleAgentRecord {
  readonly projectIdentifier: string;
  readonly roleName: string;
  readonly agentId: string;
  readonly lettaBaseUrl: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

interface ProjectRoleAgentRow {
  project_identifier: string;
  role_name: string;
  agent_id: string;
  letta_base_url: string;
  created_at: number;
  last_used_at: number;
}

function rowToRecord(row: ProjectRoleAgentRow): ProjectRoleAgentRecord {
  return {
    projectIdentifier: row.project_identifier,
    roleName: row.role_name,
    agentId: row.agent_id,
    lettaBaseUrl: row.letta_base_url,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Repository over the project_role_agents table.
 *
 * Pure CRUD; no business logic. The bootstrapper (vibesync-mcz Phase B)
 * is the only thing that should call upsertRoleAgent; the dispatcher
 * (Phase D) calls getRoleAgent + touchRoleAgent on every run.
 */
export class ProjectRoleAgentRepository {
  constructor(private db: Database.Database) {}

  /**
   * Look up the persistent agent for a (project, role) pair. Returns
   * null when no bootstrap has happened yet — callers should treat
   * null as "fall back to inline persona" (backwards compat with the
   * pre-mcz dispatch path).
   */
  getRoleAgent(projectIdentifier: string, roleName: string): ProjectRoleAgentRecord | null {
    const row = this.db
      .prepare(
        `SELECT project_identifier, role_name, agent_id, letta_base_url, created_at, last_used_at
         FROM project_role_agents
         WHERE project_identifier = ? AND role_name = ?`,
      )
      .get(projectIdentifier, roleName) as ProjectRoleAgentRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Insert or replace the persistent agent binding for a (project,
   * role) pair. Idempotent: calling twice with the same arguments
   * leaves the row in the same state (modulo created_at preservation
   * — see below).
   *
   * On INSERT, both created_at and last_used_at are set to `now`.
   * On UPDATE, created_at is preserved (the original bootstrap
   * timestamp is meaningful and should not drift), and last_used_at
   * is bumped to `now`. This way upsert acts as both bootstrap and
   * touch when the row already exists.
   */
  upsertRoleAgent(
    projectIdentifier: string,
    roleName: string,
    agentId: string,
    lettaBaseUrl: string,
    now: number = Date.now(),
  ): ProjectRoleAgentRecord {
    this.db
      .prepare(
        `INSERT INTO project_role_agents (
           project_identifier, role_name, agent_id, letta_base_url, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_identifier, role_name) DO UPDATE SET
           agent_id = excluded.agent_id,
           letta_base_url = excluded.letta_base_url,
           last_used_at = excluded.last_used_at`,
      )
      .run(projectIdentifier, roleName, agentId, lettaBaseUrl, now, now);

    // Re-read so callers get the canonical timestamps (created_at on
    // re-upsert is the original value, not `now`).
    const record = this.getRoleAgent(projectIdentifier, roleName);
    if (!record) {
      throw new Error(
        `ProjectRoleAgentRepository: upsert succeeded but row not found for ${projectIdentifier}/${roleName}`,
      );
    }
    return record;
  }

  /**
   * Bump last_used_at on the row for (project, role). No-op when the
   * row doesn't exist (returns false). Use this from the dispatcher
   * on every dispatch so refinery can identify cold role agents.
   */
  touchRoleAgent(
    projectIdentifier: string,
    roleName: string,
    now: number = Date.now(),
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE project_role_agents
         SET last_used_at = ?
         WHERE project_identifier = ? AND role_name = ?`,
      )
      .run(now, projectIdentifier, roleName);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Enumerate every role-agent binding for a project, ordered by
   * role_name. Used by admin tooling and the refinery sweep.
   */
  listRoleAgents(projectIdentifier: string): ProjectRoleAgentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT project_identifier, role_name, agent_id, letta_base_url, created_at, last_used_at
         FROM project_role_agents
         WHERE project_identifier = ?
         ORDER BY role_name`,
      )
      .all(projectIdentifier) as ProjectRoleAgentRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Drop the binding for (project, role). Returns true if a row was
   * removed. Used by the (future) admin 'refresh role agents' path.
   * Does NOT delete the underlying Letta Code agent on disk — that's
   * a separate, explicit operation.
   */
  deleteRoleAgent(projectIdentifier: string, roleName: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM project_role_agents
         WHERE project_identifier = ? AND role_name = ?`,
      )
      .run(projectIdentifier, roleName);
    return (result.changes ?? 0) > 0;
  }
}
