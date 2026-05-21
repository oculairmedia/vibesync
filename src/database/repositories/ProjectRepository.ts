import type Database from 'better-sqlite3';
import { ProjectLettaRepository } from './ProjectLettaRepository';
import { ProjectRoleAgentRepository } from './ProjectRoleAgentRepository';
import type { ProjectRow } from '../../types/db.js';
import type { LettaAgentInfo } from './ProjectLettaRepository';

export interface ProjectUpsert {
  identifier: string;
  name: string;
  huly_id?: string | null;
  vibe_id?: number | null;
  filesystem_path?: string | null;
  git_url?: string | null;
  issue_count?: number | null;
  last_checked_at?: number | null;
  last_sync_at?: number | null;
  status?: string | null;
  created_at?: number | null;
  description_hash?: string | null;
}

export interface ProjectUpdate {
  name?: string | null;
  filesystem_path?: string | null;
  git_url?: string | null;
  status?: string | null;
  last_checked_at?: number | null;
  last_sync_at?: number | null;
}

export interface BeadsRemoteSnapshot {
  owner?: string | null;
  repo?: string | null;
  url?: string | null;
  name?: string | null;
  status?: string | null;
  visibility?: string | null;
  provisioned_at?: number | null;
  last_push_at?: number | null;
  last_error?: string | null;
}

export class ProjectRepository {
  public letta: ProjectLettaRepository;
  public roleAgents: ProjectRoleAgentRepository;

  constructor(private db: Database.Database) {
    this.letta = new ProjectLettaRepository(db);
    this.roleAgents = new ProjectRoleAgentRepository(db);
  }

  upsertProject(project: ProjectUpsert): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (identifier, name, huly_id, vibe_id, filesystem_path, git_url,
         issue_count, last_checked_at, last_sync_at, status, created_at, updated_at, description_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET
           name = excluded.name, huly_id = COALESCE(excluded.huly_id, huly_id),
           vibe_id = COALESCE(excluded.vibe_id, vibe_id),
           filesystem_path = CASE WHEN excluded.filesystem_path IS NOT NULL THEN excluded.filesystem_path ELSE filesystem_path END,
           git_url = COALESCE(excluded.git_url, git_url), issue_count = excluded.issue_count,
           last_checked_at = excluded.last_checked_at, last_sync_at = excluded.last_sync_at,
           status = excluded.status, updated_at = excluded.updated_at,
           description_hash = COALESCE(excluded.description_hash, description_hash)`,
      )
      .run(
        project.identifier, project.name, project.huly_id || null, project.vibe_id || null,
        project.filesystem_path || null, project.git_url || null, project.issue_count || 0,
        project.last_checked_at || now, project.last_sync_at || now,
        project.status || 'active', project.created_at || now, now,
        project.description_hash || null,
      );
  }

  getProject(identifier: string): ProjectRow | null {
    const row = this.db
      .prepare(
        `SELECT p.*, COALESCE(issue_counts.actual_issue_count, 0) AS actual_issue_count,
         CASE WHEN COALESCE(issue_counts.actual_issue_count, 0) > COALESCE(p.issue_count, 0)
              THEN issue_counts.actual_issue_count ELSE COALESCE(p.issue_count, 0) END AS issue_count
         FROM projects p LEFT JOIN (
           SELECT project_identifier, COUNT(*) AS actual_issue_count FROM issues GROUP BY project_identifier
         ) issue_counts ON issue_counts.project_identifier = p.identifier
         WHERE p.identifier = ?`,
      )
      .get(identifier) as ProjectRow | undefined;
    return row ?? null;
  }

  getProjectByVibeId(vibeId: number): ProjectRow | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE vibe_id = ?').get(vibeId) as ProjectRow | undefined;
    return row ?? null;
  }

  updateProject(identifier: string, updates: ProjectUpdate): ProjectRow | null {
    const existing = this.getProject(identifier);
    if (!existing) return null;

    const nextName = updates.name ?? existing.name;
    const nextFilesystemPath = updates.filesystem_path ?? existing.filesystem_path;
    const nextGitUrl = updates.git_url ?? existing.git_url;
    const nextStatus = updates.status ?? existing.status;
    const nextLastCheckedAt = updates.last_checked_at ?? existing.last_checked_at;
    const nextLastSyncAt = updates.last_sync_at ?? existing.last_sync_at;
    const now = Date.now();

    this.db
      .prepare('UPDATE projects SET name = ?, filesystem_path = ?, git_url = ?, status = ?, last_checked_at = ?, last_sync_at = ?, updated_at = ? WHERE identifier = ?')
      .run(nextName, nextFilesystemPath, nextGitUrl, nextStatus, nextLastCheckedAt, nextLastSyncAt, now, identifier);

    return this.getProject(identifier);
  }

  archiveProject(identifier: string): ProjectRow | null {
    return this.updateProject(identifier, { status: 'archived' });
  }

  unarchiveProject(identifier: string): ProjectRow | null {
    return this.updateProject(identifier, { status: 'active' });
  }

  deleteProject(identifier: string): boolean {
    const existing = this.getProject(identifier);
    if (!existing) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteProject = this.db.transaction((projectIdentifier: string) => {
      this.db.prepare('DELETE FROM issues WHERE project_identifier = ?').run(projectIdentifier);
      this.db.prepare('DELETE FROM project_files WHERE project_identifier = ?').run(projectIdentifier);
      this.db.prepare('DELETE FROM bookstack_pages WHERE project_identifier = ?').run(projectIdentifier);
      this.db.prepare('DELETE FROM projects WHERE identifier = ?').run(projectIdentifier);
    }) as (...args: unknown[]) => void;

    deleteProject(identifier);
    return true;
  }

  getAllProjects(): ProjectRow[] {
    return this.db.prepare(
      `SELECT p.*, COALESCE(issue_counts.actual_issue_count, 0) AS actual_issue_count,
       CASE WHEN COALESCE(issue_counts.actual_issue_count, 0) > COALESCE(p.issue_count, 0)
            THEN issue_counts.actual_issue_count ELSE COALESCE(p.issue_count, 0) END AS issue_count
       FROM projects p LEFT JOIN (
         SELECT project_identifier, COUNT(*) AS actual_issue_count FROM issues GROUP BY project_identifier
       ) issue_counts ON issue_counts.project_identifier = p.identifier
       ORDER BY name`,
    ).all() as ProjectRow[];
  }

  getProjectsToSync(staleThreshold = 3600000, descriptionHashes: Record<string, string | null> = {}, now = Date.now()): ProjectRow[] {
    const projects = this.getAllProjects().filter((project) => project.status === 'active');
    return projects.filter((project) => {
      const externalHash = descriptionHashes[project.identifier];
      if (externalHash !== undefined && project.description_hash !== externalHash) return true;
      if (project.last_checked_at == null) return true;
      return now - project.last_checked_at > staleThreshold;
    });
  }

  getActiveProjects(): ProjectRow[] {
    return this.getAllProjects()
      .filter((project) => project.status === 'active' && project.issue_count > 0)
      .sort((a, b) => b.issue_count - a.issue_count || a.name.localeCompare(b.name));
  }

  updateProjectActivity(identifier: string, issueCount: number, checkedAt: number = Date.now()): void {
    this.db.prepare(
      'UPDATE projects SET issue_count = ?, last_checked_at = ?, updated_at = ? WHERE identifier = ?',
    ).run(issueCount, checkedAt, checkedAt, identifier);
  }

  getProjectsWithFilesystemPath(): ProjectRow[] {
    return this.db
      .prepare('SELECT * FROM projects WHERE filesystem_path IS NOT NULL AND status = ? ORDER BY name')
      .all('active') as ProjectRow[];
  }

  getProjectFilesystemPath(identifier: string): string | null {
    const row = this.db
      .prepare('SELECT filesystem_path FROM projects WHERE identifier = ?')
      .get(identifier) as { filesystem_path?: string } | undefined;
    return row?.filesystem_path ?? null;
  }

  getProjectByFolderName(folderName: string): ProjectRow | null {
    if (!folderName) return null;
    const normalizedInput = folderName.replace(/\\/g, '/').toLowerCase();
    const basename = normalizedInput.split('/').filter(Boolean).pop() || normalizedInput;
    const row = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE LOWER(REPLACE(filesystem_path, '\\', '/')) = ?
            OR LOWER(REPLACE(filesystem_path, '\\', '/')) LIKE ? ESCAPE '\\'
         LIMIT 1`,
      )
      .get(normalizedInput, `%/${basename}`) as ProjectRow | undefined;
    return row ?? null;
  }

  getHulySyncCursor(identifier: string): string | null {
    const row = this.db.prepare('SELECT huly_sync_cursor FROM projects WHERE identifier = ?')
      .get(identifier) as { huly_sync_cursor?: string | null } | undefined;
    return row?.huly_sync_cursor ?? null;
  }

  setHulySyncCursor(identifier: string, cursor: string | null): void {
    this.db.prepare('UPDATE projects SET huly_sync_cursor = ?, updated_at = ? WHERE identifier = ?')
      .run(cursor, Date.now(), identifier);
  }

  clearHulySyncCursor(identifier: string): void {
    this.setHulySyncCursor(identifier, null);
  }

  resolveProjectIdentifier(input: string | null): string | null {
    if (!input) return null;
    if (this.getProject(input)) return input;
    return this.getProjectByFolderName(input)?.identifier ?? null;
  }

  setProjectBeadsRemote(identifier: string, remote: BeadsRemoteSnapshot): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE projects SET beads_remote_owner = ?, beads_remote_repo = ?, beads_remote_url = ?,
       beads_remote_name = ?, beads_remote_status = ?, beads_remote_visibility = ?,
       beads_remote_provisioned_at = ?, beads_remote_last_push_at = ?,
       beads_remote_last_error = ?, updated_at = ? WHERE identifier = ?`,
    ).run(
      remote.owner ?? null, remote.repo ?? null, remote.url ?? null,
      remote.name ?? null, remote.status ?? null, remote.visibility ?? null,
      remote.provisioned_at ?? now, remote.last_push_at ?? null,
      remote.last_error ?? null, now, identifier,
    );
  }

  getProjectsWithLettaFolders(): ProjectRow[] {
    return this.db.prepare(
      'SELECT * FROM projects WHERE filesystem_path IS NOT NULL AND letta_folder_id IS NOT NULL AND status = ? ORDER BY name',
    ).all('active') as ProjectRow[];
  }

  getProjectLettaInfo(identifier: string) {
    return this.letta.getProjectLettaInfo(identifier);
  }

  setProjectLettaAgent(identifier: string, lettaInfo: LettaAgentInfo): void {
    this.letta.setProjectLettaAgent(identifier, lettaInfo);
  }

  setProjectLettaFolderId(identifier: string, folderId: string): void {
    this.letta.setProjectLettaFolderId(identifier, folderId);
  }

  setProjectLettaSourceId(identifier: string, sourceId: string): void {
    this.letta.setProjectLettaSourceId(identifier, sourceId);
  }

  setProjectLettaSyncAt(identifier: string, timestamp: number): void {
    this.letta.setProjectLettaSyncAt(identifier, timestamp);
  }

  getAllWithAgents(): unknown[] {
    return this.letta.getAllWithAgents();
  }

  lookupByRepo(repo: string): unknown {
    return this.letta.lookupByRepo(repo);
  }

  getBeadsMirrorSyncedAt(identifier: string): number | null {
    const row = this.db.prepare('SELECT beads_mirror_synced_at FROM projects WHERE identifier = ?')
      .get(identifier) as { beads_mirror_synced_at: number | null } | undefined;
    return row?.beads_mirror_synced_at ?? null;
  }

  setBeadsMirrorSyncedAt(identifier: string, timestamp: number, error: string | null = null): void {
    this.db.prepare(
      'UPDATE projects SET beads_mirror_synced_at = ?, beads_mirror_last_error = ?, updated_at = ? WHERE identifier = ?',
    ).run(timestamp, error, Date.now(), identifier);
  }
}
