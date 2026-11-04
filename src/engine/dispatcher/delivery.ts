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

/** Every PR URL mentioned in any step output, most recent step last. */
export function candidatePullRequests(outputs: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>();
  for (const text of Object.values(outputs)) {
    for (const m of text.matchAll(PR_URL)) seen.add(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`);
  }
  return [...seen];
}

/** Fields read from `gh pr view --json` (names as gh prints them). */
const PR_FIELDS = 'state,url,createdAt,headRefName,title,body';

interface PrView {
  readonly state?: string;
  readonly url?: string;
  readonly createdAt?: string;
  readonly headRefName?: string;
  readonly title?: string;
  readonly body?: string;
}

/**
 * Verifies `pull_request` delivery with `gh pr view`. A candidate counts only if
 * it is THIS run's PR (vibesync-9lzk.21 review): OPEN or MERGED, opened at or
 * after the run started (a PR quoted from the task predates the run), and, when
 * the run has a motivating bead, naming that bead in its title, branch or body
 * (an unrelated PR opened meanwhile does not). Anything else fails with the
 * reason per candidate.
 */
export function createGhDeliveryVerifier(gh: GhRunner): DeliveryVerifier {
  return {
    async verify(claim) {
      if (claim.kind !== 'pull_request') return { ok: false, reason: `unsupported delivery kind ${claim.kind}` };
      const candidates = candidatePullRequests(claim.outputs);
      if (candidates.length === 0) {
        return { ok: false, reason: 'formula declares delivers = "pull_request" but no step output names a pull request URL' };
      }
      const problems: string[] = [];
      for (const url of candidates.reverse()) {
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
  if (created < claim.startedAt.getTime() - 60_000) return `was opened ${pr.createdAt}, before this run started (${claim.startedAt.toISOString()})`;
  const bead = claim.motivatingBeadId;
  if (bead) {
    const named = [pr.title, pr.headRefName, pr.body].some((t) => typeof t === 'string' && t.includes(bead));
    if (!named) return `does not name the work bead ${bead} in its title, branch or body`;
  }
  return null;
}
