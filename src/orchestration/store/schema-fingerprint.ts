/**
 * bd schema fingerprint — guard the orchestration daemon against silent
 * breakage when the bd CLI evolves its SQL schema.
 *
 * Background: in May 2026 a bd release made `dependencies.depends_on_id`
 * a STORED generated column (computed from coalesce of three new
 * source columns). Every `INSERT … (depends_on_id) VALUES …` blew up
 * with "value specified for generated column is not allowed" — the
 * fix landed in 42a1c7d but the dispatcher was wedged for the duration.
 *
 * The repo_id fingerprint pattern (see repoFingerprint.ts) is the model:
 * hash a stable shape, vendor an expected hash, compare on boot, throw
 * with rich context on mismatch. This module is that pattern applied to
 * `SHOW CREATE TABLE` for every bd table the daemon INSERTs into or
 * reads from.
 *
 * Canonicalization (must absorb cosmetic drift, must surface real drift):
 *   - lowercase the whole string (Dolt sometimes capitalizes keywords
 *     inconsistently across point releases)
 *   - collapse all whitespace runs to a single space
 *   - strip whitespace around `(`, `)`, `,` so that re-flow / indent
 *     style does not move the hash
 *   - trim
 *
 * That's intentionally narrow: column adds/drops/renames, generated-
 * column expressions, constraints, defaults, and index changes all
 * change real characters and so move the hash. Re-flowing whitespace
 * does not.
 *
 * Trade-off: the vendored expected fingerprint must be bumped every
 * time we upgrade bd. That is the explicit "we re-tested" signal — if
 * a bd bump silently changes a schema we depend on, the boot fails
 * fast instead of corrupting rows on the first hot-path INSERT.
 *
 * See vibesync-bll.
 */

import { createHash } from 'node:crypto';

/** One row from `SHOW CREATE TABLE <name>` — table name + verbatim DDL. */
export interface TableSchemaRow {
  readonly table: string;
  readonly createTableSql: string;
}

/** Normalize a single create-table DDL for hashing. Exported for tests. */
export function canonicalizeCreateTableSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

/**
 * Hash a set of (table, createTableSql) tuples into a stable hex string.
 * Rows are sorted by table name so callers may pass them in any order.
 *
 * The output is sha256-hex (64 chars). Truncating to a shorter prefix
 * is fine for human-facing diff context but the full hash is what we
 * compare against the vendored constant.
 */
export function computeSchemaFingerprint(rows: readonly TableSchemaRow[]): string {
  const sorted = [...rows].sort((a, b) => a.table.localeCompare(b.table));
  const hasher = createHash('sha256');
  for (const row of sorted) {
    hasher.update(row.table.toLowerCase());
    hasher.update('\0');
    hasher.update(canonicalizeCreateTableSql(row.createTableSql));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

/**
 * Vendored expected fingerprint for the bd schema we've tested
 * vibesync against. **Update this constant — and the BD_VERSION below —
 * every time we upgrade bd and re-verify the dispatcher still works.**
 *
 * Tables included: issues, dependencies, metadata. These are the only
 * tables the daemon INSERTs into or SELECTs from. If we start touching
 * other tables (e.g. wisps, events) add them to `BD_FINGERPRINT_TABLES`
 * and bump the fingerprint.
 *
 * Last verified: 2026-05-21 against bd 1.0.4 (dev).
 */
export const BD_FINGERPRINT_BD_VERSION = '1.0.4';
export const BD_FINGERPRINT_TABLES: readonly string[] = ['issues', 'dependencies', 'metadata'];
export const EXPECTED_BD_SCHEMA_FINGERPRINT =
  '452fb5cdb836f2c0dfe43a36676ce351ebc3c42fff9ca966d476cfe88e0390b2';

/**
 * Thrown by `DoltClient.verifySchema()` when one of the bd tables we
 * INSERT into or SELECT from has drifted away from the version we
 * vendored a fingerprint for.
 *
 * Recovery: re-run the dispatcher's INSERT paths against the new bd
 * version, fix any breakage, then update `EXPECTED_BD_SCHEMA_FINGERPRINT`
 * and `BD_FINGERPRINT_BD_VERSION` to match. **Do not** just paste the
 * actual fingerprint into the constant — that defeats the purpose.
 */
export class WrongBdSchemaError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly bdVersionPin: string;
  readonly perTableDrift: readonly {
    readonly table: string;
    readonly expectedHash: string;
    readonly actualHash: string;
  }[];
  constructor(args: {
    readonly expected: string;
    readonly actual: string;
    readonly bdVersionPin: string;
    readonly perTableDrift: readonly {
      readonly table: string;
      readonly expectedHash: string;
      readonly actualHash: string;
    }[];
  }) {
    const driftedTables = args.perTableDrift.map((d) => d.table).join(', ') || '(unknown)';
    super(
      `WrongBdSchema: bd schema fingerprint mismatch — expected ${args.expected.slice(0, 16)} ` +
        `(pinned at bd ${args.bdVersionPin}) but got ${args.actual.slice(0, 16)}. ` +
        `Drifted tables: ${driftedTables}. Re-test the dispatcher's INSERT paths ` +
        `against the current bd, then bump EXPECTED_BD_SCHEMA_FINGERPRINT.`,
    );
    this.name = 'WrongBdSchemaError';
    this.expected = args.expected;
    this.actual = args.actual;
    this.bdVersionPin = args.bdVersionPin;
    this.perTableDrift = args.perTableDrift;
  }
}

/**
 * Per-table canonical hash, used to point at the exact table(s) that
 * drifted. Same canonicalization as the aggregate, so a single-table
 * change shows up in exactly one row.
 */
export function perTableHashes(rows: readonly TableSchemaRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.table] = createHash('sha256')
      .update(canonicalizeCreateTableSql(row.createTableSql))
      .digest('hex');
  }
  return out;
}
