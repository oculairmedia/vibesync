import { describe, expect, it } from 'vitest';

import { MIN_MODEL_RESPONSE_MS, assertNotFalsePass } from '../../../_fixtures/false-pass-guard.js';

describe('assertNotFalsePass (vibesync-jni4 false-pass guard)', () => {
  it('accepts a real-looking answer that took a plausible model time', () => {
    expect(() => assertNotFalsePass({ output: 'LGTM', durationMs: 2_600 })).not.toThrow();
    expect(() => assertNotFalsePass({ output: 'LGTM', durationMs: MIN_MODEL_RESPONSE_MS })).not.toThrow();
  });
  it('rejects a completion faster than the minimum model response time', () => {
    expect(() => assertNotFalsePass({ output: 'LGTM', durationMs: MIN_MODEL_RESPONSE_MS - 1 })).toThrow(/faster than the 1500 ms minimum/);
    expect(() => assertNotFalsePass({ output: 'LGTM', durationMs: 3 })).toThrow(/false pass/);
  });
  it('rejects tonight\'s placeholders even when slow and non-empty', () => {
    for (const out of ["Waiting for the coder's output.", "Waiting on the reviewer's result.", 'Waiting on task_37 to finish. Its result will come in as a task notification', 'Task running in background with task ID: task_4']) {
      expect(() => assertNotFalsePass({ output: out, durationMs: 60_000 })).toThrow(/placeholder/);
    }
  });
  it('rejects empty output', () => {
    expect(() => assertNotFalsePass({ output: '  ', durationMs: 60_000 })).toThrow(/empty/);
  });
});
