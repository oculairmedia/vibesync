/**
 * WaitService: create / cancel / read durable waits (vibesync-9g24).
 *
 * Standalone: needs only a {@link WaitStore}. No gate, formula, scheduler or
 * watcher is required to create or cancel a wait; the {@link WaitWatcher}
 * (watcher.ts) is what resolves them, and it is just as independent.
 */

import { assertBeadId } from './bd-wait-store.js';
import type { NewWait, WaitRecord, WaitStore } from './types.js';

export interface WaitServiceDeps {
  readonly store: WaitStore;
  readonly now?: () => Date;
  /**
   * Put a `bead` waiter to sleep: `bd dep add <waiter> <wait>` keeps it out of
   * `bd ready` until the wait bead closes (ready, canceled, expired or failed).
   * Default true; `agent` / `session` waiters have no bead to block.
   */
  readonly blockBeadWaiters?: boolean;
}

export class WaitService {
  private readonly now: () => Date;

  constructor(private readonly deps: WaitServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Returns the wait bead id. Throws (creating nothing durable) on invalid input. */
  async create(wait: NewWait): Promise<string> {
    const on = [...new Set(wait.on)];
    if (on.length === 0) throw new Error('a wait must name at least one bead to wait on');
    if (on.length !== wait.on.length) throw new Error('a wait names the same bead more than once');
    for (const id of on) assertBeadId(id, 'wait target');
    if (wait.waiter.id.trim().length === 0) throw new Error('a wait needs a waiter id');
    if (wait.waiter.kind === 'bead') {
      assertBeadId(wait.waiter.id, 'waiter bead');
      if (on.includes(wait.waiter.id)) throw new Error(`bead ${wait.waiter.id} cannot wait on itself`);
    }
    if (wait.mode !== undefined && wait.mode !== 'any' && wait.mode !== 'all') {
      throw new Error(`unknown wait mode ${JSON.stringify(wait.mode)}`);
    }
    if (wait.timeoutMs !== undefined && !(Number.isSafeInteger(wait.timeoutMs) && wait.timeoutMs > 0)) {
      throw new Error('timeoutMs must be a positive integer (milliseconds)');
    }

    const existing = await this.deps.store.beadStatuses(on);
    const missing = on.filter((id) => !existing.has(id));
    if (missing.length > 0) throw new Error(`cannot wait on unknown bead(s): ${missing.join(', ')}`);

    const createdAt = this.now();
    const expiresAt = wait.timeoutMs !== undefined ? new Date(createdAt.getTime() + wait.timeoutMs).toISOString() : undefined;
    const id = await this.deps.store.create({ ...wait, on }, { createdAt: createdAt.toISOString(), expiresAt });

    if (wait.waiter.kind === 'bead' && this.deps.blockBeadWaiters !== false) {
      try {
        await this.deps.store.blockWaiter(wait.waiter.id, id);
      } catch (err) {
        // Do not leave an orphan wait whose waiter never slept.
        await this.cancel(id).catch(() => undefined);
        throw err;
      }
    }
    return id;
  }

  /**
   * Withdraw a pending wait; no wake is sent. Idempotent. Returns false when the
   * wait is unknown or already resolved (a ready/expired/failed wait still owes
   * its wake and is not cancelable).
   */
  async cancel(waitId: string, reason = 'canceled'): Promise<boolean> {
    const rec = await this.deps.store.get(waitId);
    if (!rec) return false;
    if (rec.state === 'canceled') {
      if (rec.beadStatus !== 'closed') await this.deps.store.close(waitId, reason);
      return true;
    }
    if (rec.state !== 'pending') return false;
    await this.deps.store.patch(waitId, { state: 'canceled', reason });
    await this.deps.store.close(waitId, reason);
    return true;
  }

  get(waitId: string): Promise<WaitRecord | null> {
    return this.deps.store.get(waitId);
  }
}
