import { describe, expect, it, vi } from 'vitest';

import {
  SchedulerLoop,
  planDispatch,
  compareCandidates,
  type SchedulerConfig,
  type SchedulerContextStore,
  type DispatchCandidate,
} from '../../../../src/orchestration/scheduler/index.js';
import type { SlingContextRecord } from '../../../../src/orchestration/scheduler/sling-context.js';

/** Build a sling-context record with sensible defaults. */
function ctx(workBeadId: string, over: Partial<{
  id: string; enqueued_at: string; dispatch_failures: number;
}> = {}): SlingContextRecord {
  return {
    id: over.id ?? `ctx-${workBeadId}`,
    status: 'open',
    params: {
      version: 1,
      work_bead_id: workBeadId,
      target_project: 'vibesync',
      formula: 'onboard-feature',
      args: '', vars: '',
      enqueued_at: over.enqueued_at ?? '2026-07-17T20:00:00Z',
      merge: 'direct', convoy: '',
      dispatch_failures: over.dispatch_failures ?? 0,
      last_failure: '',
    },
  };
}

/** In-memory scheduler context store recording closes + failure increments. */
class FakeContextStore implements SchedulerContextStore {
  contexts: SlingContextRecord[];
  readonly closed: Array<{ id: string; reason: string }> = [];
  readonly failures = new Map<string, number>();
  constructor(contexts: SlingContextRecord[]) { this.contexts = contexts; }
  async queryPending(): Promise<SlingContextRecord[]> {
    return this.contexts.filter((c) => c.status === 'open');
  }
  async closeContext(contextId: string, reason: 'dispatched' | 'circuit-broken'): Promise<void> {
    this.closed.push({ id: contextId, reason });
    const c = this.contexts.find((x) => x.id === contextId);
    if (c) (c as { status: string }).status = 'closed';
  }
  async recordDispatchFailure(contextId: string, _error: string): Promise<number> {
    const n = (this.failures.get(contextId) ?? 0) + 1;
    this.failures.set(contextId, n);
    // reflect back onto the record so a re-query sees the new count
    const c = this.contexts.find((x) => x.id === contextId);
    if (c) (c.params as { dispatch_failures: number }).dispatch_failures = n;
    return n;
  }
}

const readySource = (ids: string[]) => ({
  async readyWorkBeadIds() { return new Set(ids); },
});

const defaultMeta = {
  async metadataFor(_r: SlingContextRecord) {
    return { priority: 2, unblockCount: 0, files: [] as string[] };
  },
};

function config(over: Partial<SchedulerConfig> = {}): () => SchedulerConfig {
  return () => ({ poolSize: over.poolSize ?? 2, batchSize: over.batchSize ?? 10, paused: over.paused ?? false });
}

describe('planDispatch (vibesync-63zx.3)', () => {
  const cand = (id: string, over: Partial<DispatchCandidate> = {}): DispatchCandidate => ({
    contextId: `ctx-${id}`, workBeadId: id, priority: 2, unblockCount: 0,
    enqueuedAt: '2026-07-17T20:00:00Z', files: [], dispatchFailures: 0, ...over,
  });

  it('toDispatch = min(capacity, batchSize, ready)', () => {
    const c = [cand('a'), cand('b'), cand('c'), cand('d')];
    expect(planDispatch(c, 2, 10, 3).toDispatch).toHaveLength(2); // capacity binds
    expect(planDispatch(c, 10, 2, 3).toDispatch).toHaveLength(2); // batch binds
    expect(planDispatch(c, 10, 10, 3).toDispatch).toHaveLength(4); // ready binds
    expect(planDispatch(c, 0, 10, 3).toDispatch).toHaveLength(0); // no capacity
  });

  it('orders by priority ASC, then unblockCount DESC, then age ASC', () => {
    const c = [
      cand('low-p1', { priority: 1, unblockCount: 0, enqueuedAt: '2026-01-01T00:00:00Z' }),
      cand('p0', { priority: 0, unblockCount: 0, enqueuedAt: '2026-06-01T00:00:00Z' }),
      cand('p1-unblocks5', { priority: 1, unblockCount: 5, enqueuedAt: '2026-05-01T00:00:00Z' }),
      cand('p1-old', { priority: 1, unblockCount: 0, enqueuedAt: '2025-01-01T00:00:00Z' }),
    ];
    const order = planDispatch(c, 10, 10, 3).toDispatch.map((x) => x.workBeadId);
    // P0 first; then among P1: highest unblockCount, then oldest.
    expect(order).toEqual(['p0', 'p1-unblocks5', 'p1-old', 'low-p1']);
  });

  it('excludes circuit-broken candidates (dispatchFailures >= threshold)', () => {
    const c = [cand('ok'), cand('broken', { dispatchFailures: 3 })];
    const plan = planDispatch(c, 10, 10, 3);
    expect(plan.toDispatch.map((x) => x.workBeadId)).toEqual(['ok']);
  });

  it('file-overlap serialization: two candidates touching the same file are not both dispatched', () => {
    const c = [
      cand('a', { priority: 0, files: ['src/x.ts'] }),
      cand('b', { priority: 1, files: ['src/x.ts', 'src/y.ts'] }),
      cand('d', { priority: 1, files: ['src/z.ts'] }),
    ];
    const plan = planDispatch(c, 10, 10, 3);
    const ids = plan.toDispatch.map((x) => x.workBeadId);
    expect(ids).toContain('a');
    expect(ids).toContain('d'); // no overlap with a
    expect(ids).not.toContain('b'); // overlaps a on src/x.ts
    expect(plan.skipped.find((s) => s.candidate.workBeadId === 'b')?.reason).toBe('file-overlap');
  });
});

describe('SchedulerLoop.runTick (vibesync-63zx.3)', () => {
  it('N ready beads + poolSize=2 dispatches EXACTLY 2, then waits (no over-dispatch)', async () => {
    const store = new FakeContextStore([ctx('a'), ctx('b'), ctx('c'), ctx('d')]);
    const executed: string[] = [];
    const loop = new SchedulerLoop({
      config: config({ poolSize: 2, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a', 'b', 'c', 'd']),
      candidateMetadata: defaultMeta,
      executor: { async execute(c) { executed.push(c.workBeadId); } },
    });

    const r = await loop.runTick();
    expect(r.dispatched).toHaveLength(2);
    expect(executed).toHaveLength(2);
    expect(store.closed.filter((x) => x.reason === 'dispatched')).toHaveLength(2);
    // The remaining two stay scheduled (open) for a later tick.
    expect(store.contexts.filter((c) => c.status === 'open')).toHaveLength(2);
  });

  it('respects already-active slots: poolSize=3 with 2 active dispatches only 1', async () => {
    const store = new FakeContextStore([ctx('a'), ctx('b'), ctx('c')]);
    const loop = new SchedulerLoop({
      config: config({ poolSize: 3, batchSize: 10 }),
      capacity: { activeCount: 2 }, // only 1 free slot
      contextStore: store,
      readyWork: readySource(['a', 'b', 'c']),
      candidateMetadata: defaultMeta,
      executor: { async execute() {} },
    });
    const r = await loop.runTick();
    expect(r.dispatched).toHaveLength(1);
  });

  it('joins against bd ready: only unblocked beads are dispatched', async () => {
    const store = new FakeContextStore([ctx('a'), ctx('blocked')]);
    const executed: string[] = [];
    const loop = new SchedulerLoop({
      config: config({ poolSize: 5, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a']), // 'blocked' is NOT ready
      candidateMetadata: defaultMeta,
      executor: { async execute(c) { executed.push(c.workBeadId); } },
    });
    await loop.runTick();
    expect(executed).toEqual(['a']);
  });

  it('circuit breaker: a context is closed circuit-broken after 3 failed dispatches', async () => {
    const store = new FakeContextStore([ctx('flaky')]);
    const loop = new SchedulerLoop({
      config: config({ poolSize: 1, batchSize: 1 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['flaky']),
      candidateMetadata: defaultMeta,
      executor: { async execute() { throw new Error('dispatch boom'); } },
    });

    // Tick 1 & 2: fail, still scheduled (below threshold).
    await loop.runTick();
    await loop.runTick();
    expect(store.contexts[0]!.status).toBe('open');
    expect(store.closed.filter((x) => x.reason === 'circuit-broken')).toHaveLength(0);

    // Tick 3: third failure trips the breaker → closed circuit-broken.
    const r3 = await loop.runTick();
    expect(r3.circuitBroken).toHaveLength(1);
    expect(store.closed.filter((x) => x.reason === 'circuit-broken')).toHaveLength(1);
    expect(store.contexts[0]!.status).toBe('closed');
  });

  it('no double-dispatch: a dispatched context is closed and not re-dispatched next tick', async () => {
    const store = new FakeContextStore([ctx('a')]);
    const executed: string[] = [];
    const loop = new SchedulerLoop({
      config: config({ poolSize: 5, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a']),
      candidateMetadata: defaultMeta,
      executor: { async execute(c) { executed.push(c.workBeadId); } },
    });
    await loop.runTick(); // dispatches a, closes context
    await loop.runTick(); // a's context is now closed → nothing to do
    expect(executed).toEqual(['a']); // dispatched exactly once
  });

  it('paused config is a no-op (zero dispatch)', async () => {
    const store = new FakeContextStore([ctx('a')]);
    let called = false;
    const loop = new SchedulerLoop({
      config: config({ paused: true }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a']),
      candidateMetadata: defaultMeta,
      executor: { async execute() { called = true; } },
    });
    const r = await loop.runTick();
    expect(r.skippedReason).toBe('paused');
    expect(called).toBe(false);
  });

  it('dispatch lock serializes: a concurrent second tick is skipped', async () => {
    const store = new FakeContextStore([ctx('a'), ctx('b')]);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => { releaseFirst = res; });
    const loop = new SchedulerLoop({
      config: config({ poolSize: 5, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a', 'b']),
      candidateMetadata: defaultMeta,
      executor: { async execute() { await gate; } }, // hold the first tick open
    });
    const first = loop.runTick();
    const second = await loop.runTick(); // runs while first holds the lock
    expect(second.skippedReason).toBe('locked');
    releaseFirst();
    await first;
  });

  // vibesync-63zx.3 (Meridian hardening): a FAILED dispatch (below the circuit
  // threshold) must NOT close the context as `dispatched`. It stays OPEN so the
  // next tick retries it — otherwise a transient dispatch error would silently
  // drop the work bead from the queue forever.
  it('a failed dispatch below threshold leaves the context OPEN for retry (not closed dispatched)', async () => {
    const store = new FakeContextStore([ctx('a')]);
    const loop = new SchedulerLoop({
      config: config({ poolSize: 3, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a']),
      candidateMetadata: defaultMeta,
      executor: { async execute() { throw new Error('transient dispatch error'); } },
    });
    const r = await loop.runTick();
    expect(r.failed).toEqual(['a']);
    expect(r.dispatched).toEqual([]);
    // context 'ctx-a' must still be OPEN (not closed), and never closed as 'dispatched'
    expect(store.closed).toEqual([]);
    expect(store.contexts.find((c) => c.id === 'ctx-a')?.status).toBe('open');
    expect(store.failures.get('ctx-a')).toBe(1);
  });

  // vibesync-63zx.3 (Meridian hardening): one rejecting executor mid-batch must
  // NOT abort the rest of the batch — the loop iterates candidates independently,
  // so a bad dispatch for one bead cannot starve the others.
  it('a rejecting dispatch mid-batch does not block the other beads in the same tick', async () => {
    const store = new FakeContextStore([ctx('a'), ctx('b'), ctx('c')]);
    const loop = new SchedulerLoop({
      config: config({ poolSize: 5, batchSize: 10 }),
      capacity: { activeCount: 0 },
      contextStore: store,
      readyWork: readySource(['a', 'b', 'c']),
      candidateMetadata: defaultMeta,
      // 'b' fails; 'a' and 'c' must still dispatch.
      executor: {
        async execute(cand) {
          if (cand.workBeadId === 'b') throw new Error('b is unlucky');
        },
      },
    });
    const r = await loop.runTick();
    expect(new Set(r.dispatched)).toEqual(new Set(['a', 'c']));
    expect(r.failed).toEqual(['b']);
    // a and c closed as dispatched; b left open for retry
    expect(store.contexts.find((c) => c.id === 'ctx-b')?.status).toBe('open');
    expect(store.contexts.find((c) => c.id === 'ctx-a')?.status).toBe('closed');
    expect(store.contexts.find((c) => c.id === 'ctx-c')?.status).toBe('closed');
  });
});
