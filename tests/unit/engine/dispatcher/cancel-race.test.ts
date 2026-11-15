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
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
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
  readonly cancelUnwindMs?: number;
  readonly before?: (spec: SessionSpec, store: InMemoryDoltClient) => Promise<void>;
  readonly stepJudge?: StepReplyJudge;
  readonly turnLimitPreserver?: TurnLimitPreserver;
}): Harness {
  const store = new InMemoryDoltClient();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = newFakeProvider({ kind: 'fake-runtime', script: (spec) => turn(gate, args.ending, args.before ? () => args.before!(spec, store) : undefined) });
  const provider: FakeProvider = args.releaseOnStop
    ? { ...base, stop: async (handle) => { await base.stop(handle); release(); await settle(); } }
    : base;
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((event) => events.push(event));
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus, maxParallelSteps: 2,
    ...(args.cancelUnwindMs !== undefined ? { cancelUnwindMs: args.cancelUnwindMs } : {}),
    ...(args.stepJudge ? { stepJudge: args.stepJudge } : {}),
    ...(args.turnLimitPreserver ? { turnLimitPreserver: args.turnLimitPreserver } : {}),
  });
  return { store, provider, events, dispatcher, release };
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
    const h = harness({ ending: 'reply', cancelUnwindMs: 150 }); // never released during the cancel
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
    const h = harness({ ending: 'reply', cancelUnwindMs: 300 });
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

  it('a cancel refused after it claimed the run gives the run back: the run finishes normally and can still be cancelled', async () => {
    // claimCancel marks the run before its first await; if cancel() then refuses (here: nothing running yet),
    // a mark left behind would make the run unsettleable and every later cancel refused.
    const h = harness({ ending: 'reply', releaseOnStop: true });
    const findRunning = h.store.findRunningStepsForMolecule.bind(h.store);
    let moleculeId = '';
    let empty = true;
    h.store.findRunningStepsForMolecule = async (rootId: string) => (empty ? [] : findRunning(rootId));
    const pending = h.dispatcher.run({ formula: formula(['worker']), pack: pack(['worker']), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    await until(async () => moleculeId !== '' && (await h.store.getBead(newMoleculeStepId(moleculeId, 'worker')))?.status === 'in_progress', 'worker in progress');

    const refused = await h.dispatcher.cancel(moleculeId).then(() => 'ok', (error: unknown) => String((error as Error).message));
    expect(refused).toContain('no running steps');
    empty = false;
    // The mark was given back: a second cancel is not refused as "already being cancelled".
    expect(await h.dispatcher.cancel(moleculeId)).toEqual({ moleculeId, cancelledStepCount: 1 });
    await pending.catch(() => undefined);
    await settle();
    expect((await h.store.getBead(moleculeId))?.status).toBe('closed');
    expect(h.dispatcher.liveMoleculeIds()).not.toContain(moleculeId);
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
