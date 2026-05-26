#!/usr/bin/env bun
/**
 * bd-registry-audit — sweep vibesync's project registry, run the bd
 * preflight against each registered project, surface drift + legacy-
 * shape projects in one report.
 *
 * Addresses three legacy operational beads:
 *   - vibesync-8sz: migrate legacy Beads stores to Dolt-server mode
 *   - vibesync-bi3: resolve registry drift (projects with
 *     tracker.provider=beads but no local .beads dir)
 *   - vibesync-y9b: verify DoltHub remotes for migrated projects
 *
 * The TOOL is code-closable here. The actual remediation per project
 * (running `bd init --migrate`, updating filesystem_path, configuring
 * remotes) is operational work — but this script makes that work
 * scriptable: it prints, for every Beads-backed registered project, the
 * categorical state (migrated / legacy / drifted / placeholder / OK)
 * so operators can act on a single sweep instead of project-by-
 * project archaeology.
 *
 * Usage:
 *   bun scripts/preflight/bd-registry-audit.ts                 # report
 *   bun scripts/preflight/bd-registry-audit.ts --json          # JSON
 *   bun scripts/preflight/bd-registry-audit.ts --drift-only    # only drifts/errors
 *   bun scripts/preflight/bd-registry-audit.ts --db /path/db   # explicit registry DB
 */

// @ts-expect-error bun-only import; resolved at runtime under Bun
import Database from 'bun:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { inspectDoltServerPortOwner } from './bd-preflight.js';

interface ProjectRow {
  readonly identifier: string;
  readonly name: string;
  readonly filesystem_path: string;
  readonly status: string;
  readonly tech_stack: string | null;
}

type Category =
  | 'ok-dolt-server'           // migrated + healthy
  | 'ok-jsonl-only'            // local-only, intentional
  | 'legacy-pre-migration'     // has deprecated dolt_server_port
  | 'port-owner-conflict'      // dolt-server.port belongs to another project process
  | 'drifted-no-beads-dir'     // tracker says beads, dir missing
  | 'placeholder-empty'        // .beads/ present but empty
  | 'no-filesystem-path'       // registry has no path
  | 'path-not-accessible'      // path exists in registry but not on disk
  | 'no-dolt-remote'           // migrated but no remote configured (warning)
  | 'unknown';

interface AuditRow {
  readonly identifier: string;
  readonly name: string;
  readonly path: string | null;
  readonly category: Category;
  readonly detail: string;
}

function tryExec(cmd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: '' };
  }
}

function classifyProject(row: ProjectRow): AuditRow {
  if (!row.filesystem_path || row.filesystem_path.trim().length === 0) {
    return { identifier: row.identifier, name: row.name, path: null, category: 'no-filesystem-path', detail: 'registry row has no path' };
  }
  if (!existsSync(row.filesystem_path)) {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'path-not-accessible', detail: `${row.filesystem_path} not present on this host` };
  }
  const beadsDir = join(row.filesystem_path, '.beads');
  if (!existsSync(beadsDir)) {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'drifted-no-beads-dir', detail: 'tracker advertised as beads-backed but .beads/ is missing' };
  }
  // size check is a quick presence sanity-check; statSync throws if
  // the dir was deleted between existsSync and now.
  try {
    statSync(beadsDir);
  } catch {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'drifted-no-beads-dir', detail: '.beads/ vanished between existsSync and stat' };
  }
  // Heuristic for "empty": no config.yaml AND no dolt subdir AND no port files
  const hasConfig = existsSync(join(beadsDir, 'config.yaml'));
  const hasDoltData = existsSync(join(beadsDir, 'dolt'));
  const hasNewPort = existsSync(join(beadsDir, 'dolt-server.port'));
  const hasDeprecatedPort = existsSync(join(beadsDir, 'dolt_server_port'));
  if (!hasConfig && !hasDoltData && !hasNewPort) {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'placeholder-empty', detail: '.beads/ exists but no config/dolt/port — placeholder or unmigrated jsonl-only' };
  }
  if (hasDeprecatedPort) {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'legacy-pre-migration', detail: 'deprecated dolt_server_port file present — needs migration to dolt-server.port' };
  }
  if (hasDoltData && hasNewPort) {
    const port = readProjectPort(join(beadsDir, 'dolt-server.port'));
    if (port === null) {
      return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'unknown', detail: 'invalid .beads/dolt-server.port value' };
    }
    const owner = inspectDoltServerPortOwner(port, join(beadsDir, 'dolt'));
    if (owner.level === 'error') {
      return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'port-owner-conflict', detail: owner.detail };
    }
    // Migrated. Check remote.
    const remote = tryExec(`cd ${row.filesystem_path} && bd dolt remote 2>&1`);
    if (!remote.ok || remote.stdout.trim().length === 0 || /no remote/.test(remote.stdout)) {
      return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'no-dolt-remote', detail: 'migrated but no DoltHub remote configured' };
    }
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'ok-dolt-server', detail: 'migrated + remote configured' };
  }
  if (!hasDoltData && hasConfig) {
    return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'ok-jsonl-only', detail: 'config present, no dolt data — intentional jsonl-only' };
  }
  return { identifier: row.identifier, name: row.name, path: row.filesystem_path, category: 'unknown', detail: `mixed state: config=${hasConfig} dolt=${hasDoltData} port=${hasNewPort}` };
}

function readProjectPort(path: string): number | null {
  try {
    const port = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function readRegistry(dbPath: string): ProjectRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.query<ProjectRow, []>(
      `SELECT identifier, name, filesystem_path, status, tech_stack FROM projects WHERE status != 'archived'`,
    );
    return stmt.all();
  } finally {
    db.close();
  }
}

function readDbPath(args: readonly string[]): string {
  const dbIndex = args.indexOf('--db');
  if (dbIndex >= 0) {
    const explicit = args[dbIndex + 1];
    if (!explicit) {
      console.error('--db requires a SQLite database path');
      process.exit(2);
    }
    return explicit;
  }
  return process.env.VIBESYNC_DB_PATH || '/opt/stacks/vibesync/logs/sync-state.db';
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const driftOnly = args.includes('--drift-only');
const dbPath = readDbPath(args);

if (!existsSync(dbPath)) {
  console.error(`registry DB not found at ${dbPath}`);
  process.exit(2);
}

let projects: ProjectRow[];
try {
  projects = readRegistry(dbPath);
} catch (err) {
  // Empty DB or schema mismatch — common during fresh installs.
  console.error(`failed to read registry at ${dbPath}: ${(err as Error).message}`);
  console.error('Pass --db <path> or set VIBESYNC_DB_PATH if the service uses a non-default registry database.');
  process.exit(2);
}

const audited = projects.map(classifyProject);
const filtered = driftOnly
  ? audited.filter(
      (r) =>
        r.category !== 'ok-dolt-server' && r.category !== 'ok-jsonl-only',
    )
  : audited;

const buckets: Record<Category, AuditRow[]> = {
  'ok-dolt-server': [],
  'ok-jsonl-only': [],
  'legacy-pre-migration': [],
  'port-owner-conflict': [],
  'drifted-no-beads-dir': [],
  'placeholder-empty': [],
  'no-filesystem-path': [],
  'path-not-accessible': [],
  'no-dolt-remote': [],
  unknown: [],
};
for (const r of audited) buckets[r.category].push(r);

if (jsonMode) {
  console.log(
    JSON.stringify({ total: audited.length, buckets, filtered: driftOnly ? filtered : undefined }, null, 2),
  );
} else {
  console.log(`# bd registry audit — ${audited.length} projects`);
  console.log('');
  for (const [cat, rows] of Object.entries(buckets)) {
    if (rows.length === 0) continue;
    console.log(`## ${cat} (${rows.length})`);
    for (const r of rows) {
      console.log(`  - ${r.identifier.padEnd(20)} ${r.name.padEnd(40)} ${r.path ?? '(no path)'} — ${r.detail}`);
    }
    console.log('');
  }
}

// Exit non-zero if there's drift requiring attention (matches 8sz/bi3/y9b acceptance).
const driftCount =
  buckets['legacy-pre-migration'].length +
  buckets['port-owner-conflict'].length +
  buckets['drifted-no-beads-dir'].length +
  buckets['no-filesystem-path'].length +
  buckets['path-not-accessible'].length +
  buckets['placeholder-empty'].length +
  buckets['unknown'].length;
process.exit(driftCount > 0 ? 1 : 0);
