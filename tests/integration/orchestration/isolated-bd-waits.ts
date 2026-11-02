import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createCliRunner, type CommandRunner } from '../../../src/orchestration/scheduler/bd-adapters.js';
import { MIN_BD_VERSION_FOR_WAITS } from '../../../src/orchestration/waits/index.js';

/**
 * Disposable bd repository for the wait tests (vibesync-9g24).
 *
 * Opt-in: set VIBESYNC_TEST_BD_WAITS=/absolute/path/to/bd (>= MIN_BD_VERSION_FOR_WAITS).
 * Separate from isolated-beads.ts on purpose: that helper pins bd 1.2.2 build
 * 7fcf4e16 for the schema-65 fingerprint tests, while waits are verified on 1.3.2.
 *
 * Isolation is the same as isolated-beads.ts: an allowlisted env (no inherited
 * BEADS or BD variables, no Git routing), a fresh temp dir with its own
 * `git init` and HOME, a loopback port reserved for this run, and a uniquely named database. The
 * production .beads / Dolt server are never addressed.
 */
export const RUN_ISOLATED_WAITS = process.env['VIBESYNC_TEST_BD_WAITS'] !== undefined;

export interface IsolatedWaitRepo {
  readonly root: string;
  /** CommandRunner bound to the disposable repo (the same type production injects). */
  readonly runner: CommandRunner;
  create(title: string): Promise<string>;
  close(id: string): Promise<void>;
  status(id: string): Promise<string>;
  readyIds(): Promise<string[]>;
  teardown(): Promise<void>;
}

function atLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export async function provisionIsolatedWaitRepo(): Promise<IsolatedWaitRepo> {
  const binary = process.env['VIBESYNC_TEST_BD_WAITS'];
  if (!binary || !isAbsolute(binary)) throw new Error('VIBESYNC_TEST_BD_WAITS must be an absolute bd binary path');
  const root = mkdtempSync(join(tmpdir(), 'vibesync-waits-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const env: Record<string, string | undefined> = {
    PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Waits test', GIT_AUTHOR_EMAIL: 'waits-test@example.invalid',
    GIT_COMMITTER_NAME: 'Waits test', GIT_COMMITTER_EMAIL: 'waits-test@example.invalid',
    BD_NON_INTERACTIVE: '1', BEADS_DOLT_AUTO_COMMIT: 'off',
  };
  const run = (command: string, args: string[]) => execFileSync(command, args, {
    cwd: root, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const bd = (...args: string[]) => run(binary, ['--sandbox', '--dolt-auto-commit=off', ...args]);

  const version = /(\d+\.\d+\.\d+)/.exec(bd('version'))?.[1] ?? '0.0.0';
  if (!atLeast(version, MIN_BD_VERSION_FOR_WAITS)) {
    throw new Error(`waits need bd >= ${MIN_BD_VERSION_FOR_WAITS}, got ${version}`);
  }
  run('git', ['init', '-q', root]);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((err) => (err ? reject(err) : resolve())));
  const database = `beads_waits_${root.split('-').pop()!.toLowerCase()}`;
  try {
    bd('init', '--server', '--server-host=127.0.0.1', `--server-port=${port}`,
      '--prefix=wt', `--database=${database}`, '--skip-hooks', '--skip-agents', '--non-interactive');
  } catch (err) {
    try { bd('dolt', 'stop'); } catch { /* init may not have reached server startup */ }
    throw err;
  }
  // createCliRunner layers `env` over process.env, so blank every inherited
  // BEADS_*/BD_* (undefined = removed from the child env) and pin the repo.
  const inherited = Object.fromEntries(
    Object.keys(process.env).filter((k) => /^(BEADS_|BD_)/.test(k)).map((k) => [k, undefined]),
  );
  const runner = createCliRunner({
    binary, cwd: root, env: { ...inherited, ...env, BEADS_DIR: join(root, '.beads') },
  });
  const sandboxed: CommandRunner = (args) => runner(['--sandbox', '--dolt-auto-commit=off', ...args]);
  return {
    root,
    runner: sandboxed,
    async create(title) { return (await sandboxed(['create', `--title=${title}`, '--silent'])).trim(); },
    async close(id) { await sandboxed(['close', id, '--reason=test']); },
    async status(id) {
      const out = await sandboxed(['list', '--id', id, '--all', '--limit', '0', '--json']);
      const rows = JSON.parse(out.slice(out.search(/[[{]/))) as Array<{ status: string }>;
      return rows[0]?.status ?? 'absent';
    },
    async readyIds() {
      const out = await sandboxed(['ready', '--json', '--limit', '0']);
      return (JSON.parse(out.slice(out.search(/[[{]/))) as Array<{ id: string }>).map((r) => r.id);
    },
    async teardown() {
      try { bd('dolt', 'stop'); } finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}
