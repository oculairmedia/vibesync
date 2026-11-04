/**
 * Durable wait-on-beads: shared types (vibesync-9g24).
 *
 * A wait is ONE bead (bd issue_type `gate`, label {@link WAIT_LABEL}) that names
 * the beads it waits on, a mode (`any` | `all`), an optional note and the waiter
 * to wake. Everything the watcher needs survives a restart because it lives in
 * the bead (invariant 2: domain state stays in bd); this module keeps no state.
 *
 * Why a bead of our own rather than `bd gate --type=bead` is documented in
 * docs/waits.md (the gap table), not repeated here.
 */

/**
 * Minimum bd release every behaviour this module relies on was verified
 * against (`gate create --type bead`, `list --id --include-gates`, `update
 * --metadata` shallow merge, `dep add` blocking `bd ready`). Reconciled with
 * the boot-time bd version check at merge (vibesync-efee).
 */
export const MIN_BD_VERSION_FOR_WAITS = '1.3.2';

/** Label carried by every wait bead. */
export const WAIT_LABEL = 'vibesync:wait';

/** Bus events (layer `daemon`, kind namespaced `waits/`). */
export const WAIT_READY_EVENT = 'waits/wait.ready';
export const WAIT_EXPIRED_EVENT = 'waits/wait.expired';
export const WAIT_FAILED_EVENT = 'waits/wait.failed';

export type WaitMode = 'any' | 'all';

/**
 * Wait lifecycle, persisted in the bead's `metadata.state`:
 *
 *   pending  open   waiting on the named beads
 *   ready    open   condition met; the wake is OWED (re-delivered until the sink accepts it)
 *   closed   closed condition met and the wake was delivered
 *   canceled closed withdrawn by the caller; no wake
 *   expired  closed `timeoutMs` elapsed before the condition was met (waiter notified)
 *   failed   closed a named bead vanished, or the wake could not be delivered
 *            (waiter notified when the sink is still usable)
 *
 * `expired` / `failed` are written while the bead is still open and the notify
 * is owed, exactly like `ready`; the bead is closed only after the sink accepted.
 */
export type WaitState = 'pending' | 'ready' | 'closed' | 'canceled' | 'expired' | 'failed';

export type WaitOutcome = 'ready' | 'expired' | 'failed';

export type WaiterKind = 'bead' | 'agent' | 'session';

export interface WaitWaiter {
  readonly kind: WaiterKind;
  readonly id: string;
}

export interface NewWait {
  /** Bead ids to wait on (same bd store). Non-empty, unique. */
  readonly on: readonly string[];
  /** Default `all`. */
  readonly mode?: WaitMode;
  /** Delivered to the waiter as the wake reason. */
  readonly note?: string;
  readonly waiter: WaitWaiter;
  /**
   * Optional deadline. Persisted as an absolute timestamp and compared against
   * the wall clock during reconcile; it can only ever EXPIRE a wait, never
   * satisfy one.
   */
  readonly timeoutMs?: number;
}

export interface WaitRecord {
  readonly id: string;
  readonly mode: WaitMode;
  readonly on: readonly string[];
  readonly note: string | undefined;
  readonly waiter: WaitWaiter;
  readonly state: WaitState;
  readonly createdAt: string | undefined;
  readonly expiresAt: string | undefined;
  readonly wakeAttempts: number;
  /** Wake reason recorded when the wait resolved (ready / expired / failed). */
  readonly reason: string | undefined;
  /** bd's own status of the wait bead (`closed` is terminal). */
  readonly beadStatus: string;
}

/** Everything the sink needs to wake a waiter; `reason` is the text the waiter receives. */
export interface WakeRequest {
  readonly waitId: string;
  readonly outcome: WaitOutcome;
  readonly waiter: WaitWaiter;
  /** The note when one was given (ready), otherwise a generated sentence. This is the wake reason. */
  readonly reason: string;
  readonly note: string | undefined;
  readonly on: readonly string[];
  readonly mode: WaitMode;
}

/**
 * Where a wake goes. Delivery is AT-LEAST-ONCE across a crash between the sink
 * accepting and the bead closing, so a real sink must treat `waitId` as an
 * idempotency key. The real waker (vibesync-2bgv / x38j) is not part of this
 * module: the default sink only logs.
 */
export interface WaitWakeSink {
  wake(request: WakeRequest): Promise<void> | void;
}

/** Persistence port. The only implementation is {@link BdWaitStore}; tests use the real one. */
export interface WaitStore {
  create(wait: NewWait, meta: { readonly createdAt: string; readonly expiresAt: string | undefined }): Promise<string>;
  /** Waits whose bead is not closed, in any state. */
  listActive(): Promise<WaitRecord[]>;
  get(id: string): Promise<WaitRecord | null>;
  /** bd status per id; ids that do not exist are ABSENT from the map. */
  beadStatuses(ids: readonly string[]): Promise<Map<string, string>>;
  patch(id: string, patch: Readonly<Record<string, unknown>>): Promise<void>;
  /** Idempotent. */
  close(id: string, reason: string): Promise<void>;
  /** Make a waiter bead sleep: `bd ready` excludes it until the wait closes. */
  blockWaiter(waiterBeadId: string, waitId: string): Promise<void>;
}

export interface WaitLogger {
  info?(o: unknown, m: string): void;
  warn?(o: unknown, m: string): void;
}
