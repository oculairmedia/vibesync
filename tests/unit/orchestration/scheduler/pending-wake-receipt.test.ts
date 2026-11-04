import { expect, it, vi } from 'vitest';
import { BdPendingWakeStore } from '../../../../src/engine/pm-wake/pending-store.js';

it('finishes closing a confirmed delivery without sending it again', async () => {
  const receipt = { accepted: true, applicationDelivered: true, msgId: 'wake-1', observedAt: new Date(0).toISOString() };
  const row = {
    id: 'pending-1', status: 'in_progress', assignee: 'holder',
    metadata: { claimToken: 'holder', receipt, payload: {
      projectIdentifier: 'project', agentId: 'pm', msgId: 'wake-1', reason: 'event', detail: 'original', body: 'original', createdAt: new Date(0).toISOString(),
    } },
  };
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'list') return JSON.stringify([row]);
    if (args[0] === 'update' && args.includes('--status')) {
      expect(args[args.indexOf('--if-assignee') + 1]).toBe('holder');
      expect(args[args.indexOf('--if-status') + 1]).toBe('in_progress');
      row.status = args[args.indexOf('--status') + 1]!;
    }
    return '{}';
  });
  const store = new BdPendingWakeStore(run);
  const pending = await store.get(row.id);
  const wake = vi.fn(async () => ({ ok: true, accepted: true, applicationDelivered: true }));
  const result = await store.sendClaimed(pending!, { wake });
  expect(wake).not.toHaveBeenCalled();
  expect(row.status).toBe('closed');
  expect(result.outcome).toMatchObject({ ok: true, accepted: true, applicationDelivered: true, msgId: 'wake-1' });
  expect(result.receipt).toEqual(receipt);
});
