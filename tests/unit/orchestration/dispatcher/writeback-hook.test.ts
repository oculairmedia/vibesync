import { describe, expect, it, vi } from 'vitest';

import { installWritebackHook } from '../../../../src/orchestration/dispatcher/writeback-hook.js';
import { EventBus } from '../../../../src/orchestration/events/index.js';
import { MoleculeWalker } from '../../../../src/orchestration/molecule/index.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

interface MoleculeFixture {
  readonly rootId: string;
  readonly motivatingBeadId: string;
  readonly formulaName: string;
}

function fakeBead(id: string, title: string): {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  metadata: Record<string, unknown>;
} {
  const now = new Date();
  return {
    id,
    title,
    description: '',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    created_at: now,
    updated_at: now,
    closed_at: null,
    metadata: {},
  };
}

async function setupMolecule(store: InMemoryDoltClient, fx: MoleculeFixture): Promise<void> {
  // Motivating bead — just an issue with notes column we expect to be appended.
  store.beads.set(fx.motivatingBeadId, fakeBead(fx.motivatingBeadId, 'Motivating: please review vibesync-bll'));
  await store.insertMoleculeRoot({
    id: fx.rootId,
    formulaName: fx.formulaName,
    title: `[${fx.formulaName}] root`,
    motivatingBeadId: fx.motivatingBeadId,
  });
}

async function addStep(store: InMemoryDoltClient, rootId: string, stepName: string, output: string): Promise<void> {
  const stepId = `${rootId}-${stepName}`;
  await store.insertMoleculeStep({
    id: stepId,
    parentRootId: rootId,
    stepName,
    title: `[${rootId}] ${stepName}`,
    dependsOnStepIds: [],
    inputPayload: { input: 'test' },
  });
  await store.markStepDone(stepId, { output });
}

async function addFailedStep(store: InMemoryDoltClient, rootId: string, stepName: string, errorTrace: string): Promise<void> {
  const stepId = `${rootId}-${stepName}`;
  await store.insertMoleculeStep({
    id: stepId,
    parentRootId: rootId,
    stepName,
    title: `[${rootId}] ${stepName}`,
    dependsOnStepIds: [],
    inputPayload: { input: 'test' },
  });
  await store.markStepFailed(stepId, errorTrace);
}

describe('installWritebackHook', () => {
  it('appends a structured completion note to the motivating bead', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-aaa', motivatingBeadId: 'vibesync-bll', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'looks good but rename foo to bar');
    await addStep(store, fx.rootId, 'coder', 'renamed foo to bar in src/baz.ts');

    const when = new Date('2026-05-21T12:34:56Z');
    installWritebackHook({ bus, walker, store, now: () => when });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, durationMs: 1000 },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(1);
    const note = store.notes[0]!;
    expect(note.beadId).toBe(fx.motivatingBeadId);
    expect(note.note).toContain('formula code-review completed at 2026-05-21T12:34:56.000Z');
    expect(note.note).toContain(`moleculeId: ${fx.rootId}`);
    expect(note.note).toContain('reviewer: looks good but rename foo to bar');
    expect(note.note).toContain('coder: renamed foo to bar in src/baz.ts');
  });

  it('appends a failure note with failing role + error_trace', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-bbb', motivatingBeadId: 'vibesync-bll', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'ok');
    await addFailedStep(store, fx.rootId, 'coder', 'TypeError: cannot read property foo of undefined');

    installWritebackHook({ bus, walker, store, now: () => new Date('2026-05-21T13:00:00Z') });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.failed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, error: 'coder step crashed' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(1);
    const note = store.notes[0]!.note;
    expect(note).toContain('FAILED at 2026-05-21T13:00:00.000Z');
    expect(note).toContain('failing step: coder');
    expect(note).toContain('TypeError: cannot read property foo of undefined');
    // Closed non-failing steps included for context
    expect(note).toContain('reviewer: ok');
  });

  it('is a no-op when motivating_bead is absent', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const rootId = 'mol-mol-noamotive';
    await store.insertMoleculeRoot({ id: rootId, formulaName: 'code-review', title: '[code-review] root' });
    await addStep(store, rootId, 'reviewer', 'ok');

    installWritebackHook({ bus, walker, store });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: rootId,
      payload: { moleculeId: rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(0);
  });

  // vibesync-u32z: the persisted molecule_root lost its motivating_bead
  // (repro: mol-mol-nu3n4s38yfxx — exec was {formula, outcome} with no
  // motivating_bead), but the completion EVENT now carries it. The hook must
  // resolve the bead from the event and POST. On main the hook only reads the
  // root exec, so this FAILS (skipped-no-motivating-bead, no note); with the
  // fix it PASSES (posted).
  it('resolves motivating_bead from the completion event when the root lost it (mol-mol-nu3n4s38yfxx repro)', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const rootId = 'mol-mol-nu3n4s38yfxx';
    const motivatingBeadId = 'vibesync-sqt0';
    // Root persisted WITHOUT motivating_bead (the exact repro state), but the
    // motivating bead itself exists and should receive the note.
    store.beads.set(motivatingBeadId, fakeBead(motivatingBeadId, 'Motivating: review vibesync-sqt0'));
    await store.insertMoleculeRoot({ id: rootId, formulaName: 'code-review', title: '[code-review] root' });
    await addStep(store, rootId, 'reviewer', 'LGTM');

    const logger = { warn: vi.fn(), info: vi.fn() };
    installWritebackHook({ bus, walker, store, logger, now: () => new Date('2026-07-16T20:00:00Z') });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: rootId,
      // The event carries the motivating bead even though the root row does not.
      payload: { moleculeId: rootId, durationMs: 1, motivating_bead: motivatingBeadId },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]!.beadId).toBe(motivatingBeadId);
    expect(store.notes[0]!.note).toContain('formula code-review completed');
    expect(store.notes[0]!.note).toContain('reviewer: LGTM');
    const postedTrace = logger.info.mock.calls.find(
      ([obj]) => (obj as { action?: string })?.action === 'posted',
    );
    expect(postedTrace, 'expected a per-invocation info trace with action=posted').toBeDefined();
  });

  it('is idempotent — replaying the same event produces exactly one note', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-ccc', motivatingBeadId: 'vibesync-zzz', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    installWritebackHook({ bus, walker, store });

    const emit = (): void => {
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/formula.completed',
        molecule_id: fx.rootId,
        payload: { moleculeId: fx.rootId, durationMs: 1 },
      });
    };
    emit();
    emit();
    emit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(1);
  });

  it('ignores unrelated event kinds', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-ddd', motivatingBeadId: 'vibesync-aaa', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    installWritebackHook({ bus, walker, store });
    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/step.started',
      molecule_id: fx.rootId,
      payload: { stepName: 'reviewer' },
    });
    bus.emit({
      layer: 'runtime',
      kind: 'runtime/session.started',
      molecule_id: fx.rootId,
      payload: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(0);
  });

  it('unsubscribe stops further writeback', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-eee', motivatingBeadId: 'vibesync-bbb', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    const unsub = installWritebackHook({ bus, walker, store });
    unsub();
    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(0);
  });

  // vibesync-er21 regression: a transient store failure on note append must
  // NOT permanently mark the writeback as done. The prior implementation
  // stamped writeback_status BEFORE appending the note, so a transient
  // failure left the stamp set and every subsequent replay short-circuited —
  // the outcome was lost forever. This test FAILS on that old ordering
  // (the retry finds the stamp and posts nothing) and PASSES with the fix
  // (append first, stamp only on success → retry re-attempts and lands).
  it('does not permanently lose the writeback when the first append fails transiently', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-transient', motivatingBeadId: 'vibesync-byil', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'CHANGES-REQUESTED: rename foo to bar');

    const logger = { warn: vi.fn() };
    installWritebackHook({ bus, walker, store, logger });

    const emit = (): void => {
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/formula.completed',
        molecule_id: fx.rootId,
        payload: { moleculeId: fx.rootId, durationMs: 1000 },
      });
    };

    // First completion event: the store is flaky, the append throws.
    store.failNextAppends = 1;
    emit();
    await new Promise((resolve) => setImmediate(resolve));

    // Failure must be loud, and NO note landed, and the writeback must NOT
    // be stamped (so it stays retryable).
    expect(store.notes).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    const rootAfterFailure = await store.getBead(fx.rootId);
    const execAfterFailure = (rootAfterFailure?.metadata.exec ?? {}) as Record<string, unknown>;
    expect(execAfterFailure['writeback_status']).toBeUndefined();

    // Replay after the store recovers: the note must now land exactly once.
    emit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]!.beadId).toBe(fx.motivatingBeadId);
    expect(store.notes[0]!.note).toContain('formula code-review completed');
    expect(store.notes[0]!.note).toContain('reviewer: CHANGES-REQUESTED: rename foo to bar');

    // And now it is stamped, so a further replay is a no-op (idempotent).
    const rootAfterSuccess = await store.getBead(fx.rootId);
    const execAfterSuccess = (rootAfterSuccess?.metadata.exec ?? {}) as Record<string, unknown>;
    expect(execAfterSuccess['writeback_status']).toBe('completed');

    emit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.notes).toHaveLength(1);
  });

  it('stamps and skips (no infinite retry) when the motivating bead is gone', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-gcd', motivatingBeadId: 'vibesync-gcd', formulaName: 'code-review' };
    // Root exists with a motivating_bead ref, but the motivating bead itself
    // was GC'd — never inserted.
    await store.insertMoleculeRoot({
      id: fx.rootId,
      formulaName: fx.formulaName,
      title: '[code-review] root',
      motivatingBeadId: fx.motivatingBeadId,
    });
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    const logger = { warn: vi.fn() };
    installWritebackHook({ bus, walker, store, logger });
    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // No note (bead gone), warned once, and stamped so replays don't retry
    // a bead that will never come back. appendNoteToBead must not have been
    // attempted at all (existence checked first).
    expect(store.notes).toHaveLength(0);
    expect(store.appendAttempts).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
    const root = await store.getBead(fx.rootId);
    const exec = (root?.metadata.exec ?? {}) as Record<string, unknown>;
    expect(exec['writeback_status']).toBe('completed');
  });

  it('logs loudly (never silent) via console.error when no logger is injected and append fails', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-silent', motivatingBeadId: 'vibesync-loud', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      installWritebackHook({ bus, walker, store }); // no logger
      store.failNextAppends = 1;
      bus.emit({
        layer: 'dispatcher',
        kind: 'dispatcher/formula.completed',
        molecule_id: fx.rootId,
        payload: { moleculeId: fx.rootId, durationMs: 1 },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.notes).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // vibesync-er21 (hook-wiring): the hook's INVOCATION must be observable.
  // On current main the subscriber callback has no info/trace logging at all,
  // so a completed molecule produces NO log line — a fired-but-skipped hook
  // is indistinguishable from a hook that never subscribed. These three tests
  // FAIL on current main (logger.info never called) and PASS with the fix
  // (subscription-confirmed line at install + a per-invocation trace).
  it('logs a subscription-confirmed line at install (proves the hook is wired)', () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const logger = { warn: vi.fn(), info: vi.fn() };

    installWritebackHook({ bus, walker, store, logger });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [, msg] = logger.info.mock.calls[0]!;
    expect(String(msg)).toContain('subscribed to EventBus');
  });

  it('logs a per-invocation "posted" trace when a completed molecule writes back', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-trace-posted', motivatingBeadId: 'vibesync-f89x', formulaName: 'code-review' };
    await setupMolecule(store, fx);
    await addStep(store, fx.rootId, 'reviewer', 'LGTM');

    const logger = { warn: vi.fn(), info: vi.fn() };
    installWritebackHook({ bus, walker, store, logger });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Note landed (the fix keeps the append working) AND the invocation was
    // traced with action=posted.
    expect(store.notes).toHaveLength(1);
    const invocationCall = logger.info.mock.calls.find(
      ([obj]) => (obj as { action?: string })?.action === 'posted',
    );
    expect(invocationCall, 'expected a per-invocation info trace with action=posted').toBeDefined();
    expect(String(invocationCall![1])).toContain('writeback hook fired');
    expect((invocationCall![0] as { moleculeId?: string }).moleculeId).toBe(fx.rootId);
  });

  it('traces "skipped-no-motivating-bead" when a completed root carries no motivating bead (mol-mol-mcuv9s9o7aaa repro)', async () => {
    // Reproduces the real evidence: mol-mol-mcuv9s9o7aaa closed with
    // exec.outcome=completed but exec had NO motivating_bead, so no note and
    // no stamp were produced. On current main this case is completely silent;
    // with the fix the hook still fires and now emits a trace explaining WHY
    // nothing was posted, instead of looking like the hook never ran.
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const rootId = 'mol-mol-no-motivating';
    await store.insertMoleculeRoot({ id: rootId, formulaName: 'code-review', title: '[code-review] root' });
    await addStep(store, rootId, 'reviewer', 'LGTM');

    const logger = { warn: vi.fn(), info: vi.fn() };
    installWritebackHook({ bus, walker, store, logger });

    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: rootId,
      payload: { moleculeId: rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(0);
    const skipTrace = logger.info.mock.calls.find(
      ([obj]) => (obj as { action?: string })?.action === 'skipped-no-motivating-bead',
    );
    expect(skipTrace, 'expected a per-invocation info trace with action=skipped-no-motivating-bead').toBeDefined();
    expect((skipTrace![0] as { moleculeId?: string }).moleculeId).toBe(rootId);
  });

  it('logs and swallows when the motivating bead is gone', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store as never);
    const bus = new EventBus({ noPersist: true });
    const fx = { rootId: 'mol-mol-fff', motivatingBeadId: 'vibesync-gone', formulaName: 'code-review' };
    // Don't insert the motivating bead — simulate it being GC'd.
    await store.insertMoleculeRoot({
      id: fx.rootId,
      formulaName: fx.formulaName,
      title: '[code-review] root',
      motivatingBeadId: fx.motivatingBeadId,
    });
    await addStep(store, fx.rootId, 'reviewer', 'ok');

    const logger = { warn: vi.fn() };
    installWritebackHook({ bus, walker, store, logger });
    bus.emit({
      layer: 'dispatcher',
      kind: 'dispatcher/formula.completed',
      molecule_id: fx.rootId,
      payload: { moleculeId: fx.rootId, durationMs: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.notes).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
