import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';

import { DoltClient } from '../../../src/orchestration/store/dolt-client.js';

// Opt-in only: never discover a store from cwd or accept a caller-owned database.
export const RUN_ISOLATED_BEADS = process.env['VIBESYNC_TEST_BD'] !== undefined;
export const TEST_BD_COMMIT = '7fcf4e1634bf1c18757d8f8c16a36fb2b14f7912';
export const SCHEMA65_FINGERPRINT =
  '55cf69b481e3086b0e8bd8b139c4dbfa598cdbdbe58d521ef791b0c72787efc5';

export const FRESH65_FINGERPRINT =
  '40ad3e43c4aaef185ab2a1f414237f26aaa861aba24fef9f8eaaf4c7b4548c64';
export type SchemaShape = 'fresh' | 'live';

export async function provisionIsolatedBeads(shape: SchemaShape = 'fresh') {
  const binary = process.env['VIBESYNC_TEST_BD'];
  if (!binary || !isAbsolute(binary)) throw new Error('VIBESYNC_TEST_BD must be an absolute pinned bd binary path');
  const root = mkdtempSync(join(tmpdir(), 'vibesync-schema65-'));
  const home = join(root, 'home');
  mkdirSync(home);
  // Allowlist, not a spread: no inherited BEADS_*, BD_*, Git routing, credentials,
  // or XDG configuration can redirect provisioning or CLI reads to production.
  const env = {
    PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Schema compatibility test', GIT_AUTHOR_EMAIL: 'schema-test@example.invalid',
    GIT_COMMITTER_NAME: 'Schema compatibility test', GIT_COMMITTER_EMAIL: 'schema-test@example.invalid',
    BD_NON_INTERACTIVE: '1', BEADS_DOLT_AUTO_COMMIT: 'off',
  };
  const run = (command: string, args: string[]) => execFileSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const bd = (...args: string[]) => run(binary, ['--sandbox', '--dolt-auto-commit=off', ...args]);
  const version = bd('version');
  if (!version.includes('1.2.2') || !version.includes(TEST_BD_COMMIT.slice(0, 12))) {
    throw new Error(`Expected bd 1.2.2 build ${TEST_BD_COMMIT}, got ${version}`);
  }
  run('git', ['init', root]);
  // Reserve an unused loopback port, then pass it explicitly to bd. Never use
  // the default server port or a .beads directory inherited from the checkout.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(err => err ? reject(err) : resolve()));
  const database = `beads_schema65_${root.split('-').pop()!.toLowerCase()}`;
  let client: DoltClient | undefined;
  try {
    bd('init', '--server', '--server-host=127.0.0.1', `--server-port=${port}`,
      '--prefix=schema65', `--database=${database}`, '--skip-hooks', '--skip-agents', '--non-interactive');
    process.stdout.write(`Isolated Beads: ${root}, 127.0.0.1:${port}/${database}, ${version}, pin ${TEST_BD_COMMIT}\n`);
    // READONLY live SHOW CREATE TABLE reconciliation: identical definitions,
    // constraints and indexes; only issues column order differs from fresh init.
    // Reproduce that exact order via bd DDL in this disposable database only.
    if (shape === 'live') {
      for (const ddl of [
        "MODIFY COLUMN no_history tinyint(1) DEFAULT '0' AFTER ephemeral",
        'MODIFY COLUMN due_at datetime AFTER waiters',
        'MODIFY COLUMN defer_until datetime AFTER due_at',
        'MODIFY COLUMN started_at datetime AFTER defer_until',
        "MODIFY COLUMN is_blocked tinyint(1) NOT NULL DEFAULT '0' AFTER started_at",
      ]) bd('sql', `ALTER TABLE issues ${ddl}`);
    }
    client = new DoltClient({ beadsRoot: root, host: '127.0.0.1', port, database });
    await client.verifyFingerprint();
    return {
      client, root, port, database, bd,
      async close() {
        try { await client!.close(); } finally { bd('dolt', 'stop'); }
        // Keep the disposable directory for diagnostics; never edit .beads files.
      },
    };
  } catch (error) {
    await client?.close();
    try { bd('dolt', 'stop'); } catch { /* Init may not have reached server startup. */ }
    throw error;
  }
}
