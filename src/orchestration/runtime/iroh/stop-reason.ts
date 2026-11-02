/**
 * What a Letta `stop_reason` means for the turn it arrives on.
 *
 * Verbatim port of letta-mobile's `AppServerStopReason.boundaryOf`
 * (android-compose/sharedLogic/src/commonMain/kotlin/com/letta/mobile/data/
 * transport/appserver/AppServerStopReason.kt, origin/main). Terminal reasons
 * are the upstream StopReasonType plus the provider finish reasons the
 * lmstudio / OpenAI-compat path surfaces (`stop_sequence`, `max_tokens`,
 * `length`). An unrecognised reason is deliberately NOT terminal.
 */

export type TurnBoundary = 'completed' | 'cancelled' | 'failed' | 'awaiting_approval' | 'continuing';

export const REQUIRES_APPROVAL = 'requires_approval';

const COMPLETED: ReadonlySet<string> = new Set([
  'end_turn',
  'max_steps',
  'max_tokens_exceeded',
  'no_tool_call',
  'tool_rule',
  // Provider finish reasons (lmstudio / OpenAI-compat).
  'stop_sequence',
  'max_tokens',
  'length',
]);

const FAILED: ReadonlySet<string> = new Set([
  'error',
  'llm_api_error',
  'invalid_llm_response',
  'invalid_tool_call',
  'insufficient_credits',
  'context_window_overflow_in_system_prompt',
]);

/** A stop frame with no reason still ends the turn; it has always been read as completed. */
export function boundaryOf(stopReason: string | null | undefined): TurnBoundary {
  if (stopReason === null || stopReason === undefined) return 'completed';
  if (stopReason === REQUIRES_APPROVAL) return 'awaiting_approval';
  if (stopReason === 'cancelled') return 'cancelled';
  if (COMPLETED.has(stopReason)) return 'completed';
  if (FAILED.has(stopReason)) return 'failed';
  return 'continuing';
}

export function isTerminal(stopReason: string | null | undefined): boolean {
  const b = boundaryOf(stopReason);
  return b !== 'awaiting_approval' && b !== 'continuing';
}
