/**
 * Read-only SQL access to a project's Beads database (the Dolt server bd
 * init manages). Writes never come through here: they go through the bd CLI
 * via orchestration/beads (vibesync-9lzk.9), so bd's validation and
 * invariants always apply.
 *
 * Reads stay on SQL because the ready-step query is a join bd's CLI cannot
 * express, and a read cannot violate bd's rules.
 *
 * Connection discovery:
 *   - port: read from .beads/dolt-server.port (managed by bd init)
 *   - linked worktrees: use the primary repository's .beads, following redirects
 *   - database: authoritative dolt_database from .beads/metadata.json
 *   - user/auth: dolt-sql-server runs with no password by default for
 *     local connections; bd's credential key file is for remote sync,
 *     not the local server
 *
 * Version-pin discipline (vibesync-bll):
 *   `verifySchema()` hashes `SHOW CREATE TABLE` for every bd table we
 *   SELECT from and compares it to the vendored constant in
 *   schema-fingerprint.ts. When bd is upgraded the hash will drift; re-run
 *   the read queries against the new bd, then bump both
 *   `EXPECTED_BD_SCHEMA_FINGERPRINT` and `BD_FINGERPRINT_BD_VERSION`.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import {
  computeRepoId,
  defaultRepoFingerprintDeps,
  type RepoFingerprintDeps,
} from './repo-fingerprint.js';
import {
  BD_FINGERPRINT_BD_VERSION,
  BD_FINGERPRINT_TABLES,
  EXPECTED_BD_SCHEMA_FINGERPRINT,
  VERIFIED_BD_SCHEMA_FINGERPRINTS,
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
  /** Database name override (otherwise metadata.json's dolt_database; never inferred). */
  readonly database?: string;
  /** Host (defaults to 127.0.0.1). */
  readonly host?: string;
  /** Connection-pool size. */
  readonly poolSize?: number;
  /** Override expected repo_id; otherwise use the canonical Beads root's remote/path.
   * With explicit port and database, a nonempty identity bypasses filesystem discovery.
   */
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
  constructor(args: {
    expectedRepoId: string;
    actualRepoId: string;
    database: string;
    port: number;
  }) {
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

interface BeadsLocation {
  root: string;
  beadsDir: string;
}

const locationKey = Symbol('resolvedBeadsLocation');
type ResolvedConfig = DoltClientConfig & { [locationKey]?: BeadsLocation };

function readOptionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function resolveBeadsLocation(cfg: ResolvedConfig): BeadsLocation {
  if (cfg[locationKey]) return cfg[locationKey];
  let root = resolve(cfg.beadsRoot ?? process.cwd());
  // Only inspect this root's Git marker: a standalone project nested in
  // another checkout must not silently inherit that checkout's Beads store.
  const gitMarker = join(root, '.git');
  if (existsSync(gitMarker)) {
    try {
      const [gitDir, commonDir] = execFileSync(
        'git',
        ['-C', root, 'rev-parse', '--git-dir', '--git-common-dir'],
        {
          encoding: 'utf8',
          timeout: 5_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
        .trim()
        .split('\n');
      if (!gitDir || !commonDir) throw new Error('missing Git directory information');
      const commonPath = realpathSync(resolve(root, commonDir));
      if (realpathSync(resolve(root, gitDir)) !== commonPath) {
        if (basename(commonPath) !== '.git') {
          throw new Error(`unsupported linked Git common directory ${commonPath}`);
        }
        root = dirname(commonPath);
      }
    } catch (err) {
      throw new Error(`DoltClient: cannot resolve canonical Beads repository for ${root}`, {
        cause: err,
      });
    }
  }

  let beadsDir = join(root, '.beads');
  const seen = new Set<string>();
  for (let hops = 0; hops < 32; hops += 1) {
    if (existsSync(beadsDir)) beadsDir = realpathSync(beadsDir);
    if (basename(beadsDir) !== '.beads') {
      throw new Error(`DoltClient: unsupported Beads redirect layout: ${beadsDir}; expected a .beads directory`);
    }
    if (seen.has(beadsDir)) throw new Error(`DoltClient: Beads redirect cycle at ${beadsDir}`);
    seen.add(beadsDir);
    const redirect = readOptionalFile(join(beadsDir, 'redirect'));
    if (redirect === null) return { root: dirname(beadsDir), beadsDir };
    const target = redirect.trim();
    if (!target || /[\r\n\0]/.test(target)) {
      throw new Error(`DoltClient: malformed Beads redirect in ${beadsDir}`);
    }
    beadsDir = resolve(beadsDir, target);
    if (!existsSync(beadsDir) || !statSync(beadsDir).isDirectory()) {
      throw new Error(`DoltClient: Beads redirect target is not a directory: ${beadsDir}`);
    }
  }
  throw new Error('DoltClient: too many Beads redirects');
}

function snapshotConfig(cfg: DoltClientConfig): ResolvedConfig {
  // Only a fully explicit endpoint AND identity can bypass local resolution.
  // Otherwise explicit endpoints use the same canonical identity as discovery.
  if (cfg.port !== undefined && cfg.database !== undefined && cfg.expectedRepoId) return cfg;
  return { ...cfg, [locationKey]: resolveBeadsLocation(cfg) };
}

function resolvedBeadsRoot(cfg: ResolvedConfig): string {
  return cfg[locationKey]?.root ?? cfg.beadsRoot ?? process.cwd();
}

function portFilePath(cfg: ResolvedConfig): string {
  return join(resolveBeadsLocation(cfg).beadsDir, 'dolt-server.port');
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

  cfg = snapshotConfig(cfg);
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

  deps.log?.(
    'warn',
    { portPath },
    'DoltClient: port file missing at boot — waiting for Dolt to come up',
  );

  while (elapsedMs < timeoutMs) {
    // On the first confirmed miss, if we are allowed to manage the Dolt
    // lifecycle, start the server ourselves (once). On the SIGKILL-restart
    // case nobody else will re-establish the port file, so passively
    // waiting is futile — recover actively, then poll for the file the
    // freshly-started server writes.
    if (!attemptedStart && startServerIfMissing) {
      attemptedStart = true;
      deps.log?.(
        'info',
        { beadsRoot },
        'DoltClient: attempting to start Dolt server via `bd dolt start`',
      );
      try {
        await deps.startDoltServer(beadsRoot);
      } catch (err) {
        deps.log?.(
          'warn',
          { err },
          'DoltClient: `bd dolt start` failed — will keep polling for the port file',
        );
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

function validateDatabase(value: unknown, source: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(
      `DoltClient: invalid dolt_database in ${source}; expected 1-64 letters, digits, underscores or hyphens`,
    );
  }
  return value;
}

function readDatabase(cfg: DoltClientConfig): string {
  if (cfg.database !== undefined) return validateDatabase(cfg.database, 'database override');
  const metadataPath = join(resolveBeadsLocation(cfg).beadsDir, 'metadata.json');
  const raw = readOptionalFile(metadataPath);
  if (raw === null) {
    throw new Error(
      `DoltClient: no reliable database name: missing ${metadataPath}; set dolt_database or an explicit database override`,
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DoltClient: malformed metadata in ${metadataPath}`, { cause: err });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`DoltClient: malformed metadata in ${metadataPath}: expected an object`);
  }
  return validateDatabase((metadata as Record<string, unknown>).dolt_database, metadataPath);
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
  /** Free-text notes column; absent when the source row does not carry it. */
  readonly notes?: string;
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

/** How long a freshly started Dolt server is given to accept its first connection. */
const RESTART_ACCEPT_BUDGET_MS = 10_000;

/** True when nothing is listening on the port we dialled (the server is down, as opposed to wrong or broken). */
function isConnectionRefused(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ECONNREFUSED';
}

/**
 * Whether a failed first connection may be answered by starting the server
 * (vibesync-9lzk.55.7). Only a refused connection qualifies: a wrong database
 * (fingerprint mismatch), a schema error or any other failure must surface
 * unchanged. An explicit port names a server someone else manages, and
 * `startServerIfMissing: false` says the same about the whole lifecycle.
 */
function canRestartDeadServer(err: unknown, cfg: DoltClientConfig, options: ResolveDoltPortOptions): boolean {
  return isConnectionRefused(err) && cfg.port === undefined && options.startServerIfMissing !== false;
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
  /** Canonical repository root that owns this database's `.beads/`. bd writes must target the same root. */
  readonly beadsRoot: string;
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
    cfg = snapshotConfig(cfg);
    // Fail closed before polling or starting a server when metadata is invalid.
    const database = readDatabase(cfg);
    const port = await resolveDoltPort(cfg, bootDeps, options);
    try {
      return await DoltClient.openVerified(cfg, port, database);
    } catch (err) {
      if (!canRestartDeadServer(err, cfg, options)) throw err;
      return await DoltClient.restartAndConnect(cfg, { database, refusedPort: port }, bootDeps, options);
    }
  }

  /** A pool on `port`, returned only once the database behind it is proven to be ours. */
  private static async openVerified(cfg: DoltClientConfig, port: number, database: string): Promise<DoltClient> {
    const client = new DoltClient({ ...cfg, port, database });
    try {
      await client.verifyFingerprint();
      return client;
    } catch (err) {
      // connect owns this pool until it returns; preserve the verification error.
      await client.close().catch(() => {});
      throw err;
    }
  }

  /**
   * vibesync-9lzk.55.7: the port file can outlive its server. A service
   * restart kills the Dolt server (it lives in the service's cgroup) and
   * leaves `.beads/dolt-server.port` behind, so the port resolves at once and
   * every connection is refused. Start the server once, re-read the port file
   * (the server may come back on another port), and connect again, waiting a
   * bounded time for it to accept. The server is started ONCE; if it still
   * refuses after that, the error says what was tried.
   */
  private static async restartAndConnect(
    cfg: ResolvedConfig,
    dead: { readonly database: string; readonly refusedPort: number },
    bootDeps: DoltBootDeps,
    options: ResolveDoltPortOptions,
  ): Promise<DoltClient> {
    const beadsRoot = resolvedBeadsRoot(cfg);
    const refused = `DoltClient: connection refused on port ${dead.refusedPort} (from ${portFilePath(cfg)})`;
    bootDeps.log?.(
      'warn',
      { port: dead.refusedPort, portPath: portFilePath(cfg), beadsRoot },
      'DoltClient: connection refused on the port from the port file — the Dolt server is down; starting it via `bd dolt start`',
    );
    try {
      await bootDeps.startDoltServer(beadsRoot);
    } catch (err) {
      throw new Error(`${refused} and \`bd dolt start\` in ${beadsRoot} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const outcome = await DoltClient.awaitRestartedServer(cfg, dead.database, bootDeps, options);
    if (outcome instanceof DoltClient) {
      bootDeps.log?.('info', { port: outcome.port, previousPort: dead.refusedPort }, 'DoltClient: Dolt server restarted and verified');
      return outcome;
    }
    throw new Error(
      `${refused}; ran \`bd dolt start\` in ${beadsRoot}, and the server still refuses connections on port ${outcome.lastPort} after ${RESTART_ACCEPT_BUDGET_MS}ms`,
    );
  }

  /**
   * `bd dolt start` returning does not promise the server accepts connections
   * yet. Poll for a bounded time, re-reading the port file each round (the
   * server may come back on another port). Returns the verified client, or
   * the last port tried when the budget runs out; any failure other than a
   * refused connection is thrown as it is.
   */
  private static async awaitRestartedServer(
    cfg: ResolvedConfig,
    database: string,
    bootDeps: DoltBootDeps,
    options: ResolveDoltPortOptions,
  ): Promise<DoltClient | { readonly lastPort: number }> {
    // Never below 50 ms: a zero interval would not advance the budget.
    const pollIntervalMs = Math.max(options.pollIntervalMs ?? 500, 50);
    // ONE budget for the whole wait: every sleep counts, including the ones
    // the port-file wait makes, so a port file that reappears late cannot
    // restart the clock. Time is the injected sleep's, as in resolveDoltPort.
    let spentMs = 0;
    const deps: DoltBootDeps = { ...bootDeps, sleep: async (ms: number) => { spentMs += ms; await bootDeps.sleep(ms); } };
    let lastPort = 0;
    while (spentMs <= RESTART_ACCEPT_BUDGET_MS) {
      lastPort = await resolveDoltPort(cfg, deps, {
        ...options,
        pollIntervalMs,
        timeoutMs: Math.max(RESTART_ACCEPT_BUDGET_MS - spentMs, pollIntervalMs),
        startServerIfMissing: false,
      });
      try {
        return await DoltClient.openVerified(cfg, lastPort, database);
      } catch (err) {
        if (!isConnectionRefused(err)) throw err;
      }
      await deps.sleep(pollIntervalMs);
    }
    return { lastPort };
  }

  constructor(cfg: DoltClientConfig = {}) {
    cfg = snapshotConfig(cfg);
    const database = readDatabase(cfg);
    const port = readPort(cfg);
    this.database = database;
    this.port = port;
    this.beadsRoot = resolvedBeadsRoot(cfg);
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
    const [rows] = await this.pool.execute('SELECT value FROM metadata WHERE `key` = ? LIMIT 1', [
      'repo_id',
    ]);
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
      const [result] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW CREATE TABLE \`${table}\``,
      );
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
    if (!VERIFIED_BD_SCHEMA_FINGERPRINTS.includes(actual)) {
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
       AND parent_dep.depends_on_issue_id = ?
       AND parent_dep.type = 'parent-child'
      WHERE i.issue_type = 'molecule_step'
        AND i.status = 'open'
        AND NOT EXISTS (
          SELECT 1
          FROM dependencies blocks_dep
          JOIN issues blocker
            ON blocker.id = blocks_dep.depends_on_issue_id
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
       AND parent_dep.depends_on_issue_id = ?
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
  async listMoleculeRoots(
    opts: { statuses?: readonly string[]; limit?: number } = {},
  ): Promise<BeadRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const statuses = opts.statuses?.filter((s) => typeof s === 'string' && s.length > 0) ?? [];
    const whereStatus =
      statuses.length > 0 ? `AND i.status IN (${statuses.map(() => '?').join(', ')})` : '';
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

    /**
   * The project's bd `issue_prefix`. bd rejects creating a bead whose id does
   * not start with it, so molecule ids must be minted from this value.
   */
  async readIssuePrefix(): Promise<string> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT value FROM config WHERE `key` = ? LIMIT 1',
      ['issue_prefix'],
    );
    const value = rows[0]?.['value'];
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
      throw new Error(`DoltClient: ${this.database} has no valid issue_prefix in bd config (got ${JSON.stringify(value)})`);
    }
    return value;
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
      `SELECT issue_id, COALESCE(depends_on_issue_id, depends_on_wisp_id, depends_on_external) AS depends_on_id, type
       FROM dependencies WHERE issue_id = ? OR COALESCE(depends_on_issue_id, depends_on_wisp_id, depends_on_external) = ?`,
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
    notes: typeof r['notes'] === 'string' ? r['notes'] : '',
  };
}
