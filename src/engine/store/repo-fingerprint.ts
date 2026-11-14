/**
 * Compute the canonical bd `repo_id` for a project — used to verify the
 * connected Dolt database actually belongs to the expected repository.
 *
 * This is a TypeScript port of `beads/internal/beads/fingerprint.go`. Bd
 * stores this value in the `metadata` table at key `repo_id` and compares
 * it during `bd doctor`. Vibesync runs the same check at every DoltClient
 * connection so a port collision that silently routes us to a foreign
 * database (vibesync-jhb) fails loudly instead of returning bad rows.
 *
 * Algorithm (must stay in lockstep with bd):
 *   1. Read `git config --get remote.origin.url` in the project root.
 *   2. If present: canonicalize → host + path-without-.git, lowercased
 *      host. Strip user@, default ports (22/80/443) drop, normalize
 *      slashes. Then sha256 the canonical string and return first 16
 *      bytes hex (32 chars).
 *   3. If no remote: fall back to sha256 of the evaluated absolute
 *      project path.
 *
 * This module deliberately avoids depending on git/fs from the hot path
 * — all process and filesystem calls go through `RepoFingerprintDeps`
 * so tests stub them.
 */

import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export interface RepoFingerprintDeps {
  /** Run `git config --get remote.origin.url` in the project root. Returns
   *  the URL on success or null when no remote is configured. */
  readonly readGitRemote: (projectPath: string) => string | null;
  /** Resolve a path to its real (symlink-evaluated) absolute form. */
  readonly realpath: (path: string) => string;
}

function defaultReadGitRemote(projectPath: string): string | null {
  try {
    const output = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim() || null;
  } catch (err) {
    const status = (err as SpawnSyncReturns<string>).status;
    // git config exits 1 when the key is unset — treat as "no remote".
    if (status === 1) return null;
    return null;
  }
}

function defaultRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

export const defaultRepoFingerprintDeps: RepoFingerprintDeps = {
  readGitRemote: defaultReadGitRemote,
  realpath: defaultRealpath,
};

/**
 * Canonicalize a git URL the way bd's `canonicalizeGitURL` does. Returns
 * `host + path-without-.git` for URL-style and scp-style; for local paths
 * returns the evaluated absolute path.
 */
export function canonicalizeGitURL(rawURL: string, deps: RepoFingerprintDeps = defaultRepoFingerprintDeps): string {
  const url = rawURL.trim();
  if (url.includes('://')) return canonicalSchemeURL(url);
  if (isScpStyle(url)) return canonicalScpURL(url);
  return deps.realpath(resolvePath(url)).replace(/\\/g, '/');
}

/** A scheme URL: lowercased host, non-default port kept, path without trailing slashes or .git. */
function canonicalSchemeURL(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const port = DEFAULT_PORTS.has(parsed.port) ? '' : `:${parsed.port}`;
  return host + port + canonicalRepoPath(parsed.pathname);
}

const DEFAULT_PORTS: ReadonlySet<string> = new Set(['', '22', '80', '443']);

/**
 * `[user@]host:path`, where the colon comes before any slash. A Windows drive
 * path (`C:/x`, `C:\\x`) has the same shape and is a local path instead.
 */
function isScpStyle(url: string): boolean {
  const colonIdx = url.indexOf(':');
  if (colonIdx <= 0 || slashBefore(url, colonIdx)) return false;
  return !isWindowsDrivePath(url, colonIdx);
}

/** Whether a `/` appears before position `idx`. */
function slashBefore(url: string, idx: number): boolean {
  const slashIdx = url.indexOf('/');
  return slashIdx !== -1 && slashIdx < idx;
}

function isWindowsDrivePath(url: string, colonIdx: number): boolean {
  return colonIdx === 1 && url.length > 2 && (url[2] === '/' || url[2] === '\\');
}

/** scp style: the host after the last `@`, lowercased, then the repository path. */
function canonicalScpURL(url: string): string {
  const colonIdx = url.indexOf(':');
  const hostPart = url.slice(0, colonIdx);
  const host = hostPart.slice(hostPart.lastIndexOf('@') + 1).toLowerCase();
  return `${host}/${canonicalRepoPath(url.slice(colonIdx + 1))}`;
}

/** A repository path without trailing slashes or a `.git` suffix, with forward slashes. */
function canonicalRepoPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const withoutGit = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  return withoutGit.replace(/\\/g, '/');
}

function sha256Hex16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Compute the expected `repo_id` for a project (matches bd ComputeRepoID).
 * Returns the 32-char hex string, or null when the project has no git
 * remote AND no resolvable path.
 */
export function computeRepoId(
  projectPath: string,
  deps: RepoFingerprintDeps = defaultRepoFingerprintDeps,
): string | null {
  const url = deps.readGitRemote(projectPath);
  if (url) {
    try {
      const canonical = canonicalizeGitURL(url, deps);
      return sha256Hex16(canonical);
    } catch {
      // fall through to path-based fingerprint
    }
  }
  try {
    const normalized = deps.realpath(resolvePath(projectPath)).replace(/\\/g, '/');
    return sha256Hex16(normalized);
  } catch {
    return null;
  }
}
