/**
 * scripts/deploy/deploy.sh: every check that can stop a deploy must be able to
 * fail (vibesync-6zos).
 *
 * The script this replaced lived only in /tmp and gated the engine boot check
 * with
 *
 *   (cd "$R" && ... engine-boot-check.sh ... 2>&1 | tail -1 | cut -c1-160); [ "${PIPESTATUS[0]}" = "0" ] || fail ...
 *
 * Read from outside the ( subshell ), PIPESTATUS is the subshell's own status:
 * the status of `cut`, always 0. The gate could not fail, on any deploy.
 *
 * SANDBOX. This script restarts a production service, so no test may run it
 * against the host. Every invocation here, including the ones that only source
 * its helpers, gets:
 *   - VIBESYNC_REPO_DIR = a throwaway repository with its own `origin`;
 *   - a PATH whose first entry holds stand-ins for systemctl, journalctl, curl,
 *     bd, bun and npm that record the call and do nothing.
 * A first version of this file ran the real script with the real PATH; a
 * mutation that removed the wrong-commit refusal then staged a release and
 * copied the live env file before the test's timeout killed it (2026-11-15).
 * The last test in this file keeps that from coming back.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/deploy/deploy.sh');
const source = readFileSync(SCRIPT, 'utf8');
/** The script's code, without its comment lines. */
const code = source.split('\n').filter((line) => !/^\s*#/.test(line));

const HOST_COMMANDS = ['systemctl', 'journalctl', 'curl', 'bd', 'bun', 'npm'];
let root = '';
let repo = '';
let stubLog = '';
let mainSha = '';

function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // VIBESYNC_DEPLOY_TOOL_PATH: the script puts its tool directories FIRST on PATH; without this the real bun and npm would win.
  return { ...process.env, PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`, VIBESYNC_DEPLOY_TOOL_PATH: join(root, 'bin'), VIBESYNC_REPO_DIR: repo, STUB_LOG: stubLog, VIBESYNC_DEPLOY_LIB: '', ...extra };
}

function sh(script: string, extra: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, env: sandboxEnv(extra) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const withHelpers = (body: string) => sh(`source "${SCRIPT}"; ${body}`, { VIBESYNC_DEPLOY_LIB: '1' });
const deploy = (sha: string) => {
  const result = spawnSync('bash', [SCRIPT, sha], { encoding: 'utf8', timeout: 30_000, env: sandboxEnv() });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const stubCalls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : []);
const worktrees = () => sh(`git -C "${repo}" worktree list | wc -l`).stdout.trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vibesync-deploy-'));
  repo = join(root, 'repo');
  stubLog = join(root, 'stub-calls.log');
  mkdirSync(join(root, 'bin'));
  for (const name of HOST_COMMANDS) {
    const stub = join(root, 'bin', name);
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  const git = 'git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main';
  const made = spawnSync('bash', ['-c', [
    `${git} init -q --bare "${root}/origin.git"`,
    `${git} init -q "${repo}"`,
    `cd "${repo}"`,
    `echo sandbox > README`,
    `${git} add README`,
    `${git} commit -q -m sandbox`,
    `git remote add origin "${root}/origin.git"`,
    `git push -q origin HEAD:main`,
    `git fetch -q origin`,
    `git rev-parse --short origin/main`,
  ].join(' && ')], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`sandbox repository: ${made.stderr}`);
  mainSha = made.stdout.trim();
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('deploy.sh gates', () => {
  it('gate stops the deploy when its command fails, and shows the last line of its output', () => {
    const result = withHelpers('gate "engine boot check" bash -c "echo starting; echo engine did not come up; exit 7"; echo CONTINUED');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('engine did not come up');
    expect(result.stdout).toContain('STOP (nothing swapped): engine boot check failed (exit 7)');
    expect(result.stdout).not.toContain('CONTINUED');
  });

  it('gate lets the deploy continue when its command passes', () => {
    const result = withHelpers('gate "engine boot check" bash -c "echo engine ready"; echo CONTINUED');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('engine ready');
    expect(result.stdout).toContain('CONTINUED');
  });

  it('gate fails on a command that times out or cannot be run', () => {
    expect(withHelpers('gate "slow check" timeout 1 sleep 5; echo CONTINUED').stdout).toContain('slow check failed (exit 124)');
    expect(withHelpers('gate "missing tool" /nonexistent/tool; echo CONTINUED').stdout).not.toContain('CONTINUED');
  });

  it('the shape the old script used cannot fail (why gate exists)', () => {
    // The same failing command, gated the old way: the deploy would have continued.
    const old = sh('(bash -c "echo engine did not come up; exit 7" 2>&1 | tail -1 | cut -c1-160); [ "${PIPESTATUS[0]}" = "0" ] || { echo STOPPED; exit 1; }; echo CONTINUED');
    expect(old.stdout).toContain('CONTINUED');
    expect(old.stdout).not.toContain('STOPPED');
  });

  it('the script reads no pipeline status from outside a subshell, and the engine boot check goes through gate', () => {
    expect(code.filter((line) => line.includes('PIPESTATUS'))).toEqual([]);
    const engineCheck = code.filter((line) => line.includes('engine-boot-check.sh'));
    expect(engineCheck).toHaveLength(1);
    expect(engineCheck[0]).toMatch(/^gate "/);
  });

  it('a subshell whose result is discarded is never used as a step', () => {
    // `( ... )` on a line of its own decides nothing unless `||` or `&&` follows it.
    const discarded = code.filter((line) => /^\(.*\)\s*$/.test(line.trim()));
    expect(discarded).toEqual([]);
  });

  it('run_swap returns the swap script\'s own status, with its last lines shown', () => {
    // A stand-in release tree whose swap.sh fails after printing, as the real one does on a missing file.
    const failing = withHelpers('d=$(mktemp -d); mkdir -p "$d/scripts/deploy"; printf \'echo one; echo "missing $1/.env" >&2; exit 2\\n\' > "$d/scripts/deploy/swap.sh"; run_swap "$d" 3; echo "status=$?"; rm -rf "$d"');
    expect(failing.stdout).toContain('missing ');
    expect(failing.stdout).toContain('status=2');
    const passing = withHelpers('d=$(mktemp -d); mkdir -p "$d/scripts/deploy"; printf \'echo "pid: 1"\\n\' > "$d/scripts/deploy/swap.sh"; run_swap "$d" 3; echo "status=$?"; rm -rf "$d"');
    expect(passing.stdout).toContain('pid: 1');
    expect(passing.stdout).toContain('status=0');
  });

  it('both swaps go through run_swap, and a failed rollback has its own exit status', () => {
    // Lines that EXECUTE swap.sh (a message that names it does not): only run_swap's own line may.
    const executes = code.filter((line) => /(^|[;&|(]\s*)bash\s+\S*swap\.sh/.test(line.trim()));
    expect(executes.map((line) => line.trim())).toEqual(['bash "$dir/scripts/deploy/swap.sh" "$dir" >"$out" 2>&1']);
    expect(code.filter((line) => /\brun_swap "\$(R|LIVE)"/.test(line))).toHaveLength(2);
    expect(code.some((line) => line.trim() === 'exit 3')).toBe(true);
    expect(code.some((line) => line.includes('ROLLBACK FAILED'))).toBe(true);
  });

  it('refuses to deploy a commit that is not origin/main, before asking anything of the service', () => {
    const before = stubCalls().length;
    const result = deploy('0000000');
    expect(result.stdout).toContain(`STOP (nothing swapped): origin/main is ${mainSha}, expected 0000000`);
    expect(result.status).toBe(1);
    // Only the "does systemd answer" probe ran: no restart, no health request, no tracker read, no install.
    expect(stubCalls().slice(before)).toEqual(['systemctl is-system-running']);
    expect(worktrees()).toBe('1');
  });

  it('with the right commit but an engine that is not ready, stops before staging a release', () => {
    const before = stubCalls().length;
    const result = deploy(mainSha); // the stand-in curl answers nothing, so the engine reads as not ready
    expect(result.stdout).toContain('STOP (nothing swapped): the engine is not ready BEFORE the swap');
    expect(result.status).toBe(1);
    const calls = stubCalls().slice(before);
    expect(calls.some((call) => call.startsWith('curl '))).toBe(true);
    expect(calls.filter((call) => /restart|daemon-reload|install/.test(call))).toEqual([]);
    expect(worktrees()).toBe('1');
  });

  it('inside the sandbox every host command the script can call is a stand-in', () => {
    const result = withHelpers(`for c in ${HOST_COMMANDS.join(' ')}; do command -v "$c"; done`);
    expect(result.stdout.trim().split('\n')).toEqual(HOST_COMMANDS.map((name) => join(root, 'bin', name)));
  });

  it('sourcing the helpers deploys nothing', () => {
    const before = stubCalls().length;
    const result = withHelpers('echo SOURCED');
    expect(result.stdout.trim()).toBe('SOURCED');
    expect(stubCalls().slice(before)).toEqual([]);
  });

  it('never prints a value from an env file', () => {
    // Env files hold credentials: the script may copy them and compare key names, not echo or cat them.
    const prints = code.filter((line) => /\b(cat|echo|printf|tail|head)\b[^|]*\.env\b/.test(line) && !/grep -[a-zA-Z]*[qcE]/.test(line));
    expect(prints).toEqual([]);
  });

  it('no test runs a deploy script outside this sandbox', () => {
    // Guard for the 2026-11-15 incident. Any test file that names scripts/deploy/*.sh must be this one,
    // and this one must hand every invocation the sandbox environment.
    const testsDir = resolve('tests');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
    const naming = files(testsDir)
      .filter((path) => /\.(ts|js|mjs|sh)$/.test(path) && /scripts\/deploy\/[\w-]+\.sh/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(testsDir, path));
    expect(naming).toEqual(['unit/deploy-script.test.ts']);
    const self = readFileSync(resolve('tests/unit/deploy-script.test.ts'), 'utf8');
    const spawns = self.split('\n').filter((line) => /spawnSync\('bash'/.test(line) && !line.includes('const made = '));
    expect(spawns.length).toBeGreaterThan(0);
    for (const line of spawns) expect(line, line.trim()).toContain('env: sandboxEnv(');
    for (const name of HOST_COMMANDS) expect(existsSync(join(root, 'bin', name)), name).toBe(true);
    // Every host command the script names has a stand-in: a new one must be added to HOST_COMMANDS.
    // Not preceded by "." or "-": `vibesync.service` is a unit name, not the `service` command.
    const named = new Set(code.join('\n').match(/(?<![.\w-])(systemctl|journalctl|curl|bd|bun|npm|docker|ssh|scp|rsync|sudo|kill|pkill|service)(?![\w-])/g) ?? []);
    expect([...named].filter((name) => !HOST_COMMANDS.includes(name))).toEqual([]);
  });
});
