#!/usr/bin/env bun
/**
 * bd-preflight — per-project Beads/Dolt health check.
 *
 * Run this BEFORE claiming work in any Beads-backed project so common
 * failure modes (missing .beads dir, deprecated metadata shape, stale
 * dolt server, root-owned state, container missing bd binary, no
 * remote configured) surface as a single readable report instead of
 * stack traces mid-command.
 *
 * Acceptance for vibesync-1sb: this tool reports per-project
 * .beads exists, metadata shape, deprecated dolt_server_port absent,
 * `bd list --json` works, `bd dolt status` healthy when backend=dolt,
 * local ownership writable by runtime user, container has bd + dolt
 * binaries, and remote push/pull status is explicit.
 *
 * Usage:
 *   bun scripts/preflight/bd-preflight.ts                 # current dir
 *   bun scripts/preflight/bd-preflight.ts /path/to/proj   # explicit path
 *   bun scripts/preflight/bd-preflight.ts --json /path    # JSON output
 *
 * Exit code 0 = all clean; 1 = warnings; 2 = errors.
 */

import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface CheckResult {
  readonly name: string;
  readonly level: 'ok' | 'warn' | 'error' | 'skip';
  readonly detail: string;
}

export interface Report {
  readonly project: string;
  readonly checks: readonly CheckResult[];
  readonly summary: { readonly ok: number; readonly warn: number; readonly error: number; readonly skip: number };
}

interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface PreflightDeps {
  readonly tryExec: (cmd: string) => ExecResult;
  readonly readlinkSync: (path: string) => string;
}

const defaultDeps: PreflightDeps = {
  tryExec,
  readlinkSync,
};

function projectRootFromDoltCwd(cwd: string): string | null {
  const markers = ['/.beads/shared-server/dolt', '/.beads/dolt'];
  const marker = markers.find((candidate) => cwd.endsWith(candidate));
  return marker ? cwd.slice(0, -marker.length) : null;
}

export function tryExec(cmd: string): ExecResult {
  try {
    const stdout = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
    };
  }
}

function whichOk(binary: string, deps: PreflightDeps = defaultDeps): boolean {
  return deps.tryExec(`which ${binary}`).ok;
}

export function inspectDoltServerPortOwner(port: number, expectedDoltData: string, deps: PreflightDeps = defaultDeps): CheckResult {
  const ss = deps.tryExec(`ss -H -tlnp 'sport = :${port}' 2>&1`);
  if (!ss.ok) {
    return {
      name: 'dolt-server-port-owner',
      level: 'skip',
      detail: `could not inspect port ${port} ownership with ss — ${String(ss.stderr || ss.stdout).slice(0, 160)}`,
    };
  }

  const line = ss.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) {
    return {
      name: 'dolt-server-port-owner',
      level: 'warn',
      detail: `port ${port} is not currently listening — bd may start the Dolt server on demand`,
    };
  }

  const pid = /pid=(\d+)/.exec(line)?.[1];
  if (!pid) {
    return {
      name: 'dolt-server-port-owner',
      level: 'warn',
      detail: `port ${port} is listening but owner PID was unavailable: ${line.slice(0, 180)}`,
    };
  }

  let cwd: string;
  try {
    cwd = deps.readlinkSync(`/proc/${pid}/cwd`);
  } catch (err) {
    return {
      name: 'dolt-server-port-owner',
      level: 'warn',
      detail: `port ${port} is owned by pid ${pid}, but its cwd could not be read: ${(err as Error).message}`,
    };
  }

  if (cwd === expectedDoltData) {
    const projectRoot = projectRootFromDoltCwd(cwd);
    return {
      name: 'dolt-server-port-owner',
      level: 'ok',
      detail: `port=${port} pid=${pid} project=${projectRoot ?? 'unknown'} cwd=${cwd}`,
    };
  }

  const ownerProjectRoot = projectRootFromDoltCwd(cwd);
  const expectedProjectRoot = projectRootFromDoltCwd(expectedDoltData);

  return {
    name: 'dolt-server-port-owner',
    level: 'error',
    detail: `port ${port} is owned by pid ${pid} for project ${ownerProjectRoot ?? 'unknown'} at ${cwd}, expected project ${expectedProjectRoot ?? 'unknown'} at ${expectedDoltData}. bd may appear empty or repeatedly auto-import JSONL. Remediate via bd-managed recovery: stop the stale owner only after confirming its cwd, restart the intended project's bd Dolt server, or repair registry/config drift; do not mutate .beads/dolt directly.`,
  };
}

export function preflight(projectRoot: string, deps: PreflightDeps = defaultDeps): Report {
  const checks: CheckResult[] = [];
  const beadsDir = join(projectRoot, '.beads');

  // 1. .beads directory exists
  if (!existsSync(beadsDir)) {
    checks.push({ name: '.beads-exists', level: 'error', detail: `${beadsDir} not found — project is not bd-backed or registry is drifted` });
    return finalize(projectRoot, checks);
  }
  checks.push({ name: '.beads-exists', level: 'ok', detail: beadsDir });

  // 2. Local ownership writable
  try {
    const stat = statSync(beadsDir);
    const writable = (stat.mode & 0o200) !== 0;
    checks.push({
      name: '.beads-writable',
      level: writable ? 'ok' : 'error',
      detail: `mode=${(stat.mode & 0o777).toString(8)} uid=${stat.uid}`,
    });
  } catch (err) {
    checks.push({ name: '.beads-writable', level: 'error', detail: (err as Error).message });
  }

  // 3. config.yaml present
  const configPath = join(beadsDir, 'config.yaml');
  if (!existsSync(configPath)) {
    checks.push({ name: '.beads/config.yaml', level: 'warn', detail: 'missing — bd may auto-create on first use' });
  } else {
    checks.push({ name: '.beads/config.yaml', level: 'ok', detail: 'present' });
  }

  // 4. Deprecated dolt_server_port file absent (key migration signal)
  const deprecatedPort = join(beadsDir, 'dolt_server_port');
  if (existsSync(deprecatedPort)) {
    checks.push({
      name: 'no-deprecated-dolt_server_port',
      level: 'error',
      detail: `legacy dolt_server_port file present at ${deprecatedPort} — project is on the pre-migration shape`,
    });
  } else {
    checks.push({ name: 'no-deprecated-dolt_server_port', level: 'ok', detail: 'absent' });
  }

  // 5. New dolt-server.port file present (post-migration shape)
  const newPort = join(beadsDir, 'dolt-server.port');
  let parsedPort: number | null = null;
  if (existsSync(newPort)) {
    const raw = readFileSync(newPort, 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0) {
      parsedPort = port;
      checks.push({ name: 'dolt-server-port', level: 'ok', detail: `port=${port}` });
    } else {
      checks.push({ name: 'dolt-server-port', level: 'error', detail: `invalid port "${raw}"` });
    }
  } else {
    checks.push({ name: 'dolt-server-port', level: 'warn', detail: 'no .beads/dolt-server.port — bd may use JSONL mode or not yet started' });
  }

  // 6. Dolt data dir present
  const doltData = join(beadsDir, 'dolt');
  if (existsSync(doltData)) {
    checks.push({ name: '.beads/dolt-data-dir', level: 'ok', detail: doltData });
    if (parsedPort !== null) {
      checks.push(inspectDoltServerPortOwner(parsedPort, doltData, deps));
    }
  } else {
    checks.push({ name: '.beads/dolt-data-dir', level: 'warn', detail: 'no .beads/dolt directory — non-Dolt backend?' });
  }

  // 7. bd binary on PATH
  if (whichOk('bd', deps)) {
    checks.push({ name: 'bd-binary', level: 'ok', detail: 'on PATH' });
  } else {
    checks.push({ name: 'bd-binary', level: 'error', detail: 'bd CLI not on PATH — install before working' });
  }

  // 8. dolt binary on PATH (needed for bd dolt subcommands)
  if (whichOk('dolt', deps)) {
    checks.push({ name: 'dolt-binary', level: 'ok', detail: 'on PATH' });
  } else {
    checks.push({ name: 'dolt-binary', level: 'warn', detail: 'dolt CLI not on PATH — bd dolt operations will fail' });
  }

  // 9. bd list --json works (the smoke check)
  const listResult = deps.tryExec(`bd --db ${beadsDir} list --json --status open --limit 1 2>&1 || cd ${projectRoot} && bd list --json --status open --limit 1`);
  if (listResult.ok) {
    checks.push({ name: 'bd-list-json', level: 'ok', detail: 'bd list --json --status open --limit 1 succeeded' });
  } else {
    checks.push({
      name: 'bd-list-json',
      level: 'error',
      detail: (listResult.stderr || listResult.stdout).slice(0, 200),
    });
  }

  // 10. bd dolt status (if dolt backend)
  if (existsSync(doltData)) {
    const status = deps.tryExec(`cd ${projectRoot} && bd dolt status`);
    if (status.ok) {
      const running = /running/.test(status.stdout);
      checks.push({
        name: 'bd-dolt-status',
        level: running ? 'ok' : 'warn',
        detail: running ? 'server running' : 'status output did not mention running',
      });
    } else {
      checks.push({ name: 'bd-dolt-status', level: 'error', detail: (status.stderr || status.stdout).slice(0, 200) });
    }
  } else {
    checks.push({ name: 'bd-dolt-status', level: 'skip', detail: 'no dolt backend in this project' });
  }

  // 11. Remote configured (DoltHub or similar)
  const remoteCheck = deps.tryExec(`cd ${projectRoot} && bd dolt remote 2>&1`);
  if (remoteCheck.ok && remoteCheck.stdout.trim().length > 0) {
    checks.push({
      name: 'dolt-remote-configured',
      level: 'ok',
      detail: remoteCheck.stdout.trim().split('\n')[0]?.slice(0, 120) ?? 'remote present',
    });
  } else {
    checks.push({
      name: 'dolt-remote-configured',
      level: 'warn',
      detail: 'no dolt remote configured — push/pull operations unavailable (local-only project, may be intentional)',
    });
  }

  return finalize(projectRoot, checks);
}

function finalize(projectRoot: string, checks: CheckResult[]): Report {
  const summary = checks.reduce(
    (acc, c) => {
      acc[c.level]++;
      return acc;
    },
    { ok: 0, warn: 0, error: 0, skip: 0 } as Record<CheckResult['level'], number>,
  );
  return { project: projectRoot, checks, summary };
}

export function format(report: Report): string {
  const lines: string[] = [];
  lines.push(`# bd preflight: ${report.project}`);
  lines.push('');
  for (const c of report.checks) {
    const icon = c.level === 'ok' ? '✓' : c.level === 'warn' ? '⚠' : c.level === 'error' ? '✗' : '·';
    lines.push(`  ${icon}  ${c.name.padEnd(34)} ${c.detail}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.error} error, ${report.summary.skip} skip`,
  );
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const target = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
  const report = preflight(target);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(format(report));
  }
  process.exit(report.summary.error > 0 ? 2 : report.summary.warn > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
