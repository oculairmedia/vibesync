import type Database from 'better-sqlite3';

export interface LettaAgentInfo {
  agentId: string;
  folderId?: string | null;
  sourceId?: string | null;
}

/**
 * Per-project runtime provider routing config (vibesync-f5g / vibesync-8hk).
 *
 * Fields are nullable. NULL means "use the boot-level default".
 * As of vibesync-xosf the supported default is the letta-code local
 * backend when VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-subagent is
 * configured. Removed provider values are read only so boot can reject
 * or safely fall back from stale project rows.
 *
 * packDir and storageDir added in lcp-kamu for role-agent bootstrap
 * (formerly hardcoded in src/index.ts). NULL for either means use the
 * default (packs/gastown, /root/.letta/lc-local-backend).
 */
export interface ProjectProviderRouting {
  readonly lettaBaseUrl: string | null;
  readonly providerKind: string | null;
  readonly parentAgentId?: string | null;
  readonly packDir?: string | null;
  readonly storageDir?: string | null;
}

export class ProjectLettaRepository {
  constructor(private db: Database.Database) {}

  getProjectLettaInfo(identifier: string) {
    const stmt = this.db.prepare(
      `SELECT letta_agent_id, letta_folder_id, letta_source_id, letta_last_sync_at
       FROM projects WHERE identifier = ?`,
    );
    return stmt.get(identifier) || null;
  }

  /**
   * Read the provider routing config for a project. Returns null when
   * the project doesn't exist; returns an object with routing fields
   * possibly null when the row exists but has no override.
   */
  getProjectProviderRouting(identifier: string): ProjectProviderRouting | null {
    const stmt = this.db.prepare(
      `SELECT letta_base_url, provider_kind, letta_agent_id, pack_dir, storage_dir FROM projects WHERE identifier = ?`,
    );
    const row = stmt.get(identifier) as
      | { letta_base_url?: string | null; provider_kind?: string | null; letta_agent_id?: string | null; pack_dir?: string | null; storage_dir?: string | null }
      | undefined;
    if (!row) return null;
    return {
      lettaBaseUrl: row.letta_base_url ?? null,
      providerKind: row.provider_kind ?? null,
      parentAgentId: row.letta_agent_id ?? null,
      packDir: row.pack_dir ?? null,
      storageDir: row.storage_dir ?? null,
    };
  }

  /**
   * Set the provider routing config for a project. Idempotent upsert
   * of the two routing columns; leaves all other project columns
   * untouched. Returns true if the row exists and was updated, false
   * if the project identifier wasn't found.
   *
   * Pass null for either field to clear the override (the dispatcher
   * will then fall back to the global default for that field).
   */
  setProjectProviderRouting(
    identifier: string,
    routing: ProjectProviderRouting,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE projects SET letta_base_url = ?, provider_kind = ?, updated_at = ?
         WHERE identifier = ?`,
      )
      .run(routing.lettaBaseUrl, routing.providerKind, Date.now(), identifier);
    return (result.changes ?? 0) > 0;
  }

  setProjectLettaAgent(identifier: string, lettaInfo: LettaAgentInfo): void {
    const { agentId, folderId, sourceId } = lettaInfo;
    this.db
      .prepare(
        `UPDATE projects SET letta_agent_id = ?, letta_folder_id = ?, letta_source_id = ?, updated_at = ?
         WHERE identifier = ?`,
      )
      .run(agentId, folderId || null, sourceId || null, Date.now(), identifier);
  }

  setProjectLettaFolderId(identifier: string, folderId: string): void {
    this.db
      .prepare('UPDATE projects SET letta_folder_id = ?, updated_at = ? WHERE identifier = ?')
      .run(folderId, Date.now(), identifier);
  }

  setProjectLettaSourceId(identifier: string, sourceId: string): void {
    this.db
      .prepare('UPDATE projects SET letta_source_id = ?, updated_at = ? WHERE identifier = ?')
      .run(sourceId, Date.now(), identifier);
  }

  setProjectLettaSyncAt(identifier: string, timestamp: number): void {
    this.db
      .prepare('UPDATE projects SET letta_last_sync_at = ?, updated_at = ? WHERE identifier = ?')
      .run(timestamp, Date.now(), identifier);
  }

  getAllWithAgents(): unknown[] {
    return this.db
      .prepare(
        `SELECT letta_agent_id AS agent_id, name AS agent_name,
                identifier AS project_identifier, git_url, filesystem_path
         FROM projects WHERE letta_agent_id IS NOT NULL ORDER BY name`,
      )
      .all();
  }

  lookupByRepo(repo: string): unknown {
    const pattern = `%${repo}%`;
    return this.db
      .prepare(
        `SELECT letta_agent_id AS agent_id, name AS agent_name,
                identifier AS project_identifier, git_url
         FROM projects WHERE letta_agent_id IS NOT NULL AND git_url IS NOT NULL
         AND LOWER(git_url) LIKE LOWER(?) LIMIT 1`,
      )
      .get(pattern);
  }
}
