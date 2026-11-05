import type Database from 'better-sqlite3';

export interface LettaAgentInfo {
  agentId: string;
}

/**
 * Per-project runtime provider routing (vibesync-f5g / vibesync-8hk).
 *
 * NULL provider_kind means "use the boot-level default provider".
 * `letta-code-iroh` is the only provider kind (vibesync-9lzk.29); any other
 * stored value is a stale row the engine rejects at dispatch.
 * parentAgentId is the project's PM agent (projects.letta_agent_id).
 */
export interface ProjectProviderRouting {
  readonly providerKind: string | null;
  readonly parentAgentId?: string | null;
}

export class ProjectLettaRepository {
  constructor(private db: Database.Database) {}

  /**
   * Read the provider routing config for a project. Returns null when
   * the project doesn't exist; returns an object with routing fields
   * possibly null when the row exists but has no override.
   */
  getProjectProviderRouting(identifier: string): ProjectProviderRouting | null {
    const stmt = this.db.prepare(
      `SELECT provider_kind, letta_agent_id FROM projects WHERE identifier = ?`,
    );
    const row = stmt.get(identifier) as
      | { provider_kind?: string | null; letta_agent_id?: string | null }
      | undefined;
    if (row == null) return null;
    return {
      providerKind: row.provider_kind ?? null,
      parentAgentId: row.letta_agent_id ?? null,
    };
  }

  setProjectLettaAgent(identifier: string, lettaInfo: LettaAgentInfo): void {
    this.db
      .prepare('UPDATE projects SET letta_agent_id = ?, updated_at = ? WHERE identifier = ?')
      .run(lettaInfo.agentId, Date.now(), identifier);
  }
}
