import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type Event } from '../../../src/engine/events/index.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../../../src/engine/events/beads.js';
import { StatusChangePoller } from '../../../src/engine/store/status-change-poller.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './isolated-beads.js';

describe.skipIf(!RUN_ISOLATED_BEADS)('status change poller on real bd (isolated repo)', () => {
  let h: Awaited<ReturnType<typeof provisionIsolatedBeads>>;
  beforeAll(async () => { h = await provisionIsolatedBeads('fresh'); }, 120_000);
  afterAll(async () => { await h?.close(); }, 120_000);

  it('emits an event after bd closes a work issue', async () => {
    const id = String(JSON.parse(h.bd('create', 'poller integration', '--type', 'task', '--json'))['id']);
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const poller = new StatusChangePoller({ store: h.client, bus, intervalMs: 100 });
    try {
      await poller.poll();
      h.bd('close', id);
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('status change was not emitted within two poll intervals')), 250);
        const unsubscribe = bus.subscribe((event) => {
          if (event.kind !== BEADS_ISSUE_STATUS_CHANGED_EVENT || event.task_id !== id) return;
          clearTimeout(deadline);
          unsubscribe();
          resolve();
        });
      });
      expect(events.filter((event) => event.kind === BEADS_ISSUE_STATUS_CHANGED_EVENT && event.task_id === id)).toHaveLength(1);
      expect(events.find((event) => event.task_id === id)?.payload).toEqual({ issueId: id, from: 'open', to: 'closed' });
    } finally {
      await poller.stop();
    }
  }, 30_000);
});
