import type Database from 'better-sqlite3';
import { ProjectLettaRepository } from './ProjectLettaRepository';
import { ProjectRoleAgentRepository } from './ProjectRoleAgentRepository';
import type { ProjectRow } from '../../types/db.js';

export interface ProjectUpsert {
  identifier: string;
  name: string;
  filesystem_path?: string | null;
  git_url?: string | null;
  last_checked_at?: number | null;
  status?: string | null;
  created_at?: number | null;
}

export interface ProjectUpdate {
  name?: string | null;
  filesystem_path?: string | null;
  git_url?: string | null;
  status?: string | null;
  last_checked_at?: number | null;
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
  readonly letta: ProjectLettaRepository;
  readonly roleAgents: ProjectRoleAgentRepository;

  constructor(private readonly db: Database.Database) {
    this.letta = new ProjectLettaRepository(db);
    this.roleAgents = new ProjectRoleAgentRepository(db);
  }

  upsertProject(project: ProjectUpsert): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (identifier, name, filesystem_path, git_url, last_checked_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET
           name = excluded.name,
           filesystem_path = COALESCE(excluded.filesystem_path, filesystem_path),
           git_url = COALESCE(excluded.git_url, git_url),
           last_checked_at = excluded.last_checked_at,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        project.identifier, project.name, project.filesystem_path ?? null, project.git_url ?? null,
        project.last_checked_at ?? now, project.status ?? 'active', project.created_at ?? now, now,
      );
  }

  getProject(identifier: string): ProjectRow | null {
    return (this.db.prepare('SELECT * FROM projects WHERE identifier = ?').get(identifier) as ProjectRow | undefined) ?? null;
  }

  updateProject(identifier: string, updates: ProjectUpdate): ProjectRow | null {
    const existing = this.getProject(identifier);
    if (!existing) return null;
    const nextStatus = updates.status ?? existing.status;
    if (nextStatus !== 'active') {
      // Archiving retires the project's role agents with it.
      this.db.prepare('DELETE FROM project_role_agents WHERE project_identifier = ?').run(identifier);
    }
    this.db
      .prepare('UPDATE projects SET name = ?, filesystem_path = ?, git_url = ?, status = ?, last_checked_at = ?, updated_at = ? WHERE identifier = ?')
      .run(
        updates.name ?? existing.name,
        updates.filesystem_path ?? existing.filesystem_path,
        updates.git_url ?? existing.git_url,
        nextStatus,
        updates.last_checked_at ?? existing.last_checked_at,
        Date.now(),
        identifier,
      );
    return this.getProject(identifier);
  }

  deleteProject(identifier: string): boolean {
    const remove = this.db.transaction((id: string) => {
      this.db.prepare('DELETE FROM project_role_agents WHERE project_identifier = ?').run(id);
      return this.db.prepare('DELETE FROM projects WHERE identifier = ?').run(id).changes;
    }) as (id: string) => number;
    return remove(identifier) > 0;
  }

  getAllProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
  }

  getProjectsWithFilesystemPath(): ProjectRow[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE filesystem_path IS NOT NULL AND status = 'active' ORDER BY name")
      .all() as ProjectRow[];
  }

  private getProjectByFolderName(folderName: string): ProjectRow | null {
    const normalized = folderName.replace(/\\/g, '/').toLowerCase();
    const basename = normalized.split('/').filter(Boolean).pop() || normalized;
    const row = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE LOWER(REPLACE(filesystem_path, '\\', '/')) = ?
            OR LOWER(REPLACE(filesystem_path, '\\', '/')) LIKE ? ESCAPE '\\'
         LIMIT 1`,
      )
      .get(normalized, `%/${basename}`) as ProjectRow | undefined;
    return row ?? null;
  }

  resolveProjectIdentifier(input: string | null): string | null {
    if (!input) return null;
    if (this.getProject(input)) return input;
    return this.getProjectByFolderName(input)?.identifier ?? null;
  }

  setProjectScan(identifier: string, techStack: string | null, at: number): void {
    this.db.prepare('UPDATE projects SET tech_stack = ?, last_scan_at = ?, updated_at = ? WHERE identifier = ?')
      .run(techStack, at, at, identifier);
  }

  setBeadsRemoteResult(identifier: string, result: { ok: boolean; remoteUrl?: string | null; error?: string | null }, at: number): void {
    if (result.ok) {
      this.db.prepare("UPDATE projects SET beads_remote_status = 'provisioned', beads_remote_url = ?, beads_remote_provisioned_at = ?, beads_remote_last_error = NULL WHERE identifier = ?")
        .run(result.remoteUrl ?? null, at, identifier);
    } else {
      this.db.prepare("UPDATE projects SET beads_remote_status = 'error', beads_remote_last_error = ? WHERE identifier = ?")
        .run(result.error ?? null, identifier);
    }
  }

  setProjectBeadsRemoteError(identifier: string, error: string): void {
    this.db.prepare("UPDATE projects SET beads_remote_status = 'error', beads_remote_last_error = ?, updated_at = ? WHERE identifier = ?")
      .run(error, Date.now(), identifier);
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
}
