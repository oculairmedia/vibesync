import { describe, expect, it } from 'vitest';

import { INFRA_RETRY_CAP, classifyFailure, decideRetry, readFailureClass, readRetryState, resolveRetryPolicy } from '../../../../src/orchestration/retry/index.js';

const policy = (maxAttempts: number, onExhausted: 'fail' | 'soft_fail' = 'fail') => resolveRetryPolicy({ retry: { maxAttempts, onExhausted, backoffMs: 7 } });

describe('retry policy (pure; state comes from the bead metadata)', () => {
  it('readRetryState defaults to attempt 1 and accepts numbers or digit strings (bd --set-metadata writes strings)', () => {
    expect(readRetryState({})).toEqual({ attempt: 1, infraRetries: 0 });
    expect(readRetryState({ 'gc.retry_attempt': 3, 'gc.infra_retries': 2 })).toEqual({ attempt: 3, infraRetries: 2 });
    expect(readRetryState({ 'gc.retry_attempt': '2' })).toEqual({ attempt: 2, infraRetries: 0 });
    expect(readRetryState({ 'gc.retry_attempt': 'junk', 'gc.infra_retries': -1 })).toEqual({ attempt: 1, infraRetries: 0 });
  });

  it('readFailureClass: a non-empty string only', () => {
    expect(readFailureClass({ failure_class: ' flaky ' })).toBe('flaky');
    expect(readFailureClass({ failure_class: '' })).toBeNull();
    expect(readFailureClass({})).toBeNull();
  });

  it('agent failure: retry while attempts remain, then soft_fail or fail per on_exhausted', () => {
    expect(decideRetry({ policy: policy(3), state: { attempt: 1, infraRetries: 0 }, kind: 'agent' })).toEqual({ action: 'retry', next: { attempt: 2, infraRetries: 0 }, backoffMs: 7 });
    expect(decideRetry({ policy: policy(3), state: { attempt: 3, infraRetries: 0 }, kind: 'agent' })).toEqual({ action: 'fail', outcome: 'exhausted' });
    expect(decideRetry({ policy: policy(3, 'soft_fail'), state: { attempt: 3, infraRetries: 0 }, kind: 'agent' })).toEqual({ action: 'soft_fail', outcome: 'exhausted' });
  });

  it('infra failure never moves the attempt, is capped, and its exhaustion is a hard fail even under soft_fail', () => {
    const p = policy(3, 'soft_fail');
    expect(decideRetry({ policy: p, state: { attempt: 2, infraRetries: 0 }, kind: 'infra' })).toMatchObject({ action: 'retry', next: { attempt: 2, infraRetries: 1 } });
    expect(decideRetry({ policy: p, state: { attempt: 2, infraRetries: INFRA_RETRY_CAP }, kind: 'infra' })).toEqual({ action: 'fail', outcome: 'infra_exhausted' });
  });

  it('terminal failures and undeclared policies are never retried', () => {
    expect(decideRetry({ policy: policy(5), state: { attempt: 1, infraRetries: 0 }, kind: 'terminal' })).toEqual({ action: 'fail', outcome: 'not_retryable' });
    const none = resolveRetryPolicy({});
    expect(decideRetry({ policy: none, state: { attempt: 1, infraRetries: 0 }, kind: 'infra' })).toEqual({ action: 'fail', outcome: 'not_retryable' });
    expect(decideRetry({ policy: none, state: { attempt: 1, infraRetries: 0 }, kind: 'agent' })).toEqual({ action: 'fail', outcome: 'not_retryable' });
  });

  it('classifyFailure uses the structured code and whether the agent produced output, never the message', () => {
    const ev = (code: string, producedOutput = false) => classifyFailure({ origin: 'event', code, producedOutput });
    expect(ev('IrohConnectionLostError')).toBe('infra');
    expect(ev('stream_error')).toBe('infra');
    expect(ev('turn_timeout')).toBe('infra');
    expect(ev('turn_timeout', true)).toBe('agent');
    expect(ev('stop_reason', true)).toBe('agent');
    expect(ev('empty_output')).toBe('agent');
    expect(ev('requires_approval')).toBe('terminal');
    expect(ev('cancelled')).toBe('terminal');
    expect(ev('whatever')).toBe('agent');
    expect(classifyFailure({ origin: 'call' })).toBe('infra');
    expect(classifyFailure({ origin: 'stopped' })).toBe('terminal');
  });
});
