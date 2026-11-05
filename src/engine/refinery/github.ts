/** GitHubPort implementations: a refusing port and one over the `gh` CLI. */
import { parseJsonOutput, type CommandRunner } from '../beads/cli.js';
import { isRepoAllowed } from '../repo-allowlist.js';
import type { GitHubPort, PrFacts } from './refinery.js';

// ---------------------------------------------------------------------------
// GitHubPort
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Port that refuses everything. Wired when `autoMerge` is false so a merge is
 * impossible even if some future code path enqueues a merge request.
 */
export const disabledGitHubPort: GitHubPort = {
  async fetchFacts(): Promise<PrFacts> {
    throw new Error('scheduler auto-merge is disabled (set VIBESYNC_SCHEDULER_AUTO_MERGE=true to enable)');
  },
  async merge(): Promise<string> {
    throw new Error('scheduler auto-merge is disabled (set VIBESYNC_SCHEDULER_AUTO_MERGE=true to enable)');
  },
};

/** GitHubPort over the `gh` CLI. Only constructed when autoMerge is explicitly on. */
export class GhCliGitHubPort implements GitHubPort {
  private readonly headOids = new Map<string, string>();

  /**
   * @param allowedRepos owner/repo allowlist (vibesync-5c8y). Required, no default:
   *   an empty list refuses every repo. Defence in depth behind the daemon's own check.
   */
  constructor(
    private readonly gh: CommandRunner,
    private readonly allowedRepos: readonly string[],
  ) {}

  private assertAllowed(repo: string): void {
    if (!isRepoAllowed(repo, this.allowedRepos)) {
      throw new Error(`refusing GitHub access to ${JSON.stringify(repo)}: repo is not in scheduler.allowedRepos`);
    }
  }

  async fetchFacts(repo: string, prNumber: number, requiredCheckNames: readonly string[]): Promise<PrFacts> {
    this.assertAllowed(repo);
    const view = parseJsonOutput(
      await this.gh(['pr', 'view', String(prNumber), '-R', repo, '--json', 'mergeable,mergeStateStatus,statusCheckRollup,headRefOid']),
      `gh pr view ${repo}#${prNumber}`,
    ) as Row;
    const removedOut = await this.gh([
      'api', `repos/${repo}/pulls/${prNumber}/files`, '--paginate',
      '--jq', '[.[] | select(.status == "removed")] | length',
    ]);
    const deletedFileTokens = removedOut.split(/\s+/).filter(Boolean);
    // Empty output is no answer, not "0 deleted": fail closed like garbage.
    if (deletedFileTokens.length === 0 || deletedFileTokens.some((token) => !/^\d+$/.test(token))) {
      throw new Error(`invalid deleted-files count for ${repo}#${prNumber}: ${JSON.stringify(removedOut)}`);
    }
    const deletedFiles = deletedFileTokens.reduce((n, token) => n + Number(token), 0);

    const requiredChecks: Record<string, string> = {};
    const rollup = Array.isArray(view['statusCheckRollup']) ? (view['statusCheckRollup'] as Row[]) : [];
    for (const entry of rollup) {
      const name = String(entry['name'] ?? entry['context'] ?? '');
      if (!name || !requiredCheckNames.includes(name)) continue;
      // CheckRun: conclusion is null until complete (then status says why);
      // StatusContext: state. Upper-case so lowercase API variants still match.
      const value = String(entry['conclusion'] || entry['state'] || entry['status'] || 'UNKNOWN').toUpperCase();
      const prior = requiredChecks[name];
      if (prior === undefined || prior === 'SUCCESS') requiredChecks[name] = value;
    }

    const oid = String(view['headRefOid'] ?? '');
    if (oid) this.headOids.set(`${repo}#${prNumber}`, oid);

    return {
      requiredChecks,
      mergeable: String(view['mergeable'] ?? 'UNKNOWN'),
      deletedFiles,
      behindBase: String(view['mergeStateStatus'] ?? '') === 'BEHIND',
    };
  }

  async merge(repo: string, prNumber: number): Promise<string> {
    this.assertAllowed(repo);
    const oid = this.headOids.get(`${repo}#${prNumber}`);
    if (!oid) throw new Error(`refusing to merge ${repo}#${prNumber}: no verified head sha from fetchFacts`);
    // --match-head-commit: merge only the exact commit whose gates we checked.
    await this.gh(['pr', 'merge', String(prNumber), '-R', repo, '--squash', '--match-head-commit', oid]);
    return oid;
  }
}
