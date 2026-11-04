import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createCliRunner, type CommandRunner } from '../../../src/orchestration/scheduler/bd-adapters.js';

export const RUN_ISOLATED_WAKES = process.env['VIBESYNC_TEST_BD_WAKES'] !== undefined;

export interface IsolatedWakeRepo {
  readonly root: string;
  readonly runner: CommandRunner;
  teardown(): Promise<void>;
}

export async function provisionIsolatedWakeRepo(): Promise<IsolatedWakeRepo> {
  const binary = process.env['VIBESYNC_TEST_BD_WAKES'];
  if (!binary || !isAbsolute(binary)) throw new Error('VIBESYNC_TEST_BD_WAKES must be an absolute bd binary path');
  const root = mkdtempSync(join(tmpdir(), 'vibesync-wake-bd-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Pending wake integration test', GIT_AUTHOR_EMAIL: 'wake-test@example.invalid',
    GIT_COMMITTER_NAME: 'Pending wake integration test', GIT_COMMITTER_EMAIL: 'wake-test@example.invalid',
    BD_NON_INTERACTIVE: '1', BEADS_DOLT_AUTO_COMMIT: 'off',
  };
  const run = (command: string, args: string[]) => execFileSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const bd = (...args: string[]) => run(binary, ['--sandbox', '--dolt-auto-commit=off', ...args]);
  run('git', ['init', '-q', root]);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const database = `beads_wakes_${root.split('-').pop()!.toLowerCase()}`;
  try {
    bd('init', '--server', '--server-host=127.0.0.1', `--server-port=${port}`,
      '--prefix=wake', `--database=${database}`, '--skip-hooks', '--skip-agents', '--non-interactive');
  } catch (error) {
    try { bd('dolt', 'stop'); } catch { /* Init may not have reached server startup. */ }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const inherited = Object.fromEntries(
    Object.keys(process.env).filter((key) => /^(BEADS_|BD_)/.test(key)).map((key) => [key, undefined]),
  );
  const runner = createCliRunner({ binary, cwd: root, env: { ...inherited, ...env, BEADS_DIR: join(root, '.beads') } });
  return {
    root,
    runner: (args) => runner(['--sandbox', '--dolt-auto-commit=off', ...args]),
    async teardown() {
      try { bd('dolt', 'stop'); } finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}
