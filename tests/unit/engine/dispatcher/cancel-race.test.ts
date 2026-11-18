/**
 * Cancelling a run while a step's turn is in flight (vibesync-6zos.3).
 *
 * Found by TLC in specs/MoleculeLifecycle.tla (property StepResultIsFinal,
 * invariant NoOpenStepUnderClosedRoot), then reproduced here on the real
 * FormulaDispatcher. cancel() used to record each running step as `cancelled`
 * itself and close the root without waiting for the turns it had stopped. A
 * stopped turn that returned afterwards (or between cancel's own writes: it is
 * the stop that makes the turn return) wrote its result anyway and
 *   - replaced `cancelled` with its error text,
 *   - or marked the cancelled step finished, with an output,
 *   - or, under a retry policy, reopened the step under the closed root.
 *
 * The rule now (CancelMode = "single_writer" in the spec): one writer per step.
 * Once a run is cancelled a returning turn writes NOTHING. cancel() stops the
 * sessions, waits for every turn of the run to return, records as cancelled
 * each step still in_progress, then closes the root; only then is the run()
 * caller told.
 *
 * The step is checked after BOTH the cancel and the turn's return, because
 * either order of those two writes must give the same record.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId, recoverInterruptedMolecules } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import type { StepReplyJudge } from '../../../../src/engine/verdict/index.js';
import type { TurnLimitPreserver } from '../../../../src/engine/dispatcher/turn-limit.js';
import { newFakeProvider, type FakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

type Ending = 'error' | 'reply' | 'stopped' | 'timeout';

/** Jev answers (the shape on main): a clean approval, and a review that asks for changes. */
const APPROVES = { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.9, reports_unverified_local_check: 0.02 };
const ASKS_FOR_CHANGES = { asks_change: 0.98, blocks_only_on_pending_ci: 0.01, reports_all_gates_passed: 0.1, reports_unverified_local_check: 0.02 };

function step(name: string, retries: number) {
  return { name, role: name, promptTemplate: 'prompts/worker.md', waitFor: 'completion' as const, ...(retries > 0 ? { retries, retryBackoffMs: 0 } : {}) };
}
const formula = (names: readonly string[], retries = 0): Formula => ({ name: 'cancel-race', description: 'Cancel race', whenToUse: '', steps: names.map((name) => step(name, retries)) });

function pack(names: readonly string[]): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-cancel-race-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts/worker.md'), 'Run ${input}');
  return {
    manifest: { name: 'test-pack', version: '1.0.0' },
    root,
    scope: 'project',
    roles: names.map((name) => ({ name, memoryBlocks: [{ label: 'persona', value: `${name} persona`, limit: 1000 }] })),
    formulas: [],
  };
}

async function until(predicate: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`condition was not met: ${what}`);
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function* turn(gate: Promise<void>, ending: Ending, before?: () => Promise<void>): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  if (before) await before();
  await gate;
  if (ending === 'error') yield { kind: 'error', ts, code: 'fake-error', message: 'session stopped' };
  else if (ending === 'timeout') yield { kind: 'error', ts, code: 'turn_timeout', message: 'turn did not finish within 1000ms' };
  else if (ending === 'stopped') yield { kind: 'stopped', ts };
  else yield { kind: 'message-delta', ts, text: 'done' };
  yield { kind: 'turn-done', ts };
}

interface Harness {
  readonly store: InMemoryDoltClient;
  readonly provider: FakeProvider;
  readonly events: Event[];
  readonly eventBus: EventBus;
  readonly dispatcher: ReturnType<typeof newDriven>;
  /** Lets the gated turns return. */
  readonly release: () => void;
}

/**
 * `releaseOnStop`: the turn returns the moment the provider is asked to stop its
 * session, as a real runtime's does, so it lands between cancel()'s own writes.
 */
function harness(args: {
  readonly ending: Ending;
  readonly releaseOnStop?: boolean;
  readonly stopNeverSettles?: boolean;
  readonly cancelUnwindMs?: number;
  readonly before?: (spec: SessionSpec, store: InMemoryDoltClient) => Promise<void>;
  readonly stepJudge?: StepReplyJudge;
  readonly turnLimitPreserver?: TurnLimitPreserver;
  readonly attemptStopTimeoutMs?: number;
}): Harness {
  const store = new InMemoryDoltClient();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = newFakeProvider({ kind: 'fake-runtime', script: (spec) => turn(gate, args.ending, args.before ? () => args.before!(spec, store) : undefined) });
  // A silent agent is interrupted now, so hold the turn open with a stop that never settles.
  const provider: FakeProvider = args.stopNeverSettles
    ? { ...base, stop: () => new Promise<void>(() => undefined) }
    : args.releaseOnStop
    ? { ...base, stop: async (handle) => { await base.stop(handle); release(); await settle(); } }
    : base;
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((event) => events.push(event));
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus, maxParallelSteps: 2,
    ...(args.cancelUnwindMs !== undefined ? { cancelUnwindMs: args.cancelUnwindMs } : {}),
    ...(args.attemptStopTimeoutMs !== undefined ? { attemptStopTimeoutMs: args.attemptStopTimeoutMs } : {}),
    ...(args.stepJudge ? { stepJudge: args.stepJudge } : {}),
    ...(args.turnLimitPreserver ? { turnLimitPreserver: args.turnLimitPreserver } : {}),
  });
  return { store, provider, events, eventBus, dispatcher, release };
}

function deferred(): { readonly promise: Promise<void>; readonly open: () => void; readonly reached: () => boolean; readonly enter: () => Promise<void> } {
  let open: () => void = () => {};
  let reached = false;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open, reached: () => reached, enter: async () => { reached = true; await promise; } };
}

/** What the run() caller saw when it was told the run had ended. */
function observeEnd(h: Harness, pending: Promise<unknown>, moleculeId: () => string, stepIds: () => readonly string[]) {
  const seen: { root?: string; outcome?: unknown; steps?: Array<string | undefined> } = {};
  const done = pending.then(() => undefined, () => undefined).then(async () => {
    seen.root = (await h.store.getBead(moleculeId()))?.status;
    seen.outcome = (await exec(h.store, moleculeId()))['outcome'];
    seen.steps = await Promise.all(stepIds().map(async (id) => (await h.store.getBead(id))?.status));
  });
  return { seen, done };
}

async function exec(store: InMemoryDoltClient, id: string): Promise<Record<string, unknown>> {
  return ((await store.getBead(id))?.metadata['exec'] ?? {}) as Record<string, unknown>;
}

/** The record a cancelled step must carry, and keep. */
async function expectCancelled(store: InMemoryDoltClient, stepId: string, when: string): Promise<void> {
  const bead = await store.getBead(stepId);
  const stepExec = await exec(store, stepId);
  expect(bead?.status, `${when}: status`).toBe('closed');
  expect(stepExec['error_trace'], `${when}: error_trace`).toBe('cancelled');
  expect(stepExec['output_payload'], `${when}: output_payload`).toBeUndefined();
}

describe('cancel while a turn is in flight: one writer per step (vibesync-6zos.3)', () => {
  const endings: ReadonlyArray<readonly [string, Ending, number]> = [
    ['an error', 'error', 0],
    ['a normal reply', 'reply', 0],
    ['a stopped event', 'stopped', 0],
    ['an error and the step has a retry policy', 'error', 2],
    ['a normal reply and the step has a retry policy', 'reply', 2],
  ];

  it.each(endings)('the turn returns AFTER cancel() has finished, with %s: the step stays cancelled', async (_name, ending, retries) => {
    const h = harness({ ending });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker'], retries), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    h.release();
    const result = await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    await expectCancelled(h.store, stepId(), 'after cancel and the turn');
    const root = await h.store.getBead(moleculeId);
    expect(root?.status).toBe('closed');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    expect(h.provider.recorder.starts).toHaveLength(1); // nothing ran after the cancel
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.retry')).toEqual([]);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.finished')).toEqual([]);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.cancelled')).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.cancelled')).toHaveLength(1);
  });

  it.each(endings)('the turn returns the moment its session is stopped, with %s: the step stays cancelled', async (_name, ending, retries) => {
    // The interleaving a fence cannot close: Start > CancelBegin > TurnEnds > (the turn rules) > CancelStep.
    const h = harness({ ending, releaseOnStop: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker'], retries), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');
    await until(async () => typeof (await exec(h.store, stepId()))['session_id'] === 'string', 'session recorded');

    const result = await h.dispatcher.cancel(moleculeId);
    await pending.catch(() => undefined);
    await settle();

    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    await expectCancelled(h.store, stepId(), 'after cancel');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    expect(h.provider.recorder.starts).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.retry')).toEqual([]);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.finished')).toEqual([]);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.cancelled')).toHaveLength(1);
  });

  it('a step its role closed with a declared failure is not reopened when the run is cancelled before its turn returns', async () => {
    // Fan-out counterexample: Start(left) Start(right) AgentCloses(left) Cancel TurnEnds(left) Write(left).
    // `left` is closed, not in_progress, when cancel runs; its turn then returns under a retry policy.
    const h = harness({
      ending: 'reply',
      before: async (spec, store) => {
        if (spec.role !== 'left') return;
        const id = String(spec.extra?.['stepId']);
        store.setStepMetadata(id, { failure_class: 'bad' });
        await store.markStepDone(id, { output: 'closed by agent' });
      },
    });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['left', 'right'], 2), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    await until(() => h.provider.recorder.starts.length === 2, 'both turns started');
    const left = newMoleculeStepId(moleculeId, 'left');
    const right = newMoleculeStepId(moleculeId, 'right');
    await until(async () => (await h.store.getBead(left))?.status === 'closed' && (await h.store.getBead(right))?.status === 'in_progress', 'left closed by its role, right running');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    h.release();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    // No step is left open under the closed root, and nothing ran after the cancel.
    expect((await h.store.getBead(left))?.status).toBe('closed');
    await expectCancelled(h.store, right, 'right');
    expect(h.provider.recorder.starts).toHaveLength(2);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.retry')).toEqual([]);
  });

  it('a turn that never returns does not hold the cancel open: cancel() records the step itself after its wait', async () => {
    const h = harness({ ending: 'reply', cancelUnwindMs: 150, stopNeverSettles: true }); // never released during the cancel
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    const startedAt = Date.now();
    const result = await h.dispatcher.cancel(moleculeId);
    const waited = Date.now() - startedAt;

    expect(waited).toBeGreaterThanOrEqual(140); // it did wait for the turn
    expect(waited).toBeLessThan(3_000); // and it did not wait for ever
    expect(h.events.filter((event) => event.kind === 'dispatcher/cancel.unwind_timeout').map((event) => event.payload)).toEqual([
      expect.objectContaining({ moleculeId, stepIds: [stepId()], waitedMs: 150 }),
    ]);
    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    await expectCancelled(h.store, stepId(), 'after the wait');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    // The turn returns long after: its result is still not written.
    h.release();
    await settle();
    await expectCancelled(h.store, stepId(), 'after the late turn');
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.finished')).toEqual([]);
  }, 20_000);

  it('the run is cancelled while the reply is being judged: the result is not written', async () => {
    // The turn has returned and is past the first check; judging can wait minutes on CI.
    const judging = deferred();
    const h = harness({
      ending: 'reply',
      stepJudge: { judge: async () => { await judging.enter(); return { answers: APPROVES, model: 'fake', inputTokens: 1 }; } },
    });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => h.provider.recorder.starts.length === 1, 'turn started');
    h.release();
    await until(() => judging.reached(), 'the reply is being judged');
    expect((await h.store.getBead(stepId()))?.status).toBe('in_progress');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    judging.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    await expectCancelled(h.store, stepId(), 'after cancel and the judge');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.finished')).toEqual([]);
  });

  it('the run is cancelled while a timed-out step\'s work is being preserved: the failure is not written', async () => {
    // escalateTurnLimit preserves the worktree (seconds) before it writes the step as failed.
    const preserving = deferred();
    const h = harness({ ending: 'timeout', turnLimitPreserver: { preserve: async () => { await preserving.enter(); return 'no uncommitted work'; } } });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', motivatingBeadId: 'work-1', workdir: '/nonexistent/worktree', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => h.provider.recorder.starts.length === 1, 'turn started');
    h.release();
    await until(() => preserving.reached(), 'work is being preserved');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    preserving.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    await expectCancelled(h.store, stepId(), 'after cancel and the preserver');
    expect((await exec(h.store, stepId()))['error_trace']).not.toContain('turn limit');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.failed')).toEqual([]);
  });

  it('the run() caller is told only after the root is closed and no step is left running', async () => {
    // The stopped turn returns in the MIDDLE of cancel(). Told then, the caller would read an open root.
    const h = harness({ ending: 'error', releaseOnStop: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    const end = observeEnd(h, pending, () => moleculeId, () => [stepId()]);
    await until(async () => moleculeId !== '' && typeof (await exec(h.store, stepId()))['session_id'] === 'string', 'session recorded');

    await h.dispatcher.cancel(moleculeId);
    await end.done;

    expect(end.seen).toEqual({ root: 'closed', outcome: 'cancelled', steps: ['closed'] });
  });

  it('a second cancel while the first is still running is refused, and the first completes', async () => {
    const h = harness({ ending: 'reply', cancelUnwindMs: 300, stopNeverSettles: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    const first = h.dispatcher.cancel(moleculeId);
    await settle();
    const second = await h.dispatcher.cancel(moleculeId).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(Error);
    expect(String((second as Error).message)).toContain('already being cancelled');
    h.release();
    expect(await first).toEqual({ moleculeId, cancelledStepCount: 1 });
    await settle();
    await expectCancelled(h.store, stepId(), 'after both');
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.cancelled')).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.cancelled')).toHaveLength(1);
  });

  it('a result written before the cancel is kept, and the cancel counts only the steps it recorded', async () => {
    // Two steps side by side; `left` finishes, then the run is cancelled while `right` is still running.
    let releaseLeft: () => void = () => {};
    const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve; });
    // `right` never returns: give the cancel a short wait.
    const short = harness({ ending: 'reply', cancelUnwindMs: 150, before: async (spec) => { if (spec.role === 'right') await new Promise<void>(() => {}); else await leftGate; } });
    let moleculeId = '';
    const pending = short.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => short.provider.recorder.starts.length === 2, 'both turns started');
    const left = newMoleculeStepId(moleculeId, 'left');
    const right = newMoleculeStepId(moleculeId, 'right');
    releaseLeft();
    short.release();
    await until(async () => (await short.store.getBead(left))?.status === 'closed', 'left finished');
    const leftBefore = await exec(short.store, left);
    expect(leftBefore['error_trace']).toBeUndefined();

    const result = await short.dispatcher.cancel(moleculeId);

    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    expect(await exec(short.store, left)).toEqual(leftBefore); // the finished step's record is untouched
    await expectCancelled(short.store, right, 'right');
    expect((await exec(short.store, moleculeId))['outcome']).toBe('cancelled');
  }, 20_000);

  it('a run cancelled before the turn returns is not judged at all, and the cancel does not time out', async () => {
    // Judging a final reply can wait minutes on CI: under a cancelled run that would outlast cancel()'s wait.
    let judged = 0;
    const h = harness({ ending: 'reply', stepJudge: { judge: async () => { judged++; return { answers: APPROVES, model: 'fake', inputTokens: 1 }; } } });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    h.release();
    await cancelling;
    await pending.catch(() => undefined);

    expect(judged).toBe(0);
    expect(h.events.filter((event) => event.kind === 'dispatcher/cancel.unwind_timeout')).toEqual([]);
    await expectCancelled(h.store, stepId(), 'after cancel');
  });

  it('the run is cancelled while a step that declared a failure is being judged: no failure and no retry are written', async () => {
    // The role set failure_class without closing its step; the judge then approves, so the declared failure is what the turn would write.
    const judging = deferred();
    const h = harness({
      ending: 'reply',
      before: async (spec, store) => { store.setStepMetadata(String(spec.extra?.['stepId']), { failure_class: 'bad' }); },
      stepJudge: { judge: async () => { await judging.enter(); return { answers: APPROVES, model: 'fake', inputTokens: 1 }; } },
    });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker'], 2), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => h.provider.recorder.starts.length === 1, 'turn started');
    h.release();
    await until(() => judging.reached(), 'the reply is being judged');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    judging.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    await expectCancelled(h.store, stepId(), 'after cancel and the judge');
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.retry' || event.kind === 'dispatcher/step.failed')).toEqual([]);
    expect(h.provider.recorder.starts).toHaveLength(1);
  });

  it('the run is cancelled while a review that will ask for changes is being judged: no step is reopened for another round', async () => {
    const judging = deferred();
    const h = harness({
      ending: 'reply',
      stepJudge: { judge: async (state) => { if (state.role === 'reviewer') await judging.enter(); return { answers: state.role === 'reviewer' ? ASKS_FOR_CHANGES : APPROVES, model: 'fake', inputTokens: 1 }; } },
    });
    const looping: Formula = {
      name: 'cancel-race-loop', description: 'Review loop', whenToUse: '',
      steps: [
        { name: 'coder', role: 'coder', promptTemplate: 'prompts/worker.md', waitFor: 'completion' },
        { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/worker.md', waitFor: 'completion', dependsOn: ['coder'], loopsBackTo: 'coder', maxRounds: 3 },
      ],
    };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: looping, pack: pack(['coder', 'reviewer']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    h.release(); // both turns return as soon as they start
    await until(() => judging.reached(), 'the review is being judged');
    const coder = newMoleculeStepId(moleculeId, 'coder');
    const reviewer = newMoleculeStepId(moleculeId, 'reviewer');
    const coderBefore = await h.store.getBead(coder);
    expect(coderBefore?.status).toBe('closed');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    judging.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    await expectCancelled(h.store, reviewer, 'reviewer');
    const coderAfter = await h.store.getBead(coder);
    expect(coderAfter?.status).toBe('closed');
    expect(coderAfter?.metadata).toEqual(coderBefore?.metadata); // not reopened for a second round
    expect(h.events.filter((event) => /review_blocked|loop_back|review_exhausted/.test(event.kind))).toEqual([]);
    expect(h.provider.recorder.starts).toHaveLength(2);
  });

  it('a result whose write was already under way lands before cancel() looks: the finished step keeps its record and is not counted', async () => {
    // The hole a "turn writes nothing once cancelled" rule cannot close by itself: the write began BEFORE the cancel.
    // cancel() waits for the turn, then reads the step fresh.
    const landing = deferred();
    const h = harness({ ending: 'reply' });
    const markStepDone = h.store.markStepDone.bind(h.store);
    h.store.markStepDone = async (id: string, output: unknown) => { await landing.enter(); return markStepDone(id, output); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => h.provider.recorder.starts.length === 1, 'turn started');
    h.release();
    await until(() => landing.reached(), 'the result write is under way');

    let cancelDone = false;
    const cancelling = h.dispatcher.cancel(moleculeId).then((result) => { cancelDone = true; return result; });
    await settle();
    expect(cancelDone).toBe(false); // waiting for the turn
    expect((await h.store.getBead(stepId()))?.status).toBe('in_progress');
    expect((await h.store.getBead(moleculeId))?.status).not.toBe('closed');
    landing.open();
    const result = await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect(result).toEqual({ moleculeId, cancelledStepCount: 0 });
    const stepExec = await exec(h.store, stepId());
    expect((await h.store.getBead(stepId()))?.status).toBe('closed');
    expect(stepExec['output_payload']).toBeDefined();
    expect(stepExec['error_trace']).toBeUndefined();
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.cancelled')).toEqual([]);
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
  });

  it('a retry reopen already under way for a step its own role closed lands before the root closes', async () => {
    // Fan-out counterexample in its hardest form. `left` is closed (declared failure), so cancel() does not see it as
    // running; its turn is mid-write, reopening it for a retry. The root must not close until that turn is back.
    const reopening = deferred();
    const rightHold = deferred();
    const h = harness({
      ending: 'reply',
      before: async (spec, store) => {
        if (spec.role === 'right') { await rightHold.enter(); return; }
        const id = String(spec.extra?.['stepId']);
        store.setStepMetadata(id, { failure_class: 'bad' });
        await store.markStepDone(id, { output: 'closed by agent' });
      },
    });
    const reopen = h.store.reopenStepForRetry.bind(h.store);
    h.store.reopenStepForRetry = async (...args: Parameters<typeof reopen>) => { await reopening.enter(); return reopen(...args); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['left', 'right'], 2), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    await until(() => h.provider.recorder.starts.length === 2, 'both turns started');
    const left = newMoleculeStepId(moleculeId, 'left');
    const right = newMoleculeStepId(moleculeId, 'right');
    h.release();
    await until(() => reopening.reached(), "left's retry reopen is under way");
    expect((await h.store.getBead(left))?.status).toBe('closed');
    expect((await h.store.getBead(right))?.status).toBe('in_progress');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    rightHold.open(); // the stop makes `right` return; `left` is still mid-write
    await settle();
    expect((await h.store.getBead(moleculeId))?.status, 'the root must wait for the turn that is mid-write').not.toBe('closed');
    reopening.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await exec(h.store, moleculeId))['outcome']).toBe('cancelled');
    expect((await h.store.getBead(left))?.status).toBe('closed'); // reopened, then closed with the run: never left open
    await expectCancelled(h.store, right, 'right');
    expect(h.provider.recorder.starts).toHaveLength(2); // the reopened step was not started again
  });

  // ---- Review on PR #188: races around cancel() itself ----

  it('two cancels that start in the same tick: exactly one runs, the other is refused', async () => {
    // Both calls used to pass the "already cancelling" check before either set the flag (an await sat between).
    const h = harness({ ending: 'reply', releaseOnStop: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    const results = await Promise.allSettled([h.dispatcher.cancel(moleculeId), h.dispatcher.cancel(moleculeId)]);
    await settle();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(String((refused[0]!.reason as Error).message)).toContain('already being cancelled');
    expect(h.events.filter((event) => event.kind === 'dispatcher/formula.cancelled')).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.cancelled')).toHaveLength(1);
  });

  it('a step being admitted when cancel() begins is either refused or captured: never left in_progress under the closed root', async () => {
    // Fan-out: `left` runs; `right` becomes ready and is being admitted (its blocker read is in flight) when cancel begins.
    // cancel() used to capture the running steps BEFORE setting the cancelled flag, so `right` could start after the
    // snapshot, write nothing on return (run cancelled), and stay in_progress under a closed root.
    const admitting = deferred();
    const h = harness({ ending: 'reply', releaseOnStop: true });
    const deps = h.store.getBeadDependencies.bind(h.store);
    let moleculeId = '';
    h.store.getBeadDependencies = async (id: string) => {
      if (moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'right')) await admitting.enter();
      return deps(id);
    };
    const pending = h.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => admitting.reached(), 'right is being admitted');
    const left = newMoleculeStepId(moleculeId, 'left');
    const right = newMoleculeStepId(moleculeId, 'right');
    await until(async () => (await h.store.getBead(left))?.status === 'in_progress', 'left in progress');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    admitting.open(); // admission continues after cancel() has begun
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await h.store.getBead(right))?.status, 'no step left in_progress under the closed root').not.toBe('in_progress');
    expect(h.provider.recorder.starts.map((s) => s.role), 'right never started').toEqual(['left']);
  });

  it('a cancel during the prompt render stops the turn from starting: no session, the step is not marked running again', async () => {
    // runStep awaits the prompt render (it can read project memory) before it starts the turn.
    const rendering = deferred();
    const h = harness({ ending: 'reply', releaseOnStop: true });
    const recordAttempt = h.store.recordStepAttempt.bind(h.store);
    let moleculeId = '';
    let held = false;
    h.store.recordStepAttempt = async (id: string, attempt: number) => {
      await recordAttempt(id, attempt);
      if (!held && moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'right')) { held = true; await rendering.enter(); }
    };
    const pending = h.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => rendering.reached(), 'right is between its attempt record and its turn');
    const right = newMoleculeStepId(moleculeId, 'right');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    rendering.open();
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect(h.provider.recorder.starts.map((s) => s.role), 'no session was started for right').toEqual(['left']);
    expect((await h.store.getBead(right))?.status).not.toBe('in_progress');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
  });

  it('a step whose "running" write lands just after cancel() read the running steps is still recorded as cancelled', async () => {
    // `right` passed admission before the flag was set; its markStepRunning is held until cancel() has read the
    // running steps, so it is not in that first read. cancel() waits for every turn, so `right`'s turn returns and
    // writes nothing; cancel() must then record it from a FRESH read, not from the first one.
    const marking = deferred();
    const read = deferred();
    const h = harness({ ending: 'reply', releaseOnStop: true });
    const markRunning = h.store.markStepRunning.bind(h.store);
    const findRunning = h.store.findRunningStepsForMolecule.bind(h.store);
    let moleculeId = '';
    let cancelReads = 0;
    h.store.markStepRunning = async (id: string) => {
      if (moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'right')) await marking.enter();
      return markRunning(id);
    };
    h.store.findRunningStepsForMolecule = async (rootId: string) => {
      const rows = await findRunning(rootId);
      if (marking.reached() && cancelReads++ === 0) read.open();
      return rows;
    };
    const pending = h.dispatcher.run({ formula: formula(['left', 'right']), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => marking.reached(), "right's running write is in flight");
    const right = newMoleculeStepId(moleculeId, 'right');

    const cancelling = h.dispatcher.cancel(moleculeId);
    await read.promise; // cancel() has read the running steps without `right`
    marking.open(); // now `right` lands as in_progress
    await cancelling;
    await pending.catch(() => undefined);
    await settle();

    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    await expectCancelled(h.store, right, 'right');
  });

  it('a live run with nothing in_progress is cancelled, not refused; a second cancel is refused as already cancelled', async () => {
    // The read that would find the running step is made to come back empty, so cancel() stops no session; the
    // turn is released by the test, as its session would otherwise run to its end. cancel() must not refuse (a
    // live run is never refused for having nothing in_progress; outside review of PR #188), and the run must end.
    const h = harness({ ending: 'reply', cancelUnwindMs: 200, stopNeverSettles: true });
    const findRunning = h.store.findRunningStepsForMolecule.bind(h.store);
    let moleculeId = '';
    let empty = true;
    h.store.findRunningStepsForMolecule = async (rootId: string) => (empty ? [] : findRunning(rootId));
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');

    const cancelling = h.dispatcher.cancel(moleculeId).then((r) => r, (error: unknown) => String((error as Error).message));
    await settle();
    // While the first cancel is under way, a second one is refused as "already being cancelled".
    const during = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(during).toMatch(/already being cancelled/);
    h.release();
    expect(await cancelling).toMatchObject({ moleculeId });
    empty = false;
    expect(await told).toBe('rejected');
    // After it the run has ended (no longer live) and its root is closed: a further cancel is refused, and changes nothing.
    const after = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(after).toContain('has no running steps to cancel');
    await settle();
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    // cancel() never saw the step as running (the read was empty), so the root close swept it up: closed with the
    // reason `run cancelled`, and no result written over it. Nothing reads a step's own trace to call a run
    // cancelled (the routes read the root's outcome), and a second writer on the step is what PR #188 removes.
    const step = await h.store.getBead(newMoleculeStepId(moleculeId, 'worker'));
    expect(step?.status).toBe('closed');
    expect(step?.metadata['close_reason']).toBe('run cancelled');
    expect((step?.metadata['exec'] as Record<string, unknown>)['output_payload']).toBeUndefined();
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
  });

  it('a second cancel after a first one gave up waiting is refused and does not un-cancel the run', async () => {
    // Review on PR #188, round 2: after a timed-out cancel, cancelInProgress is false but cancelled is true and a turn
    // is still out. A second cancel used to claim the run, be refused (nothing running), and clear `cancelled`
    // when it gave the run back, so the late turn wrote its result under the closed root.
    const h = harness({ ending: 'reply', cancelUnwindMs: 150, stopNeverSettles: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');

    await h.dispatcher.cancel(moleculeId); // gives up waiting; the turn is still out
    const second = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(second).toContain('already');
    h.release(); // the late turn returns
    await pending.catch(() => undefined);
    await settle();
    await expectCancelled(h.store, stepId(), 'after the late turn');
  });

  it('two cancels in the same tick with no live run (after a restart): exactly one runs', async () => {
    const h = harness({ ending: 'reply' });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    // A fresh dispatcher on the same store has no live run for this molecule: the restart path.
    const restarted = newDriven(h.store, { idPrefix: 'mol', provider: h.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const results = await Promise.allSettled([restarted.cancel(moleculeId), restarted.cancel(moleculeId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(String((refused[0]!.reason as Error).message)).toContain('already being cancelled');
    h.release();
    await pending.catch(() => undefined);
  });

  it('persists cancellation before stops on live and restart paths, and recovery honors the marker after both closes fail', async () => {
    const store = new InMemoryDoltClient();
    const view = await new MoleculeWalker(store).dispatch({ prefix: 'mol', formulaName: 'f', title: 't', steps: [step('worker', 0)] });
    const moleculeId = view.rootId;
    await store.markStepRunning(`${moleculeId}-worker`);
    const rootRow = await store.getBead(moleculeId);
    store.beads.set(moleculeId, { ...rootRow!, created_at: new Date(Date.now() + 1) });
    const writes: string[] = [];
    const order: string[] = [];
    const provider = newFakeProvider({ kind: 'fake-runtime' });
    const stop = provider.stop.bind(provider);
    provider.stop = async (handle) => { order.push('stop'); return stop(handle); };
    store.markMoleculeRootCancelRequested = async (id) => {
      writes.push('marker');
      order.push('marker');
      const root = await store.getBead(id);
      if (!root) throw new Error('missing root');
      store.beads.set(id, { ...root, metadata: { ...root.metadata, exec: { ...(root.metadata.exec as Record<string, unknown>), cancel_requested_at: new Date().toISOString() } } });
    };
    let closeAttempts = 0;
    const failRootClose = async () => { closeAttempts++; throw new Error('root write unavailable'); };
    store.markMoleculeRootStatus = failRootClose;
    const events: Event[] = [];
    const eventBus = new EventBus({ noPersist: true });
    eventBus.subscribe((event) => events.push(event));
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus });
    const cancel = await dispatcher.cancel(moleculeId).then(() => 'resolved', () => 'rejected');
    expect(cancel).toBe('rejected');
    // The accepted cancel's close and the settlement retry are both attempted before the returned rejection.
    expect(closeAttempts).toBeGreaterThanOrEqual(1);
    expect(order[0]).toBe('marker');
    expect(order.indexOf('marker')).toBe(0);
    expect((await store.getBead(moleculeId))?.status).toBe('open');
    expect((await store.getBead(moleculeId))?.metadata).toMatchObject({ exec: { cancel_requested_at: expect.any(String) } });
    store.beads.set('work-root-for-list', { ...(await store.getBead(moleculeId))!, id: 'work-root-for-list', created_at: new Date(Date.now() - 1000) });

    const emitted: Array<{ moleculeId: string; payload: Record<string, unknown>; eventKind?: string }> = [];
    const recoveryStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'markMoleculeRootStatus') return async (id: string, status: 'closed', outcome: 'cancelled' | 'interrupted') => {
          if (outcome === 'cancelled') return (InMemoryDoltClient.prototype.markMoleculeRootStatus as (...args: unknown[]) => Promise<boolean>).call(target, id, status, outcome);
          return failRootClose();
        };
        if (prop === 'listMoleculeRoots') return async () => {
          const root = await target.getBead(moleculeId);
          return root ? [root] : [];
        };
        return Reflect.get(target, prop, receiver);
      },
    });
    const report = await recoverInterruptedMolecules(recoveryStore as never, (id, payload, eventKind) => emitted.push({ moleculeId: id, payload, eventKind }));
    expect(report.cancelled).toContain(moleculeId);
    expect(report.interrupted).not.toContain(moleculeId);
    expect(await store.getBead(moleculeId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'cancelled' } } });
    expect(emitted.find((event) => event.moleculeId === moleculeId)).toMatchObject({ eventKind: 'dispatcher/formula.cancelled', payload: { cancelledStepCount: 0, recoveredAfterRestart: true } });
    expect(writes).toEqual(['marker']);
    expect(events.some((event) => event.kind === 'dispatcher/formula.interrupted')).toBe(false);
  });

  it('a live cancel retries both failed root closes and recovery preserves cancellation', async () => {
    const store = new InMemoryDoltClient();
    const gate = deferred();
    const base = newFakeProvider({ kind: 'fake-runtime', script: () => turn(gate.promise, 'reply') });
    const provider: FakeProvider = { ...base, stop: async (handle) => { await base.stop(handle); gate.open(); } };
    let rootCloseAttempts = 0;
    const markRoot = store.markMoleculeRootStatus.bind(store);
    store.markMoleculeRootStatus = async (...args) => {
      if (args[2] === 'cancelled') {
        rootCloseAttempts++;
        if (rootCloseAttempts <= 2) throw new Error('root write unavailable');
      }
      return markRoot(...args);
    };
    const walker = new MoleculeWalker(store);
    const eventBus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    eventBus.subscribe((event) => events.push(event));
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker, eventBus, cancelUnwindMs: 10 });
    let moleculeId = '';
    const pending = dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    void pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');

    const cancel = dispatcher.cancel(moleculeId).then(() => 'resolved', () => 'rejected');
    await until(() => rootCloseAttempts >= 2, 'both cancelled-root closes failed');
    const root = await store.getBead(moleculeId);
    expect(rootCloseAttempts).toBe(2);
    expect(root?.status).toBe('open');
    expect(root?.metadata).toMatchObject({ exec: { cancel_requested_at: expect.any(String) } });
    expect(await cancel).toBe('rejected');
    await pending.catch(() => undefined);

    const emitted: Array<{ moleculeId: string; payload: Record<string, unknown>; eventKind?: string }> = [];
    const report = await recoverInterruptedMolecules(store, (id, payload, eventKind) => emitted.push({ moleculeId: id, payload, eventKind }));
    expect(report.cancelled).toContain(moleculeId);
    expect(report.interrupted).not.toContain(moleculeId);
    expect(await store.getBead(moleculeId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'cancelled' } } });
    expect(emitted.find((event) => event.moleculeId === moleculeId)?.eventKind).toBe('dispatcher/formula.cancelled');
    expect(events.some((event) => event.kind === 'dispatcher/formula.interrupted')).toBe(false);
  });

  it('writes the marker before stopping sessions when cancelling without a live run', async () => {
    const store = new InMemoryDoltClient();
    const view = await new MoleculeWalker(store).dispatch({ prefix: 'mol', formulaName: 'f', title: 't', steps: [step('worker', 0)] });
    await store.markStepRunning(`${view.rootId}-worker`);
    const stepRow = await store.getBead(`${view.rootId}-worker`);
    store.beads.set(`${view.rootId}-worker`, { ...stepRow!, metadata: { ...stepRow!.metadata, exec: { ...(stepRow!.metadata.exec as Record<string, unknown>), session_id: 'session-1', provider_kind: 'fake-runtime' } } });
    const order: string[] = [];
    store.markMoleculeRootCancelRequested = async (id) => {
      order.push('marker');
      const root = await store.getBead(id);
      if (root) store.beads.set(id, { ...root, metadata: { ...root.metadata, exec: { ...(root.metadata.exec as Record<string, unknown>), cancel_requested_at: new Date().toISOString() } } });
    };
    const provider = newFakeProvider({ kind: 'fake-runtime' });
    const stop = provider.stop.bind(provider);
    provider.stop = async (handle) => { order.push('stop'); return stop(handle); };
    const eventBus = new EventBus({ noPersist: true });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus });

    await dispatcher.cancel(view.rootId);

    expect(order[0]).toBe('marker');
    expect(order.indexOf('marker')).toBeLessThan(order.indexOf('stop'));
  });

  it('writes the marker before stopping sessions when cancelling a live run', async () => {
    const store = new InMemoryDoltClient();
    const order: string[] = [];
    const markerWrite = store.markMoleculeRootCancelRequested.bind(store);
    store.markMoleculeRootCancelRequested = async (id) => { order.push('marker'); return markerWrite(id); };
    const gate = deferred();
    const base = newFakeProvider({ kind: 'fake-runtime', script: () => turn(gate.promise, 'reply') });
    const provider: FakeProvider = { ...base, stop: async (handle) => { order.push('stop'); await base.stop(handle); gate.open(); } };
    const eventBus = new EventBus({ noPersist: true });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus });
    let moleculeId = '';
    const pending = dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    void pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    const cancelling = dispatcher.cancel(moleculeId);
    await until(() => order.includes('stop'), 'provider stop requested');
    expect(order.indexOf('marker')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('marker')).toBeLessThan(order.indexOf('stop'));
    await cancelling;
    await pending.catch(() => undefined);
  });

  it('a failed marker write is logged without preventing the no-live-run cancel', async () => {
    const h = harness({ ending: 'reply' });
    const moleculeId = await new Promise<string>((resolve) => {
      const run = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: resolve });
      void run.then(() => undefined, () => undefined);
      setTimeout(h.release, 25);
    });
    await until(() => !h.dispatcher.liveMoleculeIds().includes(moleculeId), 'run settles without a live run');
    const root = await h.store.getBead(moleculeId);
    h.store.beads.set(moleculeId, { ...root!, status: 'open' });
    h.store.markMoleculeRootCancelRequested = async () => { throw new Error('marker unavailable'); };
    const events: Event[] = [];
    h.eventBus.subscribe((event) => events.push(event));
    await h.dispatcher.cancel(moleculeId);
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect(events.some((event) => event.kind === 'dispatcher/formula.cancel_marker_failed')).toBe(true);
  });

  it('a turn that returns while a cancel holds its claim, and the read then finds nothing in_progress: the run still ends', async () => {
    // Review on PR #188, round 2. The turn returns during the claim (run.cancelled is set), so it writes nothing and
    // its settlement is held. If cancel() is then refused, nothing used to settle the run again: it stayed live,
    // its step in_progress, until a restart.
    const reading = deferred();
    const h = harness({ ending: 'reply' });
    const findRunning = h.store.findRunningStepsForMolecule.bind(h.store);
    let moleculeId = '';
    let refuse = false;
    h.store.findRunningStepsForMolecule = async (rootId: string) => {
      if (refuse) { await reading.enter(); return []; }
      return findRunning(rootId);
    };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');

    refuse = true;
    const cancelling = h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await until(() => reading.reached(), 'cancel holds its claim and is reading the running steps');
    h.release(); // the turn returns now, during the claim
    await settle();
    reading.open(); // the read comes back empty
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    // Not refused: a live run is cancelled even when the read finds nothing in_progress (outside review of PR #188).
    expect(await within(cancelling, 'cancel() to return')).toBe('ok');
    await settle();

    expect(await within(told, 'run() to be told'), 'run() is told the run ended').toMatch(/^(resolved|rejected)$/);
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
    expect((await h.store.getBead(moleculeId))?.status, 'the root is closed').toBe('closed');
  });

  it('a cancel between two steps of a chain (nothing in_progress yet) ends the run: it is not refused and does not strand it', async () => {
    // Outside review (Fable, GPT) of PR #188: `worker` is admitted, then cancel() lands while its attempt record is
    // being written, before markStepRunning. Nothing is in_progress, so cancel() was refused; the turn had seen
    // `cancelled` and started nothing, and its try key was already taken, so the run could never continue.
    const holding = deferred();
    const h = harness({ ending: 'reply', releaseOnStop: true });
    const recordAttempt = h.store.recordStepAttempt.bind(h.store);
    let moleculeId = '';
    let held = false;
    h.store.recordStepAttempt = async (id: string, attempt: number) => {
      await recordAttempt(id, attempt);
      if (!held) { held = true; await holding.enter(); }
    };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => holding.reached(), 'worker is between admission and its turn');
    const cancelling = h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await settle();
    holding.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    expect(await within(cancelling, 'cancel() to return')).toBe('ok');
    expect(await within(told, 'run() to be told')).toBe('rejected');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status).toBe('closed');
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
    expect(h.provider.recorder.starts, 'no session was started').toHaveLength(0);
  });

  it('a cancel while a step its role closed with a declared failure is unruled: the run ends cancelled, never stuck, never completed', async () => {
    // Outside review (Fable): the role closes its own step declaring a failure_class; cancel() claims the run; the
    // turn returns INSIDE the claim (held at cancel's first read) and writes nothing, so the failure is never ruled
    // on. Observed on 82fd087 (2026-11-15): cancel() was refused (nothing in_progress) and gave the run back, and the
    // run was STUCK: run() never told, root open. Fable predicted it could instead end `completed` with no output;
    // that outcome was not observed here, so this test asserts both: the run ends, as cancelled, and never completed.
    const reading = deferred();
    const h = harness({
      ending: 'reply',
      before: async (spec, store) => {
        const id = String(spec.extra?.['stepId']);
        store.setStepMetadata(id, { failure_class: 'bad' });
        await store.markStepDone(id, { declared: true });
      },
    });
    const findRunning = h.store.findRunningStepsForMolecule.bind(h.store);
    let moleculeId = '';
    let hold = false;
    h.store.findRunningStepsForMolecule = async (rootId: string) => {
      if (hold) { hold = false; await reading.enter(); }
      return findRunning(rootId);
    };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'closed', 'the role closed its step');
    hold = true;
    const cancelling = h.dispatcher.cancel(moleculeId).catch(() => undefined);
    await until(() => reading.reached(), 'cancel holds its claim at its first read');
    h.release(); // the turn returns inside the claim
    await settle();
    reading.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    expect(await within(cancelling.then(() => 'returned'), 'cancel() to return')).toBe('returned');
    expect(await within(pending.then(() => 'resolved', () => 'rejected'), 'run() to be told'), 'the run ends').toBe('rejected');
    await settle();
    const outcome = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(outcome, 'ended as cancelled, never completed').toBe('cancelled');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect(h.events.some((event) => event.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it('a cancel that fails part-way stays a cancel: a late turn cannot overwrite the step it already recorded as cancelled', async () => {
    // Outside review (Fable, GPT): the turn outlives cancel's wait; cancel records the step as cancelled, then its
    // root write fails. 82fd087 marked the run failed and CLEARED `cancelled`, so the late turn, returning, saw the
    // run as not cancelled and wrote its result over the `cancelled` record.
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    const stepId = () => newMoleculeStepId(moleculeId, 'worker');
    await until(async () => moleculeId !== '' && (await h.store.getBead(stepId()))?.status === 'in_progress', 'worker in progress');
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    let failOnce = true;
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (failOnce && outcome === 'cancelled') { failOnce = false; throw new Error('tracker down'); }
      return markRoot(rootId, status, outcome);
    };

    const result = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(result).toContain('tracker down');
    await expectCancelled(h.store, stepId(), 'recorded by cancel before its root write failed');
    h.release(); // the late turn returns now
    await pending.catch(() => undefined);
    await settle();
    await expectCancelled(h.store, stepId(), 'after the late turn returned');
    expect(await told).toBe('rejected');
    const root = await h.store.getBead(moleculeId);
    expect(root?.status).toBe('closed');
    expect((root?.metadata['exec'] as Record<string, unknown>)['outcome']).toBe('cancelled');
    // Second outside review (GPT, Fable): when settlement, not cancel(), closes the root, the run still ends with
    // exactly one formula.cancelled event, as every listener expects.
    expect(h.events.filter((e) => e.kind === 'dispatcher/formula.cancelled'), 'one cancelled event').toHaveLength(1);
  });

  it('a session stop that never returns does not hold cancel() open: it ends within its wait', async () => {
    // Outside review (GPT): cancel() awaited each provider.stop before its bounded wait even began, so one stop that
    // never settles held the run open for ever and refused every later cancel.
    const h = harness({ ending: 'reply', cancelUnwindMs: 200 });
    h.provider.stop = () => new Promise<void>(() => {}); // never settles
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    const result = await within(h.dispatcher.cancel(moleculeId).then(() => 'returned', (e: unknown) => `failed: ${String((e as Error).message)}`), 'cancel() to return');
    expect(result, 'cancel() is bounded by its wait').not.toMatch(/^TIMED OUT/);
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
  });

  it('a prompt that resolves after the run was cancelled writes no task or session details on the step', async () => {
    // Outside review (GPT): the attempt writes the turn's task and session (recordStepTask) after provider.prompt
    // resolves, without asking whether the run was cancelled. A prompt that resolves after cancel() has recorded
    // the step and closed the root used to write onto the closed, cancelled step.
    const prompting = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 });
    const basePrompt = h.provider.prompt.bind(h.provider);
    h.provider.prompt = async (handle, content) => { await prompting.enter(); return basePrompt(handle, content); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => prompting.reached(), 'the attempt is waiting on its prompt');
    const stepId = newMoleculeStepId(moleculeId, 'worker');
    await h.dispatcher.cancel(moleculeId); // gives up waiting; records the step; closes the root
    await expectCancelled(h.store, stepId, 'after cancel');
    const before = JSON.stringify((await h.store.getBead(stepId))?.metadata);
    prompting.open(); // the prompt resolves now, with a task id
    h.release();
    await pending.catch(() => undefined);
    await settle();
    expect(JSON.stringify((await h.store.getBead(stepId))?.metadata), 'the cancelled step is not written again').toBe(before);
    expect(h.events.filter((event) => event.kind === 'dispatcher/step.task_recorded')).toHaveLength(0);
  });

  it('after a restart (no live run), a session stop that never returns does not hold cancel() open', async () => {
    // The same finding on the restart path: cancel() there awaited each stop with no bound at all.
    const h = harness({ ending: 'reply' });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    await until(async () => Boolean(((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.metadata['exec'] as Record<string, unknown> | undefined)?.['session_id']), 'worker has a session');
    const stuck = { ...h.provider, stop: () => new Promise<void>(() => {}) };
    const restarted = newDriven(h.store, { idPrefix: 'mol', provider: stuck, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }), cancelUnwindMs: 200 });
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    const result = await within(restarted.cancel(moleculeId).then(() => 'returned', (e: unknown) => `failed: ${String((e as Error).message)}`), 'cancel() to return');
    expect(result, 'cancel() after a restart is bounded too').toBe('returned');
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    h.release();
    await pending.catch(() => undefined);
  });

  it('a cancel accepted while the run is settling as completed wins: the run ends cancelled, never completed', async () => {
    // Second outside review (GPT, Fable): settlement checks `cancelled` first, then awaits isComplete(). Now that a
    // live cancel with nothing running is accepted, a cancel landing in that await is accepted, and settlement used
    // to go on to completeMolecule: the caller got success and the root was written `completed`.
    const completing = deferred();
    const h = harness({ ending: 'reply' });
    let moleculeId = '';
    let held = false;
    // Settlement's isComplete() reads the run through walker.load() -> getBeadDependencies(root): hold that read,
    // once the step is closed (so this is the settlement read, not an earlier one).
    const deps = h.store.getBeadDependencies.bind(h.store);
    h.store.getBeadDependencies = async (id: string) => {
      const rows = await deps(id);
      if (!held && moleculeId !== '' && id === moleculeId && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'closed') {
        held = true;
        await completing.enter();
      }
      return rows;
    };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '', 'run started');
    h.release();
    await until(() => completing.reached(), 'settlement is reading whether the run is complete');
    const cancelling = h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await settle();
    completing.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    const c = await within(cancelling, 'cancel() to return');
    const t = await within(told, 'run() to be told');
    await settle();
    const outcome = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    if (c === 'ok') {
      // The cancel was accepted, so it must win.
      expect(t, 'the caller is not told success').toBe('rejected');
      expect(outcome).toBe('cancelled');
      expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
    } else {
      // Or it was refused because the run had already finished: then the run is completed, consistently.
      expect(c).not.toMatch(/^TIMED OUT/);
      expect(t).toBe('resolved');
      expect(outcome).toBe('completed');
    }
  });

  it('a cancel accepted while a delivery check is running wins: the run ends cancelled, never completed', async () => {
    // Second outside review (GPT): settlement checks `cancelled`, reads completeness, then awaits checkDelivery()
    // before completeMolecule(). A cancel accepted during the delivery check used to lose: completeMolecule checked
    // only `finalized`, wrote `completed` and resolved the run as a success.
    const verifying = deferred();
    const store = new InMemoryDoltClient();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => turn(gate, 'reply') });
    const eventBus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    eventBus.subscribe((event) => events.push(event));
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus, maxParallelSteps: 2,
      // A real verdict shape: the delivery is confirmed (returning anything else fails the run closed instead).
      deliveryVerifier: { verify: async () => { await verifying.enter(); return { ok: true as const, artifact: 'https://github.com/o/r/pull/1' }; } },
    } as never);
    const delivering = { ...formula(['worker']), delivers: 'pull_request' } as unknown as Formula;
    // cancel()'s first read is held too, so the cancel is accepted but still in progress when settlement completes.
    const reading = deferred();
    const findRunning = store.findRunningStepsForMolecule.bind(store);
    let holdCancel = false;
    store.findRunningStepsForMolecule = async (rootId: string) => {
      if (holdCancel) { holdCancel = false; await reading.enter(); }
      return findRunning(rootId);
    };
    let moleculeId = '';
    const pending = dispatcher.run({ formula: delivering, pack: pack(['worker']), input: 'go', motivatingBeadId: 'w', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '', 'run started');
    release();
    await until(() => verifying.reached(), 'settlement is checking the delivery');
    holdCancel = true;
    const cancelling = dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await until(() => reading.reached(), 'cancel is accepted and holding at its first read');
    verifying.open(); // the delivery is confirmed now, while the accepted cancel is still in progress
    await settle();
    reading.open(); // the cancel goes on
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    const c = await within(cancelling, 'cancel() to return');
    const t = await within(told, 'run() to be told');
    await settle();
    const outcome = ((await store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(c, 'the cancel is accepted (the run is live)').toBe('ok');
    expect(t, 'an accepted cancel wins: the caller is not told success').toBe('rejected');
    expect(outcome).toBe('cancelled');
    expect(events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
    // The delivery really was confirmed: this run reached the completion path, not the fail-closed one.
    expect(events.some((e) => e.kind === 'dispatcher/formula.delivered')).toBe(true);
  });

  it('a cancel that arrives while a completed run is writing its root is refused: it does not overwrite the outcome', async () => {
    // Second outside review (Fable): completeMolecule deletes the run from `live` BEFORE its root write lands. A cancel
    // in that gap found no live run, took the restart path, read the root as still open with nothing running, and
    // closed it `cancelled` while run() was told `completed`.
    const writing = deferred();
    const h = harness({ ending: 'reply' });
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (outcome === 'completed') await writing.enter();
      return markRoot(rootId, status, outcome);
    };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '', 'run started');
    h.release();
    await until(() => writing.reached(), 'the completed root write is in flight');
    const cancelling = h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await settle();
    writing.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    const c = await within(cancelling, 'cancel() to return');
    expect(c, 'refused: the run is finishing').not.toBe('ok');
    expect(c).not.toMatch(/^TIMED OUT/);
    expect(await within(told, 'run() to be told')).toBe('resolved');
    await settle();
    const outcome = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(outcome, 'the outcome run() was told stands').toBe('completed');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.cancelled')).toBe(false);
  });

  it('a session cancel() could not name (no session id recorded yet) is stopped by its own turn', async () => {
    // Second outside review (Fable, GPT): the session id is recorded only after provider.prompt resolves, so a cancel
    // between start and prompt finds no session to stop. The turn kept its handle and went on observing the agent
    // after the root was closed `cancelled`, until the turn ended by itself.
    const prompting = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 });
    const basePrompt = h.provider.prompt.bind(h.provider);
    h.provider.prompt = async (handle, content) => { await prompting.enter(); return basePrompt(handle, content); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => prompting.reached(), 'the session is started and its prompt is pending');
    expect(h.provider.recorder.starts).toHaveLength(1);
    await h.dispatcher.cancel(moleculeId); // finds no session id to stop; gives up waiting; closes the root
    prompting.open(); // the prompt resolves; the agent's turn is NOT released by the test
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told'), 'the turn ends by itself once it sees the cancel').toBe('rejected');
    expect(h.provider.recorder.stops.length, 'the turn stopped its own session').toBeGreaterThanOrEqual(1);
    h.release();
  });

  it('a "mark running" write delayed past the root close does not reopen the step or start a session', async () => {
    // Second outside review (GPT, Fable): markStepRunning was an unconditional bd update. Delayed past cancel's wait,
    // it reopened a step the root close had just closed, and the attempt then started a session for it.
    const marking = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 });
    let moleculeId = '';
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => marking.reached(), "the step's running write is in flight");
    const stepId = newMoleculeStepId(moleculeId, 'worker');
    await h.dispatcher.cancel(moleculeId); // gives up waiting; the root close closes the open step
    expect((await h.store.getBead(stepId))?.status).toBe('closed');
    marking.open(); // the delayed running write lands now
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
    await settle();
    expect((await h.store.getBead(stepId))?.status, 'the late write did not reopen the step').toBe('closed');
    expect(h.provider.recorder.starts, 'no session was started').toHaveLength(0);
    h.release();
  });

  it('after a run completed, a cancel is refused as having nothing to cancel, not as still finishing', async () => {
    // The finalizing claim is held only while the outcome is written: once it lands, a cancel sees a closed root.
    const h = harness({ ending: 'reply' });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    h.release();
    await pending;
    const later = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(later).toContain('has no running steps to cancel');
    expect(later).not.toContain('already finishing');
  });

  it('a cancel that lands while the session is starting sends it no prompt', async () => {
    // The attempt asks "cancelled?" right after provider.start: the agent never receives the prompt.
    const starting = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 });
    const baseStart = h.provider.start.bind(h.provider);
    h.provider.start = async (spec) => { await starting.enter(); return baseStart(spec); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => starting.reached(), 'the session is being started');
    await h.dispatcher.cancel(moleculeId);
    starting.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
    expect(h.provider.recorder.prompts, 'no prompt was sent').toHaveLength(0);
    expect(h.provider.recorder.stops.length, 'the started session was stopped').toBeGreaterThanOrEqual(1);
  });

  it('a cancel during the prompt, with an agent that then stays silent, still ends the turn', async () => {
    // The attempt asks "cancelled?" right after the prompt resolves: an agent that emits nothing would otherwise hold
    // the observe loop (which only checks between events) for its whole turn.
    const prompting = deferred();
    const store = new InMemoryDoltClient();
    let silence: () => void = () => {};
    const silent = new Promise<void>((resolve) => { silence = resolve; });
    async function* quiet(): AsyncIterable<SessionEvent> { await silent; yield { kind: 'turn-done', ts: new Date().toISOString() }; }
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => quiet() });
    const basePrompt = provider.prompt.bind(provider);
    provider.prompt = async (handle, content) => { await prompting.enter(); return basePrompt(handle, content); };
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), cancelUnwindMs: 150 });
    let moleculeId = '';
    const told = dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } }).then(() => 'resolved', () => 'rejected');
    await until(() => prompting.reached(), 'the prompt is pending');
    await dispatcher.cancel(moleculeId);
    prompting.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
    silence();
  });

  it('a cancel while the agent is streaming ends the turn at the next event, not at the end of the turn', async () => {
    // The observe loop asks "cancelled?" after each event: an agent that keeps talking would otherwise run on, under a
    // closed root, until its turn ended by itself.
    const store = new InMemoryDoltClient();
    async function* chatty(): AsyncIterable<SessionEvent> {
      yield { kind: 'started', ts: new Date().toISOString() };
      for (let i = 0; i < 400; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); yield { kind: 'message-delta', ts: new Date().toISOString(), text: '.' }; }
      yield { kind: 'turn-done', ts: new Date().toISOString() };
    }
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => chatty() });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), cancelUnwindMs: 150 });
    let moleculeId = '';
    const told = dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } }).then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '' && Boolean(((await store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.metadata['exec'] as Record<string, unknown> | undefined)?.['session_id']), 'the agent is streaming');
    await dispatcher.cancel(moleculeId);
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
  });

  it('a cancel during the "mark running" write, which then succeeds, starts no session', async () => {
    // The write lands while the step is still open (it succeeds), but the run was cancelled meanwhile: the attempt asks
    // "cancelled?" after the write, so provider.start is never called.
    const marking = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 2000 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => marking.reached(), "the step's running write is in flight");
    const cancelling = h.dispatcher.cancel(moleculeId);
    await settle();
    marking.open(); // lands before cancel() gives up waiting: the step is still open, so the write succeeds
    await cancelling;
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
    expect(h.provider.recorder.starts, 'no session was started').toHaveLength(0);
    await expectCancelled(h.store, newMoleculeStepId(moleculeId, 'worker'), 'the step');
  });

  it('a step closed by ANOTHER dispatcher during its "mark running" write starts no session here', async () => {
    // The refusal half of the start guard. Inside one dispatcher a refused start always follows a cancel of this run,
    // so `cancelled()` alone would stop it; but a second dispatcher on the same tracker (the restart path) can close
    // the root while THIS run is never marked cancelled. Only bd's refusal tells the attempt not to start a session.
    const marking = deferred();
    const h = harness({ ending: 'reply' });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => marking.reached(), "the step's running write is in flight");
    // Another dispatcher, with no live run for this molecule, cancels it: it closes the root and the open step.
    const other = newDriven(h.store, { idPrefix: 'mol', provider: h.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    await other.cancel(moleculeId);
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status).toBe('closed');
    marking.open(); // the write lands on a closed step: refused
    await settle();
    expect(h.provider.recorder.starts, 'no session was started').toHaveLength(0);
    h.release();
  });

  it('a refused start after ANOTHER dispatcher cancelled the run is not judged, written or completed over that cancel', async () => {
    // Third outside review (GPT): the refused start returned an ordinary empty output. This run was never marked
    // cancelled, so the turn judged that empty reply, wrote it as the step's result, and settlement then found every
    // step closed and wrote the root `completed` over the other dispatcher's `cancelled`.
    const marking = deferred();
    const h = harness({ ending: 'reply' });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => marking.reached(), "the step's running write is in flight");
    const stepId = newMoleculeStepId(moleculeId, 'worker');
    const other = newDriven(h.store, { idPrefix: 'mol', provider: h.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    await other.cancel(moleculeId);
    const stepAfterCancel = JSON.stringify((await h.store.getBead(stepId))?.metadata);
    marking.open(); // refused: the step is closed
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    const t = await within(told, 'run() to be told');
    await settle();
    expect(h.provider.recorder.starts, 'no session was started').toHaveLength(0);
    expect(t, 'the caller is not told the run succeeded').not.toBe('resolved');
    expect(JSON.stringify((await h.store.getBead(stepId))?.metadata), 'no result written over the closed step').toBe(stepAfterCancel);
    const outcome = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(outcome, "the other dispatcher's cancel stands").toBe('cancelled');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed'), 'no completed event').toBe(false);
    h.release();
  });

  it('a session stop that never returns does not keep the run() caller waiting after a cancel', async () => {
    // Outside review, rounds 2 and 3 (GPT, Fable): cancel() no longer awaits the stops, but the attempt's own finally
    // awaited provider.stop(handle). A stop that never settles kept the turn in flight for ever, so the run never
    // settled: run() stayed pending and the run stayed live.
    const h = harness({ ending: 'reply', cancelUnwindMs: 150, attemptStopTimeoutMs: 200 });
    h.provider.stop = () => new Promise<void>(() => {}); // never settles
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '' && Boolean(((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.metadata['exec'] as Record<string, unknown> | undefined)?.['session_id']), 'the session is running');
    await h.dispatcher.cancel(moleculeId);
    h.release(); // the agent's turn ends; the attempt's finally then asks for a stop that never returns
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told'), 'the caller is told the run was cancelled').toBe('rejected');
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
    expect(h.events.some((e) => e.kind === 'dispatcher/step.stop_timeout'), 'the unanswered stop is reported').toBe(true);
  });

  it('a run cancelled while its reply is being judged does not run the delivery check', async () => {
    // Third outside review (Fable): settlement re-checked `cancelled` only AFTER checkDelivery, which can call a
    // verifier (and wait on CI) and emit formula.delivered for a run that was cancelled.
    const completing = deferred();
    const store = new InMemoryDoltClient();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => turn(gate, 'reply') });
    const eventBus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    eventBus.subscribe((event) => events.push(event));
    let verified = 0;
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus,
      deliveryVerifier: { verify: async () => { verified += 1; return { ok: true as const, artifact: 'https://github.com/o/r/pull/1' }; } },
    } as never);
    const delivering = { ...formula(['worker']), delivers: 'pull_request' } as unknown as Formula;
    let moleculeId = '';
    let held = false;
    const deps = store.getBeadDependencies.bind(store);
    store.getBeadDependencies = async (id: string) => {
      const rows = await deps(id);
      if (!held && moleculeId !== '' && id === moleculeId && (await store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'closed') { held = true; await completing.enter(); }
      return rows;
    };
    // cancel()'s first read is held too, so the cancel is accepted but still in progress when settlement goes on.
    const reading = deferred();
    const findRunning = store.findRunningStepsForMolecule.bind(store);
    let holdCancel = false;
    store.findRunningStepsForMolecule = async (rootId: string) => {
      if (holdCancel) { holdCancel = false; await reading.enter(); }
      return findRunning(rootId);
    };
    const told = dispatcher.run({ formula: delivering, pack: pack(['worker']), input: 'go', motivatingBeadId: 'w', onStarted: (id) => { moleculeId = id; } }).then(() => 'resolved', () => 'rejected');
    await until(async () => moleculeId !== '', 'run started');
    release();
    await until(() => completing.reached(), 'settlement is reading completeness, before the delivery check');
    holdCancel = true;
    const cancelling = dispatcher.cancel(moleculeId).catch(() => undefined);
    await until(() => reading.reached(), 'cancel is accepted and holding at its first read');
    completing.open(); // settlement resumes while the accepted cancel is still in progress
    await settle();
    reading.open();
    await cancelling;
    expect(await told).toBe('rejected');
    expect(verified, 'the delivery verifier was not called for a cancelled run').toBe(0);
    expect(events.some((e) => e.kind === 'dispatcher/formula.delivered')).toBe(false);
  });

  it('a cancel claimed while the session id is being recorded, with a silent agent, still ends the turn', async () => {
    // Third outside review (Fable): a cancel claimed during recordStepTask can read the steps before the session id
    // lands, so it stops nothing; the observe loop then waits for an event a silent agent never sends.
    const recording = deferred();
    const store = new InMemoryDoltClient();
    let silence: () => void = () => {};
    const silent = new Promise<void>((resolve) => { silence = resolve; });
    async function* quiet(): AsyncIterable<SessionEvent> { await silent; yield { kind: 'turn-done', ts: new Date().toISOString() }; }
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => quiet() });
    const recordTask = store.recordStepTask.bind(store);
    store.recordStepTask = async (...a: Parameters<typeof recordTask>) => { await recording.enter(); return recordTask(...a); };
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), cancelUnwindMs: 150 });
    let moleculeId = '';
    const told = dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } }).then(() => 'resolved', () => 'rejected');
    await until(() => recording.reached(), 'the session id is being recorded');
    await dispatcher.cancel(moleculeId);
    recording.open();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toBe('rejected');
    silence();
  });

  it('a run that fails after ANOTHER dispatcher closed its root reports that outcome and writes nothing', async () => {
    // The failed path of "closed elsewhere": the root close is refused, so this run must not announce `failed` or
    // overwrite the outcome the other closer recorded.
    const h = harness({ ending: 'error' });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (e: unknown) => String((e as Error).message));
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    // Another closer records `cancelled` on the root, directly.
    await h.store.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled');
    h.release(); // the turn fails: this run settles as failed and finds the root already closed
    const t = await told;
    expect(t, 'run() is told the outcome that stands').toContain('already closed elsewhere (outcome: cancelled)');
    expect(((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown>)['outcome']).toBe('cancelled');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed'), 'no failed event').toBe(false);
  });

  it('a cancel of a run whose root someone else already closed announces nothing', async () => {
    // closeCancelledRoot emits formula.cancelled only when THIS call closed the root.
    const h = harness({ ending: 'reply', releaseOnStop: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    // The root is closed by someone else just before this cancel's own root write.
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (outcome === 'cancelled') await markRoot(rootId, status, 'completed');
      return markRoot(rootId, status, outcome);
    };
    await h.dispatcher.cancel(moleculeId).catch(() => undefined);
    await pending.catch(() => undefined);
    await settle();
    expect(h.events.filter((e) => e.kind === 'dispatcher/formula.cancelled'), 'no cancelled event for a root it did not close').toHaveLength(0);
  });

  it("another dispatcher's cancel sweep, landing before its root close, does not let this run claim completion", async () => {
    // Fourth outside review (GPT): B's cancel sweeps the step closed, then pauses before its root write. A's start is
    // refused (NOT_STARTED, nothing written), A settles, finds every step closed, and wins the root CAS with
    // `completed`: a step that never ran, recorded as a completed run.
    const marking = deferred();
    const rootHeld = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 3000 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (outcome === 'cancelled') {
        // B's sweep, as the real writer does it, BEFORE its root write; then B pauses.
        for (const step of await h.store.findStepsForMolecule(rootId)) {
          if (step.status !== 'closed') await h.store.closeOpenStep(step.id, 'run cancelled', true);
        }
        await rootHeld.enter();
      }
      return markRoot(rootId, status, outcome);
    };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => marking.reached(), "A's start write is in flight");
    const other = newDriven(h.store, { idPrefix: 'mol', provider: h.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const bCancel = other.cancel(moleculeId).catch(() => undefined);
    await until(() => rootHeld.reached(), "B has swept the step and is about to close the root");
    marking.open(); // A's start is refused: the step is closed
    // A decides WHILE B is still paused before its root write: the old code completed the run here.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const duringHold = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(duringHold, 'A did not close the root as completed while B was paused').toBeUndefined();
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    rootHeld.open(); // B closes the root as cancelled; A, waiting on the root, then reports that outcome
    await bCancel;
    // Asserted on the real answer, after B's root close (fifth outside review: a 2 s wait against the 5 s default
    // cancel wait let this pass on a timeout string).
    const t = await within(told, 'run() to be told');
    expect(t, 'the caller is told the run ended').toBe('rejected');
    await settle();
    const outcome = ((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown> | undefined)?.['outcome'];
    expect(outcome, 'a run whose only step never ran is never recorded as completed').not.toBe('completed');
    expect(t, 'the caller is not told the run succeeded').not.toBe('resolved');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
    h.release();
  });

  it("a refused start while ANOTHER dispatcher is still sweeping a multi-step run does not leave this run hanging", async () => {
    // Fourth outside review (Fable): B's sweep has closed `left` but not `right` when A's start of `left` is refused.
    // A settles once, finds `right` open, does nothing, and nothing ever asks it to settle again: run() hangs.
    const marking = deferred();
    const sweepHeld = deferred();
    const h = harness({ ending: 'reply' });
    const markRunning = h.store.markStepRunning.bind(h.store);
    let moleculeId = '';
    h.store.markStepRunning = async (id: string) => {
      if (moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'left')) await marking.enter();
      return markRunning(id);
    };
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (outcome === 'cancelled') {
        // B's sweep, closing `left` first, then pausing before `right` and the root.
        await h.store.closeOpenStep(newMoleculeStepId(rootId, 'left'), 'run cancelled', true);
        await sweepHeld.enter();
      }
      return markRoot(rootId, status, outcome);
    };
    const chain: Formula = { name: 'chain', description: '', whenToUse: '', steps: [step('left', 0), { ...step('right', 0), dependsOn: ['left'] }] } as Formula;
    const pending = h.dispatcher.run({ formula: chain, pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', () => 'rejected');
    await until(() => marking.reached(), "A's start of `left` is in flight");
    const other = newDriven(h.store, { idPrefix: 'mol', provider: h.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const bCancel = other.cancel(moleculeId).catch(() => undefined);
    await until(() => sweepHeld.reached(), 'B has closed `left` and paused');
    marking.open(); // A's start of `left` is refused
    await settle();
    sweepHeld.open(); // B finishes: closes `right` and the root
    await bCancel;
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    expect(await within(told, 'run() to be told'), 'the run ends: it is told the outcome that stands').toBe('rejected');
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
    h.release();
  });

  it('a step closed under the run by a writer that never closes the root: the run fails after its wait, never completes', async () => {
    // The fallback of settleClosedUnder: the other writer closed the step and stopped. After the wait, this run closes
    // the root itself, as FAILED (never completed: its step never ran), and announces it.
    const marking = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 200 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (e: unknown) => `rejected: ${String((e as Error).message)}`);
    await until(() => marking.reached(), "the step's start write is in flight");
    // Another writer closes the step and nothing else: the root stays open.
    await h.store.closeOpenStep(newMoleculeStepId(moleculeId, 'worker'), 'closed by hand', true);
    marking.open(); // refused
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 3000))]);
    const t = await within(told, 'run() to be told');
    expect(t).toMatch(/^rejected: .*closed by another writer/);
    const root = await h.store.getBead(moleculeId);
    expect(root?.status).toBe('closed');
    expect((root?.metadata['exec'] as Record<string, unknown>)['outcome'], 'failed, never completed').toBe('failed');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed')).toBe(true);
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it("a step closed under the run while the other closer is still finishing: this run waits, and the other's cancel stands", async () => {
    // Why settleClosedUnder waits: B's sweep has closed the step and B's root write is still to come. Without the wait,
    // this run would close the root as `failed` first and B's `cancelled` would lose the CAS.
    const marking = deferred();
    const h = harness({ ending: 'reply', cancelUnwindMs: 2000 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    h.store.markStepRunning = async (id: string) => { await marking.enter(); return markRunning(id); };
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (e: unknown) => `rejected: ${String((e as Error).message)}`);
    await until(() => marking.reached(), "the step's start write is in flight");
    // B sweeps the step closed; its root write lands 300 ms later.
    await h.store.closeOpenStep(newMoleculeStepId(moleculeId, 'worker'), 'run cancelled', true);
    const bRoot = new Promise<void>((resolve) => setTimeout(() => { void h.store.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled').then(() => resolve()); }, 300));
    marking.open(); // refused: this run settles as closed-under and must wait
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 4000))]);
    const t = await within(told, 'run() to be told');
    await bRoot;
    expect(t, 'told the outcome B recorded').toContain('already closed elsewhere (outcome: cancelled)');
    expect(((await h.store.getBead(moleculeId))?.metadata['exec'] as Record<string, unknown>)['outcome'], "B's cancel stands").toBe('cancelled');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed'), 'this run announced no failure').toBe(false);
  });

  it('a start lost to ANOTHER dispatcher that claimed the same step does not close the root or sweep its step', async () => {
    // CodeRabbit on e78c063: two dispatchers read the same open step; the other's conditional start wins (the step is
    // in_progress, still being run by its owner). This run's start is refused for that reason, not because the step
    // was closed. Treating it as closedUnder made this run close the root as `failed` after its wait and sweep the
    // owner's active step.
    const h = harness({ ending: 'reply', cancelUnwindMs: 200 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    let moleculeId = '';
    h.store.markStepRunning = async (id: string) => {
      // The other dispatcher claims the step first; this run's compare-and-set then finds it in_progress, not open.
      await markRunning(id);
      return markRunning(id);
    };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (e: unknown) => `rejected: ${String((e as Error).message)}`);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'the other dispatcher holds the step');
    await new Promise((resolve) => setTimeout(resolve, 600)); // past this run's wait
    expect((await h.store.getBead(moleculeId))?.status, 'the root is left to its owner').toBe('open');
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status, "the owner's step is not swept").toBe('in_progress');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed'), 'no failure announced for a run someone else owns').toBe(false);
    // And this run is not left hanging: it stops, tells its caller why, and leaves the live map.
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    expect(await within(told, 'run() to be told')).toMatch(/^rejected: .*held by another writer/);
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
  });

  it('a refused start whose re-read of the step fails stops the run without closing the root or sweeping the step', async () => {
    // Outside review (Fable) of the claimed-elsewhere fix: the re-read after the refusal had no error handling. A failed
    // read threw, set run.failed, and the run then closed the root as failed and swept a step another dispatcher holds.
    const h = harness({ ending: 'reply', cancelUnwindMs: 200 });
    const markRunning = h.store.markStepRunning.bind(h.store);
    let moleculeId = '';
    h.store.markStepRunning = async (id: string) => { await markRunning(id); return markRunning(id); }; // claimed elsewhere
    const getBead = h.store.getBead.bind(h.store);
    let refused = false;
    h.store.getBead = async (id: string) => {
      if (refused && moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'worker')) throw new Error('bd unavailable');
      return getBead(id);
    };
    const realMark = h.store.markStepRunning;
    h.store.markStepRunning = async (id: string) => { const r = await realMark(id); if (!r) refused = true; return r; };
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (e: unknown) => `rejected: ${String((e as Error).message)}`);
    const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`TIMED OUT: ${what}`), 2000))]);
    const t = await within(told, 'run() to be told');
    refused = false;
    expect(t).toMatch(/^rejected: /);
    expect((await h.store.getBead(moleculeId))?.status, 'the root is not closed').toBe('open');
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status, 'the held step is not swept').toBe('in_progress');
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.failed'), 'no failure announced').toBe(false);
    expect(h.events.some((e) => e.kind === 'dispatcher/run.claimed_elsewhere'), 'the stop is visible as an event').toBe(true);
  });

  it('a run whose step is held elsewhere starts no further step while a sibling is still running', async () => {
    // Outside review (Fable): cannotStartSteps ignored closedUnder/claimedElsewhere. In a fan of three with two slots,
    // `left` is held elsewhere while `right` still runs; the run cannot settle yet, and the third step must not start
    // under a run that has already stopped.
    const h = harness({ ending: 'reply' });
    const markRunning = h.store.markStepRunning.bind(h.store);
    let moleculeId = '';
    h.store.markStepRunning = async (id: string) => {
      if (moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'left')) { await markRunning(id); }
      return markRunning(id);
    };
    const fan3 = formula(['left', 'right', 'third'], 2);
    const pending = h.dispatcher.run({ formula: fan3, pack: pack(['left', 'right', 'third']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'right')))?.status === 'in_progress', '`right` is running');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await h.store.getBead(newMoleculeStepId(moleculeId, 'third')))?.status, 'the third step did not start').toBe('open');
    expect(h.provider.recorder.starts.map((s) => s.role), 'no session for the third step').not.toContain('third');
    h.release();
  });

  it('a step admitted just before its run stopped records no attempt (ownership re-checked after the blocker read)', async () => {
    // CodeRabbit on 42d7db8: runReadyStep checks cannotStartSteps, then awaits hasBlockerPendingRetry. A sibling turn can
    // stop the run (claimedElsewhere) during that await; the step then reserved its try and recorded an attempt.
    const h = harness({ ending: 'reply' });
    const markRunning = h.store.markStepRunning.bind(h.store);
    let moleculeId = '';
    // `left`'s start is refused: another dispatcher holds it -> this run stops (claimedElsewhere).
    h.store.markStepRunning = async (id: string) => {
      if (moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'left')) await markRunning(id);
      return markRunning(id);
    };
    // Hold `right` inside its blocker read until `left` has stopped the run.
    const reading = deferred();
    const blockers = h.store.getBeadDependencies.bind(h.store);
    let held = false;
    h.store.getBeadDependencies = async (id: string) => {
      if (!held && moleculeId !== '' && id === newMoleculeStepId(moleculeId, 'right')) { held = true; await reading.enter(); }
      return blockers(id);
    };
    const attempts: string[] = [];
    const recordAttempt = h.store.recordStepAttempt.bind(h.store);
    h.store.recordStepAttempt = async (id: string, attempt: number) => { attempts.push(id); return recordAttempt(id, attempt); };
    const pending = h.dispatcher.run({ formula: formula(['left', 'right'], 2), pack: pack(['left', 'right']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(() => reading.reached(), '`right` is inside its blocker read');
    await until(() => !h.dispatcher.liveMoleculeIds().includes(moleculeId), '`left` stopped the run (claimed elsewhere)');
    reading.open();
    await settle();
    expect(attempts, 'no attempt recorded on `right` after the run stopped').not.toContain(newMoleculeStepId(moleculeId, 'right'));
    expect(h.provider.recorder.starts.map((sp) => sp.role)).not.toContain('right');
    h.release();
  });

  it('a cancel whose tracker writes fail does not discard the run silently: the run ends failed, the error is not swallowed', async () => {
    const h = harness({ ending: 'reply', releaseOnStop: true });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    const told = pending.then(() => 'resolved', (error: unknown) => `rejected: ${String((error as Error).message)}`);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');
    const markRoot = h.store.markMoleculeRootStatus.bind(h.store);
    let failOnce = true;
    h.store.markMoleculeRootStatus = async (rootId, status, outcome) => {
      if (failOnce && outcome === 'cancelled') { failOnce = false; throw new Error('tracker down'); }
      return markRoot(rootId, status, outcome);
    };

    const result = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    await settle();
    expect(result, 'the caller of cancel() hears about the failure').toContain('tracker down');
    expect(await told, 'run() is told the run did not end cleanly').toMatch(/^rejected: /);
    // The root is closed with an outcome on the retry the settlement makes, never left open with no live run.
    const root = await h.store.getBead(moleculeId);
    expect(root?.status).toBe('closed');
    expect(['cancelled', 'failed']).toContain((root?.metadata['exec'] as Record<string, unknown>)['outcome']);
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
  });

  it('a run that is not cancelled is unaffected: the turn\'s reply finishes the step', async () => {
    const h = harness({ ending: 'reply' });
    let moleculeId = '';
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    await until(() => h.provider.recorder.starts.length === 1, 'turn started');
    h.release();
    const result = await pending;
    const stepExec = await exec(h.store, newMoleculeStepId(moleculeId, 'worker'));
    expect(result.outputs).toEqual({ worker: 'done' });
    expect(stepExec['error_trace']).toBeUndefined();
    expect((await exec(h.store, moleculeId))['outcome']).toBe('completed');
  });
});
