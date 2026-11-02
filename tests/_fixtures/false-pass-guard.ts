/**
 * False-pass guards for step-output assertions (vibesync-jni4, Meridian).
 *
 * Tonight's production run (mol-mol-wi8ykf4h1vm9) closed 3 steps "completed"
 * with non-empty output in 100 s total and did no work: each output was the
 * parent's "Waiting for ..." placeholder. "Completed" + "non-empty" is therefore
 * NOT evidence that a model answered. Two independent guards:
 *
 *   1. LATENCY. A step that finishes faster than a model can plausibly answer
 *      did not run a model turn. MIN_MODEL_RESPONSE_MS = 1500: the fastest live
 *      direct turns measured on this host were 2.1-4.0 s (the PONG turn) and
 *      2.57-2.68 s (a one-word LGTM reply on the mayor agent), so 1.5 s sits
 *      below every real turn we have seen (no flaky red) and far above the
 *      single-digit-ms of a replayed/cached/placeholder result (the unit fake
 *      answers in ~1 ms).
 *   2. PLACEHOLDER TEXT. The output must not be a "still waiting" stub.
 *
 * Used by the LIVE test; unit-tested in tests/unit/orchestration/runtime/false-pass-guard.test.ts.
 */
export const MIN_MODEL_RESPONSE_MS = 1_500;

const PLACEHOLDER = /\bWaiting (for|on)\b|Task running in background|task notification/i;

export function assertNotFalsePass(args: { readonly output: string; readonly durationMs: number; readonly minMs?: number }): void {
  const min = args.minMs ?? MIN_MODEL_RESPONSE_MS;
  if (args.output.trim().length === 0) {
    throw new Error('false pass: step output is empty');
  }
  if (PLACEHOLDER.test(args.output)) {
    throw new Error(`false pass: step output is a placeholder, not a role agent report: ${JSON.stringify(args.output.slice(0, 120))}`);
  }
  if (args.durationMs < min) {
    throw new Error(
      `false pass: step completed in ${args.durationMs} ms, faster than the ${min} ms minimum a model needs to answer; ` +
        'no model turn can have produced this output',
    );
  }
}
