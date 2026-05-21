import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/orchestration/events/index.js';
import type { Formula } from '../../../../src/orchestration/formula/index.js';
import { FormulaDispatchError, FormulaDispatcher } from '../../../../src/orchestration/dispatcher/index.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/orchestration/molecule/index.js';
import type { Pack } from '../../../../src/orchestration/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/orchestration/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

describe('FormulaDispatcher', () => {
  it('runs a three-step formula, closes step beads, and emits dispatcher events in order', async () => {
    const { dispatcher, store, events } = newHarness({
      script: scriptByRole({ reviewer: 'review output', coder: 'code output', tester: 'test output' }),
    });

    const result = await dispatcher.run({ formula: codeReviewFormula(), pack: newPack(), input: 'please review' });

    expect(result.outputs).toEqual({ reviewer: 'review output', coder: 'code output', tester: 'test output' });
    for (const stepName of ['reviewer', 'coder', 'tester']) {
      const row = await store.getBead(newMoleculeStepId(result.moleculeId, stepName));
      expect(row?.status).toBe('closed');
      expect(row?.metadata).toMatchObject({
        exec: {
          task_id: expect.stringContaining('fake-runtime:'),
          provider_kind: 'fake-runtime',
          output_payload: { output: result.outputs[stepName], eventCount: 3 },
        },
      });
    }
    expect(events.map((event) => event.kind)).toEqual([
      'dispatcher/formula.started',
      'dispatcher/step.started',
      'dispatcher/step.task_recorded',
      'dispatcher/step.finished',
      'dispatcher/step.started',
      'dispatcher/step.task_recorded',
      'dispatcher/step.finished',
      'dispatcher/step.started',
      'dispatcher/step.task_recorded',
      'dispatcher/step.finished',
      'dispatcher/formula.completed',
    ]);
    expect(events.every((event) => event.molecule_id === result.moleculeId)).toBe(true);
  });

  it('threads predecessor output into successor prompt context', async () => {
    const { dispatcher, provider } = newHarness({
      script: scriptByRole({ reviewer: 'review says fix auth', coder: 'code done', tester: 'tests pass' }),
    });

    await dispatcher.run({ formula: codeReviewFormula(), pack: newPack(), input: 'top-level task' });

    const coderPrompt = provider.recorder.prompts[1]?.content[0];
    expect(coderPrompt).toMatchObject({ type: 'text' });
    expect(coderPrompt?.type === 'text' ? coderPrompt.text : '').toContain('Prior review: review says fix auth');
    expect(coderPrompt?.type === 'text' ? coderPrompt.text : '').toContain('Input: top-level task');
  });

  it('fails the current step and does not start successors when the provider emits an error', async () => {
    const { dispatcher, store, provider } = newHarness({
      script: (spec) => eventScript(spec.role === 'reviewer' ? [{ kind: 'error', message: 'review exploded' }] : []),
    });

    const thrown = await dispatcher.run({ formula: codeReviewFormula(), pack: newPack(), input: 'please review' }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect((thrown as FormulaDispatchError).moleculeId).toMatch(/^mol-mol-/);
    const moleculeId = (thrown as FormulaDispatchError).moleculeId;
    expect((await store.getBead(newMoleculeStepId(moleculeId, 'reviewer')))?.metadata).toMatchObject({
      exec: { error_trace: 'review exploded' },
    });
    expect((await store.getBead(newMoleculeStepId(moleculeId, 'coder')))?.status).toBe('open');
    expect(provider.recorder.starts.map((start) => start.role)).toEqual(['reviewer']);
  });

  it('retries a failed step according to the formula retry policy', async () => {
    const { dispatcher, store, provider, events } = newHarness({
      script: (spec) => {
        const attempt = Number(spec.extra?.['attempt'] ?? 0);
        return eventScript(attempt < 3 ? [{ kind: 'error', message: `attempt ${attempt} failed` }] : [{ kind: 'message-delta', text: 'eventual success' }]);
      },
    });

    const result = await dispatcher.run({ formula: retryFormula(), pack: retryPack(), input: 'retry this' });
    const step = await store.getBead(newMoleculeStepId(result.moleculeId, 'worker'));

    expect(result.outputs).toEqual({ worker: 'eventual success' });
    expect(provider.recorder.starts.map((start) => start.extra?.['attempt'])).toEqual([1, 2, 3]);
    expect(step?.status).toBe('closed');
    expect(step?.metadata).toMatchObject({
      exec: {
        attempts: 3,
        output_payload: { output: 'eventual success', attempts: 3 },
      },
    });
    expect(events.filter((event) => event.kind === 'dispatcher/step.retry').map((event) => event.payload)).toEqual([
      expect.objectContaining({ attempt: 1, nextAttempt: 2, backoffMs: 0, reason: 'attempt 1 failed' }),
      expect.objectContaining({ attempt: 2, nextAttempt: 3, backoffMs: 0, reason: 'attempt 2 failed' }),
    ]);
  });

  it('renders only declared predecessor outputs required by depends_on before each step runs', async () => {
    const formula: Formula = {
      name: 'chain',
      description: 'Chain',
      whenToUse: '',
      steps: [
        { name: 'alpha', role: 'alpha', promptTemplate: 'prompts/alpha.md', waitFor: 'completion' },
        { name: 'beta', role: 'beta', promptTemplate: 'prompts/beta.md', dependsOn: ['alpha'], waitFor: 'completion' },
      ],
    };
    const pack = newPack({
      roles: ['alpha', 'beta'],
      prompts: {
        'prompts/alpha.md': 'Alpha ${input}',
        'prompts/beta.md': 'Beta ${prior_alpha}',
      },
    });
    const { dispatcher, provider } = newHarness({
      script: scriptByRole({ alpha: 'alpha-output', beta: 'beta-output' }),
    });

    await dispatcher.run({ formula, pack, input: 'go' });

    const betaPrompt = provider.recorder.prompts[1]?.content[0];
    expect(betaPrompt?.type === 'text' ? betaPrompt.text : '').toBe('Beta alpha-output');
  });

  it('fans out independent ready steps before waiting for either to finish', async () => {
    const { dispatcher, events } = newHarness({
      script: scriptByRole({ alpha: 'alpha-output', beta: 'beta-output' }),
    });

    const result = await dispatcher.run({ formula: parallelFormula(), pack: parallelPack(), input: 'go' });

    expect(result.outputs).toEqual({ alpha: 'alpha-output', beta: 'beta-output' });
    const lifecycle = events
      .filter((event) => event.kind === 'dispatcher/step.started' || event.kind === 'dispatcher/step.finished')
      .map((event) => `${event.kind}:${String(event.payload.stepName)}`);
    expect(lifecycle.slice(0, 2)).toEqual(['dispatcher/step.started:alpha', 'dispatcher/step.started:beta']);
    expect(lifecycle).toEqual([
      'dispatcher/step.started:alpha',
      'dispatcher/step.started:beta',
      'dispatcher/step.finished:alpha',
      'dispatcher/step.finished:beta',
    ]);
  });

  it('respects maxParallelSteps when choosing a ready-step batch', async () => {
    const { dispatcher, events } = newHarness({
      maxParallelSteps: 1,
      script: scriptByRole({ alpha: 'alpha-output', beta: 'beta-output' }),
    });

    await dispatcher.run({ formula: parallelFormula(), pack: parallelPack(), input: 'go' });

    const lifecycle = events
      .filter((event) => event.kind === 'dispatcher/step.started' || event.kind === 'dispatcher/step.finished')
      .map((event) => `${event.kind}:${String(event.payload.stepName)}`);
    expect(lifecycle).toEqual([
      'dispatcher/step.started:alpha',
      'dispatcher/step.finished:alpha',
      'dispatcher/step.started:beta',
      'dispatcher/step.finished:beta',
    ]);
  });

  it('queues whole-molecule runs FIFO when maxConcurrentMolecules is reached', async () => {
    const gates = [newDeferred<void>(), newDeferred<void>(), newDeferred<void>(), newDeferred<void>(), newDeferred<void>()];
    let observeCount = 0;
    const { dispatcher, provider, events } = newHarness({
      maxConcurrentMolecules: 2,
      script: () => gatedScript(gates[observeCount++]?.promise ?? Promise.resolve()),
    });

    const runs = ['one', 'two', 'three', 'four', 'five'].map((input) =>
      dispatcher.run({ formula: singleStepFormula(), pack: singleStepPack(), input }),
    );

    await waitForCondition(() => provider.recorder.starts.length === 2 && dispatcher.getQueueDepth() === 3);
    expect(dispatcher.getActiveMoleculeCount()).toBe(2);
    expect(events.filter((event) => event.kind === 'dispatcher/formula.queued').map((event) => event.payload)).toEqual([
      expect.objectContaining({ depth: 1, position: 1, formulaName: 'single-step', active: 2, maxConcurrentMolecules: 2 }),
      expect.objectContaining({ depth: 2, position: 2, formulaName: 'single-step', active: 2, maxConcurrentMolecules: 2 }),
      expect.objectContaining({ depth: 3, position: 3, formulaName: 'single-step', active: 2, maxConcurrentMolecules: 2 }),
    ]);

    gates[0]?.resolve(undefined);
    await waitForCondition(() => provider.recorder.starts.length === 3 && dispatcher.getQueueDepth() === 2);
    gates[1]?.resolve(undefined);
    await waitForCondition(() => provider.recorder.starts.length === 4 && dispatcher.getQueueDepth() === 1);
    gates[2]?.resolve(undefined);
    await waitForCondition(() => provider.recorder.starts.length === 5 && dispatcher.getQueueDepth() === 0);
    gates[3]?.resolve(undefined);
    gates[4]?.resolve(undefined);

    await Promise.all(runs);
    expect(provider.recorder.prompts.map((prompt) => prompt.content[0]?.type === 'text' ? prompt.content[0].text : '')).toEqual([
      'Run one',
      'Run two',
      'Run three',
      'Run four',
      'Run five',
    ]);
    expect(dispatcher.getActiveMoleculeCount()).toBe(0);
  });

  it('passes role memory block replace policy into runtime extra', async () => {
    const { dispatcher, provider } = newHarness({
      script: scriptByRole({ reviewer: 'review output', coder: 'code output', tester: 'test output' }),
    });

    await dispatcher.run({ formula: codeReviewFormula(), pack: newPack({ replaceMemoryRoles: ['reviewer'] }), input: 'please review' });

    expect(provider.recorder.starts[0]?.extra).toMatchObject({
      memoryBlockSeedMode: 'replace',
      memoryBlocks: [{ label: 'persona', value: 'reviewer persona', limit: 1000 }],
    });
    expect(provider.recorder.starts[1]?.extra).not.toHaveProperty('memoryBlockSeedMode');
  });

  it('threads roleConfig.tools through to extra.tools on each session start (vibesync-cs2)', async () => {
    const { dispatcher, provider } = newHarness({
      script: scriptByRole({ reviewer: 'review output', coder: 'code output', tester: 'test output' }),
    });

    await dispatcher.run({
      formula: codeReviewFormula(),
      pack: newPack({ toolsByRole: { reviewer: ['dispatch_molecule', 'search_folder_passages'], coder: [] } }),
      input: 'please review',
    });

    expect(provider.recorder.starts[0]?.extra).toMatchObject({
      tools: ['dispatch_molecule', 'search_folder_passages'],
    });
    // Empty tools array → property omitted entirely (avoids no-op tool-attach loops).
    expect(provider.recorder.starts[1]?.extra).not.toHaveProperty('tools');
    expect(provider.recorder.starts[2]?.extra).not.toHaveProperty('tools');
  });

  it('resumes a running step by re-attaching to the persisted runtime task id', async () => {
    const { dispatcher, store, provider, events } = newHarness({
      script: (spec) => eventScript([{ kind: 'message-delta', text: `recovered ${String(spec.extra?.['resumeTaskId'] ?? '')}` }]),
    });
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol',
      formulaName: 'code-review',
      title: '[formula:code-review] Code review',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
    });
    const stepId = newMoleculeStepId(view.rootId, 'reviewer');
    await walker.startStep(stepId);
    await walker.recordStepTask(stepId, {
      taskId: 'task-recovered-1',
      providerKind: 'fake-runtime',
      sessionId: 'fake-runtime:reviewer-previous',
    });

    const result = await dispatcher.resume(view.rootId);

    expect(result.outputs).toEqual({ reviewer: 'recovered task-recovered-1' });
    expect(provider.recorder.prompts).toHaveLength(0);
    expect(provider.recorder.starts[0]?.extra).toMatchObject({ resumeTaskId: 'task-recovered-1', moleculeId: view.rootId });
    expect((await store.getBead(stepId))?.metadata).toMatchObject({
      exec: { output_payload: { output: 'recovered task-recovered-1', resumed: true } },
    });
    expect(events.map((event) => event.kind)).toEqual([
      'dispatcher/formula.resumed',
      'dispatcher/step.reattached',
      'dispatcher/step.finished',
      'dispatcher/formula.completed',
    ]);
  });

  it('fails a running step that has no persisted runtime task id', async () => {
    const { dispatcher, store } = newHarness({ script: scriptByRole({ reviewer: 'unused' }) });
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol',
      formulaName: 'code-review',
      title: '[formula:code-review] Code review',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
    });
    const stepId = newMoleculeStepId(view.rootId, 'reviewer');
    await walker.startStep(stepId);

    const thrown = await dispatcher.resume(view.rootId).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect((await store.getBead(stepId))?.metadata).toMatchObject({
      exec: { error_trace: expect.stringContaining('has no metadata.exec.task_id') },
    });
  });

  it('cancels running steps, stops persisted sessions, and emits cancellation events', async () => {
    const { dispatcher, store, provider, events } = newHarness({ script: scriptByRole({ reviewer: 'unused' }) });
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol',
      formulaName: 'code-review',
      title: '[formula:code-review] Code review',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
    });
    const stepId = newMoleculeStepId(view.rootId, 'reviewer');
    await walker.startStep(stepId);
    await walker.recordStepTask(stepId, {
      taskId: 'task-cancel-1',
      providerKind: 'fake-runtime',
      sessionId: 'fake-runtime:reviewer-previous',
    });

    const result = await dispatcher.cancel(view.rootId);

    expect(result).toEqual({ moleculeId: view.rootId, cancelledStepCount: 1 });
    expect(provider.recorder.stops).toEqual([{ id: 'fake-runtime:reviewer-previous', providerKind: 'fake-runtime' }]);
    expect((await store.getBead(stepId))?.metadata).toMatchObject({ exec: { error_trace: 'cancelled' } });
    expect(events.map((event) => event.kind)).toEqual(['dispatcher/step.cancelled', 'dispatcher/formula.cancelled']);
    expect(events[0]?.task_id).toBe('task-cancel-1');
  });

  it('rejects cancellation when no step is running', async () => {
    const { dispatcher, store } = newHarness({ script: scriptByRole({ reviewer: 'unused' }) });
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol',
      formulaName: 'code-review',
      title: '[formula:code-review] Code review',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
    });

    const thrown = await dispatcher.cancel(view.rootId).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(String((thrown as Error).message)).toContain('has no running steps to cancel');
  });
});

function newHarness(args: {
  readonly script: (spec: SessionSpec) => AsyncIterable<SessionEvent>;
  readonly maxParallelSteps?: number;
  readonly maxConcurrentMolecules?: number;
}) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake-runtime', script: args.script });
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((event) => events.push(event));
  const dispatcher = new FormulaDispatcher({
    provider,
    walker: new MoleculeWalker(store),
    eventBus,
    ...(args.maxParallelSteps === undefined ? {} : { maxParallelSteps: args.maxParallelSteps }),
    ...(args.maxConcurrentMolecules === undefined ? {} : { maxConcurrentMolecules: args.maxConcurrentMolecules }),
  });
  return { dispatcher, store, provider, events };
}

function codeReviewFormula(): Formula {
  return {
    name: 'code-review',
    description: 'Code review',
    whenToUse: '',
    steps: [
      { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/reviewer.md', waitFor: 'completion' },
      { name: 'coder', role: 'coder', promptTemplate: 'prompts/coder.md', dependsOn: ['reviewer'], waitFor: 'completion' },
      { name: 'tester', role: 'tester', promptTemplate: 'prompts/tester.md', dependsOn: ['coder'], waitFor: 'completion' },
    ],
  };
}

function parallelFormula(): Formula {
  return {
    name: 'parallel-review',
    description: 'Parallel review',
    whenToUse: '',
    steps: [
      { name: 'alpha', role: 'alpha', promptTemplate: 'prompts/alpha.md', waitFor: 'completion' },
      { name: 'beta', role: 'beta', promptTemplate: 'prompts/beta.md', waitFor: 'completion' },
    ],
  };
}

function parallelPack(): Pack {
  return newPack({
    roles: ['alpha', 'beta'],
    prompts: {
      'prompts/alpha.md': 'Alpha ${input}',
      'prompts/beta.md': 'Beta ${input}',
    },
  });
}

function retryFormula(): Formula {
  return {
    name: 'retrying',
    description: 'Retrying formula',
    whenToUse: '',
    steps: [{ name: 'worker', role: 'worker', promptTemplate: 'prompts/worker.md', waitFor: 'completion', retries: 2, retryBackoffMs: 0 }],
  };
}

function retryPack(): Pack {
  return newPack({
    roles: ['worker'],
    prompts: { 'prompts/worker.md': 'Retry ${input}' },
  });
}

function singleStepFormula(): Formula {
  return {
    name: 'single-step',
    description: 'Single step',
    whenToUse: '',
    steps: [{ name: 'worker', role: 'worker', promptTemplate: 'prompts/worker.md', waitFor: 'completion' }],
  };
}

function singleStepPack(): Pack {
  return newPack({
    roles: ['worker'],
    prompts: { 'prompts/worker.md': 'Run ${input}' },
  });
}

function newPack(args: {
  readonly roles?: readonly string[];
  readonly prompts?: Readonly<Record<string, string>>;
  readonly replaceMemoryRoles?: readonly string[];
  readonly toolsByRole?: Readonly<Record<string, readonly string[]>>;
} = {}): Pack {
  const prompts = args.prompts ?? {
    'prompts/reviewer.md': 'Review ${input}',
    'prompts/coder.md': 'Input: ${input}\nPrior review: ${prior_reviewer}',
    'prompts/tester.md': 'Prior code: ${prior_coder}',
  };
  const root = mkdtempSync(join(tmpdir(), 'vibesync-dispatcher-'));
  for (const [relativePath, content] of Object.entries(prompts)) {
    const path = join(root, relativePath);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, content);
  }
  const roles = args.roles ?? ['reviewer', 'coder', 'tester'];
  const replaceMemoryRoles = new Set(args.replaceMemoryRoles ?? []);
  const toolsByRole = args.toolsByRole ?? {};
  return {
    manifest: { name: 'test-pack', version: '1.0.0' },
    root,
    scope: 'project',
    roles: roles.map((role) => ({
      name: role,
      memoryBlocks: [{ label: 'persona', value: `${role} persona`, limit: 1000 }],
      ...(replaceMemoryRoles.has(role) ? { memoryBlocksPolicy: { mode: 'replace' as const } } : {}),
      ...(toolsByRole[role] !== undefined ? { tools: toolsByRole[role] } : {}),
    })),
    formulas: [],
  };
}

function scriptByRole(outputs: Readonly<Record<string, string>>): (spec: SessionSpec) => AsyncIterable<SessionEvent> {
  return (spec) => eventScript([{ kind: 'message-delta', text: outputs[spec.role] ?? '' }]);
}

async function* eventScript(events: readonly ScriptEvent[]): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  for (const event of events) {
    if (event.kind === 'message-delta') yield { kind: 'message-delta', ts, text: event.text };
    else yield { kind: 'error', ts, code: 'fake-error', message: event.message };
  }
  yield { kind: 'turn-done', ts };
}

async function* gatedScript(done: Promise<void>): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  await done;
  yield { kind: 'message-delta', ts, text: 'ok' };
  yield { kind: 'turn-done', ts };
}

function newDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

type ScriptEvent =
  | { readonly kind: 'message-delta'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };
