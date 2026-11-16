/**
 * The in-memory tracker stand-in answers listIssueStatusSince the way DoltClient does
 * (vibesync-yvmk), so tests that boot the engine run the status poller against it
 * instead of the engine skipping the poller for a store without the method.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import { StatusChangePoller } from '../../../../src/engine/store/status-change-poller.js';
import { EventBus, BEADS_ISSUE_STATUS_CHANGED_EVENT, type Event } from '../../../../src/engine/events/index.js';

type Row = Record<string, unknown>;
function seed(store: InMemoryDoltClient, rows: ReadonlyArray<{ id: string; type: string; status: string; at: string }>): void {
  const beads = (store as unknown as { beads: Map<string, Row> }).beads;
  for (const r of rows) beads.set(r.id, { id: r.id, title: r.id, issue_type: r.type, status: r.status, metadata: {}, created_at: new Date(r.at), updated_at: new Date(r.at), closed_at: null });
}

describe('InMemoryDoltClient.listIssueStatusSince', () => {
  it('returns issues at or after the cursor, ordered by time then id, without engine-owned run beads', async () => {
    const store = new InMemoryDoltClient();
    seed(store, [
      { id: 'b', type: 'task', status: 'open', at: '2026-11-15T10:00:01Z' },
      { id: 'a', type: 'bug', status: 'closed', at: '2026-11-15T10:00:01Z' },
      { id: 'old', type: 'task', status: 'open', at: '2026-11-15T09:59:59Z' },
      { id: 'mol', type: 'molecule_root', status: 'open', at: '2026-11-15T10:00:02Z' },
      { id: 'step', type: 'molecule_step', status: 'closed', at: '2026-11-15T10:00:02Z' },
      { id: 'gate', type: 'gate', status: 'open', at: '2026-11-15T10:00:02Z' },
      { id: 'c', type: 'task', status: 'in_progress', at: '2026-11-15T10:00:03Z' },
    ]);
    const rows = await store.listIssueStatusSince(new Date('2026-11-15T10:00:01Z'), 500);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toEqual({ id: 'a', status: 'closed', updated_at: new Date('2026-11-15T10:00:01Z') });
  });

  it('pages within one second by id, as the real query does', async () => {
    const store = new InMemoryDoltClient();
    seed(store, ['x1', 'x2', 'x3', 'x4'].map((id) => ({ id, type: 'task', status: 'open', at: '2026-11-15T10:00:00Z' })));
    const cursor = new Date('2026-11-15T10:00:00Z');
    const first = await store.listIssueStatusSince(cursor, 2);
    expect(first.map((r) => r.id)).toEqual(['x1', 'x2']);
    const next = await store.listIssueStatusSince(cursor, 2, { updatedAt: first[1]!.updated_at, id: first[1]!.id });
    expect(next.map((r) => r.id)).toEqual(['x3', 'x4']);
  });

  it('a poller running against the stand-in emits a status change made through it', async () => {
    const store = new InMemoryDoltClient();
    seed(store, [{ id: 'w1', type: 'task', status: 'open', at: '2026-11-15T10:00:00Z' }]);
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((event) => { if (event.kind === BEADS_ISSUE_STATUS_CHANGED_EVENT) events.push(event); });
    const warnings: string[] = [];
    const poller = new StatusChangePoller({ store, bus, intervalMs: 60_000, logger: { warn: (_o, m) => { warnings.push(m); } } });
    await (poller as unknown as { readBatch(initial?: boolean): Promise<void> }).readBatch(true);
    const beads = (store as unknown as { beads: Map<string, Row> }).beads;
    beads.set('w1', { ...beads.get('w1')!, status: 'closed', updated_at: new Date('2026-11-15T10:00:05Z') });
    await (poller as unknown as { readBatch(initial?: boolean): Promise<void> }).readBatch(false);
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.payload)).toEqual([{ issueId: 'w1', from: 'open', to: 'closed' }]);
  });
});
