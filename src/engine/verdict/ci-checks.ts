/**
 * vibesync-9lzk.46: read a PR's checks for the final step's verdict, instead of
 * trusting what the reply says about CI. Only the named FAST checks count (the
 * engine's inner loop); slow merge gates such as integration-bd gate the merge,
 * never a step.
 */
export type CheckState = 'pass' | 'fail' | 'pending';

export interface PrChecksReader {
  /** State of each named check on the PR's head; a check not reported yet is pending. */
  read(prUrl: string, names: readonly string[]): Promise<Readonly<Record<string, CheckState>>>;
}

export type GhRunner = (args: readonly string[]) => Promise<string>;

/** `gh pr checks <url> --json name,bucket` (bucket: pass | fail | pending | skipping | cancel). */
export function createGhPrChecksReader(gh: GhRunner): PrChecksReader {
  return {
    async read(prUrl, names) {
      let raw: string;
      try {
        raw = await gh(['pr', 'checks', prUrl, '--json', 'name,bucket']);
      } catch (err) {
        // gh exits non-zero while checks are pending or failing but still prints the JSON.
        const text = err instanceof Error ? err.message : String(err);
        const at = text.indexOf('[');
        if (at < 0) throw err;
        raw = text.slice(at);
      }
      const rows = JSON.parse(raw) as Array<{ name?: string; bucket?: string }>;
      const out: Record<string, CheckState> = {};
      for (const name of names) {
        const row = rows.find((r) => r.name === name);
        const bucket = row?.bucket;
        out[name] = bucket === 'pass' ? 'pass' : bucket === 'fail' || bucket === 'cancel' ? 'fail' : 'pending';
      }
      return out;
    },
  };
}

export interface SettleCiOptions {
  readonly names: readonly string[];
  readonly pollMs: number;
  readonly maxWaitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export type CiOutcome =
  | { readonly kind: 'green' }
  | { readonly kind: 'failed'; readonly failed: readonly string[] }
  | { readonly kind: 'still_pending'; readonly pending: readonly string[] };

/** Poll the named checks until all pass, one fails, or the wait cap is reached. */
export async function settleCi(reader: PrChecksReader, prUrl: string, opts: SettleCiOptions): Promise<CiOutcome> {
  const deadline = opts.now() + opts.maxWaitMs;
  for (;;) {
    const states = await reader.read(prUrl, opts.names);
    const failed = opts.names.filter((n) => states[n] === 'fail');
    if (failed.length > 0) return { kind: 'failed', failed };
    const pending = opts.names.filter((n) => states[n] !== 'pass');
    if (pending.length === 0) return { kind: 'green' };
    if (opts.now() >= deadline) return { kind: 'still_pending', pending };
    await opts.sleep(opts.pollMs);
  }
}
