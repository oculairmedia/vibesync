import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { FormulaDispatchError, FormulaDispatcher } from '../../../../src/engine/dispatcher/index.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { RuntimeProvider, SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { STEP_OUTCOME_INSTRUCTIONS } from '../../../../src/engine/dispatcher/step-outcome.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

/**
 * The rendered template body: every step prompt ends with the blocked-outcome
 * instructions (vibesync-zvcm), so strip exactly that suffix and require it.
 */
function renderedBody(prompt: string): string {
  if (!prompt.endsWith(STEP_OUTCOME_INSTRUCTIONS)) throw new Error(`prompt is missing the step-outcome instructions: ${prompt.slice(-80)}`);
  return prompt.slice(0, prompt.length - STEP_OUTCOME_INSTRUCTIONS.length);
}

function isDispatcherEvent(event: Event): boolean {
  return event.layer === 'dispatcher';
}

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
    expect(events.filter(isDispatcherEvent).map((event) => event.kind)).toEqual([
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
    expect(events.filter((event) => event.kind.startsWith('runtime/session.')).map((event) => event.kind)).toContain('runtime/session.message_delta');
    expect(events.find((event) => event.kind === 'runtime/session.message_delta')?.payload).toMatchObject({
      stepName: 'reviewer',
      role: 'reviewer',
      providerKind: 'fake-runtime',
      sessionId: expect.stringContaining('fake-runtime:'),
      text: 'review output',
    });
  });

  it('stops observing at turn-done and stops the provider before finishing the step', async () => {
    const timeline: string[] = [];
    const provider = newFakeProvider({
      kind: 'fake-runtime',
      script: async function* () {
        const ts = new Date().toISOString();
        yield { kind: 'turn-done', ts };
        throw new Error('event after completion must not be consumed');
      },
    });
    const eventBus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
      if (event.kind === 'dispatcher/step.finished') timeline.push(event.kind);
    });
    const store = new InMemoryDoltClient();
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus });
    const stop = provider.stop.bind(provider);
    provider.stop = async (handle) => {
      timeline.push('provider.stop');
      await stop(handle);
    };
    await dispatcher.run({ formula: singleStepFormula(), pack: singleStepPack(), input: 'go' });

    expect(provider.recorder.stops).toHaveLength(1);
    const finishedIndex = events.findIndex((event) => event.kind === 'dispatcher/step.finished');
    expect(timeline).toEqual(['provider.stop', 'dispatcher/step.finished']);
    expect(finishedIndex).toBeGreaterThan(-1);
    expect(events.slice(0, finishedIndex).some((event) => event.kind === 'runtime/session.turn_done')).toBe(true);
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf('dispatcher/step.finished')).toBeGreaterThan(kinds.indexOf('runtime/session.turn_done'));
    expect(kinds).not.toContain('dispatcher/step.failed');
  });

  it('records the runtime task id on the step bead BEFORE it starts observing events (vibesync-vp76.2)', async () => {
    // A restart resumes a running step by its persisted task id (see "resumes a running step"). That
    // id must therefore already be on the bead when the first event arrives; if the order of
    // "record the task" and "observe the stream" ever flipped, a crash mid-stream would leave a
    // running step with no task id to reattach to.
    const store = new InMemoryDoltClient();
    let taskIdOnBeadWhenFirstEventArrived: unknown = 'observe never started';
    const provider = newFakeProvider({
      kind: 'fake-runtime',
      script: async function* (spec: SessionSpec) {
        const stepId = (spec.extra as { stepId: string }).stepId;
        const bead = await store.getBead(stepId);
        taskIdOnBeadWhenFirstEventArrived = (bead?.metadata as { exec?: { task_id?: string } } | undefined)?.exec?.task_id;
        yield { kind: 'turn-done', ts: new Date().toISOString() };
      },
    });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    await dispatcher.run({ formula: singleStepFormula(), pack: singleStepPack(), input: 'go' });

    expect(typeof taskIdOnBeadWhenFirstEventArrived).toBe('string');
    expect(taskIdOnBeadWhenFirstEventArrived).toContain(':prompt-');
  });

  it('applies the dispatch timeout to every step unless the formula declares an override', async () => {
    const formula: Formula = {
      name: 'timeouts', description: '', whenToUse: '',
      steps: [
        { name: 'alpha', role: 'alpha', promptTemplate: 'prompts/alpha.md', waitFor: 'completion' },
        { name: 'beta', role: 'beta', promptTemplate: 'prompts/beta.md', waitFor: 'completion', turnTimeoutMs: 9_000 },
      ],
    };
    const { dispatcher, provider } = newHarness({ script: scriptByRole({ alpha: 'a', beta: 'b' }) });

    await dispatcher.run({ formula, pack: newPack({ roles: ['alpha', 'beta'], prompts: { 'prompts/alpha.md': 'A', 'prompts/beta.md': 'B' } }), input: 'go', stepTimeoutMs: 1_800_000 });

    expect(provider.recorder.starts.map((start) => (start.extra as Record<string, unknown>)['turnTimeoutMs'])).toEqual([1_800_000, 9_000]);
  });

  it('passes the dispatch workdir to every step session', async () => {
    const formula: Formula = {
      name: 'workdir', description: '', whenToUse: '',
      steps: [
        { name: 'alpha', role: 'alpha', promptTemplate: 'prompts/alpha.md', waitFor: 'completion' },
        { name: 'beta', role: 'beta', promptTemplate: 'prompts/beta.md', waitFor: 'completion' },
      ],
    };
    const { dispatcher, provider } = newHarness({ script: scriptByRole({ alpha: 'a', beta: 'b' }) });

    await dispatcher.run({ formula, pack: newPack({ roles: ['alpha', 'beta'], prompts: { 'prompts/alpha.md': 'A', 'prompts/beta.md': 'B' } }), input: 'go', workdir: '/opt/stacks/x' });

    expect(provider.recorder.starts.map((start) => (start.extra as Record<string, unknown>)['workdir'])).toEqual(['/opt/stacks/x', '/opt/stacks/x']);
  });

  // vibesync-u32z: the motivating bead must be carried on the completion event
  // so the writeback hook can resolve it directly from the event, not only by
  // re-reading the persisted molecule_root. On main the formula.completed
  // payload carries no motivating_bead — this assertion FAILS there and PASSES
  // with the fix (dispatcher threads input.motivatingBeadId onto the event).
  it('carries motivating_bead on the formula.completed event when dispatched with one', async () => {
    const { dispatcher, store, events } = newHarness({
      script: scriptByRole({ reviewer: 'review output', coder: 'code output', tester: 'test output' }),
    });

    const result = await dispatcher.run({
      formula: codeReviewFormula(),
      pack: newPack(),
      input: 'please review',
      motivatingBeadId: 'vibesync-sqt0',
    });

    const completed = events.find((event) => event.kind === 'dispatcher/formula.completed');
    expect(completed?.payload).toMatchObject({ motivating_bead: 'vibesync-sqt0' });

    // Regression guard: the persisted root must ALSO carry it (the walker/store
    // path is the belt; the event is the suspenders).
    const root = await store.getBead(result.moleculeId);
    expect(root?.metadata).toMatchObject({ exec: { motivating_bead: 'vibesync-sqt0' } });
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

  it('threads all prior outputs into the generic prior_outputs prompt context', async () => {
    const formula: Formula = {
      name: 'handoff-chain',
      description: 'Handoff chain',
      whenToUse: '',
      steps: [
        { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/mayor.md', waitFor: 'completion' },
        { name: 'coder', role: 'coder', promptTemplate: 'prompts/coder.md', dependsOn: ['mayor'], waitFor: 'completion' },
        { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/reviewer.md', dependsOn: ['coder'], waitFor: 'completion' },
      ],
    };
    const pack = newPack({
      roles: ['mayor', 'coder', 'reviewer'],
      prompts: {
        'prompts/mayor.md': 'Task: ${input}\nPrior: ${prior_outputs}',
        'prompts/coder.md': 'Task: ${input}\nHandoff:\n${prior_outputs}',
        'prompts/reviewer.md': 'Task: ${input}\nHandoff:\n${prior_outputs}',
      },
    });
    const { dispatcher, provider } = newHarness({
      script: scriptByRole({
        mayor: 'mayor spec',
        coder: 'coder patch summary',
        reviewer: 'review verdict',
      }),
    });

    await dispatcher.run({ formula, pack, input: 'build concrete feature' });

    const mayorPrompt = provider.recorder.prompts[0]?.content[0];
    const coderPrompt = provider.recorder.prompts[1]?.content[0];
    const reviewerPrompt = provider.recorder.prompts[2]?.content[0];
    expect(mayorPrompt?.type === 'text' ? mayorPrompt.text : '').toContain('No prior step outputs yet.');
    expect(coderPrompt?.type === 'text' ? coderPrompt.text : '').toContain('## mayor\nmayor spec');
    expect(coderPrompt?.type === 'text' ? coderPrompt.text : '').toContain('Task: build concrete feature');
    expect(reviewerPrompt?.type === 'text' ? reviewerPrompt.text : '').toContain('## mayor\nmayor spec');
    expect(reviewerPrompt?.type === 'text' ? reviewerPrompt.text : '').toContain('## coder\ncoder patch summary');
  });

  it('renders ordered formula roles for the mayor when the input names none', async () => {
    const formula: Formula = {
      name: 'onboard-feature',
      description: '',
      whenToUse: '',
      steps: [
        { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/mayor.md', waitFor: 'completion' },
        { name: 'coder', role: 'coder', promptTemplate: 'prompts/coder.md', dependsOn: ['mayor'], waitFor: 'completion' },
        { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/reviewer.md', dependsOn: ['coder'], waitFor: 'completion' },
        { name: 'tester', role: 'tester', promptTemplate: 'prompts/tester.md', dependsOn: ['reviewer'], waitFor: 'completion' },
      ],
    };
    const pack = newPack({
      roles: ['mayor', 'coder', 'reviewer', 'tester'],
      prompts: {
        'prompts/mayor.md': 'Roles in order: ${roles}\nTask: ${input}',
        'prompts/coder.md': 'Coder',
        'prompts/reviewer.md': 'Reviewer',
        'prompts/tester.md': 'Tester',
      },
    });
    const { dispatcher, provider } = newHarness({ script: scriptByRole({ mayor: 'plan' }) });

    await dispatcher.run({ formula, pack, input: 'Build a feature with no role names in this request.' });

    const mayorPrompt = provider.recorder.prompts[0]?.content[0];
    expect(mayorPrompt?.type === 'text' ? mayorPrompt.text : '').toContain('Roles in order: mayor, coder, reviewer, tester');
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
    expect(renderedBody(betaPrompt?.type === 'text' ? betaPrompt.text : '')).toBe('Beta alpha-output');
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
    expect(provider.recorder.prompts.map((prompt) => renderedBody(prompt.content[0]?.type === 'text' ? prompt.content[0].text : ''))).toEqual([
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
    expect(events.filter(isDispatcherEvent).map((event) => event.kind)).toEqual([
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

  describe('onStarted (vibesync-izn3)', () => {
    it('reports the molecule id once, after the molecule exists and BEFORE the first step runs', async () => {
      const { dispatcher, events, store } = newHarness({ script: scriptByRole({ reviewer: 'a', coder: 'b', tester: 'c' }) });
      const seen: Array<{ id: string; eventKindsSoFar: string[]; rootExists: boolean }> = [];
      let pendingRoot: Promise<unknown> | null = null;
      const result = await dispatcher.run({
        formula: codeReviewFormula(),
        pack: newPack(),
        input: 'go',
        onStarted: (id) => {
          seen.push({ id, eventKindsSoFar: events.filter(isDispatcherEvent).map((e) => e.kind), rootExists: false });
          pendingRoot = store.getBead(id).then((row) => { seen[0]!.rootExists = row !== null && row !== undefined; });
        },
      });
      await pendingRoot;
      expect(seen).toHaveLength(1);
      expect(seen[0]!.id).toBe(result.moleculeId);
      expect(seen[0]!.rootExists).toBe(true);
      // Nothing beyond the (pre-step) lifecycle had happened when the callback fired.
      expect(seen[0]!.eventKindsSoFar).not.toContain('dispatcher/step.started');
    });

    it('a throwing onStarted never fails the run', async () => {
      const { dispatcher } = newHarness({ script: scriptByRole({ reviewer: 'a', coder: 'b', tester: 'c' }) });
      const result = await dispatcher.run({
        formula: codeReviewFormula(),
        pack: newPack(),
        input: 'go',
        onStarted: () => { throw new Error('observer exploded'); },
      });
      expect(result.outputs).toEqual({ reviewer: 'a', coder: 'b', tester: 'c' });
    });
  });

  describe('per-project provider routing (vibesync-f5g)', () => {
    it('resumes a dispatcher-created persisted task on its resolved project provider after restart', async () => {
      const store = new InMemoryDoltClient();
      const defaultProvider = newFakeProvider({ kind: 'default-runtime' });
      const alternateProvider = newFakeProvider({ kind: 'fake-runtime', script: (spec) => eventScript([
        { kind: 'message-delta', text: `reattached ${String(spec.extra?.['resumeTaskId'] ?? '')}` },
      ]) });
      const options = {
        idPrefix: 'mol', provider: defaultProvider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
        providerResolver: { resolve: (input) => input.projectIdentifier === 'vibesync' ? alternateProvider : null },
      };
      const originalDispatcher = newDriven(store, options);
      let moleculeId = '';
      const pending = originalDispatcher.run({
        formula: singleStepFormula(), pack: singleStepPack(), input: 'go', projectIdentifier: 'vibesync',
        onStarted: (id) => { moleculeId = id; },
      });
      await waitForCondition(() => alternateProvider.recorder.starts.length === 1);
      const stepId = newMoleculeStepId(moleculeId, 'worker');
      const walker = new MoleculeWalker(store);
      await walker.startStep(stepId);
      await walker.recordStepTask(stepId, {
        taskId: 'task-resume-project', providerKind: 'fake-runtime', sessionId: 'fake-runtime:worker-previous',
      });

      await newDriven(store, options).resume(moleculeId);
      await originalDispatcher.cancel(moleculeId).catch(() => undefined);
      await pending.catch(() => undefined);

      expect(alternateProvider.recorder.starts).toContainEqual(expect.objectContaining({
        extra: expect.objectContaining({ resumeTaskId: 'task-resume-project' }),
      }));
      expect(defaultProvider.recorder.starts).toHaveLength(0);
    });

    it('cancels a dispatcher-created persisted molecule on its resolved project provider after restart', async () => {
      const store = new InMemoryDoltClient();
      const defaultProvider = newFakeProvider({ kind: 'default-runtime' });
      const alternateProvider = newFakeProvider({ kind: 'fake-runtime' });
      const options = {
        idPrefix: 'mol', provider: defaultProvider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
        providerResolver: { resolve: (input) => input.projectIdentifier === 'vibesync' ? alternateProvider : null },
      };
      const originalDispatcher = newDriven(store, options);
      let moleculeId = '';
      const pending = originalDispatcher.run({
        formula: singleStepFormula(), pack: singleStepPack(), input: 'go', projectIdentifier: 'vibesync',
        onStarted: (id) => { moleculeId = id; },
      });
      await waitForCondition(() => alternateProvider.recorder.starts.length === 1);
      const stepId = newMoleculeStepId(moleculeId, 'worker');
      const walker = new MoleculeWalker(store);
      await walker.startStep(stepId);
      await walker.recordStepTask(stepId, {
        taskId: 'task-cancel-project', providerKind: 'fake-runtime', sessionId: 'fake-runtime:worker-previous',
      });

      await newDriven(store, options).cancel(moleculeId);
      await pending.catch(() => undefined);

      expect(alternateProvider.recorder.stops).toContainEqual({ id: 'fake-runtime:worker-previous', providerKind: 'fake-runtime' });
      expect(defaultProvider.recorder.stops).toHaveLength(0);
    });

    it('cancels an orphan whose running steps have no session to stop without consulting the provider resolver', async () => {
      // vibesync-mswv (CodeRabbit on #140): a resolver error must not abort a cancel that has nothing to stop.
      const store = new InMemoryDoltClient();
      const defaultProvider = newFakeProvider({ kind: 'default-runtime' });
      const options = {
        idPrefix: 'mol', provider: defaultProvider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
        providerResolver: { resolve: () => newFakeProvider({ kind: 'fake-runtime' }) },
      };
      const originalDispatcher = newDriven(store, options);
      let moleculeId = '';
      const pending = originalDispatcher.run({
        formula: singleStepFormula(), pack: singleStepPack(), input: 'go', projectIdentifier: 'vibesync',
        onStarted: (id) => { moleculeId = id; },
      });
      await waitForCondition(() => moleculeId !== '');
      const stepId = newMoleculeStepId(moleculeId, 'worker');
      // The dispatcher may already have started the step and recorded a session: make this one running
      // with NO persisted session, the case under test.
      const step = (await store.getBead(stepId))!;
      const exec = { ...((step.metadata['exec'] as Record<string, unknown>) ?? {}) };
      delete exec['session_id'];
      delete exec['provider_kind'];
      delete exec['task_id'];
      store.beads.set(stepId, { ...step, status: 'in_progress', metadata: { ...step.metadata, exec } });
      let resolverCalls = 0;
      const afterRestart = newDriven(store, {
        ...options,
        providerResolver: { resolve: () => { resolverCalls += 1; throw new Error('provider routing is broken'); } },
      });

      const result = await afterRestart.cancel(moleculeId);
      await pending.catch(() => undefined);

      expect(result.cancelledStepCount).toBe(1);
      expect(resolverCalls).toBe(0);
    });

    it('cancels a live run using the provider selected when it was dispatched', async () => {
      const store = new InMemoryDoltClient();
      const defaultProvider = newFakeProvider({ kind: 'default-runtime' });
      let releaseObservation: (() => void) | undefined;
      const observationBlocked = new Promise<void>((resolve) => { releaseObservation = resolve; });
      const alternateProvider = newFakeProvider({
        kind: 'fake-runtime',
        script: async function* () {
          await observationBlocked;
          yield { kind: 'turn-done', ts: new Date().toISOString() };
        },
      });
      const dispatcher = newDriven(store, {
        idPrefix: 'mol', provider: defaultProvider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
        providerResolver: { resolve: (input) => input.projectIdentifier === 'vibesync' ? alternateProvider : null },
      });
      let moleculeId = '';
      const pending = dispatcher.run({
        formula: singleStepFormula(), pack: singleStepPack(), input: 'go', projectIdentifier: 'vibesync',
        onStarted: (id) => { moleculeId = id; },
      });
      await waitForCondition(() => alternateProvider.recorder.starts.length === 1);
      const stepId = newMoleculeStepId(moleculeId, 'worker');
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await store.getBead(stepId))?.status === 'in_progress') break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect((await store.getBead(stepId))?.status).toBe('in_progress');
      for (let attempt = 0; attempt < 50; attempt++) {
        const exec = (await store.getBead(stepId))?.metadata['exec'] as Record<string, unknown> | undefined;
        if (exec?.['session_id']) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await dispatcher.cancel(moleculeId);
      releaseObservation?.();
      await pending.catch(() => undefined);

      expect(alternateProvider.recorder.stops).toContainEqual({ id: 'fake-runtime:worker-1', providerKind: 'fake-runtime' });
      expect(defaultProvider.recorder.stops).toHaveLength(0);
    });

    it('uses the default provider when no resolver is wired', async () => {
      const { dispatcher, provider } = newHarness({ script: scriptByRole({ worker: 'ran on default' }) });
      const result = await dispatcher.resolveProvider({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'hi',
        projectIdentifier: 'whatever',
      });
      expect(result).toBe(provider);
    });

    it('uses the default provider when a resolver is wired but projectIdentifier is absent', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'default', script: scriptByRole({ worker: 'ok' }) });
      const altProvider = newFakeProvider({ kind: 'alt', script: scriptByRole({ worker: 'alt' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: { resolve: () => altProvider },
      });
      const result = await dispatcher.resolveProvider({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'hi',
        // No projectIdentifier — routing skipped.
      });
      expect(result).toBe(provider);
    });

    it('routes through the resolver when projectIdentifier is set', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'default', script: scriptByRole({ worker: 'default ran' }) });
      const altProvider = newFakeProvider({ kind: 'alt', script: scriptByRole({ worker: 'alt ran' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: {
          resolve: (input) => (input.projectIdentifier === 'vibesync' ? altProvider : null),
        },
      });
      const result = await dispatcher.resolveProvider({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'hi',
        projectIdentifier: 'vibesync',
      });
      expect(result).toBe(altProvider);
    });

    it('falls back to the default when the resolver returns null', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'default', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: { resolve: () => null },
      });
      const result = await dispatcher.resolveProvider({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'hi',
        projectIdentifier: 'other-project',
      });
      expect(result).toBe(provider);
    });

    it('runs the entire molecule against the resolved provider — not the default', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'default', script: scriptByRole({ worker: 'DEFAULT' }) });
      const altProvider = newFakeProvider({ kind: 'alt', script: scriptByRole({ worker: 'ALT' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: {
          resolve: (input) => (input.projectIdentifier === 'vibesync' ? altProvider : null),
        },
      });

      const result = await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });

      // Default provider never received start().
      expect(provider.recorder.starts).toHaveLength(0);
      expect(provider.recorder.prompts).toHaveLength(0);

      // Alt provider ran the whole step.
      expect(altProvider.recorder.starts).toHaveLength(1);
      expect(altProvider.recorder.prompts).toHaveLength(1);
      expect(altProvider.recorder.stops).toHaveLength(1);

      // The step output came from the alt provider's script.
      expect(result.outputs).toMatchObject({ worker: 'ALT' });
    });

    it('threads projectIdentifier into the spawned session.extra', async () => {
      const store = new InMemoryDoltClient();
      const altProvider = newFakeProvider({ kind: 'alt', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider: newFakeProvider({ kind: 'default', script: scriptByRole({ worker: 'unused' }) }),
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: { resolve: () => altProvider },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      const spec = altProvider.recorder.starts[0]!;
      expect((spec.extra as Record<string, unknown>)['projectIdentifier']).toBe('vibesync');
    });

    it('emits formula.started with providerKind so observers can see routing', async () => {
      const store = new InMemoryDoltClient();
      const altProvider = newFakeProvider({ kind: 'subagent-test', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      eventBus.subscribe((event) => events.push(event));
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider: newFakeProvider({ kind: 'default-test', script: scriptByRole({ worker: 'unused' }) }),
        walker: new MoleculeWalker(store),
        eventBus,
        providerResolver: { resolve: () => altProvider },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      const started = events.find((e) => e.kind === 'dispatcher/formula.started');
      expect(started).toBeDefined();
      expect(started?.payload?.providerKind).toBe('subagent-test');
      expect(started?.payload?.projectIdentifier).toBe('vibesync');
    });
  });

  describe('step conversation id (vibesync-jni4, vibesync-9lzk.29)', () => {
    it('records the conversation id the provider reports, and passes none in', async () => {
      const store = new InMemoryDoltClient();
      const base = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      // The Iroh provider creates the conversation on the host and reports it.
      const provider: RuntimeProvider = {
        ...base,
        async prompt(handle, content) {
          const result = await base.prompt(handle, content);
          return { ...result, conversationId: 'local-conv-host-7' };
        },
      };
      const dispatcher = newDriven(store, { idPrefix: 'mol',
        provider,
        walker: new MoleculeWalker(store),
        eventBus: new EventBus({ noPersist: true }),
      });
      const result = await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      const extra = base.recorder.starts[0]!.extra as Record<string, unknown>;
      expect(extra['conversationId']).toBeUndefined();
      expect(extra['agentId']).toBeUndefined();
      const view = await new MoleculeWalker(store).load(result.moleculeId);
      const exec = view!.steps[0]!.metadata['exec'] as Record<string, unknown>;
      expect(exec['conversation_id']).toBe('local-conv-host-7');
      expect(exec['task_id']).toBeTruthy();
    });
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
  const dispatcher = newDriven(store, { idPrefix: 'mol',
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
