/**
 * Project registry (SQLite). Holds only what the orchestration engine and the
 * project API read: project identity/paths, PM agent, Beads remote status,
 * provider routing, pack/storage dirs and role-agent bindings. All issue and
 * molecule state lives in Beads/Dolt; nothing here mirrors it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runMigrations } from './migrations';
import { ProjectRepository } from './repositories/ProjectRepository';

import type BetterSqlite3 from 'better-sqlite3';
import type { ProjectRow } from '../types/db.js';
import type { BeadsRemoteSnapshot, ProjectUpdate, ProjectUpsert } from './repositories/ProjectRepository';

const sqliteModuleName = (globalThis as Record<string, unknown>).Bun ? 'bun:sqlite' : 'better-sqlite3';
const sqliteModule = await import(sqliteModuleName);
const DatabaseConstructor = sqliteModule.default || sqliteModule.Database;

function openDatabase(dbPath: string): BetterSqlite3.Database {
  const db = new DatabaseConstructor(dbPath);
  if (typeof (db as Record<string, unknown>).pragma !== 'function') {
    (db as Record<string, unknown>).pragma = (statement: string) => db.exec(`PRAGMA ${statement}`);
  }
  if (typeof (db as Record<string, unknown>).transaction !== 'function') {
    (db as Record<string, unknown>).transaction = (callback: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
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
  }
  return db;
}

export class Registry {
  readonly dbPath: string;
  db: BetterSqlite3.Database | null = null;
  projects: ProjectRepository | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  initialize(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = openDatabase(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
    this.projects = new ProjectRepository(this.db);
  }

  close(): void {
    this.db?.close();
  }

  upsertProject(project: ProjectUpsert): void { this.projects!.upsertProject(project); }
  getProject(identifier: string): ProjectRow | undefined { return this.projects!.getProject(identifier) ?? undefined; }
  updateProject(identifier: string, updates: ProjectUpdate): ProjectRow | null { return this.projects!.updateProject(identifier, updates); }
  archiveProject(identifier: string): ProjectRow | null { return this.projects!.updateProject(identifier, { status: 'archived' }); }
  unarchiveProject(identifier: string): ProjectRow | null { return this.projects!.updateProject(identifier, { status: 'active' }); }
  deleteProject(identifier: string): boolean { return this.projects!.deleteProject(identifier); }
  getAllProjects(): ProjectRow[] { return this.projects!.getAllProjects(); }
  getProjectsWithFilesystemPath(): ProjectRow[] { return this.projects!.getProjectsWithFilesystemPath(); }
  resolveProjectIdentifier(input: string | null): string | null { return this.projects!.resolveProjectIdentifier(input); }
  setProjectBeadsRemote(id: string, remote: BeadsRemoteSnapshot): void { this.projects!.setProjectBeadsRemote(id, remote); }
  setProjectScan(id: string, techStack: string | null, at: number): void { this.projects!.setProjectScan(id, techStack, at); }
  setBeadsRemoteResult(id: string, result: { ok: boolean; remoteUrl?: string | null; error?: string | null }, at: number): void {
    this.projects!.setBeadsRemoteResult(id, result, at);
  }

  getProjectProviderRouting(id: string) { return this.projects!.letta.getProjectProviderRouting(id); }
  setProjectLettaAgent(identifier: string, info: { agentId: string }) { return this.projects!.letta.setProjectLettaAgent(identifier, info); }

  getRoleAgent(projectIdentifier: string, roleName: string) { return this.projects!.roleAgents.getRoleAgent(projectIdentifier, roleName); }
  upsertRoleAgent(projectIdentifier: string, roleName: string, agentId: string, lettaBaseUrl: string, now?: number) {
    return this.projects!.roleAgents.upsertRoleAgent(projectIdentifier, roleName, agentId, lettaBaseUrl, now);
  }
  touchRoleAgent(projectIdentifier: string, roleName: string, now?: number): boolean {
    return this.projects!.roleAgents.touchRoleAgent(projectIdentifier, roleName, now);
  }
  listRoleAgents(projectIdentifier: string) { return this.projects!.roleAgents.listRoleAgents(projectIdentifier); }
  deleteRoleAgent(projectIdentifier: string, roleName: string): boolean { return this.projects!.roleAgents.deleteRoleAgent(projectIdentifier, roleName); }
}

export function createRegistry(dbPath: string): Registry {
  const db = new Registry(dbPath);
  db.initialize();
  return db;
}
