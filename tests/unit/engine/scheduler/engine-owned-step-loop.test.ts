import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { BootSchedulerOptions } from '../../../../src/engine/scheduler/boot-scheduler.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

function formula(): Formula {
  return {
    name: 'two', description: 'two steps', whenToUse: '',
    steps: [
      { name: 'first', role: 'reviewer', promptTemplate: 'prompts/p.md', waitFor: 'completion' },
      { name: 'dependent', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['first'], waitFor: 'completion' },
    ],
  };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'engine-step-loop-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return {
    manifest: { name: 'test', version: '1.0.0' }, root, scope: 'project',
    roles: ['reviewer', 'coder'].map((name) => ({ name, memoryBlocks: [] })), formulas: [],
  };
}

function schedulerOptions(projectIdentifier: string, paused = false): BootSchedulerOptions {
  const bd = async (args: readonly string[]): Promise<string> => {
    if (args[0] === 'ready' || args[0] === 'list') return '[]';
    throw new Error(`unexpected bd call: ${args.join(' ')}`);
  };
  return {
    config: {
      enabled: true, projectIdentifier, intervalMs: 600_000, poolSize: 1, batchSize: 1, paused,
      readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: 'packs/gastown', autoMerge: false,
      requiredChecks: [], allowedRepos: [], eventDebounceMs: 1,
    },
    listPoolMembers: () => [{ agentId: 'agent-a', role: 'r' }], bd, appRoot: process.cwd(),
  };
}

const handles: OrchestrationHandle[] = [];
async function boot(opts: { scheduler?: BootSchedulerOptions; stepTickIntervalMs?: number } = {}) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake', script: (spec: SessionSpec) => (async function* () {
    const ts = new Date().toISOString();
    yield { kind: 'started', ts } as SessionEvent;
    yield { kind: 'message-delta', ts, text: `${spec.role}-out` } as SessionEvent;
    yield { kind: 'turn-done', ts } as SessionEvent;
  })() });
  const handle = await bootOrchestrationPlane({
    dolt: store as never, beadsStore: store as never, provider, persistEvents: false, runDriftAuditOnBoot: false,
    stepTickIntervalMs: 10, ...opts,
  });
  handles.push(handle);
  return { handle, store, provider };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.shutdown();
});

describe('engine-owned step loop', () => {
  it('starts a cooked molecule step without waiting for a daemon tick', async () => {
    const { handle, provider } = await boot({ scheduler: schedulerOptions('proj') });
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go', projectIdentifier: 'proj' });
    await waitFor(() => provider.recorder.starts.length > 0, 'first formula step did not start');
    expect(provider.recorder.starts[0]?.role).toBe('reviewer');
    await run;
  });

  it('blocks only molecules of the paused project', async () => {
    const { handle, provider } = await boot({ scheduler: schedulerOptions('paused', true) });
    let pausedSettled = false;
    const pausedRun = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'paused', projectIdentifier: 'paused' });
    pausedRun.then(() => { pausedSettled = true; }, () => { pausedSettled = true; });
    const liveRun = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'live', projectIdentifier: 'unpaused' });
    await waitFor(() => provider.recorder.starts.length >= 2, "unpaused project's steps did not run");
    expect(pausedSettled).toBe(false);
    expect(provider.recorder.starts.every((start) => start.extra?.['projectIdentifier'] === 'unpaused')).toBe(true);
    await liveRun;
  });

  it('runs molecules without a project when the scheduler is paused', async () => {
    const { handle, provider } = await boot({ scheduler: schedulerOptions('paused', true) });
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'unscoped' });
    await run;
    expect(provider.recorder.starts.map((start) => start.role)).toEqual(['reviewer', 'coder']);
  });

  it('lets a held molecule proceed after the scheduler is unpaused', async () => {
    let paused = true;
    const options = schedulerOptions('proj', true);
    const { handle, provider } = await boot({ scheduler: { ...options, config: { ...options.config, get paused() { return paused; } } } });
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go', projectIdentifier: 'proj' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(provider.recorder.starts).toHaveLength(0);
    paused = false;
    await run;
    expect(provider.recorder.starts.map((start) => start.role)).toEqual(['reviewer', 'coder']);
  });

  it('finishes an in-flight step after pausing but does not start its dependent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: (spec) => (async function* () {
      const ts = new Date().toISOString();
      yield { kind: 'started', ts } as SessionEvent;
      if (spec.role === 'reviewer') {
        started();
        await gate;
      }
      yield { kind: 'message-delta', ts, text: 'done' } as SessionEvent;
      yield { kind: 'turn-done', ts } as SessionEvent;
    })() });
    let paused = false;
    const options = schedulerOptions('proj');
    const scheduledConfig = { ...options.config, get paused() { return paused; } };
    const handle = await bootOrchestrationPlane({
      dolt: store as never, beadsStore: store as never, provider,
      scheduler: { ...options, config: scheduledConfig }, persistEvents: false,
      runDriftAuditOnBoot: false, stepTickIntervalMs: 10,
    });
    handles.push(handle);
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go', projectIdentifier: 'proj' });
    await firstStarted;
    paused = true;
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(provider.recorder.starts.map((start) => start.role)).toEqual(['reviewer']);
    const moleculeId = handle.dispatcher.liveMoleculeIds()[0]!;
    const firstStepId = `${moleculeId}-first`;
    const dependentId = `${moleculeId}-dependent`;
    await waitFor(() => (store.beads.get(firstStepId)?.status === 'closed'), 'in-flight step did not finish');
    expect((await store.getBead(dependentId))?.status).toBe('open');
    expect(handle.dispatcher.liveMoleculeIds()).toContain(moleculeId);
    await handle.shutdown();
    void run;
  });
});
