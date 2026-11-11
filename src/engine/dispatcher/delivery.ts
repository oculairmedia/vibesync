/**
 * Delivery verification (vibesync-9lzk.21).
 *
 * A formula that declares `delivers = "pull_request"` only completes once a
 * real, open pull request exists. The trial run that motivated this
 * (vibesync-mol-rvut9fq9qv12) closed "completed" with every edit uncommitted:
 * completion had meant "each turn ended with text". A PR URL in step output is
 * only a CANDIDATE; the verifier confirms it against GitHub, so an agent
 * claiming a PR it never opened cannot pass.
 */
import type { FormulaDelivery } from '../formula/index.js';

export interface DeliveryClaim {
  readonly kind: FormulaDelivery;
  /** Every step's output, in step order. */
  readonly outputs: Readonly<Record<string, string>>;
  readonly moleculeId: string;
  /** When this run began. A PR opened before it cannot be this run's delivery. */
  readonly startedAt: Date;
  /** The work bead the run is for; when set, the PR must name it (title, branch or body). */
  readonly motivatingBeadId?: string;
}

/** Where a run's PR must live. Resolved once from the project's git checkout. */
export interface DeliveryTarget {
  /** `owner/name`, as `gh repo view --json nameWithOwner` prints it. */
  readonly repository: string;
}

export type DeliveryVerdict =
  | { readonly ok: true; readonly artifact: string }
  | { readonly ok: false; readonly reason: string };

/** Confirms a declared artifact exists. Injected; the default uses the `gh` CLI. */
export interface DeliveryVerifier {
  verify(claim: DeliveryClaim): Promise<DeliveryVerdict>;
}

/** Runs `gh` and returns stdout; rejects on a non-zero exit. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

const PR_URL = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;

/** `owner/name` (lower case) of a github.com PR URL; empty when it is not one. */
export function repositoryOf(url: string): string {
  const m = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\//i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

/** Every PR URL mentioned in any step output, most recent step last. */
export function candidatePullRequests(outputs: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>();
  for (const text of Object.values(outputs)) {
    for (const m of text.matchAll(PR_URL)) seen.add(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`);
  }
  return [...seen];
}

/** Fields read from `gh pr view --json` (names as gh prints them). */
const PR_FIELDS = 'state,url,createdAt,headRefName,title,body,commits';

interface PrView {
  readonly state?: string;
  readonly url?: string;
  readonly createdAt?: string;
  readonly headRefName?: string;
  readonly title?: string;
  readonly body?: string;
  /** `gh pr view --json commits`: every commit on the PR with its dates. */
  readonly commits?: readonly { readonly oid?: string; readonly committedDate?: string }[];
}

/**
 * Verifies `pull_request` delivery with `gh pr view`. A candidate counts only if
 * it is THIS run's PR (vibesync-9lzk.21 review): in the project's repository,
 * OPEN or MERGED, opened at or after the run started (a PR quoted from the task
 * predates the run), and naming the run's work bead in its title, branch or body
 * (an unrelated PR opened meanwhile does not). A run with no work bead cannot be
 * bound and fails. Anything else fails with the reason per candidate.
 */
export function createGhDeliveryVerifier(gh: GhRunner, target: () => Promise<DeliveryTarget>): DeliveryVerifier {
  return {
    async verify(claim) {
      if (claim.kind !== 'pull_request') return { ok: false, reason: `unsupported delivery kind ${claim.kind}` };
      // A run cannot be bound to a PR without knowing which work it is for and
      // where its PRs live (vibesync-9lzk.21 review): fail closed on either.
      if (!claim.motivatingBeadId) {
        return { ok: false, reason: 'delivery needs a work bead to bind the pull request to, and this run has none' };
      }
      let repository: string;
      try {
        repository = (await target()).repository.toLowerCase();
      } catch (err) {
        return { ok: false, reason: `could not resolve the project repository (${ghReason(err)})` };
      }
      const candidates = candidatePullRequests(claim.outputs);
      if (candidates.length === 0) {
        return { ok: false, reason: 'formula declares delivers = "pull_request" but no step output names a pull request URL' };
      }
      const problems: string[] = [];
      for (const url of candidates.reverse()) {
        if (repositoryOf(url) !== repository) {
          problems.push(`${url} is not in the project repository ${repository}`);
          continue;
        }
        let pr: PrView;
        try {
          pr = JSON.parse(await gh(['pr', 'view', url, '--json', PR_FIELDS])) as PrView;
        } catch (err) {
          problems.push(`${url} could not be confirmed (${ghReason(err)})`);
          continue;
        }
        const why = notThisRunsPr(pr, claim);
        if (why === null) return { ok: true, artifact: pr.url ?? url };
        problems.push(`${url} ${why}`);
      }
      return { ok: false, reason: `no pull request from this run confirmed: ${problems.join('; ')}` };
    },
  };
}

/**
 * gh's own explanation, not the command line it echoes (which is long and
 * would push the useful part out of a truncated reason).
 */
function ghReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const afterFailed = text.includes(' failed: ') ? text.slice(text.indexOf(' failed: ') + ' failed: '.length) : text;
  return afterFailed.trim().slice(0, 200);
}

/** Null when `pr` is this run's open/merged PR, else why not. */
function notThisRunsPr(pr: PrView, claim: DeliveryClaim): string | null {
  if (pr.state !== 'OPEN' && pr.state !== 'MERGED') return `is ${pr.state ?? 'in an unknown state'}`;
  const created = pr.createdAt ? Date.parse(pr.createdAt) : NaN;
  if (Number.isNaN(created)) return 'has no creation time';
  // One minute of slack for clock skew between this host and GitHub.
  const runStart = claim.startedAt.getTime() - 60_000;
  // This run's PR is one it opened, or one it pushed a commit to (a review
  // round updates the existing PR, vibesync-9lzk.38). A PR with no activity
  // during the run is someone else's.
  if (created < runStart && !commitDuringRun(pr, runStart)) {
    return `was opened ${pr.createdAt}, before this run started (${claim.startedAt.toISOString()}), and received no commit during it`;
  }
  const bead = claim.motivatingBeadId!;
  const named = [pr.title, pr.headRefName, pr.body].some((t) => typeof t === 'string' && t.includes(bead));
  if (!named) return `does not name the work bead ${bead} in its title, branch or body`;
  return null;
}

function commitDuringRun(pr: PrView, runStart: number): boolean {
  return (pr.commits ?? []).some((c) => typeof c.committedDate === 'string' && Date.parse(c.committedDate) >= runStart);
}

/** The project repository from `gh repo view` in the project checkout, cached after the first success. */
export function ghRepositoryTarget(gh: GhRunner): () => Promise<DeliveryTarget> {
  let cached: DeliveryTarget | null = null;
  return async () => {
    if (cached) return cached;
    const view = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner?: string };
    if (!view.nameWithOwner) throw new Error('gh repo view returned no nameWithOwner');
    cached = { repository: view.nameWithOwner };
    return cached;
  };
}

/**
 * Pull requests in the project repository that name `bead` (title or branch)
 * and were opened at or after `since`. Used to hold a plan-only step to its
 * role (vibesync-9lzk.37): the planner must not open the PR itself.
 */
export interface ShippedWorkProbe {
  pullRequestsOpenedSince(bead: string, since: Date): Promise<readonly string[]>;
}

export function createGhShippedWorkProbe(gh: GhRunner, target: () => Promise<DeliveryTarget>): ShippedWorkProbe {
  return {
    async pullRequestsOpenedSince(bead, since) {
      const { repository } = await target();
      const raw = await gh(['pr', 'list', '--repo', repository, '--state', 'all', '--search', bead, '--json', 'url,title,headRefName,createdAt', '--limit', '20']);
      const prs = JSON.parse(raw) as Array<{ url?: string; title?: string; headRefName?: string; createdAt?: string }>;
      // gh --search is fuzzy (it matched vibesync-9lzk.31 for "9lzk.34"): keep
      // only PRs whose title or branch contains the exact bead id.
      return prs
        .filter((pr) => [pr.title, pr.headRefName].some((t) => typeof t === 'string' && t.includes(bead)))
        .filter((pr) => typeof pr.createdAt === 'string' && Date.parse(pr.createdAt) >= since.getTime() - 60_000)
        .map((pr) => pr.url ?? '');
    },
  };
}
