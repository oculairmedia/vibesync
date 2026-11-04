import { describe, expect, it } from 'vitest';

import { boundaryOf, isTerminal } from '../../../../../src/engine/runtime/iroh/stop-reason.js';

describe('boundaryOf (port of AppServerStopReason.kt)', () => {
  it.each(['end_turn', 'max_steps', 'max_tokens_exceeded', 'no_tool_call', 'tool_rule', 'stop_sequence', 'max_tokens', 'length'])(
    '%s -> completed',
    (r) => {
      expect(boundaryOf(r)).toBe('completed');
      expect(isTerminal(r)).toBe(true);
    },
  );

  it.each(['error', 'llm_api_error', 'invalid_llm_response', 'invalid_tool_call', 'insufficient_credits', 'context_window_overflow_in_system_prompt'])(
    '%s -> failed',
    (r) => {
      expect(boundaryOf(r)).toBe('failed');
      expect(isTerminal(r)).toBe(true);
    },
  );

  it('cancelled -> cancelled (terminal)', () => {
    expect(boundaryOf('cancelled')).toBe('cancelled');
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('requires_approval -> awaiting_approval, NOT terminal', () => {
    expect(boundaryOf('requires_approval')).toBe('awaiting_approval');
    expect(isTerminal('requires_approval')).toBe(false);
  });

  it('a stop with no reason (null / undefined) is completed', () => {
    expect(boundaryOf(null)).toBe('completed');
    expect(boundaryOf(undefined)).toBe('completed');
  });

  it('unknown reasons (including provider tool_use and the empty string) keep the turn open', () => {
    for (const r of ['tool_use', 'something_new', '']) {
      expect(boundaryOf(r)).toBe('continuing');
      expect(isTerminal(r)).toBe(false);
    }
  });
});
