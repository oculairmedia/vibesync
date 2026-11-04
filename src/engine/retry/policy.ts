/**
 * Per-step retry policy (vibesync-ynmp).
 *
 * A formula step may declare
 *
 *   [formula.<name>.steps.retry]
 *   max_attempts = 3            # total tries INCLUDING the first; >= 1
 *   on_exhausted = "soft_fail"  # or "fail" (default)
 *   backoff_ms   = 1000         # optional pause before the next try
 *
 * This module is pure: types, constants, and readers/decisions over a step
 * bead's metadata. It imports nothing from the rest of orchestration, and the
 * ONLY state it reasons about lives on the step bead (never in memory):
 *
 *   metadata["gc.retry_attempt"]  the attempt number the step is on (1-based)
 *   metadata["gc.infra_retries"]  infra failures absorbed so far (do NOT burn an attempt)
 *   metadata["failure_class"]     written by the AGENT during its turn to declare a
 *                                 retryable failure; absent on success
 *
 * Keys are flat, dotted strings (the form `bd update --set-metadata gc.retry_attempt=2`
 * writes), so `bd show --json` and the agent see the same fields we do.
 */

export const RETRY_ATTEMPT_KEY = 'gc.retry_attempt';
export const INFRA_RETRIES_KEY = 'gc.infra_retries';
export const FAILURE_CLASS_KEY = 'failure_class';
export const LAST_FAILURE_CLASS_KEY = 'gc.last_failure_class';
export const RETRY_OUTCOME_KEY = 'gc.retry_outcome';

/**
 * How many INFRA failures (provider/transport error, timeout before the agent
 * produced output) a single step absorbs without burning an attempt. The next
 * one fails the step, so a permanently broken model cannot spin forever:
 * at most `INFRA_RETRY_CAP + 1` tries per step from infra failures alone.
 */
export const INFRA_RETRY_CAP = 3;

export const DEFAULT_RETRY_BACKOFF_MS = 1000;

export type OnExhausted = 'soft_fail' | 'fail';

export interface RetryPolicy {
  /** Total tries including the first (>= 1). */
  readonly maxAttempts: number;
  readonly onExhausted: OnExhausted;
  readonly backoffMs: number;
}

/** What a step spec carries; the legacy `retries` pair is the deprecated alias. */
export interface RetryPolicySource {
  readonly retry?: RetryPolicy;
  /** @deprecated alias: max_attempts = retries + 1, on_exhausted = "fail". */
  readonly retries?: number;
  /** @deprecated alias of retry.backoff_ms. */
  readonly retryBackoffMs?: number;
}

export interface ResolvedRetryPolicy extends RetryPolicy {
  /**
   * False when the formula declared no retry at all: the step gets exactly one
   * try and ANY failure is final (infra failures are not retried either, so a
   * formula without retry behaves as it did before this module existed).
   */
  readonly declared: boolean;
}

export function resolveRetryPolicy(step: RetryPolicySource): ResolvedRetryPolicy {
  if (step.retry) return { ...step.retry, declared: true };
  const retries = step.retries ?? 0;
  if (retries > 0) {
    return {
      maxAttempts: retries + 1,
      onExhausted: 'fail',
      backoffMs: step.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
      declared: true,
    };
  }
  return { maxAttempts: 1, onExhausted: 'fail', backoffMs: step.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS, declared: false };
}

export interface RetryState {
  /** The attempt the step is on (1 before anything has been recorded). */
  readonly attempt: number;
  readonly infraRetries: number;
}

/** `bd update --set-metadata k=v` may store the value as a string; accept both forms. */
function asInt(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

function positiveInt(v: unknown): number | null {
  const n = asInt(v);
  return n !== null && n >= 1 ? n : null;
}

function nonNegativeInt(v: unknown): number | null {
  const n = asInt(v);
  return n !== null && n >= 0 ? n : null;
}

/** Read the retry state off a step bead's metadata. Pure; the bead is the only source. */
export function readRetryState(metadata: Readonly<Record<string, unknown>>): RetryState {
  return {
    attempt: positiveInt(metadata[RETRY_ATTEMPT_KEY]) ?? 1,
    infraRetries: nonNegativeInt(metadata[INFRA_RETRIES_KEY]) ?? 0,
  };
}

/** The failure class the agent declared on the bead during its turn, if any. */
export function readFailureClass(metadata: Readonly<Record<string, unknown>>): string | null {
  const v = metadata[FAILURE_CLASS_KEY];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export type FailureKind =
  /** The agent ran and declared (or produced) a failure: burns an attempt. */
  | 'agent'
  /** Provider/transport/timeout-before-output: does NOT burn an attempt, bounded by INFRA_RETRY_CAP. */
  | 'infra'
  /** Cancelled/stopped: never retried. */
  | 'terminal';

export type RetryDecision =
  | { readonly action: 'retry'; readonly next: RetryState; readonly backoffMs: number }
  /** Close the step failed and let the molecule continue (on_exhausted = soft_fail, agent failures only). */
  | { readonly action: 'soft_fail'; readonly outcome: 'exhausted' }
  /** Close the step failed and abort the molecule. */
  | { readonly action: 'fail'; readonly outcome: 'exhausted' | 'infra_exhausted' | 'not_retryable' };

/** What to do after a failed try. Pure: (policy, bead state, kind) -> decision. */
export function decideRetry(args: {
  readonly policy: ResolvedRetryPolicy;
  readonly state: RetryState;
  readonly kind: FailureKind;
}): RetryDecision {
  const { policy, state, kind } = args;
  if (kind === 'terminal') return { action: 'fail', outcome: 'not_retryable' };
  if (kind === 'infra') {
    // Infra exhaustion is always a hard failure: the agent never ran, so
    // "skip this optional step" (soft_fail) is not the author's call to make.
    if (!policy.declared) return { action: 'fail', outcome: 'not_retryable' };
    if (state.infraRetries >= INFRA_RETRY_CAP) return { action: 'fail', outcome: 'infra_exhausted' };
    return { action: 'retry', next: { attempt: state.attempt, infraRetries: state.infraRetries + 1 }, backoffMs: policy.backoffMs };
  }
  // No retry declared: the failure is final and is reported as it is, not as "exhausted".
  if (!policy.declared) return { action: 'fail', outcome: 'not_retryable' };
  if (state.attempt >= policy.maxAttempts) {
    return policy.onExhausted === 'soft_fail' ? { action: 'soft_fail', outcome: 'exhausted' } : { action: 'fail', outcome: 'exhausted' };
  }
  return { action: 'retry', next: { attempt: state.attempt + 1, infraRetries: state.infraRetries }, backoffMs: policy.backoffMs };
}
