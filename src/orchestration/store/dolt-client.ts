/**
 * Daemon ↔ Dolt direct SQL client for hot-path molecule operations.
 *
 * The orchestration daemon must not shell out to the `bd` CLI for hot-
 * path operations — 100ms+ per call × hundreds of operations per turn =
 * unacceptable latency. This module gives the daemon a typed SQL
 * connection to the local Dolt server that bd init manages, with
 * narrow query wrappers for the operations molecules need.
 *
 * Connection discovery:
 *   - port: read from .beads/dolt-server.port (managed by bd init)
 *   - database: the configured bd prefix with dashes → underscores
 *     (today: "huly_vibe_sync" pending the deprecated prefix rename)
 *   - user/auth: dolt-sql-server runs with no password by default for
 *     local connections; bd's credential key file is for remote sync,
 *     not the local server
 *
 * Layering invariants:
 *   - Schema migrations still go through bd. This module does INSERTs
 *     and SELECTs against bd's existing tables; it does not ALTER.
 *   - Same database as the bd CLI uses. No parallel store.
 *   - Type discriminator (vibesync-93h): molecule beads are written
 *     with issue_type ∈ {'molecule_root', 'molecule_step', 'mail'}.
 *
 * Version-pin discipline (vibesync-bll):
 *   `verifySchema()` hashes `SHOW CREATE TABLE` for every bd table we
 *   INSERT into or SELECT from and compares it to the vendored constant
 *   in schema-fingerprint.ts. When bd is upgraded the hash will drift —
 *   that is intentional. The fix is to re-run the dispatcher's hot-path
 *   INSERTs against the new bd, fix any breakage, and bump both
 *   `EXPECTED_BD_SCHEMA_FINGERPRINT` and `BD_FINGERPRINT_BD_VERSION`.
 *   Never paste the actual fingerprint in without re-testing — that
 *   defeats the silent-breakage guard the constant exists to provide.
 *
 * See vibesync-w5z.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { computeRepoId, defaultRepoFingerprintDeps, type RepoFingerprintDeps } from '../../beads/repoFingerprint.js';
import {
  BD_FINGERPRINT_BD_VERSION,
  BD_FINGERPRINT_TABLES,
  EXPECTED_BD_SCHEMA_FINGERPRINT,
  WrongBdSchemaError,
  computeSchemaFingerprint,
  perTableHashes,
  type TableSchemaRow,
} from './schema-fingerprint.js';

/**
 * Configuration for connecting to the local Dolt server that bd init
 * spawned. Defaults read from the on-disk .beads/ files.
 */
export interface DoltClientConfig {
  /** Repo root that contains .beads/. Defaults to process.cwd(). */
  readonly beadsRoot?: string;
  /** Override port (otherwise read from .beads/dolt-server.port). */
  readonly port?: number;
  /** Database name (defaults to bd prefix normalized: dashes → underscores). */
  readonly database?: string;
  /** Host (defaults to 127.0.0.1). */
  readonly host?: string;
  /** Connection-pool size. */
  readonly poolSize?: number;
  /** Override the expected repo_id (otherwise computed from git remote of beadsRoot). */
  readonly expectedRepoId?: string;
  /** Injectable deps for tests; defaults read real git/fs. */
  readonly repoFingerprintDeps?: RepoFingerprintDeps;
}

/**
 * Thrown by `DoltClient.verifyFingerprint()` when the connected database's
 * `metadata.repo_id` does not match the expected fingerprint for the
 * project. This is the same condition `bd doctor` reports as
 * "Repo Fingerprint: Database belongs to different repository".
 *
 * Treat this error as a hard signal that the local Dolt server is bound
 * to the wrong database (typically: another project's `dolt sql-server`
 * grabbed the port after a host reboot). Recover by running the port
 * sweep (see vibesync-jhb).
 */
export class WrongDoltDatabaseError extends Error {
  readonly expectedRepoId: string;
  readonly actualRepoId: string;
  readonly database: string;
  readonly port: number;
  constructor(args: { expectedRepoId: string; actualRepoId: string; database: string; port: number }) {
    super(
      `WrongDoltDatabase: connected to ${args.database} on port ${args.port} ` +
        `with repo_id=${args.actualRepoId.slice(0, 8)}, expected ${args.expectedRepoId.slice(0, 8)} — ` +
        `another project's Dolt server probably owns this port (bd doctor: \"Database belongs to different repository\")`,
    );
    this.name = 'WrongDoltDatabaseError';
    this.expectedRepoId = args.expectedRepoId;
    this.actualRepoId = args.actualRepoId;
    this.database = args.database;
    this.port = args.port;
  }
}

function resolvedBeadsRoot(cfg: DoltClientConfig): string {
  return cfg.beadsRoot ?? process.cwd();
}

function portFilePath(cfg: DoltClientConfig): string {
  return join(resolvedBeadsRoot(cfg), '.beads', 'dolt-server.port');
}

function parsePort(raw: string, portPath: string): number {
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`DoltClient: invalid port "${raw.trim()}" in ${portPath}`);
  }
  return port;
}

function readPort(cfg: DoltClientConfig): number {
  if (cfg.port !== undefined) return cfg.port;
  const portPath = portFilePath(cfg);
  const raw = readFileSync(portPath, 'utf8');
  return parsePort(raw, portPath);
}

const execFileAsync = promisify(execFile);

/**
 * Injectable side-effects for the resilient boot path (vibesync-nl0l).
 * Split out so the retry/start logic can be unit-tested without a real
 * filesystem or `bd` binary.
 */
export interface DoltBootDeps {
  /** Read the raw port file; returns null when it does not exist. */
  readPortFile(portPath: string): string | null;
  /** Start (or restart) the local Dolt server via `bd dolt start`. */
  startDoltServer(beadsRoot: string): Promise<void>;
  /** Sleep for the given ms (injectable so tests run instantly). */
  sleep(ms: number): Promise<void>;
  /** Structured log sink for boot progress/warnings. */
  log?(level: 'info' | 'warn', obj: Record<string, unknown>, msg: string): void;
}

export const defaultDoltBootDeps: DoltBootDeps = {
  readPortFile(portPath: string): string | null {
    try {
      return readFileSync(portPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async startDoltServer(beadsRoot: string): Promise<void> {
    // `bd dolt start` is the canonical way to (re)spawn the local Dolt
    // sql-server and re-establish .beads/dolt-server.port. It is a no-op
    // when the server is already running.
    await execFileAsync('bd', ['dolt', 'start'], { cwd: beadsRoot, timeout: 30_000 });
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * Options controlling how hard `resolveDoltPort` tries before giving up.
 */
export interface ResolveDoltPortOptions {
  /** Total wall-clock budget across all attempts (ms). Default 30s. */
  readonly timeoutMs?: number;
  /** Delay between port-file polls (ms). Default 500ms. */
  readonly pollIntervalMs?: number;
  /**
   * Whether we are permitted to start the Dolt server ourselves when the
   * port file never appears. Default true. Set false in contexts where an
   * external supervisor owns the Dolt lifecycle (e.g. a systemd unit split
   * — see vibesync-nl0l follow-up).
   */
  readonly startServerIfMissing?: boolean;
}

/**
 * Resilient port resolution (vibesync-nl0l).
 *
 * On every vibesync restart the service SIGKILLs its child Dolt fleet, so
 * `.beads/dolt-server.port` can be absent at boot. The old single
 * `readFileSync` threw ENOENT, which bubbled up and permanently disabled
 * the orchestration plane. This resolver instead:
 *   1. Polls for the port file up to `timeoutMs`.
 *   2. If it never appears and `startServerIfMissing`, runs `bd dolt start`
 *      to (re)spawn the Dolt server, then polls again.
 *   3. Only throws after the full budget is exhausted — and the error is
 *      explicit about what was tried.
 */
export async function resolveDoltPort(
  cfg: DoltClientConfig,
  deps: DoltBootDeps = defaultDoltBootDeps,
  options: ResolveDoltPortOptions = {},
): Promise<number> {
  if (cfg.port !== undefined) return cfg.port;

  const portPath = portFilePath(cfg);
  const beadsRoot = resolvedBeadsRoot(cfg);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const startServerIfMissing = options.startServerIfMissing ?? true;
  // Elapsed is tracked via the injected sleep budget (not wall-clock) so
  // the loop cannot busy-spin and unit tests with an instant sleep stay
  // deterministic and fast.
  let elapsedMs = 0;
  let attemptedStart = false;

  // First read: if the file is already present, we are done — zero added
  // latency on the happy path.
  const first = deps.readPortFile(portPath);
  if (first !== null) return parsePort(first, portPath);

  deps.log?.('warn', { portPath }, 'DoltClient: port file missing at boot — waiting for Dolt to come up');

  while (elapsedMs < timeoutMs) {
    // On the first confirmed miss, if we are allowed to manage the Dolt
    // lifecycle, start the server ourselves (once). On the SIGKILL-restart
    // case nobody else will re-establish the port file, so passively
    // waiting is futile — recover actively, then poll for the file the
    // freshly-started server writes.
    if (!attemptedStart && startServerIfMissing) {
      attemptedStart = true;
      deps.log?.('info', { beadsRoot }, 'DoltClient: attempting to start Dolt server via `bd dolt start`');
      try {
        await deps.startDoltServer(beadsRoot);
      } catch (err) {
        deps.log?.('warn', { err }, 'DoltClient: `bd dolt start` failed — will keep polling for the port file');
      }
      // Re-check immediately after the start attempt before sleeping.
      const afterStart = deps.readPortFile(portPath);
      if (afterStart !== null) {
        deps.log?.('info', { portPath }, 'DoltClient: port file appeared after start — Dolt is up');
        return parsePort(afterStart, portPath);
      }
    }

    await deps.sleep(pollIntervalMs);
    elapsedMs += pollIntervalMs;
    const raw = deps.readPortFile(portPath);
    if (raw !== null) {
      deps.log?.('info', { portPath }, 'DoltClient: port file appeared — Dolt is up');
      return parsePort(raw, portPath);
    }
  }

  throw new Error(
    `DoltClient: Dolt server did not become available within ${timeoutMs}ms — ` +
      `port file ${portPath} never appeared` +
      (startServerIfMissing ? ' (including after `bd dolt start`)' : '') +
      '. Is the Dolt server up? (vibesync-nl0l)',
  );
}

function readDatabase(cfg: DoltClientConfig): string {
  if (cfg.database) return cfg.database;
  // bd creates a Dolt database directory at `.beads/dolt/<name>/` whose
  // name is the bd prefix with dashes → underscores. That's the
  // canonical source. config.yaml's `issue-prefix:` is commented-out by
  // default at bd init, so we walk the directory.
  const doltRoot = join(resolvedBeadsRoot(cfg), '.beads', 'dolt');
  try {
    // The dolt root contains a config.yaml file + exactly one database
    // subdirectory whose name is what we want.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const entries = readdirSync(doltRoot, { withFileTypes: true });
    const dbDir = entries.find((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (dbDir) return dbDir.name;
  } catch {
    // ignore — fall through to inferred name
  }
  // Inferred fallback: last segment of beadsRoot, dashes → underscores
  const segments = resolvedBeadsRoot(cfg).split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? 'beads';
  return name.replace(/-/g, '_');
}

/**
 * Bead row shape — narrow projection of the bd `issues` table covering
 * the fields the orchestration daemon reads. Add columns here as
 * additional queries need them, but resist the urge to mirror the whole
 * 30+-column row.
 */
export interface BeadRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: number;
  readonly issue_type: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly closed_at: Date | null;
  readonly metadata: Record<string, unknown>;
}

/**
 * Dependency-edge row shape from bd's `dependencies` table.
 *
 *   type='parent-child' — molecule root → step
 *   type='blocks'       — sibling step depends_on
 */
export interface DependencyRow {
  readonly issue_id: string;
  readonly depends_on_id: string;
  readonly type: string;
}

/**
 * Compare an expected repo_id against the value just read from the
 * connected database. Throws `WrongDoltDatabaseError` on mismatch.
 * Treats an empty `actualRepoId` as a legacy DB (no error) — same
 * convention as `bd doctor` (warning, not error).
 *
 * Extracted as a top-level pure function so unit tests can pin the
 * mismatch behavior without spinning up a real mysql pool.
 */
export function assertFingerprintMatch(args: {
  readonly expectedRepoId: string;
  readonly actualRepoId: string;
  readonly database: string;
  readonly port: number;
}): void {
  if (!args.actualRepoId) return;
  if (args.actualRepoId !== args.expectedRepoId) {
    throw new WrongDoltDatabaseError({
      expectedRepoId: args.expectedRepoId,
      actualRepoId: args.actualRepoId,
      database: args.database,
      port: args.port,
    });
  }
}

/**
 * The direct-SQL client. Owns a connection pool to the local Dolt
 * server. All operations are typed and parameterized; raw SQL is not
 * exposed to callers.
 */
export class DoltClient {
  private readonly pool: Pool;
  readonly database: string;
  readonly port: number;
  private readonly expectedRepoId: string | null;
  private fingerprintVerified = false;
  private schemaVerified = false;

  /**
   * Resilient async constructor (vibesync-nl0l). Resolves the Dolt port
   * with retry/wait (and, if permitted, `bd dolt start`) before building
   * the pool, so a restart that killed the Dolt fleet self-heals instead
   * of throwing ENOENT synchronously in the constructor. Prefer this over
   * `new DoltClient()` on the boot path.
   */
  static async connect(
    cfg: DoltClientConfig = {},
    bootDeps: DoltBootDeps = defaultDoltBootDeps,
    options: ResolveDoltPortOptions = {},
  ): Promise<DoltClient> {
    const port = await resolveDoltPort(cfg, bootDeps, options);
    return new DoltClient({ ...cfg, port });
  }

  constructor(cfg: DoltClientConfig = {}) {
    const port = readPort(cfg);
    const database = readDatabase(cfg);
    this.database = database;
    this.port = port;
    this.expectedRepoId =
      cfg.expectedRepoId ??
      computeRepoId(resolvedBeadsRoot(cfg), cfg.repoFingerprintDeps ?? defaultRepoFingerprintDeps);
    this.pool = mysql.createPool({
      host: cfg.host ?? '127.0.0.1',
      port,
      database,
      user: 'root',
      // dolt-sql-server runs without auth for local connections by default.
      // bd's credential key is for remote sync, not the local socket.
      password: '',
      connectionLimit: cfg.poolSize ?? 8,
      waitForConnections: true,
      queueLimit: 0,
    });
  }

  /** Close the pool. Idempotent. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Verify the connected Dolt database is actually the one we expect.
   * Compares the DB's `metadata.repo_id` row against the fingerprint
   * computed from the project's git remote (see repoFingerprint.ts).
   *
   * Returns immediately once verified. Throws `WrongDoltDatabaseError`
   * on mismatch — callers should treat that as a hard failure and refuse
   * to read or write further.
   *
   * No-op when no expected fingerprint is known (project lacks a git
   * remote and a resolvable path). That's a legacy/edge case; we log
   * a warning instead of forcing every test fixture to set one.
   */
  async verifyFingerprint(): Promise<void> {
    if (this.fingerprintVerified) return;
    if (!this.expectedRepoId) {
      this.fingerprintVerified = true;
      return;
    }
    const [rows] = await this.pool.execute(
      'SELECT value FROM metadata WHERE `key` = ? LIMIT 1',
      ['repo_id'],
    );
    const actualRepoId = (rows as { value?: string }[])[0]?.value ?? '';
    assertFingerprintMatch({
      expectedRepoId: this.expectedRepoId,
      actualRepoId,
      database: this.database,
      port: this.port,
    });
    this.fingerprintVerified = true;
  }

  /**
   * Verify the bd table schemas the daemon depends on still match the
   * version we vendored a fingerprint for. See schema-fingerprint.ts
   * for the version-pin discipline.
   *
   * Boot calls this before the dispatcher starts so a bd upgrade that
   * silently changes one of the tables we INSERT into fails loudly
   * here instead of wedging on the first hot-path INSERT.
   *
   * Throws `WrongBdSchemaError` with per-table drift context on
   * mismatch. Idempotent after the first successful call.
   */
  async verifySchema(): Promise<void> {
    if (this.schemaVerified) return;
    const rows: TableSchemaRow[] = [];
    for (const table of BD_FINGERPRINT_TABLES) {
      const [result] = await this.pool.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${table}\``);
      const createTableSql = String(result[0]?.['Create Table'] ?? '');
      if (!createTableSql) {
        throw new WrongBdSchemaError({
          expected: EXPECTED_BD_SCHEMA_FINGERPRINT,
          actual: '(missing)',
          bdVersionPin: BD_FINGERPRINT_BD_VERSION,
          perTableDrift: [{ table, expectedHash: '(pinned)', actualHash: '(missing)' }],
        });
      }
      rows.push({ table, createTableSql });
    }
    const actual = computeSchemaFingerprint(rows);
    if (actual !== EXPECTED_BD_SCHEMA_FINGERPRINT) {
      const actualPerTable = perTableHashes(rows);
      const perTableDrift = BD_FINGERPRINT_TABLES.map((table) => ({
        table,
        expectedHash: '(pinned aggregate)',
        actualHash: actualPerTable[table] ?? '(missing)',
      }));
      throw new WrongBdSchemaError({
        expected: EXPECTED_BD_SCHEMA_FINGERPRINT,
        actual,
        bdVersionPin: BD_FINGERPRINT_BD_VERSION,
        perTableDrift,
      });
    }
    this.schemaVerified = true;
  }

  /**
   * Insert a `molecule_root` bead. Returns the id assigned by the caller
   * (we don't use bd's hash-id generator here because the daemon needs
   * to know the id BEFORE the row is written so it can record events
   * about it).
   *
   * The caller is responsible for generating a unique id; convention is
   * `<prefix>-mol-<ulid>` to keep them visually distinct from human
   * beads.
   */
  async insertMoleculeRoot(args: {
    readonly id: string;
    readonly formulaName: string;
    readonly title: string;
    readonly motivatingBeadId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    const meta = {
      ...(args.metadata ?? {}),
      exec: {
        formula: args.formulaName,
        ...(args.motivatingBeadId ? { motivating_bead: args.motivatingBeadId } : {}),
      },
    };
    await this.pool.execute(
      `INSERT INTO issues (id, title, description, design, acceptance_criteria, notes, status, priority, issue_type, metadata, created_by, owner)
       VALUES (?, ?, '', '', '', '', 'open', 2, 'molecule_root', CAST(? AS JSON), 'orchestration-daemon', 'orchestration-daemon')`,
      [args.id, args.title, JSON.stringify(meta)],
    );
  }

  /**
   * Insert a `molecule_step` bead with a parent-child link to its
   * molecule root and optional `blocks` edges to sibling steps it
   * depends on.
   */
  async insertMoleculeStep(args: {
    readonly id: string;
    readonly parentRootId: string;
    readonly stepName: string;
    readonly title: string;
    readonly dependsOnStepIds?: readonly string[];
    readonly inputPayload?: unknown;
  }): Promise<void> {
    const meta = {
      exec: {
        step: args.stepName,
        molecule: args.parentRootId,
        input_payload: args.inputPayload,
      },
    };
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO issues (id, title, description, design, acceptance_criteria, notes, status, priority, issue_type, metadata, created_by, owner)
         VALUES (?, ?, '', '', '', '', 'open', 2, 'molecule_step', CAST(? AS JSON), 'orchestration-daemon', 'orchestration-daemon')`,
        [args.id, args.title, JSON.stringify(meta)],
      );
      // parent-child edge to root (depends_on_id is now a generated column in
      // bd's schema; write the issue-typed source column instead)
      await conn.execute(
        `INSERT INTO dependencies (issue_id, depends_on_issue_id, type, created_by)
         VALUES (?, ?, 'parent-child', 'orchestration-daemon')`,
        [args.id, args.parentRootId],
      );
      // blocks edges to predecessor steps
      for (const dep of args.dependsOnStepIds ?? []) {
        await conn.execute(
          `INSERT INTO dependencies (issue_id, depends_on_issue_id, type, created_by)
           VALUES (?, ?, 'blocks', 'orchestration-daemon')`,
          [args.id, dep],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Find steps in a molecule whose `blocks` predecessors are all closed
   * and that are themselves still open — i.e. ready to dispatch.
   *
   * Returns step bead rows in arbitrary order. Caller is responsible
   * for any preferred dispatch ordering beyond dep satisfaction.
   */
  async findReadyStepsForMolecule(rootId: string): Promise<BeadRow[]> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `
      SELECT i.*
      FROM issues i
      JOIN dependencies parent_dep
        ON parent_dep.issue_id = i.id
       AND parent_dep.depends_on_id = ?
       AND parent_dep.type = 'parent-child'
      WHERE i.issue_type = 'molecule_step'
        AND i.status = 'open'
        AND NOT EXISTS (
          SELECT 1
          FROM dependencies blocks_dep
          JOIN issues blocker
            ON blocker.id = blocks_dep.depends_on_id
          WHERE blocks_dep.issue_id = i.id
            AND blocks_dep.type = 'blocks'
            AND blocker.status != 'closed'
        )
      `,
      [rootId],
    );
    return rows.map(toBeadRow);
  }

  /** Find steps in a molecule currently marked as running. */
  async findRunningStepsForMolecule(rootId: string): Promise<BeadRow[]> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `
      SELECT i.*
      FROM issues i
      JOIN dependencies parent_dep
        ON parent_dep.issue_id = i.id
       AND parent_dep.depends_on_id = ?
       AND parent_dep.type = 'parent-child'
      WHERE i.issue_type = 'molecule_step'
        AND i.status = 'in_progress'
      `,
      [rootId],
    );
    return rows.map(toBeadRow);
  }

  /**
   * lcp-61uj: list molecule-root beads (the rig runs) for the fleet-status
   * endpoint. Ordered newest-first. `statuses` filters by bead status
   * (e.g. ['open','in_progress'] for active runs); omit for all. `limit`
   * caps the result (default 50).
   */
  async listMoleculeRoots(opts: { statuses?: readonly string[]; limit?: number } = {}): Promise<BeadRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const statuses = opts.statuses?.filter((s) => typeof s === 'string' && s.length > 0) ?? [];
    const whereStatus = statuses.length > 0
      ? `AND i.status IN (${statuses.map(() => '?').join(', ')})`
      : '';
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `
      SELECT i.*
      FROM issues i
      WHERE i.issue_type = 'molecule_root'
      ${whereStatus}
      ORDER BY i.created_at DESC
      LIMIT ${limit}
      `,
      [...statuses],
    );
    return rows.map(toBeadRow);
  }

  /** Mark a step as running (status='in_progress'). */
  async markStepRunning(stepId: string): Promise<void> {
    await this.pool.execute(`UPDATE issues SET status = 'in_progress' WHERE id = ?`, [stepId]);
  }

  /**
   * Persist provider-opaque runtime task metadata for restart re-attachment.
   * vibesync-mcz Phase D: also persists conversation_id when supplied so a
   * future resume can re-attach to the same persistent-subagent conversation.
   */
  async recordStepTask(stepId: string, task: {
    readonly taskId?: string;
    readonly providerKind: string;
    readonly sessionId: string;
    readonly conversationId?: string;
  }): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [stepId],
      );
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      meta.exec = {
        ...(meta.exec ?? {}),
        ...(task.taskId ? { task_id: task.taskId } : {}),
        provider_kind: task.providerKind,
        session_id: task.sessionId,
        ...(task.conversationId ? { conversation_id: task.conversationId } : {}),
      };
      await conn.execute(
        `UPDATE issues SET metadata = CAST(? AS JSON) WHERE id = ?`,
        [JSON.stringify(meta), stepId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Persist latest retry-aware execution attempt count. */
  async recordStepAttempt(stepId: string, attempt: number): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [stepId],
      );
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      meta.exec = { ...(meta.exec ?? {}), attempts: attempt };
      await conn.execute(
        `UPDATE issues SET metadata = CAST(? AS JSON) WHERE id = ?`,
        [JSON.stringify(meta), stepId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Mark a step as done with an optional output payload merged into metadata. */
  async markStepDone(stepId: string, output: unknown): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [stepId],
      );
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      meta.exec = { ...(meta.exec ?? {}), output_payload: output };
      await conn.execute(
        `UPDATE issues SET status = 'closed', closed_at = NOW(), metadata = CAST(? AS JSON) WHERE id = ?`,
        [JSON.stringify(meta), stepId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Mark a step as failed with an error trace recorded in metadata. */
  async markStepFailed(stepId: string, errorTrace: string): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [stepId],
      );
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      meta.exec = { ...(meta.exec ?? {}), error_trace: errorTrace };
      await conn.execute(
        `UPDATE issues SET status = 'closed', closed_at = NOW(), close_reason = ?, metadata = CAST(? AS JSON) WHERE id = ?`,
        [`step failed: ${errorTrace.slice(0, 200)}`, JSON.stringify(meta), stepId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Append a structured note to a bead's `notes` column. Used by the
   * dispatcher's writeback hook (vibesync-0xo) to tell a PM agent that
   * the work it dispatched is done. Existing notes are preserved; the
   * new block is appended after a blank-line separator when notes are
   * non-empty.
   *
   * Throws when the bead does not exist — callers should check
   * existence first when the bead may have been GC'd.
   */
  async appendNoteToBead(beadId: string, note: string): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT notes FROM issues WHERE id = ?`,
        [beadId],
      );
      if (rows.length === 0) {
        throw new Error(`appendNoteToBead: bead ${beadId} not found`);
      }
      const existing = typeof rows[0]?.['notes'] === 'string' ? (rows[0]['notes'] as string) : '';
      const next = existing.length > 0 ? `${existing.trimEnd()}\n\n${note}` : note;
      await conn.execute(`UPDATE issues SET notes = ? WHERE id = ?`, [next, beadId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Stamp `metadata.exec.writeback_status` on a molecule_root bead so a
   * replayed dispatcher event does not double-append the writeback note.
   * Returns the previous stamp value (undefined when first seen) so the
   * caller can decide whether to short-circuit.
   */
  async recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed'): Promise<string | undefined> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [rootId],
      );
      if (rows.length === 0) {
        throw new Error(`recordMoleculeWriteback: molecule ${rootId} not found`);
      }
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      const exec = typeof meta.exec === 'object' && meta.exec !== null ? meta.exec : {};
      const previous = typeof exec.writeback_status === 'string' ? (exec.writeback_status as string) : undefined;
      meta.exec = { ...exec, writeback_status: status };
      await conn.execute(
        `UPDATE issues SET metadata = CAST(? AS JSON) WHERE id = ?`,
        [JSON.stringify(meta), rootId],
      );
      await conn.commit();
      return previous;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Mark a molecule root bead as terminal (lcp-s0wi). Sets status to 'closed'
   * and records the outcome (completed|failed|cancelled) in metadata.exec.outcome.
   * Used by the dispatcher to close finished molecule roots so GET /molecules
   * can filter them out from the active list.
   */
  async markMoleculeRootStatus(
    rootId: string,
    status: 'closed',
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT metadata FROM issues WHERE id = ?`,
        [rootId],
      );
      if (rows.length === 0) {
        throw new Error(`markMoleculeRootStatus: molecule ${rootId} not found`);
      }
      const existing = rows[0]?.['metadata'];
      const meta = typeof existing === 'string' ? JSON.parse(existing) : (existing ?? {});
      meta.exec = { ...(meta.exec ?? {}), outcome };
      await conn.execute(
        `UPDATE issues SET status = ?, closed_at = NOW(), metadata = CAST(? AS JSON) WHERE id = ?`,
        [status, JSON.stringify(meta), rootId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Read a single bead by id. */
  async getBead(id: string): Promise<BeadRow | null> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM issues WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    return row ? toBeadRow(row) : null;
  }

  /** Read the dependencies edges of a bead. */
  async getBeadDependencies(id: string): Promise<DependencyRow[]> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT issue_id, depends_on_id, type FROM dependencies WHERE issue_id = ? OR depends_on_id = ?`,
      [id, id],
    );
    return rows.map((r) => ({
      issue_id: String(r['issue_id']),
      depends_on_id: String(r['depends_on_id']),
      type: String(r['type']),
    }));
  }
}

function toBeadRow(r: mysql.RowDataPacket): BeadRow {
  const metaRaw = r['metadata'];
  const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : (metaRaw ?? {});
  return {
    id: String(r['id']),
    title: String(r['title'] ?? ''),
    description: String(r['description'] ?? ''),
    status: String(r['status'] ?? 'open'),
    priority: Number(r['priority'] ?? 2),
    issue_type: String(r['issue_type'] ?? 'task'),
    created_at: new Date(r['created_at']),
    updated_at: new Date(r['updated_at']),
    closed_at: r['closed_at'] ? new Date(r['closed_at']) : null,
    metadata: meta,
  };
}
