import fs from 'node:fs';
import path from 'node:path';
import { BookStackRepository } from './database/repositories/BookStackRepository';
import { IssueRepository } from './database/repositories/IssueRepository';
import { ProjectFilesRepository } from './database/repositories/ProjectFilesRepository';
import { ProjectRepository } from './database/repositories/ProjectRepository';
import { SyncStateRepository } from './database/repositories/SyncStateRepository';
import { computeDescriptionHash, computeIssueContentHash, hasIssueContentChanged } from './database/utils';
import { runAllMigrations } from './database/migrations';

import type BetterSqlite3 from 'better-sqlite3';
import type { ProjectRow, IssueRow } from './types/db.js';
import type { ProjectUpsert, ProjectUpdate, BeadsRemoteSnapshot } from './database/repositories/ProjectRepository';
import type { IssueUpsert, BeadsIssueInput } from './database/repositories/IssueRepository';

// ... rest of imports ...

const sqliteModuleName = (globalThis as Record<string, unknown>).Bun ? 'bun:sqlite' : 'better-sqlite3';
const sqliteModule = await import(sqliteModuleName);
const DatabaseConstructor = sqliteModule.default || sqliteModule.Database;

function createDatabaseConnection(dbPath: string): BetterSqlite3.Database {
  const db = new DatabaseConstructor(dbPath);

  if (typeof (db as Record<string, unknown>).pragma !== 'function') {
    (db as Record<string, unknown>).pragma = (statement: string) => db.exec(`PRAGMA ${statement}`);
  }

  if (typeof (db as Record<string, unknown>).transaction !== 'function') {
    (db as Record<string, unknown>).transaction = (callback: (...args: unknown[]) => unknown) => {
      return (...args: unknown[]) => {
        db.exec('BEGIN');
        try {
          const result = callback(...args);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      };
    };
  }

  return db;
}

export class SyncDatabase {
  dbPath: string;
  db: BetterSqlite3.Database | null;
  syncState: SyncStateRepository | null;
  metadata: SyncStateRepository | null;
  projects: ProjectRepository | null;
  issues: IssueRepository | null;
  syncHistory: SyncStateRepository | null;
  projectFiles: ProjectFilesRepository | null;
  bookstack: BookStackRepository | null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = null;
    this.syncState = null;
    this.projects = null;
    this.issues = null;
    this.metadata = null;
    this.syncHistory = null;
    this.projectFiles = null;
    this.bookstack = null;
  }

  initialize(): void {
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = createDatabaseConnection(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.syncState = new SyncStateRepository(this.db);
    this.metadata = this.syncState;
    this.projects = new ProjectRepository(this.db);
    this.issues = new IssueRepository(this.db);
    this.syncHistory = this.syncState;
    this.projectFiles = new ProjectFilesRepository(this.db);
    this.bookstack = new BookStackRepository(this.db);
    console.log(`[DB] Initialized database at ${this.dbPath}`);
  }

  createTables(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS projects (
        identifier TEXT PRIMARY KEY, name TEXT NOT NULL, huly_id TEXT, vibe_id INTEGER,
        last_sync_at INTEGER, issue_count INTEGER DEFAULT 0, last_checked_at INTEGER,
        filesystem_path TEXT, git_url TEXT, status TEXT DEFAULT 'active',
        created_at INTEGER, updated_at INTEGER,
        letta_agent_id TEXT, letta_folder_id TEXT, letta_source_id TEXT, letta_last_sync_at INTEGER,
        description_hash TEXT,
        beads_remote_owner TEXT, beads_remote_repo TEXT, beads_remote_url TEXT,
        beads_remote_name TEXT, beads_remote_status TEXT, beads_remote_visibility TEXT,
        beads_remote_provisioned_at INTEGER, beads_remote_last_push_at INTEGER,
        beads_remote_last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_sync ON projects(last_sync_at);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
      CREATE INDEX IF NOT EXISTS idx_projects_issue_count ON projects(issue_count);
      CREATE INDEX IF NOT EXISTS idx_projects_description_hash ON projects(description_hash);
      CREATE TABLE IF NOT EXISTS issues (
        identifier TEXT PRIMARY KEY, project_identifier TEXT NOT NULL,
        huly_id TEXT, vibe_task_id INTEGER, title TEXT NOT NULL, description TEXT,
        status TEXT, priority TEXT, last_sync_at INTEGER, created_at INTEGER, updated_at INTEGER,
        vibe_status TEXT, huly_modified_at INTEGER, vibe_modified_at INTEGER,
        deleted_from_huly INTEGER DEFAULT 0, deleted_from_vibe INTEGER DEFAULT 0,
        FOREIGN KEY (project_identifier) REFERENCES projects(identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_identifier);
      CREATE INDEX IF NOT EXISTS idx_issues_last_sync ON issues(last_sync_at);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_deleted_from_huly ON issues(deleted_from_huly);
      CREATE TABLE IF NOT EXISTS sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, completed_at INTEGER,
        projects_processed INTEGER, projects_failed INTEGER, issues_synced INTEGER,
        errors TEXT, duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sync_history_started ON sync_history(started_at);
      CREATE TABLE IF NOT EXISTS project_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_identifier TEXT NOT NULL,
        relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, letta_file_id TEXT,
        file_size INTEGER, uploaded_at INTEGER, updated_at INTEGER,
        UNIQUE(project_identifier, relative_path),
        FOREIGN KEY (project_identifier) REFERENCES projects(identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_identifier);
      CREATE INDEX IF NOT EXISTS idx_project_files_hash ON project_files(content_hash);
    `);
    runAllMigrations(this.db!);
  }

  getBookStackLastExport(projectIdentifier: string): number | null {
    return this.bookstack!.getBookStackLastExport(projectIdentifier);
  }

  setBookStackLastExport(projectIdentifier: string, timestamp: number): void {
    this.bookstack!.setBookStackLastExport(projectIdentifier, timestamp);
  }

  upsertBookStackPage(page: Record<string, unknown>): void {
    this.bookstack!.upsertBookStackPage(page);
  }

  getBookStackPages(projectIdentifier: string): unknown[] {
    return this.bookstack!.getBookStackPages(projectIdentifier);
  }

  getBookStackPageByPath(localPath: string): unknown {
    return this.bookstack!.getBookStackPageByPath(localPath);
  }

  getLastSync(): number | null {
    return this.syncState!.getLastSync();
  }

  setLastSync(timestamp: number): void {
    this.syncState!.setLastSync(timestamp);
  }

  static computeDescriptionHash(description: string | null | undefined): string | null {
    return computeDescriptionHash(description);
  }

  static computeIssueContentHash(issue: Record<string, unknown>): string | null {
    return computeIssueContentHash(issue);
  }

  static hasIssueContentChanged(newIssue: Record<string, unknown>, storedHash: string | null | undefined): boolean {
    return hasIssueContentChanged(newIssue, storedHash);
  }

  close(): void {
    this.db?.close();
  }

  // Convenience proxies — tests call these directly on SyncDatabase
  upsertProject(project: ProjectUpsert): void { return this.projects!.upsertProject(project); }
  getProject(identifier: string): ProjectRow | undefined { return this.projects!.getProject(identifier) ?? undefined; }
  getProjectByVibeId(vibeId: number): ProjectRow | null { return this.projects!.getProjectByVibeId(vibeId); }
  updateProject(identifier: string, updates: ProjectUpdate): ProjectRow | null { return this.projects!.updateProject(identifier, updates); }
  archiveProject(identifier: string): ProjectRow | null { return this.projects!.archiveProject(identifier); }
  deleteProject(identifier: string): boolean { return this.projects!.deleteProject(identifier); }
  getAllProjects(): ProjectRow[] { return this.projects!.getAllProjects(); }
  getProjectsToSync(staleThreshold?: number, descriptionHashes?: Record<string, string | null>): ProjectRow[] { return this.projects!.getProjectsToSync(staleThreshold, descriptionHashes); }
  getActiveProjects(): ProjectRow[] { return this.projects!.getActiveProjects(); }
  updateProjectActivity(id: string, count: number, at?: number): void { return this.projects!.updateProjectActivity(id, count, at); }
  getProjectsWithFilesystemPath(): ProjectRow[] { return this.projects!.getProjectsWithFilesystemPath(); }
  getProjectFilesystemPath(id: string): string | null { return this.projects!.getProjectFilesystemPath(id); }
  getProjectByFolderName(name: string | null): string | null { return this.projects!.getProjectByFolderName(name ?? '')?.identifier ?? null; }
  resolveProjectIdentifier(input: string | null): string | null { return this.projects!.resolveProjectIdentifier(input); }
  getHulySyncCursor(id: string): string | null { return this.projects!.getHulySyncCursor(id); }
  setHulySyncCursor(id: string, cursor: string): void { return this.projects!.setHulySyncCursor(id, cursor); }
  clearHulySyncCursor(id: string): void { return this.projects!.clearHulySyncCursor(id); }
  setProjectBeadsRemote(id: string, remote: BeadsRemoteSnapshot): void { return this.projects!.setProjectBeadsRemote(id, remote); }
  getProjectsWithLettaFolders(): ProjectRow[] { return this.projects!.getProjectsWithLettaFolders(); }

  // Letta convenience proxies
  getProjectLettaInfo(identifier: string) { return this.projects!.letta.getProjectLettaInfo(identifier); }
  setProjectLettaAgent(identifier: string, info: { agentId: string }) { return this.projects!.letta.setProjectLettaAgent(identifier, info); }
  setProjectLettaFolderId(id: string, fid: string): void { return this.projects!.letta.setProjectLettaFolderId(id, fid); }
  setProjectLettaSourceId(id: string, sid: string): void { return this.projects!.letta.setProjectLettaSourceId(id, sid); }
  setProjectLettaSyncAt(id: string, ts: number): void { return this.projects!.letta.setProjectLettaSyncAt(id, ts); }
  getAllWithAgents(): unknown[] { return this.projects!.letta.getAllWithAgents(); }
  lookupByRepo(repo: string): unknown { return this.projects!.letta.lookupByRepo(repo); }
  getAllProjectsWithAgents(): unknown[] { return this.getAllWithAgents(); }
  lookupProjectByRepo(repo: string): unknown { return this.lookupByRepo(repo); }
  getProjectProviderRouting(id: string) { return this.projects!.letta.getProjectProviderRouting(id); }
  setProjectProviderRouting(id: string, routing: { lettaBaseUrl: string | null; providerKind: string | null }): boolean {
    return this.projects!.letta.setProjectProviderRouting(id, routing);
  }

  // Project role-agent convenience proxies (vibesync-mcz Phase A)
  getRoleAgent(projectIdentifier: string, roleName: string) {
    return this.projects!.roleAgents.getRoleAgent(projectIdentifier, roleName);
  }
  upsertRoleAgent(projectIdentifier: string, roleName: string, agentId: string, lettaBaseUrl: string, now?: number) {
    return this.projects!.roleAgents.upsertRoleAgent(projectIdentifier, roleName, agentId, lettaBaseUrl, now);
  }
  touchRoleAgent(projectIdentifier: string, roleName: string, now?: number): boolean {
    return this.projects!.roleAgents.touchRoleAgent(projectIdentifier, roleName, now);
  }
  listRoleAgents(projectIdentifier: string) {
    return this.projects!.roleAgents.listRoleAgents(projectIdentifier);
  }
  deleteRoleAgent(projectIdentifier: string, roleName: string): boolean {
    return this.projects!.roleAgents.deleteRoleAgent(projectIdentifier, roleName);
  }

  // Issue convenience proxies
  upsertIssue(issue: IssueUpsert): void { return this.issues!.upsertIssue(issue); }
  upsertBeadsIssue(pid: string, issue: BeadsIssueInput): void { return this.issues!.upsertBeadsIssue(pid, issue); }
  getMaxBeadsUpdatedAt(pid: string): number | null { return this.issues!.getMaxBeadsUpdatedAt(pid); }
  getBeadsMirrorSyncedAt(pid: string): number | null { return this.projects!.getBeadsMirrorSyncedAt(pid); }
  setBeadsMirrorSyncedAt(pid: string, ts: number, err: string | null = null): void { return this.projects!.setBeadsMirrorSyncedAt(pid, ts, err); }
  getProjectIssues(pid: string): IssueRow[] { return this.issues!.getProjectIssues(pid); }
  getIssue(identifier: string): IssueRow | undefined { return this.issues!.getIssue(identifier) ?? undefined; }
  getIssueByVibeTaskId(pid: string, vid: number): IssueRow | null { return this.issues!.getIssueByVibeTaskId(pid, vid); }
  markDeletedFromHuly(id: string) { return this.issues!.markDeletedFromHuly(id); }
  isDeletedFromHuly(id: string): boolean { return this.issues!.isDeletedFromHuly(id); }
  markDeletedFromVibe(id: string) { return this.issues!.markDeletedFromVibe(id); }
  deleteIssue(id: string) { return this.issues!.deleteIssue(id); }
  getAllIssues(): IssueRow[] { return this.issues!.getAllIssues(); }
  getIssuesWithVibeTaskId(pid: string | null): IssueRow[] { return this.issues!.getIssuesWithVibeTaskId(pid); }
  getModifiedIssues(pid: string, since: number): IssueRow[] { return this.issues!.getModifiedIssues(pid, since); }
  hasIssueChanged(id: string, issue: IssueUpsert): boolean { return this.issues!.hasIssueChanged(id, issue); }
  getIssuesWithContentMismatch(pid: string): IssueRow[] { return this.issues!.getIssuesWithContentMismatch(pid); }
  getChildIssuesByHulyParent(phid: string): IssueRow[] { return this.issues!.getChildIssuesByHulyParent(phid); }
  getParentIssues(pid: string): IssueRow[] { return this.issues!.getParentIssues(pid); }
  getChildIssues(pid: string): IssueRow[] { return this.issues!.getChildIssues(pid); }
  updateParentChild(id: string, phid: string | null): void { return this.issues!.updateParentChild(id, phid); }
  updateSubIssueCount(id: string, count: number): void { return this.issues!.updateSubIssueCount(id, count); }

  // File convenience proxies
  getProjectFiles(pid: string): unknown[] { return this.projectFiles!.getProjectFiles(pid); }
  getProjectFile(pid: string, rp: string): unknown { return this.projectFiles!.getProjectFile(pid, rp); }
  upsertProjectFile(fi: Record<string, unknown>): void { return this.projectFiles!.upsertProjectFile(fi); }
  deleteProjectFile(pid: string, rp: string): void { return this.projectFiles!.deleteProjectFile(pid, rp); }
  deleteAllProjectFiles(pid: string): void { return this.projectFiles!.deleteAllProjectFiles(pid); }
  getOrphanedFiles(pid: string, paths: string[]): unknown[] { return this.projectFiles!.getOrphanedFiles(pid, paths); }

  // Sync history convenience proxies
  startSyncRun(): number | bigint { return this.syncState!.startSyncRun(); }
  completeSyncRun(id: number | bigint, stats: Record<string, unknown>): void { return this.syncState!.completeSyncRun(id, stats); }
  getRecentSyncs(limit?: number): unknown[] { return this.syncState!.getRecentSyncs(limit); }

  // BookStack convenience proxies (already proxied above, add missing)
  importFromJSON(data: Record<string, unknown>): void {
    if (data.lastSync) this.setLastSync(data.lastSync as number);
    if (data.projectActivity && this.projects) {
      for (const [id, entry] of Object.entries(data.projectActivity)) {
        const activity = entry as { issueCount?: number; issue_count?: number; lastChecked?: number; last_checked_at?: number };
        this.projects.upsertProject({
          identifier: id,
          name: id,
          issue_count: activity.issueCount ?? activity.issue_count ?? 0,
          last_checked_at: activity.lastChecked ?? activity.last_checked_at ?? Date.now(),
        });
      }
    }
    if (data.projectTimestamps && this.projects) {
      for (const [id, timestamp] of Object.entries(data.projectTimestamps)) {
        this.projects.updateProject(id, { last_sync_at: Number(timestamp), last_checked_at: Number(timestamp) });
      }
    }
  }

  getStats() {
    const projects = this.getAllProjects();
    return {
      totalProjects: projects.length,
      activeProjects: projects.filter((project) => project.issue_count > 0).length,
      emptyProjects: projects.filter((project) => project.issue_count === 0).length,
      totalIssues: this.getAllIssues().length,
      lastSync: this.getLastSync(),
    };
  }

  getProjectSummary() {
    return [...this.getAllProjects()].sort((a, b) => b.issue_count - a.issue_count || a.name.localeCompare(b.name));
  }
}

export function createSyncDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath);
  db.initialize();
  return db;
}

export function migrateFromJSON(db: SyncDatabase, jsonFilePath: string): boolean {
  if (!fs.existsSync(jsonFilePath)) return false;
  try {
    if (db.getLastSync() || db.getAllProjects().length > 0 || db.getAllIssues().length > 0) return false;
    const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
    if (!data || !db.db) return false;
    db.importFromJSON(data as Record<string, unknown>);
    fs.renameSync(jsonFilePath, `${jsonFilePath}.backup-${Date.now()}`);
    console.log('[Migration] ✓ Imported sync state from JSON');
    return true;
  } catch (err) {
    console.error('[Migration] ✗ Failed to migrate JSON data:', (err as Error).message);
    console.log('[Migration] Continuing with empty database...');
    return false;
  }
}
