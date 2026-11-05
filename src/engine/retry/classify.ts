/**
 * Infra vs agent failure, classified from STRUCTURED signals only: the
 * runtime's error-event `code` (iroh-wrapper-provider.ts) plus whether the
 * agent had produced any output. Never from the free-text message.
 *
 *   code                                              kind
 *   ------------------------------------------------  ---------------------------------
 *   Iroh*Error, FrameTooLargeError, iroh_error        infra   (transport / wrapper refusal)
 *   stream_error, sse_read_error, empty_body          infra   (letta-code shim transport)
 *   unknown_session                                   infra   (session vanished under us)
 *   input_rejected, requires_approval                 terminal (deterministic environment/config
 *                                                     error: another try hits the same wall)
 *   turn_timeout, stop_reason, turn_failed            infra iff the agent produced NO output,
 *                                                     else agent (it ran, then died)
 *   empty_output                                      agent   (turn completed, said nothing)
 *   cancelled / the `stopped` event                   terminal (never retried)
 *   anything else                                     agent   (UNCLASSIFIED: burns an attempt,
 *                                                     which is the explicitly configured bound)
 *   a thrown error from start/prompt/bootstrap/store  infra   (origin 'call')
 */

import type { FailureKind } from './policy.js';

export type FailureSignal =
  | { readonly origin: 'event'; readonly code: string; readonly producedOutput: boolean }
  | { readonly origin: 'stopped' }
  | { readonly origin: 'call' };

const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'iroh_error',
  'FrameTooLargeError',
  'stream_error',
  'sse_read_error',
  'empty_body',
  'unknown_session',
]);

const DETERMINISTIC_CODES: ReadonlySet<string> = new Set(['input_rejected', 'requires_approval']);

const TURN_LEVEL_CODES: ReadonlySet<string> = new Set(['turn_timeout', 'stop_reason', 'turn_failed']);

export function classifyFailure(signal: FailureSignal): FailureKind {
  if (signal.origin === 'stopped') return 'terminal';
  if (signal.origin === 'call') return 'infra';
  const { code, producedOutput } = signal;
  if (code === 'cancelled' || DETERMINISTIC_CODES.has(code)) return 'terminal';
  if (TRANSPORT_CODES.has(code) || /^Iroh[A-Za-z]*Error$/.test(code)) return 'infra';
  if (TURN_LEVEL_CODES.has(code)) return producedOutput ? 'agent' : 'infra';
  return 'agent';
}
