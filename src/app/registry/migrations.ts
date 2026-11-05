import type BetterSqlite3 from 'better-sqlite3';

/**
 * Registry schema. Idempotent: creates the tables a fresh database needs and
 * strips everything left over from the retired Huly/Vibe Kanban/BookStack/
 * Letta-folder sync era from an existing one. Issues and molecules live in
 * Beads/Dolt; this database never mirrors them.
 */

const PROJECT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['identifier', 'TEXT PRIMARY KEY'],
  ['name', 'TEXT NOT NULL'],
  ['filesystem_path', 'TEXT'],
  ['git_url', 'TEXT'],
  ['status', "TEXT DEFAULT 'active'"],
  ['tech_stack', 'TEXT'],
  ['last_scan_at', 'INTEGER'],
  ['last_checked_at', 'INTEGER'],
  ['created_at', 'INTEGER'],
  ['updated_at', 'INTEGER'],
  ['letta_agent_id', 'TEXT'],
  // vibesync-9lzk.29: letta_base_url, pack_dir and storage_dir fed only the
  // removed shim provider; runMigrations drops them from existing databases.
  ['provider_kind', 'TEXT'],
  ['beads_prefix', 'TEXT'],
  ['beads_remote_owner', 'TEXT'],
  ['beads_remote_repo', 'TEXT'],
  ['beads_remote_url', 'TEXT'],
  ['beads_remote_name', 'TEXT'],
  ['beads_remote_status', 'TEXT'],
  ['beads_remote_visibility', 'TEXT'],
  ['beads_remote_provisioned_at', 'INTEGER'],
  ['beads_remote_last_push_at', 'INTEGER'],
  ['beads_remote_last_error', 'TEXT'],
];

/** Tables from retired subsystems. */
const RETIRED_TABLES = ['issues', 'issue_mutation_idempotency', 'bookstack_pages', 'project_files', 'sync_history', 'sync_metadata'];

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function tableExists(db: BetterSqlite3.Database, table: string): boolean {
  // No row is `undefined` under better-sqlite3 (Node) but `null` under
  // bun:sqlite (production), so test for a row, not for `undefined`.
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;
}

export function runMigrations(db: BetterSqlite3.Database): void {
  for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);

  if (!tableExists(db, 'projects')) {
    db.exec(`CREATE TABLE projects (${PROJECT_COLUMNS.map(([name, def]) => `${name} ${def}`).join(', ')})`);
  } else {
    const existing = columnNames(db, 'projects');
    const wanted = new Set(PROJECT_COLUMNS.map(([name]) => name));
    const missing = PROJECT_COLUMNS.filter(([name]) => !existing.includes(name));
    for (const [name, def] of missing) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def.replace(/ PRIMARY KEY| NOT NULL/g, '')}`);
    const retired = existing.filter((name) => !wanted.has(name));
    if (retired.length > 0) {
      // Indexes on dropped columns must go first; recreated below.
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='projects' AND sql IS NOT NULL").all() as Array<{ name: string }>) {
        db.exec(`DROP INDEX IF EXISTS ${row.name}`);
      }
      for (const name of retired) db.exec(`ALTER TABLE projects DROP COLUMN ${name}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_beads_remote_status ON projects(beads_remote_status);
    CREATE TABLE IF NOT EXISTS project_role_agents (
      project_identifier TEXT NOT NULL,
      role_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      letta_base_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (project_identifier, role_name)
    );
    CREATE INDEX IF NOT EXISTS idx_project_role_agents_project ON project_role_agents(project_identifier);
    CREATE INDEX IF NOT EXISTS idx_project_role_agents_agent ON project_role_agents(agent_id);
  `);
  // An archived project is never dispatched to, so its role-agent bindings
  // are dead; drop them (and any whose project row is gone).
  db.exec(`
    DELETE FROM project_role_agents
    WHERE project_identifier NOT IN (SELECT identifier FROM projects WHERE status = 'active')
  `);
}
