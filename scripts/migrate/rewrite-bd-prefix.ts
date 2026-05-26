#!/usr/bin/env bun
/**
 * rewrite-bd-prefix — rewrite every "huly-vibe-sync-" → "vibesync-"
 * occurrence in the bd Dolt database via the running SQL server.
 *
 * Use this instead of offline `dolt sql -q` after `bd dolt stop` —
 * the offline path hit a journal-flush race that corrupted the
 * journal and required `dolt fsck --revive-journal-with-data-loss`.
 * The live SQL server path is the one bd itself uses; it handles
 * journal flushing correctly via auto-commit.
 *
 * Usage:
 *   bun scripts/migrate/rewrite-bd-prefix.ts                 # execute
 *   bun scripts/migrate/rewrite-bd-prefix.ts --dry-run       # report only
 *
 * Idempotent: re-running after a successful pass is a no-op (UPDATEs
 * match on `LIKE 'huly-vibe-sync-%'` so already-renamed rows skip).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

const VIBESYNC_ROOT = process.env['VIBESYNC_ROOT'] ?? '/opt/stacks/vibesync';
const OLD_PREFIX = 'huly-vibe-sync';
const NEW_PREFIX = 'vibesync';

const dryRun = process.argv.includes('--dry-run');

const portPath = join(VIBESYNC_ROOT, '.beads', 'dolt-server.port');
const port = Number.parseInt(readFileSync(portPath, 'utf8').trim(), 10);
if (!Number.isFinite(port)) {
  throw new Error(`invalid port in ${portPath}`);
}

const conn = await mysql.createConnection({
  host: '127.0.0.1',
  port,
  user: 'root',
  password: '',
  database: 'vibesync',
  multipleStatements: false,
});

// FK constraints on dependencies.issue_id → issues.id would otherwise
// fail mid-update (you can't rewrite the child id while the parent
// still points to the old). Disable for the migration window; the data
// stays internally consistent because every UPDATE rewrites both sides.
await conn.execute('SET FOREIGN_KEY_CHECKS = 0');

const tables: Array<{ readonly tbl: string; readonly col: string }> = [
  { tbl: 'dependencies', col: 'issue_id' },
  { tbl: 'dependencies', col: 'depends_on_id' },
  { tbl: 'events', col: 'issue_id' },
  { tbl: 'labels', col: 'issue_id' },
  { tbl: 'child_counters', col: 'parent_id' },
  { tbl: 'comments', col: 'issue_id' },
  { tbl: 'compaction_snapshots', col: 'issue_id' },
  { tbl: 'interactions', col: 'issue_id' },
  { tbl: 'issue_snapshots', col: 'issue_id' },
  { tbl: 'blocked_issues', col: 'id' },
  { tbl: 'ready_issues', col: 'id' },
];

const textColumns: Array<{ readonly tbl: string; readonly col: string }> = [
  { tbl: 'issues', col: 'description' },
  { tbl: 'issues', col: 'notes' },
  { tbl: 'issues', col: 'close_reason' },
];

async function countLikeOld(tbl: string, col: string, anywhere: boolean): Promise<number> {
  const pattern = anywhere ? `%${OLD_PREFIX}-%` : `${OLD_PREFIX}-%`;
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM \`${tbl}\` WHERE \`${col}\` LIKE ?`,
    [pattern],
  );
  return Number(rows[0]?.['n'] ?? 0);
}

async function updatePrefixColumn(tbl: string, col: string): Promise<number> {
  const [result] = await conn.execute<mysql.ResultSetHeader>(
    `UPDATE \`${tbl}\` SET \`${col}\` = REPLACE(\`${col}\`, ?, ?) WHERE \`${col}\` LIKE ?`,
    [`${OLD_PREFIX}-`, `${NEW_PREFIX}-`, `${OLD_PREFIX}-%`],
  );
  return result.affectedRows;
}

async function updateTextColumn(tbl: string, col: string): Promise<number> {
  const [result] = await conn.execute<mysql.ResultSetHeader>(
    `UPDATE \`${tbl}\` SET \`${col}\` = REPLACE(\`${col}\`, ?, ?) WHERE \`${col}\` LIKE ?`,
    [`${OLD_PREFIX}-`, `${NEW_PREFIX}-`, `%${OLD_PREFIX}-%`],
  );
  return result.affectedRows;
}

try {
  console.log(`[rewrite-bd-prefix] connected to dolt-sql-server :${port}`);
  console.log(`[rewrite-bd-prefix] dry-run = ${dryRun}`);

  for (const { tbl, col } of tables) {
    const before = await countLikeOld(tbl, col, false);
    if (before === 0) {
      console.log(`  ${tbl}.${col}: 0 to update`);
      continue;
    }
    if (dryRun) {
      console.log(`  ${tbl}.${col}: would update ${before}`);
    } else {
      const affected = await updatePrefixColumn(tbl, col);
      console.log(`  ${tbl}.${col}: updated ${affected} rows`);
    }
  }

  // Issues.id (the PK) — separate because of its unique-key nature.
  {
    const before = await countLikeOld('issues', 'id', false);
    if (before === 0) {
      console.log('  issues.id: 0 to update');
    } else if (dryRun) {
      console.log(`  issues.id: would update ${before} primary-key rows`);
    } else {
      const [result] = await conn.execute<mysql.ResultSetHeader>(
        `UPDATE \`issues\` SET \`id\` = REPLACE(\`id\`, ?, ?) WHERE \`id\` LIKE ?`,
        [`${OLD_PREFIX}-`, `${NEW_PREFIX}-`, `${OLD_PREFIX}-%`],
      );
      console.log(`  issues.id: updated ${result.affectedRows} primary-key rows`);
    }
  }

  // Text columns — embedded ID references in description / notes / close_reason.
  for (const { tbl, col } of textColumns) {
    const before = await countLikeOld(tbl, col, true);
    if (before === 0) {
      console.log(`  ${tbl}.${col} (text): 0 to update`);
      continue;
    }
    if (dryRun) {
      console.log(`  ${tbl}.${col} (text): would update ${before} rows containing old prefix`);
    } else {
      const affected = await updateTextColumn(tbl, col);
      console.log(`  ${tbl}.${col} (text): updated ${affected} rows`);
    }
  }

  // Final sanity: any remaining huly-vibe-sync- rows anywhere?
  if (!dryRun) {
    const checks = [
      ...tables.map(({ tbl, col }) => ({ tbl, col, anywhere: false })),
      { tbl: 'issues', col: 'id', anywhere: false },
      ...textColumns.map(({ tbl, col }) => ({ tbl, col, anywhere: true })),
    ];
    let totalLeft = 0;
    for (const { tbl, col, anywhere } of checks) {
      totalLeft += await countLikeOld(tbl, col, anywhere);
    }
    console.log(`[rewrite-bd-prefix] total remaining ${OLD_PREFIX}- references: ${totalLeft}`);
    if (totalLeft > 0) {
      process.exitCode = 1;
    }
  }
} finally {
  await conn.end();
}
