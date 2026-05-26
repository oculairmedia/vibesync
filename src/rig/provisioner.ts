import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger as rootLogger } from '../logger.js';

const log = rootLogger.child({ module: 'rig-provisioner' });

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 15_000 });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function getGitRemote(dir: string): string | null {
  const r = run('git', ['remote', 'get-url', 'origin'], dir);
  return r.ok ? r.stdout : null;
}

export function derivePrefix(dir: string): string {
  const name = basename(dir);
  const parts = name.split('-');
  if (parts.length === 1) return name.slice(0, 3);
  return parts.map(p => p[0] ?? '').join('');
}

export function hasBeadsRig(dir: string): boolean {
  return existsSync(`${dir}/.beads`);
}

export function hasDoltRemote(dir: string): boolean {
  const r = run('bd', ['dolt', 'remote', 'list'], dir);
  return r.ok && r.stdout.includes('origin');
}

function getIssuePrefix(dir: string): string | null {
  const r = run('bd', ['config', 'get', 'issue_prefix'], dir);
  if (!r.ok) return null;
  const match = r.stdout.match(/^issue_prefix\s*=\s*(.+)$/m);
  if (match) return match[1]!.trim();
  if (r.stdout.includes('(not set)')) return null;
  return r.stdout || null;
}

export interface RigStatus {
  path: string;
  name: string;
  hasRig: boolean;
  hasRemote: boolean;
  hasGitRemote: boolean;
  gitRemote: string | null;
  issuePrefix: string | null;
}

export interface RigHealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  noRig: number;
  degradedProjects: string[];
}

export function auditRigs(stacksDir: string): RigStatus[] {
  const entries = readdirSync(stacksDir);
  const results: RigStatus[] = [];

  for (const entry of entries) {
    if (entry.startsWith('_') || entry === 'tmp' || entry === 'rootCA.pem') continue;
    const full = resolve(stacksDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }

    const gitRemote = getGitRemote(full);
    const hasRig = hasBeadsRig(full);

    results.push({
      path: full,
      name: entry,
      hasRig,
      hasRemote: hasRig ? hasDoltRemote(full) : false,
      hasGitRemote: !!gitRemote,
      gitRemote,
      issuePrefix: hasRig ? getIssuePrefix(full) : null,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeRigHealth(statuses: RigStatus[]): RigHealthSummary {
  const healthy = statuses.filter(r => r.hasRig && r.hasRemote);
  const degraded = statuses.filter(r => r.hasRig && !r.hasRemote);
  const noRig = statuses.filter(r => !r.hasRig);

  return {
    total: statuses.length,
    healthy: healthy.length,
    degraded: degraded.length,
    noRig: noRig.length,
    degradedProjects: degraded.map(r => r.name),
  };
}

export interface RigResult {
  ok: boolean;
  message: string;
  remoteUrl?: string;
}

export function initRig(dir: string, prefixOverride?: string): RigResult {
  dir = resolve(dir);
  if (!existsSync(dir)) return { ok: false, message: `directory ${dir} does not exist` };
  if (hasBeadsRig(dir)) return { ok: false, message: `rig already exists at ${dir}/.beads — use repairRig instead` };

  const gitRemote = getGitRemote(dir);
  if (!gitRemote) return { ok: false, message: `no git remote at ${dir}` };

  const prefix = prefixOverride || derivePrefix(dir);
  const doltRemote = gitRemote.startsWith('git+') ? gitRemote : `git+${gitRemote}`;

  const init = run('bd', ['init', '--prefix', prefix], dir);
  if (!init.ok) return { ok: false, message: `bd init failed: ${init.stderr}` };

  const remote = run('bd', ['dolt', 'remote', 'add', 'origin', doltRemote], dir);
  if (!remote.ok) return { ok: false, message: `bd dolt remote add failed: ${remote.stderr}` };

  log.info({ dir, prefix, doltRemote }, 'Rig initialized');
  return { ok: true, message: `initialized with prefix=${prefix} remote=${doltRemote}`, remoteUrl: doltRemote };
}

export function repairRig(dir: string): RigResult {
  dir = resolve(dir);
  if (!hasBeadsRig(dir)) return { ok: false, message: `no rig at ${dir}/.beads` };
  if (hasDoltRemote(dir)) return { ok: true, message: 'already has remote' };

  const gitRemote = getGitRemote(dir);
  if (!gitRemote) return { ok: false, message: `no git remote at ${dir}` };

  const doltRemote = gitRemote.startsWith('git+') ? gitRemote : `git+${gitRemote}`;
  const result = run('bd', ['dolt', 'remote', 'add', 'origin', doltRemote], dir);
  if (!result.ok) return { ok: false, message: `bd dolt remote add failed: ${result.stderr}` };

  log.info({ dir, doltRemote }, 'Rig repaired — remote added');
  return { ok: true, message: `remote added: ${doltRemote}`, remoteUrl: doltRemote };
}

export interface EnsureRigResult {
  ok: boolean;
  action: 'none' | 'init' | 'repair' | 'skipped';
  message: string;
  remoteUrl?: string;
}

export function ensureRig(dir: string): EnsureRigResult {
  dir = resolve(dir);
  if (!existsSync(dir)) return { ok: false, action: 'skipped', message: 'directory does not exist' };

  const gitRemote = getGitRemote(dir);
  if (!gitRemote) return { ok: true, action: 'skipped', message: 'no git remote — skipping' };

  if (!hasBeadsRig(dir)) {
    const result = initRig(dir);
    return { ok: result.ok, action: 'init', message: result.message, ...(result.remoteUrl ? { remoteUrl: result.remoteUrl } : {}) };
  }

  if (!hasDoltRemote(dir)) {
    const result = repairRig(dir);
    return { ok: result.ok, action: 'repair', message: result.message, ...(result.remoteUrl ? { remoteUrl: result.remoteUrl } : {}) };
  }

  return { ok: true, action: 'none', message: 'rig healthy' };
}
