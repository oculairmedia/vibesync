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

  // scheme://
  if (url.includes('://')) {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    const port = parsed.port;
    if (port && port !== '22' && port !== '80' && port !== '443') {
      host = `${host}:${port}`;
    }
    let path = parsed.pathname.replace(/\/+$/, '');
    if (path.endsWith('.git')) path = path.slice(0, -4);
    path = path.replace(/\\/g, '/');
    return host + path;
  }

  // scp-style: [user@]host:path
  const colonIdx = url.indexOf(':');
  const slashIdx = url.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    // Windows path shortcut: C:/foo
    const looksWindows = colonIdx === 1 && url.length > 2 && (url[2] === '/' || url[2] === '\\');
    if (!looksWindows) {
      const [hostPart, pathPart] = [url.slice(0, colonIdx), url.slice(colonIdx + 1)];
      const atIdx = hostPart.lastIndexOf('@');
      const host = (atIdx >= 0 ? hostPart.slice(atIdx + 1) : hostPart).toLowerCase();
      let path = pathPart.replace(/\/+$/, '');
      if (path.endsWith('.git')) path = path.slice(0, -4);
      path = path.replace(/\\/g, '/');
      return `${host}/${path}`;
    }
  }

  // Local path
  return deps.realpath(resolvePath(url)).replace(/\\/g, '/');
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
