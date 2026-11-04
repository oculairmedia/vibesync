/**
 * The PM wake contract: what a wake is and how a sink delivers it. No imports,
 * so the waker, its state store, the pending-wake store and every sink can
 * depend on it without depending on each other.
 */

export type WakeReason = 'event' | 'ready' | 'stall' | 'backstop';

export const PM_WOKEN_EVENT = 'daemon/pm.woken';
export const PM_WAKE_SKIPPED_EVENT = 'daemon/pm.wake_skipped';

/** Wait after a failed wake before retrying it (ms). */
export const PM_WAKE_RETRY_BACKOFF_MS = 300_000;

export interface PmWakeInput {
  readonly agentId: string;
  readonly projectIdentifier: string;
  readonly reason: WakeReason;
  readonly detail: string;
  /** Stable per logical wake (reused on retry); becomes the inbox message id. */
  readonly wakeId: string;
  /** Optional producer correlation; absent for backstop wakes with no known work bead. */
  readonly correlation?: Readonly<Record<string, string>>;
}

export interface PmWakeOutcome {
  readonly ok: boolean;
  readonly accepted?: boolean;
  readonly applicationDelivered?: boolean;
  readonly msgId?: string;
  readonly reason?: string;
  readonly error?: string;
}

export interface PmWakeSink {
  wake(input: PmWakeInput): Promise<PmWakeOutcome>;
}

/** One-line wake message text, shared by every sink implementation. */
export function formatWakeMessage(input: Pick<PmWakeInput, 'reason' | 'detail' | 'wakeId'>): string {
  return `[vibesync wake] reason=${input.reason} detail=${input.detail.replace(/\s+/g, ' ').trim()} wakeId=${input.wakeId}`;
}
