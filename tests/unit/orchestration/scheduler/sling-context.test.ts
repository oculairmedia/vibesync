import { describe, expect, it } from 'vitest';

import {
  SlingContextManager,
  SLING_CONTEXT_LABEL,
  SLING_CONTEXT_VERSION,
  serializeParams,
  tryParseParams,
  type SlingContextStore,
  type SlingCloseReason,
  type SlingContextParams,
} from '../../../../src/orchestration/scheduler/index.js';

/**
 * In-memory SlingContextStore fake. Also records every bead id it ever wrote
 * to, so tests can PROVE the work bead is never mutated by the scheduler.
 */
interface FakeContext {
  id: string;
  status: 'open' | 'closed';
  label: string;
  description: string;
  tracks: string;
  closeReason?: SlingCloseReason;
}

class FakeStore implements SlingContextStore {
  readonly contexts = new Map<string, FakeContext>();
  /** Every bead id this store wrote to (create/close). Used to assert the
   *  work bead is NEVER among them. */
  readonly writtenBeadIds: string[] = [];
  private seq = 0;

  async createSlingContext(input: {
    label: string; title: string; description: string; tracksWorkBeadId: string;
  }): Promise<string> {
    const id = `sling-ctx-${++this.seq}`;
    this.contexts.set(id, {
      id,
      status: 'open',
      label: input.label,
      description: input.description,
      tracks: input.tracksWorkBeadId,
    });
    this.writtenBeadIds.push(id); // the CONTEXT bead, never the work bead
    return id;
  }

  async listOpenSlingContexts(label: string): Promise<ReadonlyArray<{ id: string; description: string }>> {
    return [...this.contexts.values()]
      .filter((c) => c.status === 'open' && c.label === label)
      .map((c) => ({ id: c.id, description: c.description }));
  }

  async closeSlingContext(contextId: string, reason: SlingCloseReason): Promise<void> {
    const c = this.contexts.get(contextId);
    if (!c) throw new Error(`unknown context ${contextId}`);
    c.status = 'closed';
    c.closeReason = reason;
    this.writtenBeadIds.push(contextId); // still a context bead, never work bead
  }
}

const baseInput = {
  workBeadId: 'vibesync-work-1',
  targetProject: 'vibesync',
  formula: 'onboard-feature',
  args: 'do the thing',
  vars: 'k=v',
} as const;

describe('SlingContextManager (vibesync-63zx.1)', () => {
  it('atomic create: scheduleBead creates ONE open context tracking the work bead with version-1 JSON params', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store, now: () => new Date('2026-07-17T20:00:00Z') });

    const { context, created } = await mgr.scheduleBead(baseInput);

    expect(created).toBe(true);
    expect(context.status).toBe('open');
    expect(store.contexts.size).toBe(1);
    const raw = [...store.contexts.values()][0]!;
    expect(raw.label).toBe(SLING_CONTEXT_LABEL);
    expect(raw.tracks).toBe('vibesync-work-1'); // tracks -> work bead
    const params = JSON.parse(raw.description) as SlingContextParams;
    expect(params.version).toBe(SLING_CONTEXT_VERSION);
    expect(params.work_bead_id).toBe('vibesync-work-1');
    expect(params.target_project).toBe('vibesync');
    expect(params.formula).toBe('onboard-feature');
    expect(params.args).toBe('do the thing');
    expect(params.vars).toBe('k=v');
    expect(params.merge).toBe('direct');
    expect(params.dispatch_failures).toBe(0);
    expect(params.last_failure).toBe('');
    expect(params.enqueued_at).toBe('2026-07-17T20:00:00.000Z');
  });

  it('idempotency: double-schedule of the same work bead yields exactly ONE context', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store });

    const first = await mgr.scheduleBead(baseInput);
    const second = await mgr.scheduleBead(baseInput);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.context.id).toBe(first.context.id);
    expect(store.contexts.size).toBe(1);
    expect((await mgr.queryPending())).toHaveLength(1);
  });

  it('idempotency does NOT block a DIFFERENT work bead', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store });

    await mgr.scheduleBead(baseInput);
    const other = await mgr.scheduleBead({ ...baseInput, workBeadId: 'vibesync-work-2' });

    expect(other.created).toBe(true);
    expect(store.contexts.size).toBe(2);
    expect(await mgr.queryPending()).toHaveLength(2);
  });

  it('idempotency re-opens after a close: a closed context does not block re-scheduling', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store });

    const { context } = await mgr.scheduleBead(baseInput);
    await mgr.closeContext(context.id, 'dispatched');

    // Closed context is terminal; scheduling again is allowed (fresh claim).
    const again = await mgr.scheduleBead(baseInput);
    expect(again.created).toBe(true);
    expect(again.context.id).not.toBe(context.id);
    const open = await mgr.queryPending();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(again.context.id);
  });

  it('state transitions: open = SCHEDULED; closeContext(reason) makes it terminal for each reason', async () => {
    for (const reason of ['dispatched', 'circuit-broken', 'cleared'] as const) {
      const store = new FakeStore();
      const mgr = new SlingContextManager({ store });
      const { context } = await mgr.scheduleBead(baseInput);
      expect(await mgr.queryPending()).toHaveLength(1); // SCHEDULED

      await mgr.closeContext(context.id, reason);

      expect(store.contexts.get(context.id)!.status).toBe('closed');
      expect(store.contexts.get(context.id)!.closeReason).toBe(reason);
      expect(await mgr.queryPending()).toHaveLength(0); // no longer pending
    }
  });

  it('INVARIANT: the work bead is NEVER written by the scheduler (atomic-claim)', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store });

    const { context } = await mgr.scheduleBead(baseInput);
    await mgr.scheduleBead(baseInput); // idempotent no-op
    await mgr.closeContext(context.id, 'dispatched');
    await mgr.queryPending();

    // Every write the store saw was a context bead; the work bead id must
    // never appear among written bead ids.
    expect(store.writtenBeadIds).not.toContain('vibesync-work-1');
    for (const id of store.writtenBeadIds) {
      expect(id.startsWith('sling-ctx-')).toBe(true);
    }
  });

  it('queryPending skips malformed / wrong-version contexts instead of throwing', async () => {
    const store = new FakeStore();
    const mgr = new SlingContextManager({ store });
    await mgr.scheduleBead(baseInput); // valid
    // Inject a malformed open context directly.
    store.contexts.set('sling-ctx-bad', {
      id: 'sling-ctx-bad', status: 'open', label: SLING_CONTEXT_LABEL,
      description: '{not json', tracks: 'x',
    });
    store.contexts.set('sling-ctx-oldver', {
      id: 'sling-ctx-oldver', status: 'open', label: SLING_CONTEXT_LABEL,
      description: JSON.stringify({ version: 0, work_bead_id: 'y' }), tracks: 'y',
    });

    const pending = await mgr.queryPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.params.work_bead_id).toBe('vibesync-work-1');
  });

  it('serializeParams / tryParseParams round-trip', () => {
    const params: SlingContextParams = {
      version: SLING_CONTEXT_VERSION,
      work_bead_id: 'w', target_project: 'p', formula: 'f', args: 'a', vars: 'k=v',
      enqueued_at: '2026-07-17T20:00:00.000Z', merge: 'mr', convoy: 'cv-1',
      dispatch_failures: 2, last_failure: 'boom',
    };
    const parsed = tryParseParams(serializeParams(params));
    expect(parsed).toEqual(params);
    expect(tryParseParams('garbage')).toBeNull();
    expect(tryParseParams(JSON.stringify({ version: 99 }))).toBeNull();
  });
});
