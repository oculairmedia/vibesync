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

  describe('per-project provider routing (vibesync-f5g)', () => {
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
      const dispatcher = new FormulaDispatcher({
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
      const dispatcher = new FormulaDispatcher({
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
      const dispatcher = new FormulaDispatcher({
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
      const dispatcher = new FormulaDispatcher({
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
      const dispatcher = new FormulaDispatcher({
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
      const dispatcher = new FormulaDispatcher({
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

  describe('persistent role-agent bootstrap (vibesync-mcz Phase D)', () => {
    /**
     * A recording RoleAgentBootstrapperLike that returns a fixed
     * agentId. Lets us assert both that the dispatcher called it
     * with the right args, and how many times.
     */
    function recordingBootstrapper(agentId: string = 'agent-reviewer-vibesync-1') {
      const calls: Array<{
        projectIdentifier: string;
        role: string;
        packDir: string;
        lettaBaseUrl: string;
        storageDir: string;
      }> = [];
      return {
        calls,
        bootstrapper: {
          async ensureRoleAgent(args: {
            projectIdentifier: string;
            role: string;
            packDir: string;
            lettaBaseUrl: string;
            storageDir: string;
          }) {
            calls.push(args);
            return { agentId };
          },
        },
      };
    }

    function deterministicConvGen(): { calls: number; gen: { next(): string } } {
      const state = { calls: 0, gen: { next: (): string => '' } };
      state.gen.next = () => {
        state.calls += 1;
        return `conv-test-${state.calls}`;
      };
      return state;
    }

    it('skips bootstrap and conversation_id when no context resolver is wired (compat)', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      const spec = provider.recorder.starts[0]!;
      expect((spec.extra as Record<string, unknown>)['agentId']).toBeUndefined();
      expect((spec.extra as Record<string, unknown>)['conversationId']).toBeUndefined();
    });

    it('skips bootstrap when context resolver returns null', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const { calls, bootstrapper } = recordingBootstrapper();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        roleAgentContextResolver: { resolve: () => null },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      // Bootstrapper never consulted (resolver returned null).
      expect(calls).toHaveLength(0);
      void bootstrapper; // suppress unused warning
      const spec = provider.recorder.starts[0]!;
      expect((spec.extra as Record<string, unknown>)['agentId']).toBeUndefined();
      expect((spec.extra as Record<string, unknown>)['conversationId']).toBeUndefined();
    });

    it('skips bootstrap when projectIdentifier is absent', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const { calls, bootstrapper } = recordingBootstrapper();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        // No projectIdentifier — bootstrap must NOT fire.
      });
      expect(calls).toHaveLength(0);
    });

    it('calls ensureRoleAgent per step and threads extra.agentId + extra.conversationId', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const { calls, bootstrapper } = recordingBootstrapper('agent-worker-vibesync');
      const { gen } = deterministicConvGen();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        conversationIdGenerator: gen,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      expect(calls).toEqual([
        {
          projectIdentifier: 'vibesync',
          role: 'worker',
          packDir: '/packs/gastown',
          lettaBaseUrl: 'http://shim:8291',
          storageDir: '/storage',
        },
      ]);
      const spec = provider.recorder.starts[0]!;
      const extra = spec.extra as Record<string, unknown>;
      expect(extra['agentId']).toBe('agent-worker-vibesync');
      expect(extra['conversationId']).toBe('conv-test-1');
    });

    it('mints a fresh conversation_id per step (multi-step formula)', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({
        kind: 'fake',
        script: scriptByRole({ reviewer: 'r-ok', coder: 'c-ok', tester: 't-ok' }),
      });
      const eventBus = new EventBus({ noPersist: true });
      const { calls, bootstrapper } = recordingBootstrapper('agent-stub');
      const { gen } = deterministicConvGen();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        conversationIdGenerator: gen,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      await dispatcher.run({
        formula: codeReviewFormula(),
        pack: newPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      // Three steps → three bootstrap calls (one per step).
      expect(calls.map((c) => c.role)).toEqual(['reviewer', 'coder', 'tester']);
      // Three distinct conversation_ids — one per step.
      const conversationIds = provider.recorder.starts.map(
        (s) => (s.extra as Record<string, unknown>)['conversationId'],
      );
      expect(conversationIds).toEqual(['conv-test-1', 'conv-test-2', 'conv-test-3']);
    });

    it('persists conversation_id on the step bead via recordStepTask', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const { bootstrapper } = recordingBootstrapper();
      const { gen } = deterministicConvGen();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        conversationIdGenerator: gen,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      const result = await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });

      // Walk the molecule's step beads and find the conversation_id.
      const view = await new MoleculeWalker(store).load(result.moleculeId);
      const stepBead = view!.steps[0]!;
      const exec = stepBead.metadata['exec'] as Record<string, unknown>;
      expect(exec['conversation_id']).toBe('conv-test-1');
      // task_id still recorded (no regression on f5g).
      expect(exec['task_id']).toBeTruthy();
    });

    it('fails fast when the bootstrapper throws', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const failingBootstrapper = {
        async ensureRoleAgent() {
          throw new Error('persona md missing');
        },
      };
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper: failingBootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      let captured: unknown;
      try {
        await dispatcher.run({
          formula: singleStepFormula(),
          pack: singleStepPack(),
          input: 'go',
          projectIdentifier: 'vibesync',
        });
      } catch (err) {
        captured = err;
      }
      // Wrapped in FormulaDispatchError with cause = original error.
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toMatch(/step "worker" failed/);
      expect(((captured as { cause?: Error }).cause)?.message).toMatch(/persona md missing/);
      // Provider was NOT started — bootstrap failure is pre-flight.
      expect(provider.recorder.starts).toHaveLength(0);
    });

    it('emits dispatcher/step.role_agent_bootstrapped on the bootstrap path', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake', script: scriptByRole({ worker: 'ok' }) });
      const eventBus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      eventBus.subscribe((event) => events.push(event));
      const { bootstrapper } = recordingBootstrapper('agent-emitted');
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      await dispatcher.run({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
        projectIdentifier: 'vibesync',
      });
      const bootstrapped = events.find((e) => e.kind === 'dispatcher/step.role_agent_bootstrapped');
      expect(bootstrapped).toBeDefined();
      expect(bootstrapped?.payload?.agentId).toBe('agent-emitted');
      expect(bootstrapped?.payload?.projectIdentifier).toBe('vibesync');
      expect(bootstrapped?.payload?.role).toBe('worker');
    });

    it('resolveRoleAgentContext returns null when no projectIdentifier on the input', async () => {
      const store = new InMemoryDoltClient();
      const provider = newFakeProvider({ kind: 'fake' });
      const eventBus = new EventBus({ noPersist: true });
      const { bootstrapper } = recordingBootstrapper();
      const dispatcher = new FormulaDispatcher({
        provider,
        walker: new MoleculeWalker(store),
        eventBus,
        roleAgentContextResolver: {
          resolve: () => ({
            bootstrapper,
            packDir: '/packs/gastown',
            lettaBaseUrl: 'http://shim:8291',
            storageDir: '/storage',
          }),
        },
      });
      const result = await dispatcher.resolveRoleAgentContext({
        formula: singleStepFormula(),
        pack: singleStepPack(),
        input: 'go',
      });
      expect(result).toBeNull();
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
