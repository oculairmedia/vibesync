import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../../../../src/engine/events/beads.js';
import { StatusChangePoller, type IssueStatusRow } from '../../../../src/engine/store/status-change-poller.js';

const at = (second: number) => new Date(second * 1000);

describe('StatusChangePoller', () => {
  afterEach(() => vi.useRealTimers());

  it('emits actual status transitions once, including a transition in the cursor second', async () => {
    const batches: IssueStatusRow[][] = [
      [{ id: 'task-1', status: 'open', updated_at: at(10) }],
      [{ id: 'task-1', status: 'in_progress', updated_at: at(11) }],
      [{ id: 'task-1', status: 'in_progress', updated_at: at(11) }],
      [{ id: 'task-1', status: 'closed', updated_at: at(11) }, { id: 'task-2', status: 'open', updated_at: at(11) }],
    ];
    const store = { listIssueStatusSince: vi.fn(async (cursor: Date, limit: number) => {
      expect(limit).toBe(500);
      if (cursor.getTime() > 0) expect(cursor.getTime()).toBeGreaterThanOrEqual(at(10).getTime());
      return batches.shift() ?? [];
    }) };
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const poller = new StatusChangePoller({ store, bus });

    await poller.poll();
    expect(events).toHaveLength(0);
    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(events).toHaveLength(2);
    expect(events.map(({ kind, layer, task_id, payload }) => ({ kind, layer, task_id, payload }))).toEqual([
      { kind: BEADS_ISSUE_STATUS_CHANGED_EVENT, layer: 'molecule', task_id: 'task-1', payload: { issueId: 'task-1', from: 'open', to: 'in_progress' } },
      { kind: BEADS_ISSUE_STATUS_CHANGED_EVENT, layer: 'molecule', task_id: 'task-1', payload: { issueId: 'task-1', from: 'in_progress', to: 'closed' } },
    ]);
    expect(store.listIssueStatusSince.mock.calls[3]).toEqual([at(11), 500]);
  });

  it('warns once across failed reads, preserves the cursor, and emits recovered changes', async () => {
    const initial: IssueStatusRow[] = [{ id: 'task-1', status: 'open', updated_at: at(10) }];
    const recovered: IssueStatusRow[] = [{ id: 'task-1', status: 'closed', updated_at: at(12) }];
    const store = { listIssueStatusSince: vi.fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(recovered) };
    const logger = { warn: vi.fn() };
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const poller = new StatusChangePoller({ store, bus, logger });

    await poller.poll();
    for (let i = 0; i < 3; i += 1) await poller.poll();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(store.listIssueStatusSince.mock.calls.slice(1).map(([cursor]) => cursor)).toEqual([at(10), at(10), at(10)]);
    await poller.poll();

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ issueId: 'task-1', from: 'open', to: 'closed' });
  });

  it('runs an immediate boot read, polls on interval, and stops its timer', async () => {
    vi.useFakeTimers();
    const store = { listIssueStatusSince: vi.fn().mockResolvedValue([]) };
    const poller = new StatusChangePoller({ store, bus: new EventBus({ noPersist: true }), intervalMs: 50 });
    poller.start();
    await vi.waitFor(() => expect(store.listIssueStatusSince).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(store.listIssueStatusSince).toHaveBeenCalledTimes(2);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.listIssueStatusSince).toHaveBeenCalledTimes(2);
  });
});
