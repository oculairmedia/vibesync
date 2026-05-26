import type BetterSqlite3 from 'better-sqlite3';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqlMasterRow {
  name?: string;
  sql?: string;
}

export function migrateParentChildColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(issues)').all() as ColumnInfo[];
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('parent_huly_id')) {
    console.log('[DB] Adding parent_huly_id column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN parent_huly_id TEXT');
  }

  if (!columnNames.includes('parent_vibe_id')) {
    console.log('[DB] Adding parent_vibe_id column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN parent_vibe_id TEXT');
  }

  if (!columnNames.includes('sub_issue_count')) {
    console.log('[DB] Adding sub_issue_count column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN sub_issue_count INTEGER DEFAULT 0');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_parent_huly ON issues(parent_huly_id);
    CREATE INDEX IF NOT EXISTS idx_issues_parent_vibe ON issues(parent_vibe_id);
  `);

  if (!columnNames.includes('content_hash')) {
    console.log('[DB] Adding content_hash column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN content_hash TEXT');
  }

  if (!columnNames.includes('huly_content_hash')) {
    console.log('[DB] Adding huly_content_hash column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN huly_content_hash TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_content_hash ON issues(content_hash);
  `);

  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
  const projectColumnNames = projectColumns.map((c) => c.name);

  if (!projectColumnNames.includes('huly_sync_cursor')) {
    console.log('[DB] Adding huly_sync_cursor column to projects table');
    db.exec('ALTER TABLE projects ADD COLUMN huly_sync_cursor TEXT');
  }
}

export function migrateDeletionColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(issues)').all() as ColumnInfo[];
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('deleted_from_vibe')) {
    console.log('[DB] Adding deleted_from_vibe column to issues table');
    db.exec('ALTER TABLE issues ADD COLUMN deleted_from_vibe INTEGER DEFAULT 0');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_deleted_from_vibe ON issues(deleted_from_vibe);
  `);
}

export function migrateVibeIndexes(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_vibe_task_id ON issues(vibe_task_id);
    CREATE INDEX IF NOT EXISTS idx_issues_vibe_status ON issues(vibe_status);
  `);
}

export function migrateBookStackTables(db: BetterSqlite3.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookstack_pages'")
    .all() as SqlMasterRow[];

  if (tables.length > 0) {
    const fkCheck = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookstack_pages'")
      .get() as SqlMasterRow | undefined;
    if (fkCheck?.sql?.includes('FOREIGN KEY')) {
      console.log('[DB] Recreating bookstack_pages without FK constraint');
      db.exec('DROP TABLE bookstack_pages');
    }
  }

  const tablesAfter = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookstack_pages'")
    .all() as SqlMasterRow[];
  if (tablesAfter.length === 0) {
    console.log('[DB] Creating bookstack_pages table');
    db.exec(`
      CREATE TABLE bookstack_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookstack_page_id INTEGER NOT NULL UNIQUE,
        bookstack_book_id INTEGER NOT NULL,
        bookstack_chapter_id INTEGER,
        project_identifier TEXT,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        local_path TEXT,
        content_hash TEXT,
        bookstack_modified_at TEXT,
        local_modified_at INTEGER,
        last_export_at INTEGER,
        last_import_at INTEGER,
        sync_direction TEXT,
        created_at INTEGER DEFAULT (unixepoch('now') * 1000),
        updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
      );

      CREATE INDEX idx_bs_pages_project ON bookstack_pages(project_identifier);
      CREATE INDEX idx_bs_pages_bookstack_id ON bookstack_pages(bookstack_page_id);
      CREATE INDEX idx_bs_pages_slug ON bookstack_pages(slug);
      CREATE INDEX idx_bs_pages_local_path ON bookstack_pages(local_path);
    `);
  }

  const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
  const colNames = projectColumns.map((c) => c.name);

  if (!colNames.includes('bookstack_last_export_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN bookstack_last_export_at INTEGER');
  }
  if (!colNames.includes('bookstack_book_slug')) {
    db.exec('ALTER TABLE projects ADD COLUMN bookstack_book_slug TEXT');
  }

  const bsColumns = db.prepare('PRAGMA table_info(bookstack_pages)').all() as ColumnInfo[];
  const bsColNames = bsColumns.map((c) => c.name);

  if (!bsColNames.includes('bookstack_content_hash')) {
    db.exec('ALTER TABLE bookstack_pages ADD COLUMN bookstack_content_hash TEXT');
  }
  if (!bsColNames.includes('sync_status')) {
    db.exec("ALTER TABLE bookstack_pages ADD COLUMN sync_status TEXT DEFAULT 'synced'");
  }
  if (!bsColNames.includes('bookstack_revision_count')) {
    db.exec('ALTER TABLE bookstack_pages ADD COLUMN bookstack_revision_count INTEGER');
  }
}

export function migrateProjectRegistryColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('tech_stack')) {
    db.exec('ALTER TABLE projects ADD COLUMN tech_stack TEXT');
  }

  if (!columnNames.includes('last_scan_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN last_scan_at INTEGER');
  }

  if (!columnNames.includes('mcp_enabled')) {
    db.exec('ALTER TABLE projects ADD COLUMN mcp_enabled INTEGER DEFAULT 1');
  }
}

export function migrateProjectBeadsRemoteColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
  const columnNames = columns.map((c) => c.name);

  const addColumn = (name: string, definition: string) => {
    if (!columnNames.includes(name)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    }
  };

  addColumn('beads_remote_owner', 'TEXT');
  addColumn('beads_remote_repo', 'TEXT');
  addColumn('beads_remote_url', 'TEXT');
  addColumn('beads_remote_name', 'TEXT');
  addColumn('beads_remote_status', 'TEXT');
  addColumn('beads_remote_visibility', 'TEXT');
  addColumn('beads_remote_provisioned_at', 'INTEGER');
  addColumn('beads_remote_last_push_at', 'INTEGER');
  addColumn('beads_remote_last_error', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_beads_remote_status ON projects(beads_remote_status);
  `);
}

export function migrateBeadsIssueMirrorColumns(db: BetterSqlite3.Database): void {
  const projectCols = (db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[]).map((c) => c.name);
  if (!projectCols.includes('beads_mirror_synced_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN beads_mirror_synced_at INTEGER');
  }
  if (!projectCols.includes('beads_mirror_last_error')) {
    db.exec('ALTER TABLE projects ADD COLUMN beads_mirror_last_error TEXT');
  }

  const issueCols = (db.prepare('PRAGMA table_info(issues)').all() as ColumnInfo[]).map((c) => c.name);
  if (!issueCols.includes('beads_updated_at')) {
    db.exec('ALTER TABLE issues ADD COLUMN beads_updated_at INTEGER');
  }
  if (!issueCols.includes('issue_type')) {
    db.exec('ALTER TABLE issues ADD COLUMN issue_type TEXT');
  }
  if (!issueCols.includes('assignee')) {
    db.exec('ALTER TABLE issues ADD COLUMN assignee TEXT');
  }
  if (!issueCols.includes('labels_json')) {
    db.exec('ALTER TABLE issues ADD COLUMN labels_json TEXT');
  }
  if (!issueCols.includes('blocked_by_json')) {
    db.exec('ALTER TABLE issues ADD COLUMN blocked_by_json TEXT');
  }
  if (!issueCols.includes('source')) {
    db.exec("ALTER TABLE issues ADD COLUMN source TEXT");
  }
}

/**
 * Per-project runtime provider routing columns (vibesync-f5g / vibesync-8hk).
 *
 * Adds two nullable columns to the projects table so the orchestration
 * plane can route formula dispatches to different Letta backends per
 * project without a new join or a separate agents table:
 *
 *   letta_base_url  — override of LETTA_BASE_URL for this project's PM
 *                     agent. NULL = use the global default.
 *   provider_kind   — which RuntimeProvider implementation to use.
 *                     NULL or absent = boot-level default.
 *                     Recognized values today: 'letta-code-subagent'.
 *
 * Backwards-compatible: existing rows read NULL/NULL and route to the
 * boot-level letta-code local backend provider. The dispatcher only
 * changes behavior when a row explicitly opts in.
 */
export function migrateProjectProviderRoutingColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as ColumnInfo[];
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes('letta_base_url')) {
    db.exec('ALTER TABLE projects ADD COLUMN letta_base_url TEXT');
  }
  if (!columnNames.includes('provider_kind')) {
    db.exec("ALTER TABLE projects ADD COLUMN provider_kind TEXT");
  }
}

export function migrateIssueMutationIdempotencyTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_mutation_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      action TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(idempotency_key, issue_identifier, action)
    );

    CREATE INDEX IF NOT EXISTS idx_issue_mutation_idempotency_issue
      ON issue_mutation_idempotency(issue_identifier);
  `);
}

/**
 * Per-project, per-role persistent subagent identity (vibesync-mcz Phase A).
 *
 * Each row binds a (project_identifier, role_name) pair to a single
 * persistent Letta Code agent_id that lives on a specific backend.
 * The orchestration plane uses this mapping so that, e.g., every
 * dispatch of the `reviewer` role for project `vibesync` reuses the
 * same Reviewer-vibesync agent — preserving its memfs, recall, and
 * accumulated learning across runs.
 *
 * Schema:
 *   project_identifier  — FK-equivalent to projects.identifier (no hard
 *                         FK; the routing table is intentionally
 *                         decoupled from project lifecycle).
 *   role_name           — pack-defined role (reviewer, coder, tester,
 *                         refinery, …).
 *   agent_id            — the persistent Letta Code agent id (string
 *                         like 'agent-<uuid>'). Authoritative — the
 *                         provider dispatches against this id.
 *   letta_base_url      — the backend that owns this agent (typically
 *                         the local letta-code shim at
 *                         http://192.168.50.90:8291). Recorded so we
 *                         can detect cross-backend mismatches and
 *                         migrate or re-bootstrap cleanly.
 *   created_at          — bootstrap timestamp (ms).
 *   last_used_at        — touched on every dispatch; useful for
 *                         eviction policies / refinery scheduling.
 *
 * Backwards compat: pure additive table. When no row exists for a
 * (project, role) pair, the provider falls back to its existing
 * inline-persona path (see LettaCodeSubagentProvider).
 */
export function migrateProjectRoleAgentsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_role_agents (
      project_identifier TEXT NOT NULL,
      role_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      letta_base_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (project_identifier, role_name)
    );

    CREATE INDEX IF NOT EXISTS idx_project_role_agents_project
      ON project_role_agents(project_identifier);
    CREATE INDEX IF NOT EXISTS idx_project_role_agents_agent
      ON project_role_agents(agent_id);
  `);
}

export function runAllMigrations(db: BetterSqlite3.Database): void {
  migrateParentChildColumns(db);
  migrateBookStackTables(db);
  migrateDeletionColumns(db);
  migrateVibeIndexes(db);
  migrateProjectRegistryColumns(db);
  migrateProjectBeadsRemoteColumns(db);
  migrateBeadsIssueMirrorColumns(db);
  migrateIssueMutationIdempotencyTable(db);
  migrateProjectProviderRoutingColumns(db);
  migrateProjectRoleAgentsTable(db);
}
