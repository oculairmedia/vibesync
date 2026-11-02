/**
 * Repo allowlist helpers (vibesync-5c8y).
 *
 * Agent run output is untrusted text (it can echo PR bodies, issues, web
 * pages). Only repos the operator named in `scheduler.allowedRepos` may ever
 * be queued for, or touched by, an auto-merge. GitHub owner/repo names are
 * case-insensitive, so comparison is case-insensitive; otherwise exact.
 */

/** Valid `owner/repo` (no scheme, no extra segments, no whitespace). */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Lower-case and strip one trailing `.git` from the repo segment. */
export function normalizeRepo(repo: string): string {
  return repo.trim().replace(/\.git$/i, '').toLowerCase();
}

/** True iff `repo` (after normalisation) is a well-formed slug present in `allowed`. */
export function isRepoAllowed(repo: string, allowed: readonly string[]): boolean {
  const n = normalizeRepo(repo);
  if (!REPO_SLUG_PATTERN.test(n)) return false;
  return allowed.some((a) => normalizeRepo(a) === n);
}
