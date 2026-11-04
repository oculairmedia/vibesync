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

/**
 * Verifies `pull_request` delivery with `gh pr view`: the PR must exist and be
 * OPEN (or already MERGED). A closed-unmerged PR, an unreachable URL, or no
 * candidate at all fails with a reason naming what is missing.
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
        try {
          const raw = await gh(['pr', 'view', url, '--json', 'state,url']);
          const pr = JSON.parse(raw) as { state?: string; url?: string };
          if (pr.state === 'OPEN' || pr.state === 'MERGED') return { ok: true, artifact: pr.url ?? url };
          problems.push(`${url} is ${pr.state ?? 'in an unknown state'}`);
        } catch (err) {
          problems.push(`${url} could not be confirmed (${err instanceof Error ? err.message.slice(0, 160) : String(err)})`);
        }
      }
      return { ok: false, reason: `no open pull request confirmed: ${problems.join('; ')}` };
    },
  };
}
