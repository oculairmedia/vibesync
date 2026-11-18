/**
 * scripts/deploy/deploy.sh: every check that can stop a deploy must be able to
 * fail, and what it reports after a swap must be true (vibesync-6zos).
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
 * against the host. Every invocation here gets:
 *   - VIBESYNC_REPO_DIR = a throwaway repository with its own `origin`, whose
 *     committed swap.sh, boot-check.sh and engine-boot-check.sh are stand-ins;
 *   - a PATH whose first entry holds stand-ins for systemctl, journalctl, curl,
 *     bd, bun and npm, and VIBESYNC_BD pointing at a stand-in of its own;
 *   - a "service": a `sleep` process whose working directory is the release it
 *     "runs from", which is how the script tells which release is serving.
 * A first version of this file ran the real script with the real PATH; a
 * mutation that removed the wrong-commit refusal then staged a release and
 * copied the live env file before the test's timeout killed it (2026-11-15).
 * The last test in this file keeps that from coming back.
 *
 * The full-run tests exist because of review on PR #186: checks that only read
 * the script's text passed while a failed fetch deployed a stale commit, the
 * quiet check used a different bd from the one configured, and a release that
 * was not serving was reported as deployed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/deploy/deploy.sh');
const source = readFileSync(SCRIPT, 'utf8');
/** The script's code, without its comment lines. */
const code = source.split('\n').filter((line) => !/^\s*#/.test(line));

const HOST_COMMANDS = ['systemctl', 'journalctl', 'curl', 'bd', 'bun', 'npm'];
/** What each PATH stand-in does after recording its call. */
const STUB_BODIES: Record<string, string> = {
  systemctl: 'case "$*" in *"-p MainPID"*) cat "$SANDBOX_STATE/mainpid" 2>/dev/null;; *"-p WorkingDirectory"*) cat "$SANDBOX_STATE/loaded-release" 2>/dev/null;; esac',
  journalctl: '',
  curl: '[ "$(cat "$SANDBOX_STATE/ready" 2>/dev/null)" = "1" ] && printf \'{"status":"healthy","orchestration":{"ready":true}}\'',
  // The bd on PATH says the engine is busy: a quiet check that used it instead of the configured bd would stop the deploy.
  bd: 'echo \'[{"id":"from-the-bd-on-PATH"}]\'',
  bun: 'if [ "$1" = "-e" ]; then echo "config ok"; elif [ "$1" = "scripts/roles/check-role-agents.ts" ]; then if [ -e "$SANDBOX_STATE/roles-fail" ]; then echo "role drift"; exit 1; fi; echo "roles ok"; fi',
  npm: '',
};
const ENV_SECRET = 'do-not-print-me-7f3a';

/** Stand-in for scripts/deploy/swap.sh, committed in the sandbox repository: "restarts the service" into a release tree. */
const SWAP_STAND_IN = `#!/bin/bash
dir=$(realpath "$1"); name=$(basename "$dir")
echo "swap $name" >> "$STUB_LOG"
if grep -qxF "$name" "$SANDBOX_STATE/swap-fails-for" 2>/dev/null; then echo "missing $dir/.env" >&2; exit 2; fi
# The real swap.sh, in its order: write the drop-in on disk; daemon-reload (systemd loads it); restart.
echo "WorkingDirectory=$dir" > "$SANDBOX_STATE/release.conf"
if grep -qxF "$name" "$SANDBOX_STATE/swap-fails-before-reload-for" 2>/dev/null; then echo "Failed to reload daemon" >&2; exit 1; fi
printf '%s' "$dir" > "$SANDBOX_STATE/loaded-release"
if grep -qxF "$name" "$SANDBOX_STATE/swap-fails-after-config-for" 2>/dev/null; then echo "Failed to restart vibesync.service" >&2; exit 1; fi
# Reports success but restarts nothing; whatever is serving reports ready by now.
if grep -qxF "$name" "$SANDBOX_STATE/swap-changes-nothing-for" 2>/dev/null; then echo 1 > "$SANDBOX_STATE/ready"; echo "pid:      unchanged"; exit 0; fi
old=$(cat "$SANDBOX_STATE/mainpid" 2>/dev/null)
[ -n "$old" ] && kill "$old" 2>/dev/null
( cd "$dir" && exec sleep 300 ) >/dev/null 2>&1 &
pid=$!
for i in $(seq 1 100); do [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$dir" ] && break; sleep 0.02; done
echo "$pid" > "$SANDBOX_STATE/mainpid"; echo "$pid" >> "$SANDBOX_STATE/pids"
if grep -qxF "$name" "$SANDBOX_STATE/comes-up-not-ready" 2>/dev/null; then echo 0 > "$SANDBOX_STATE/ready"; else echo 1 > "$SANDBOX_STATE/ready"; fi
[ -n "\${SANDBOX_AFTER_SWAP:-}" ] && [ "$name" != "$(basename "$(cat "$SANDBOX_STATE/live-dir")")" ] && eval "$SANDBOX_AFTER_SWAP"
echo "pid:      $pid"
`;
/** Stand-in for scripts/ci/boot-check.sh. With the flag set, the service restarts by itself on the LIVE release meanwhile. */
const BOOT_CHECK_STAND_IN = `#!/bin/bash
echo "boot-check $(basename "$PWD")" >> "$STUB_LOG"
# A run starts while the release is being staged.
if [ -e "$SANDBOX_STATE/busy-during-staging" ]; then cp "$SANDBOX_STATE/busy-during-staging" "$SANDBOX_STATE/busy-on"; fi
if [ -e "$SANDBOX_STATE/restart-during-staging" ]; then
  rm -f "$SANDBOX_STATE/restart-during-staging"
  live=$(cat "$SANDBOX_STATE/live-dir"); old=$(cat "$SANDBOX_STATE/mainpid" 2>/dev/null)
  [ -n "$old" ] && kill "$old" 2>/dev/null
  ( cd "$live" && exec sleep 300 ) >/dev/null 2>&1 &
  pid=$!
  for i in $(seq 1 100); do [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$live" ] && break; sleep 0.02; done
  echo "$pid" > "$SANDBOX_STATE/mainpid"; echo "$pid" >> "$SANDBOX_STATE/pids"
fi
exit 0
`;
const ENGINE_BOOT_CHECK_STAND_IN = `#!/bin/bash
echo "engine-boot-check bd=$1" >> "$STUB_LOG"
if [ -e "$SANDBOX_STATE/engine-boot-fails" ]; then echo "engine did not come up"; exit 7; fi
echo "engine boot ok"
`;

let root = '';
let repo = '';
let state = '';
let stubLog = '';
let liveSha = '';
let mainSha = '';
let liveDir = '';
let stagedDir = '';
let originUrl = '';
const started: number[] = [];

function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
    // The script puts its tool directories FIRST on PATH; without this the real bun and npm would win.
    VIBESYNC_DEPLOY_TOOL_PATH: join(root, 'bin'),
    VIBESYNC_REPO_DIR: repo,
    // Its default is the host's real bd.
    VIBESYNC_BD: join(root, 'configured', 'bd'),
    // Its default is the host's real systemd drop-in.
    VIBESYNC_UNIT_DROPIN: join(state, 'release.conf'),
    VIBESYNC_DEPLOY_READY_TRIES: '5',
    VIBESYNC_DEPLOY_READY_PAUSE: '0.1',
    SANDBOX_STATE: state,
    STUB_LOG: stubLog,
    VIBESYNC_DEPLOY_LIB: '',
    ...extra,
  };
}

function sh(script: string, extra: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, env: sandboxEnv(extra) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const withHelpers = (body: string) => sh(`source "${SCRIPT}"; ${body}`, { VIBESYNC_DEPLOY_LIB: '1' });
const deploy = (sha: string, extra: Record<string, string> = {}) => {
  const result = spawnSync('bash', [SCRIPT, sha], { encoding: 'utf8', timeout: 60_000, env: sandboxEnv(extra) });
  if (`${result.stdout}${result.stderr}`.includes(ENV_SECRET)) throw new Error('deploy.sh printed a value from the env file');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const stubCalls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : []);
const worktrees = () => sh(`git -C "${repo}" worktree list | wc -l`).stdout.trim();
const flag = (name: string, lines: readonly string[] = ['1']) => writeFileSync(join(state, name), `${lines.join('\n')}\n`);
const mainPid = () => Number(readFileSync(join(state, 'mainpid'), 'utf8').trim());
/** The release tree the "service" is running from. */
const servingDir = () => readlinkSync(`/proc/${mainPid()}/cwd`);
/** The release in systemd's LOADED configuration (what `systemctl show` reports). */
const configuredDir = () => readFileSync(join(state, 'loaded-release'), 'utf8');
/** The release the drop-in file ON DISK names (what the next daemon-reload or reboot follows). */
const diskDir = () => readFileSync(join(state, 'release.conf'), 'utf8').replace('WorkingDirectory=', '').trim();

function stop(pid: number): void {
  try { process.kill(pid); } catch { /* already gone */ }
}

/** Start the "service" on a release: a process whose working directory is that release tree. */
function serveFrom(dir: string): void {
  const child = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  started.push(child.pid!);
  writeFileSync(join(state, 'mainpid'), String(child.pid));
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vibesync-deploy-')));
  repo = join(root, 'repo');
  state = join(root, 'state');
  stubLog = join(root, 'stub-calls.log');
  originUrl = join(root, 'origin.git');
  for (const dir of [join(root, 'bin'), join(root, 'configured'), state, join(repo, 'scripts/deploy'), join(repo, 'scripts/ci')]) mkdirSync(dir, { recursive: true });
  for (const name of HOST_COMMANDS) {
    const stub = join(root, 'bin', name);
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${STUB_BODIES[name]}\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  // The bd the deploy is CONFIGURED to use: the engine is quiet.
  writeFileSync(join(root, 'configured', 'bd'), [
    '#!/bin/sh',
    'echo "configured-bd $*" >> "$STUB_LOG"',
    // "busy-on" names the kind of read that finds something (a label, or a bead type); empty = the engine is quiet.
    'busy=$(cat "$SANDBOX_STATE/busy-on" 2>/dev/null)',
    'case "$*" in *"$busy"*) [ -n "$busy" ] && { echo \'[{"id":"sandbox-busy"}]\'; exit 0; };; esac',
    "echo '[]'",
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(root, 'configured', 'bd'), 0o755);
  for (const [path, body] of [['scripts/deploy/swap.sh', SWAP_STAND_IN], ['scripts/ci/boot-check.sh', BOOT_CHECK_STAND_IN], ['scripts/ci/engine-boot-check.sh', ENGINE_BOOT_CHECK_STAND_IN]] as const) {
    writeFileSync(join(repo, path), body);
    chmodSync(join(repo, path), 0o755);
  }
  writeFileSync(join(repo, '.gitignore'), '.env\n.letta/\nnode_modules/\n');
  writeFileSync(join(repo, 'README'), 'the live release\n');
  const git = 'git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main';
  const made = spawnSync('bash', ['-c', [
    `${git} init -q --bare "${originUrl}"`,
    `${git} init -q "${repo}"`,
    `cd "${repo}"`,
    `${git} add -A`,
    `${git} commit -q -m "the live release"`,
    `git rev-parse --short HEAD`,
    `echo "the next release" > README`,
    `${git} add README`,
    `${git} commit -q -m "the next release"`,
    `git remote add origin "${originUrl}"`,
    `git push -q origin HEAD:main`,
    `git fetch -q origin`,
    `git worktree add -q --detach ".letta/worktrees/stage-$(git rev-parse --short HEAD~1)" HEAD~1`,
    `git rev-parse --short origin/main`,
  ].join(' && ')], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`sandbox repository: ${made.stderr}`);
  [liveSha, mainSha] = made.stdout.trim().split('\n') as [string, string];
  liveDir = join(repo, '.letta/worktrees', `stage-${liveSha}`);
  stagedDir = join(repo, '.letta/worktrees', `stage-${mainSha}`);
  writeFileSync(join(state, 'live-dir'), liveDir);
});

/** Every test starts with the service on the live release, ready, and no fault planted. */
beforeEach(() => {
  for (const name of ['swap-fails-for', 'swap-fails-before-reload-for', 'swap-fails-after-config-for', 'swap-changes-nothing-for', 'comes-up-not-ready', 'restart-during-staging', 'engine-boot-fails', 'roles-fail', 'busy-on', 'busy-during-staging']) rmSync(join(state, name), { force: true });
  if (existsSync(join(state, 'mainpid'))) stop(mainPid());
  serveFrom(liveDir);
  writeFileSync(join(state, 'loaded-release'), liveDir);
  writeFileSync(join(state, 'release.conf'), `WorkingDirectory=${liveDir}\n`);
  flag('ready');
  writeFileSync(join(liveDir, '.env'), `VIBESYNC_PM_WAKE_STATE_PATH=${join(root, 'pm-wake-state.json')}\nSANDBOX_SECRET=${ENV_SECRET}\n`);
  const reset = sh(`git -C "${repo}" remote set-url origin "${originUrl}"`);
  if (reset.status !== 0) throw new Error(`sandbox reset: ${reset.stderr}`);
});

afterAll(() => {
  const fromSwaps = existsSync(join(state, 'pids')) ? readFileSync(join(state, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) : [];
  for (const pid of [...started, ...fromSwaps]) stop(pid);
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

  it('only run_swap executes swap.sh', () => {
    // Lines that EXECUTE swap.sh (a message that names it does not).
    const executes = code.filter((line) => /(^|[;&|(]\s*)bash\s+\S*swap\.sh/.test(line.trim()));
    expect(executes.map((line) => line.trim())).toEqual(['bash "$dir/scripts/deploy/swap.sh" "$dir" >"$out" 2>&1']);
  });

  it('serving, loaded and on_disk each report their own record of the release', () => {
    expect(withHelpers('serving').stdout.trim()).toBe(liveDir);
    expect(withHelpers('loaded').stdout.trim()).toBe(liveDir);
    expect(withHelpers('on_disk').stdout.trim()).toBe(liveDir);
    expect(withHelpers(`on_release "${liveDir}" && echo YES || echo NO`).stdout.trim()).toBe('YES');
    // Only the file on disk changes: systemd's loaded configuration and the running process do not.
    writeFileSync(join(state, 'release.conf'), `[Service]\nWorkingDirectory=${stagedDir}\n`);
    expect(withHelpers('on_disk').stdout.trim()).toBe(stagedDir);
    expect(withHelpers('loaded').stdout.trim()).toBe(liveDir);
    expect(withHelpers(`on_release "${liveDir}" && echo YES || echo NO`).stdout.trim()).toBe('NO');
    // Only the loaded configuration changes.
    writeFileSync(join(state, 'release.conf'), `WorkingDirectory=${liveDir}\n`);
    writeFileSync(join(state, 'loaded-release'), stagedDir);
    expect(withHelpers(`on_release "${liveDir}" && echo YES || echo NO`).stdout.trim()).toBe('NO');
    // systemd takes the LAST assignment when a drop-in sets WorkingDirectory more than once.
    writeFileSync(join(state, 'release.conf'), `[Service]\nWorkingDirectory=${stagedDir}\nWorkingDirectory=${liveDir}\n`);
    expect(withHelpers('on_disk').stdout.trim()).toBe(liveDir);
    // A drop-in that cannot be read is not "configured".
    rmSync(join(state, 'release.conf'));
    writeFileSync(join(state, 'loaded-release'), liveDir);
    expect(withHelpers('on_disk').stdout.trim()).toBe('');
    expect(withHelpers(`on_release "${liveDir}" && echo YES || echo NO`).stdout.trim()).toBe('NO');
  });
});

describe('deploy.sh stops before the swap', () => {
  it('refuses to deploy a commit that is not origin/main, before asking anything of the service', () => {
    const before = stubCalls().length;
    const trees = worktrees();
    const result = deploy('0000000');
    expect(result.stdout).toContain(`STOP (nothing swapped): origin/main is ${mainSha}, expected 0000000`);
    expect(result.status).toBe(1);
    // Only the "does systemd answer" probe ran: no restart, no health request, no tracker read, no install.
    expect(stubCalls().slice(before)).toEqual(['systemctl is-system-running']);
    expect(worktrees()).toBe(trees);
  });

  it('stops when the fetch fails: the origin/main in this checkout may no longer be origin/main', () => {
    // The cached ref still says mainSha, so without the check the right-looking argument would deploy a stale commit.
    expect(sh(`git -C "${repo}" remote set-url origin "${join(root, 'gone.git')}"`).status).toBe(0);
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.stdout).toContain('STOP (nothing swapped): git fetch origin failed');
    expect(result.status).toBe(1);
    expect(stubCalls().slice(before)).toEqual(['systemctl is-system-running']);
    expect(servingDir()).toBe(liveDir);
  });

  it('with the right commit but an engine that is not ready, stops before staging a release', () => {
    flag('ready', ['0']);
    const before = stubCalls().length;
    const trees = worktrees();
    const result = deploy(mainSha);
    expect(result.stdout).toContain('STOP (nothing swapped): the engine is not ready BEFORE the swap');
    expect(result.status).toBe(1);
    const calls = stubCalls().slice(before);
    expect(calls.some((call) => call.startsWith('curl '))).toBe(true);
    expect(calls.filter((call) => /restart|daemon-reload|install|^swap /.test(call))).toEqual([]);
    expect(worktrees()).toBe(trees);
  });

  it.each([
    ['an open run', 'molecule_root'],
    ['a running step', 'molecule_step'],
    ['an open scheduler context', 'vibesync:sling-context'],
    ['a bead queued for the scheduler', 'scheduler:eligible'],
  ])('stops before staging when the engine is not quiet: %s', (_what, read) => {
    flag('busy-on', [read]);
    const before = stubCalls().length;
    const trees = worktrees();
    const result = deploy(mainSha);
    expect(result.stdout).toContain('STOP (nothing swapped): engine not quiet');
    expect(result.status).toBe(1);
    const calls = stubCalls().slice(before);
    expect(calls.filter((call) => /^swap |^boot-check |install/.test(call))).toEqual([]);
    expect(worktrees()).toBe(trees);
    expect(servingDir()).toBe(liveDir);
  });

  it('stops just before the swap when a run started while the release was being staged', () => {
    // Staging takes a minute or two on the real host; the engine was quiet when it began.
    flag('busy-during-staging', ['molecule_root']);
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.stdout).toContain('STOP (nothing swapped): engine no longer quiet: 1/0/0/0');
    expect(result.status).toBe(1);
    const calls = stubCalls().slice(before);
    expect(calls.some((call) => call.startsWith('engine-boot-check '))).toBe(true); // it got all the way to the swap
    expect(calls.filter((call) => call.startsWith('swap '))).toEqual([]);
    expect(servingDir()).toBe(liveDir);
  });

  it('stops when the live env does not pin the PM wake state outside the release tree', () => {
    writeFileSync(join(liveDir, '.env'), `SANDBOX_SECRET=${ENV_SECRET}\n`);
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.stdout).toContain('STOP (nothing swapped): the release .env does not pin VIBESYNC_PM_WAKE_STATE_PATH');
    expect(result.status).toBe(1);
    expect(stubCalls().slice(before).filter((call) => call.startsWith('swap '))).toEqual([]);
    expect(servingDir()).toBe(liveDir);
  });

  it('stops before swap when the role persona check fails', () => {
    flag('roles-fail');
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STOP (nothing swapped): role persona check failed (exit 1)');
    expect(stubCalls().slice(before).filter((call) => call.startsWith('swap '))).toEqual([]);
    expect(servingDir()).toBe(liveDir);
  });

  it('stops when the engine boot check fails in the staged tree', () => {
    flag('engine-boot-fails');
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.stdout).toContain('engine did not come up');
    expect(result.stdout).toContain('STOP (nothing swapped): engine boot check (orchestration on, Dolt stopped) failed (exit 7)');
    expect(result.status).toBe(1);
    expect(stubCalls().slice(before).filter((call) => call.startsWith('swap '))).toEqual([]);
    expect(servingDir()).toBe(liveDir);
  });
});

describe('deploy.sh after the swap', () => {
  it('deploys: the staged release is serving and ready, and every tracker read used the configured bd', () => {
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.stdout).toContain(`DEPLOYED stage-${mainSha}`);
    expect(result.status).toBe(0);
    expect(servingDir()).toBe(stagedDir);
    expect(configuredDir()).toBe(stagedDir);
    expect(diskDir()).toBe(stagedDir);
    const calls = stubCalls().slice(before);
    expect(calls.filter((call) => call.startsWith('swap '))).toEqual([`swap stage-${mainSha}`]);
    // Two quiet checks of four reads each, all with the configured bd; the bd on PATH (which says "busy") was never asked.
    expect(calls.filter((call) => call.startsWith('configured-bd list '))).toHaveLength(8);
    expect(calls.filter((call) => call.startsWith('bd '))).toEqual([]);
    expect(calls).toContain(`engine-boot-check bd=${join(root, 'configured', 'bd')}`);
  });

  it('rolls back when the staged release comes up not ready: exit 2, and the previous release is serving', () => {
    flag('comes-up-not-ready', [`stage-${mainSha}`]);
    const before = stubCalls().length;
    const result = deploy(mainSha);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(result.stdout).toContain('previous release serving, configured and ready: yes');
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir()).toBe(liveDir);
    expect(diskDir()).toBe(liveDir);
    expect(stubCalls().slice(before).filter((call) => call.startsWith('swap '))).toEqual([`swap stage-${mainSha}`, `swap stage-${liveSha}`]);
  });

  it('a rollback whose swap fails is exit 3, not 2: the staged release is still what is serving', () => {
    flag('comes-up-not-ready', [`stage-${mainSha}`]);
    flag('swap-fails-for', [`stage-${liveSha}`]);
    const result = deploy(mainSha);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('ROLLBACK FAILED (swap.sh ok: NO');
    expect(result.stdout).toContain(`Run: bash ${liveDir}/scripts/deploy/swap.sh ${liveDir}`);
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(servingDir()).toBe(stagedDir);
  });

  it('a rollback that leaves the previous release serving but not ready is exit 3, not 2', () => {
    flag('comes-up-not-ready', [`stage-${mainSha}`, `stage-${liveSha}`]);
    const result = deploy(mainSha);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('ROLLBACK FAILED (swap.sh ok: yes');
    expect(result.stdout).toContain('previous release serving, configured and ready: NO');
    expect(servingDir()).toBe(liveDir);
  });

  it('a rollback swap that reports success but changes nothing is exit 3: a ready answer from the staged release is not a rollback', () => {
    // The staged release was slow, not dead: it reports ready by the time the rollback is checked.
    flag('comes-up-not-ready', [`stage-${mainSha}`]);
    flag('swap-changes-nothing-for', [`stage-${liveSha}`]);
    const result = deploy(mainSha);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('ROLLBACK FAILED (swap.sh ok: yes');
    expect(result.stdout).toContain(`serving: stage-${mainSha}`);
    expect(servingDir()).toBe(stagedDir);
  });

  it('exit 3, not 2, when the old release is still serving but systemd is left configured for the staged one', () => {
    // Review on PR #186. The deploy swap writes the drop-in and then fails to restart: the old process keeps
    // running. The rollback swap then fails before writing its own drop-in. The running process looks like a
    // clean rollback, but the next restart of the service, for any reason, would start the staged release.
    flag('swap-fails-after-config-for', [`stage-${mainSha}`]);
    flag('swap-fails-for', [`stage-${liveSha}`]);
    const pidBefore = mainPid();
    const result = deploy(mainSha);
    expect(mainPid(), 'the old process was never restarted').toBe(pidBefore);
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir(), 'systemd has the staged release loaded').toBe(stagedDir);
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`systemd loaded: stage-${mainSha}`);
    expect(result.stdout).toContain(`Run: bash ${liveDir}/scripts/deploy/swap.sh ${liveDir}`);
  });

  it('exit 3, not 2, when only the drop-in ON DISK is left naming the staged release', () => {
    // Review on PR #186, third round. The deploy swap writes the drop-in and fails BEFORE daemon-reload: systemd
    // still has the previous release loaded, so `systemctl show` looks right. The rollback swap then fails before
    // rewriting the file. Old process, old loaded configuration, ready: but the next reload or reboot follows the file.
    flag('swap-fails-before-reload-for', [`stage-${mainSha}`]);
    flag('swap-fails-for', [`stage-${liveSha}`]);
    const pidBefore = mainPid();
    const result = deploy(mainSha);
    expect(mainPid(), 'the old process was never restarted').toBe(pidBefore);
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir(), 'systemd still has the previous release loaded').toBe(liveDir);
    expect(diskDir(), 'the file on disk names the staged release').toBe(stagedDir);
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`systemd loaded: stage-${liveSha}; drop-in on disk: stage-${mainSha}`);
  });

  it('exit 2 when the deploy swap failed before daemon-reload and the rollback rewrote the drop-in', () => {
    flag('swap-fails-before-reload-for', [`stage-${mainSha}`]);
    const result = deploy(mainSha);
    expect(result.stdout).toContain('SWAP FAILED');
    expect(result.status).toBe(2);
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir()).toBe(liveDir);
    expect(diskDir()).toBe(liveDir);
  });

  it('does not report a deploy when the staged release is serving, loaded and ready but the drop-in on disk names another release', () => {
    // Something rewrote the file after the swap: this release would not survive a reload or a reboot.
    const result = deploy(mainSha, { SANDBOX_AFTER_SWAP: `echo "WorkingDirectory=${liveDir}" > "${join(state, 'release.conf')}"` });
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(result.status).toBe(2);
    expect(diskDir()).toBe(liveDir);
  });

  it('exit 2 when the deploy swap failed after writing the drop-in and the rollback put it back', () => {
    // The same first failure, but the rollback swap works: systemd is configured for the previous release again.
    flag('swap-fails-after-config-for', [`stage-${mainSha}`]);
    const result = deploy(mainSha);
    expect(result.stdout).toContain('SWAP FAILED');
    expect(result.status).toBe(2);
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir()).toBe(liveDir);
  });

  it('does not report a deploy when the staged release is serving and ready but systemd is configured for another release', () => {
    // After the swap something else rewrote the drop-in (a second deploy, a hand edit): this release would not survive a restart.
    // The stand-in swap runs this hook right after it has restarted the service into the staged release.
    const result = deploy(mainSha, { SANDBOX_AFTER_SWAP: `printf '%s' "${liveDir}" > "${join(state, 'loaded-release')}"` });
    expect(result.stdout).not.toContain('DEPLOYED');
    // The rollback then restores both: the previous release serves and is the configured one.
    expect(result.status).toBe(2);
    expect(servingDir()).toBe(liveDir);
    expect(configuredDir()).toBe(liveDir);
  });

  it('does not report a deploy when the swap failed and the PREVIOUS release restarted by itself', () => {
    // A new PID and a ready answer, but from the old release: the service restarted during staging and the swap changed nothing.
    flag('restart-during-staging');
    flag('swap-fails-for', [`stage-${mainSha}`]);
    const pidBefore = mainPid();
    const result = deploy(mainSha);
    expect(mainPid(), 'the service did restart').not.toBe(pidBefore);
    expect(result.stdout).toContain('SWAP FAILED');
    expect(result.stdout).not.toContain('DEPLOYED');
    expect(result.status).toBe(2);
    expect(servingDir()).toBe(liveDir);
  });
});

describe('deploy.sh sandbox', () => {
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
    // (Every full run above also fails if the sandbox env's secret appears in its output.)
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
    // Every setting whose default is a path on the host is overridden in the sandbox.
    const hostDefaults = [...source.matchAll(/\$\{(VIBESYNC_[A-Z_]+):-\//g)].map((match) => match[1]!);
    expect(hostDefaults.sort()).toEqual(['VIBESYNC_BD', 'VIBESYNC_DEPLOY_TOOL_PATH', 'VIBESYNC_REPO_DIR', 'VIBESYNC_UNIT_DROPIN']);
    const env = sandboxEnv();
    for (const name of hostDefaults) expect(String(env[name]).startsWith(root), `${name} must point into the sandbox`).toBe(true);
  });
});
