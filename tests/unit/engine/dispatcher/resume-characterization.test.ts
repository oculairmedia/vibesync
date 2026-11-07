import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import { FormulaDispatchError, FormulaDispatcher, FormulaEscalationError } from '../../../../src/engine/dispatcher/index.js';
import type { DeliveryVerifier } from '../../../../src/engine/dispatcher/delivery.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
import type { RuntimeProvider, SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

describe('FormulaDispatcher.resume characterization', () => {
  it('rejects an unknown molecule before emitting a resume event', async () => {
    const h = harness();

    const error = await h.dispatcher.resume('missing-molecule').catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toBe('FormulaDispatcher: molecule missing-molecule not found');
    expect(h.events).toHaveLength(0);
  });

  it('emits resumed before rejecting an unfinished molecule without running steps', async () => {
    const h = harness();
    const view = await rootWithSteps(h.store, ['worker']);

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toContain('has no running steps to resume');
    expect(h.events.map((event) => event.kind)).toEqual(['dispatcher/formula.resumed']);
  });

  it('emits a resumed event with zero running steps when all steps are closed', async () => {
    const h = harness();
    const view = await rootWithSteps(h.store, ['worker']);
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'saved output', eventCount: 2, resumed: true });

    await h.dispatcher.resume(view.rootId);

    expect(h.events[0]?.payload).toMatchObject({ moleculeId: view.rootId, runningStepCount: 0 });
  });

  it('completes an already-finished molecule and emits completion without delivery metadata', async () => {
    const h = harness();
    const view = await rootWithSteps(h.store, ['worker']);
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'saved output', eventCount: 2, resumed: true });

    const result = await h.dispatcher.resume(view.rootId);

    expect(result.outputs).toEqual({ worker: 'saved output' });
    expect(h.events.map((event) => event.kind)).toEqual(['dispatcher/formula.resumed', 'dispatcher/formula.completed']);
    expect(h.events.at(-1)?.payload).toMatchObject({ moleculeId: view.rootId, resumed: true });
  });

  it('fails closed for a persisted unknown delivery kind', async () => {
    const h = harness();
    const view = await rootWithSteps(h.store, ['worker'], { delivers: 'archive' });
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'saved output', eventCount: 2, resumed: true });

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toContain('unknown delivery kind "archive"');
    expect((await h.store.getBead(view.rootId))?.metadata).toMatchObject({ exec: { outcome: 'failed' } });
    expect(h.events.map((event) => event.kind)).toEqual(['dispatcher/formula.resumed', 'dispatcher/formula.failed']);
    expect(h.events.at(-1)?.payload).toMatchObject({ resumed: true, error: expect.stringContaining('unknown delivery kind') });
  });

  it('fails delivery verification when pull-request metadata has no verifier', async () => {
    const h = harness();
    const view = await rootWithSteps(h.store, ['worker'], { delivers: 'pull_request' });
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'saved output', eventCount: 2, resumed: true });

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toContain('no delivery verifier is configured');
    expect((await h.store.getBead(view.rootId))?.metadata).toMatchObject({ exec: { outcome: 'failed' } });
    expect(h.events.at(-1)?.payload).toMatchObject({ error: expect.stringContaining('no delivery verifier') });
  });

  it('reports a declined resumed delivery and includes the motivating bead', async () => {
    const verifier: DeliveryVerifier = { verify: async () => ({ ok: false, reason: 'no matching pull request' }) };
    const h = harness({ deliveryVerifier: verifier });
    const view = await rootWithSteps(h.store, ['worker'], { delivers: 'pull_request', motivatingBeadId: 'vibesync-work' });
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'finished without a PR', eventCount: 2, resumed: true });

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toContain('declared delivery not met: no matching pull request');
    expect((await h.store.getBead(view.rootId))?.metadata).toMatchObject({ exec: { outcome: 'failed' } });
    expect(h.events.at(-1)?.payload).toMatchObject({ resumed: true, motivating_bead: 'vibesync-work' });
  });

  it('reports verifier exceptions as delivery failures', async () => {
    const verifier: DeliveryVerifier = { verify: async () => { throw new Error('verification unavailable'); } };
    const h = harness({ deliveryVerifier: verifier });
    const view = await rootWithSteps(h.store, ['worker'], { delivers: 'pull_request' });
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'finished', eventCount: 2, resumed: true });

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect((error as Error).message).toContain('delivery could not be verified: verification unavailable');
    expect(h.events.at(-1)?.kind).toBe('dispatcher/formula.failed');
  });

  it('emits a resumed-delivery event before completion when verification succeeds', async () => {
    let claim: Parameters<DeliveryVerifier['verify']>[0] | undefined;
    const verifier: DeliveryVerifier = { verify: async (value) => { claim = value; return { ok: true, artifact: 'https://github.com/org/repo/pull/9' }; } };
    const h = harness({ deliveryVerifier: verifier });
    const view = await rootWithSteps(h.store, ['worker'], { delivers: 'pull_request', motivatingBeadId: 'vibesync-work' });
    await h.walker.finishStep(newMoleculeStepId(view.rootId, 'worker'), { output: 'done', eventCount: 2, resumed: true });
    const createdAt = (await h.store.getBead(view.rootId))!.created_at;

    await h.dispatcher.resume(view.rootId);

    expect(claim?.startedAt).toEqual(createdAt);
    expect(claim?.motivatingBeadId).toBe('vibesync-work');
    expect(h.events.map((event) => event.kind)).toEqual([
      'dispatcher/formula.resumed', 'dispatcher/formula.delivered', 'dispatcher/formula.completed',
    ]);
    expect(h.events[1]?.payload).toMatchObject({ resumed: true, artifact: 'https://github.com/org/repo/pull/9' });
  });

  it('fails a resumed running step with a blocked outcome and closes its root failed', async () => {
    const h = harness({ script: () => eventScript([{ kind: 'message-delta', ts: new Date().toISOString(), text: 'STEP OUTCOME: BLOCKED - needs approval' }]) });
    const view = await rootWithSteps(h.store, ['worker']);
    const stepId = newMoleculeStepId(view.rootId, 'worker');
    await h.walker.startStep(stepId);
    await h.walker.recordStepTask(stepId, { taskId: 'task-blocked', providerKind: 'fake-runtime', sessionId: 'old-session' });

    const error = await h.dispatcher.resume(view.rootId).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(FormulaEscalationError);
    expect((error as Error).message).toContain('resumed step "worker" escalated: needs approval');
    expect((await h.store.getBead(stepId))?.metadata).toMatchObject({ 'gc.retry_outcome': 'not_retryable' });
    expect((await h.store.getBead(view.rootId))?.status).toBe('open');
    expect(h.events.map((event) => event.kind)).toContain('dispatcher/step.failed');
    expect(h.events.at(-1)?.kind).toBe('dispatcher/formula.failed');
  });

  it('pauses after reattaching a running step when its open successor needs a new formula context', async () => {
    const h = harness({ script: () => eventScript([{ kind: 'message-delta', ts: new Date().toISOString(), text: 'recovered' }]) });
    const view = await rootWithSteps(h.store, ['worker', 'next']);
    const workerId = newMoleculeStepId(view.rootId, 'worker');
    await h.walker.startStep(workerId);
    await h.walker.recordStepTask(workerId, { taskId: 'task-recovered', providerKind: 'fake-runtime', sessionId: 'old-session' });

    const result = await h.dispatcher.resume(view.rootId);

    expect(result.outputs).toEqual({ worker: 'recovered' });
    expect((await h.store.getBead(workerId))?.status).toBe('closed');
    expect((await h.store.getBead(newMoleculeStepId(view.rootId, 'next')))?.status).toBe('open');
    expect(h.events.at(-1)?.kind).toBe('dispatcher/formula.resume.paused');
    expect(h.events.at(-1)?.payload).toMatchObject({ reason: 'running steps completed; open successors require a fresh formula run context' });
  });
});

function harness(args: { readonly script?: (spec: SessionSpec) => AsyncIterable<SessionEvent>; readonly deliveryVerifier?: DeliveryVerifier } = {}) {
  const store = new InMemoryDoltClient();
  const walker = new MoleculeWalker(store);
  const provider: RuntimeProvider = newFakeProvider({ kind: 'fake-runtime', script: args.script });
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((event) => events.push(event));
  const dispatcher = new FormulaDispatcher({
    idPrefix: 'mol', provider, walker, eventBus,
    ...(args.deliveryVerifier ? { deliveryVerifier: args.deliveryVerifier } : {}),
  });
  return { store, walker, dispatcher, events };
}

async function rootWithSteps(
  store: InMemoryDoltClient,
  names: readonly string[],
  options: { readonly delivers?: string; readonly motivatingBeadId?: string } = {},
) {
  return new MoleculeWalker(store).dispatch({
    prefix: 'mol',
    formulaName: 'resume-characterization',
    title: '[formula:resume-characterization]',
    ...options,
    steps: names.map((name, index) => ({ name, role: name, ...(index === 0 ? {} : { dependsOn: [names[index - 1]!] }) })),
  });
}

async function* eventScript(events: readonly SessionEvent[]): AsyncIterable<SessionEvent> {
  for (const event of events) yield { ...event, ts: new Date().toISOString() } as SessionEvent;
}
