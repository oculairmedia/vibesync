import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSyncDatabase, type SyncDatabase } from '../../src/database.js';

const LEGACY_PROJECTS_SQL = `CREATE TABLE projects (
  identifier TEXT PRIMARY KEY, name TEXT NOT NULL, huly_id TEXT, vibe_id INTEGER,
  last_sync_at INTEGER, issue_count INTEGER DEFAULT 0, last_checked_at INTEGER,
  filesystem_path TEXT, git_url TEXT, status TEXT DEFAULT 'active', created_at INTEGER, updated_at INTEGER,
  letta_agent_id TEXT, letta_folder_id TEXT, letta_source_id TEXT, letta_last_sync_at INTEGER,
  description_hash TEXT, huly_sync_cursor TEXT, bookstack_last_export_at INTEGER, bookstack_book_slug TEXT,
  beads_issue_count INTEGER DEFAULT 0, beads_prefix TEXT, tech_stack TEXT, last_scan_at INTEGER,
  mcp_enabled INTEGER DEFAULT 1, beads_remote_status TEXT, beads_remote_url TEXT,
  beads_mirror_synced_at INTEGER, letta_base_url TEXT, provider_kind TEXT, pack_dir TEXT, storage_dir TEXT
);
CREATE INDEX idx_projects_description_hash ON projects(description_hash);
CREATE TABLE issues (identifier TEXT PRIMARY KEY, project_identifier TEXT, huly_id TEXT, title TEXT NOT NULL);
CREATE TABLE bookstack_pages (id INTEGER PRIMARY KEY, bookstack_page_id INTEGER);
CREATE TABLE project_role_agents (
  project_identifier TEXT NOT NULL, role_name TEXT NOT NULL, agent_id TEXT NOT NULL,
  letta_base_url TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
  PRIMARY KEY (project_identifier, role_name)
);`;

describe('registry database', () => {
  let dir: string;
  let dbPath: string;
  let db: SyncDatabase | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-registry-'));
    dbPath = path.join(dir, 'registry.db');
  });
  afterEach(() => {
    db?.close();
    db = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips Huly/Vibe/BookStack/Letta-folder state from a legacy database and keeps the engine registry intact', () => {
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_PROJECTS_SQL);
    legacy.prepare(`INSERT INTO projects (identifier, name, huly_id, filesystem_path, letta_agent_id, provider_kind, pack_dir, beads_remote_status, beads_prefix)
      VALUES ('vibesync', 'Vibesync', 'HULY-1', '/opt/stacks/vibesync', 'agent-pm', 'letta-code-iroh', 'packs/gastown', 'provisioned', 'vibesync')`).run();
    legacy.prepare("INSERT INTO issues VALUES ('VIBES-1', 'vibesync', 'h1', 'old huly issue')").run();
    legacy.prepare("INSERT INTO project_role_agents VALUES ('vibesync', 'coder', 'agent-coder', 'http://shim', 1, 2)").run();
    legacy.close();

    db = createSyncDatabase(dbPath);

    const raw = new Database(dbPath, { readonly: true });
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name).sort();
    const columns = (raw.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();

    expect(tables).toEqual(['project_role_agents', 'projects']);
    for (const retired of ['huly_id', 'huly_sync_cursor', 'vibe_id', 'issue_count', 'letta_folder_id', 'bookstack_book_slug', 'mcp_enabled', 'description_hash', 'beads_mirror_synced_at']) {
      expect(columns, retired).not.toContain(retired);
    }
    expect(db.getProject('vibesync')).toMatchObject({
      identifier: 'vibesync', filesystem_path: '/opt/stacks/vibesync', letta_agent_id: 'agent-pm',
      provider_kind: 'letta-code-iroh', pack_dir: 'packs/gastown', beads_remote_status: 'provisioned', beads_prefix: 'vibesync',
    });
    expect(db.getProjectProviderRouting('vibesync')).toMatchObject({ providerKind: 'letta-code-iroh', parentAgentId: 'agent-pm', packDir: 'packs/gastown' });
    expect(db.getRoleAgent('vibesync', 'coder')).toMatchObject({ agentId: 'agent-coder' });
  });

  it('startup drops role bindings of archived or missing projects, keeps active ones', () => {
    db = createSyncDatabase(dbPath);
    db.upsertProject({ identifier: 'live', name: 'Live' });
    db.upsertProject({ identifier: 'old', name: 'Old' });
    db.upsertRoleAgent('live', 'coder', 'agent-live', 'http://shim');
    db.upsertRoleAgent('old', 'coder', 'agent-old', 'http://shim');
    db.upsertRoleAgent('ghost', 'coder', 'agent-ghost', 'http://shim');
    db.db!.prepare("UPDATE projects SET status = 'archived' WHERE identifier = 'old'").run();
    db.close();
    db = createSyncDatabase(dbPath);
    expect(db.listRoleAgents('live')).toHaveLength(1);
    expect(db.listRoleAgents('old')).toEqual([]);
    expect(db.listRoleAgents('ghost')).toEqual([]);
  });

  it('is idempotent across restarts', () => {
    db = createSyncDatabase(dbPath);
    db.upsertProject({ identifier: 'p', name: 'P', filesystem_path: '/x' });
    db.close();
    db = createSyncDatabase(dbPath);
    expect(db.getProject('p')).toMatchObject({ name: 'P', filesystem_path: '/x', status: 'active' });
  });

  it('upserts, updates, resolves by folder name, archives and deletes (removing role bindings)', () => {
    db = createSyncDatabase(dbPath);
    db.upsertProject({ identifier: 'alpha', name: 'Alpha', filesystem_path: '/opt/stacks/alpha', git_url: 'https://x/a.git' });
    db.upsertProject({ identifier: 'alpha', name: 'Alpha2' });
    expect(db.getProject('alpha')).toMatchObject({ name: 'Alpha2', filesystem_path: '/opt/stacks/alpha', git_url: 'https://x/a.git' });

    expect(db.resolveProjectIdentifier('/opt/stacks/alpha')).toBe('alpha');
    expect(db.resolveProjectIdentifier('missing')).toBeNull();

    expect(db.updateProject('alpha', { status: 'archived' })?.status).toBe('archived');
    expect(db.getProjectsWithFilesystemPath()).toEqual([]);
    expect(db.unarchiveProject('alpha')?.status).toBe('active');

    db.upsertRoleAgent('alpha', 'coder', 'agent-1', 'http://shim');
    expect(db.deleteProject('alpha')).toBe(true);
    expect(db.getProject('alpha')).toBeUndefined();
    expect(db.listRoleAgents('alpha')).toEqual([]);
    expect(db.deleteProject('alpha')).toBe(false);
  });

  it('records Beads remote provisioning success and failure', () => {
    db = createSyncDatabase(dbPath);
    db.upsertProject({ identifier: 'b', name: 'B' });
    db.setBeadsRemoteResult('b', { ok: false, error: 'boom' }, 10);
    expect(db.getProject('b')).toMatchObject({ beads_remote_status: 'error', beads_remote_last_error: 'boom' });
    db.setBeadsRemoteResult('b', { ok: true, remoteUrl: 'https://dolthub/b' }, 20);
    expect(db.getProject('b')).toMatchObject({ beads_remote_status: 'provisioned', beads_remote_url: 'https://dolthub/b', beads_remote_provisioned_at: 20, beads_remote_last_error: null });
    db.projects!.setProjectBeadsRemoteError('b', 'later failure');
    expect(db.getProject('b')).toMatchObject({ beads_remote_status: 'error', beads_remote_last_error: 'later failure' });
  });
});
