/**
 * Pure wait evaluation (vibesync-9g24). No I/O, no clock of its own: the caller
 * supplies the named beads' statuses and "now", so the same inputs always give
 * the same verdict (the property restart-safety rests on).
 */

import type { WaitMode, WaitOutcome } from './types.js';

export type WaitVerdict =
  | { readonly kind: 'pending' }
  | { readonly kind: WaitOutcome; readonly reason: string };

export interface EvaluableWait {
  readonly id: string;
  readonly mode: WaitMode;
  readonly on: readonly string[];
  readonly note: string | undefined;
  readonly expiresAt: string | undefined;
}

/**
 * @param statuses bd status per named bead; a bead that does not exist is ABSENT.
 *
 * Precedence: satisfied beats expired (a wait whose beads all closed is ready
 * even if the deadline passed in the same interval). Time never makes a wait
 * ready — only closed beads do.
 */
export function evaluateWait(
  wait: EvaluableWait,
  statuses: ReadonlyMap<string, string>,
  nowMs: number,
): WaitVerdict {
  const closed = wait.on.filter((id) => statuses.get(id) === 'closed');
  const missing = wait.on.filter((id) => !statuses.has(id));

  if (wait.mode === 'all') {
    if (missing.length > 0) {
      return { kind: 'failed', reason: `${describeWait(wait)} cannot complete: bead ${missing.join(', ')} no longer exists` };
    }
    if (closed.length === wait.on.length) {
      return { kind: 'ready', reason: readyReason(wait) };
    }
  } else {
    if (closed.length > 0) {
      return { kind: 'ready', reason: readyReason(wait) };
    }
    if (missing.length === wait.on.length) {
      return { kind: 'failed', reason: `${describeWait(wait)} cannot complete: bead ${missing.join(', ')} no longer exists` };
    }
  }

  if (wait.expiresAt !== undefined) {
    const deadline = Date.parse(wait.expiresAt);
    if (Number.isFinite(deadline) && nowMs >= deadline) {
      return { kind: 'expired', reason: `${describeWait(wait)} expired at ${wait.expiresAt} before it was satisfied${noteSuffix(wait)}` };
    }
  }
  return { kind: 'pending' };
}

/** The wake reason for a satisfied wait: the caller's note verbatim, else a sentence. */
export function readyReason(wait: Pick<EvaluableWait, 'id' | 'mode' | 'on' | 'note'>): string {
  if (wait.note !== undefined && wait.note.length > 0) return wait.note;
  return `${describeWait(wait)} satisfied`;
}

export function describeWait(wait: Pick<EvaluableWait, 'id' | 'mode' | 'on'>): string {
  return `wait ${wait.id} (${wait.mode} of ${wait.on.join(', ')})`;
}

function noteSuffix(wait: Pick<EvaluableWait, 'note'>): string {
  return wait.note !== undefined && wait.note.length > 0 ? `: ${wait.note}` : '';
}
