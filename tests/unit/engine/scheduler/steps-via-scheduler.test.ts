/**
 * vibesync-efee — formula steps are dispatched by the scheduler loop (or, with
 * the scheduler off, by the step loop boot starts), never by the dispatcher's
 * own in-process "what runs next" loop.
 *
 * Everything goes through the REAL boot path (`bootOrchestrationPlane`). FALSE
 * PASS this suite avoids: walking steps through the old walker/dispatcher loop.
 * Proof it is gone: with nothing ticking, `dispatcher.run()` starts NO step.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFormulaRoutes } from '../../../../src/app/http/routes/formulas.js';
import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import { FormulaDispatcher } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { BootSchedulerOptions } from '../../../../src/engine/scheduler/boot-scheduler.js';
import { StepDispatcher, type ReadyStepSource } from '../../../../src/engine/scheduler/step-dispatcher.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import type { App, HandleContext, OrchestrationApi, RouteContext } from '../../../../src/app/types/api.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const TICK = 'daemon/scheduler.tick';

function formula(): Formula {
  return {
    name: 'three',
    description: 'three steps',
    whenToUse: '',
    steps: [
      { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/p.md', waitFor: 'completion' },
      { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['reviewer'], waitFor: 'completion' },
      { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'], waitFor: 'completion' },
    ],
  };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'efee-pack-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return {
    manifest: { name: 'efee', version: '1.0.0' },
    root,
    scope: 'project',
    roles: ['reviewer', 'coder', 'tester'].map((name) => ({ name, memoryBlocks: [] })),
    formulas: [],
  };
}

function script(spec: SessionSpec): AsyncIterable<SessionEvent> {
  return (async function* () {
    const ts = new Date().toISOString();
    yield { kind: 'started', ts };
    yield { kind: 'message-delta', ts, text: `${spec.role}-out` };
    yield { kind: 'turn-done', ts };
  })();
}

const POOL = [{ agentId: 'agent-a', role: 'r' }];

/** Fake `bd` for the work-bead side of the daemon; step readiness never goes through it. */
function fakeBd() {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === 'ready' || args[0] === 'list') return '[]';
    throw new Error(`unexpected bd call: ${args.join(' ')}`);
  };
  return { run, calls };
}

function schedulerOptions(bd: ReturnType<typeof fakeBd>): BootSchedulerOptions {
  return {
    config: {
      enabled: true, projectIdentifier: 'proj', intervalMs: 600_000, poolSize: 1, batchSize: 1, paused: false,
      readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: 'packs/gastown', autoMerge: false,
      requiredChecks: [], allowedRepos: [], eventDebounceMs: 1,
    },
    listPoolMembers: () => POOL,
    bd: bd.run,
    appRoot: process.cwd(),
  };
}

const handles: OrchestrationHandle[] = [];
async function boot(extra: Partial<Parameters<typeof bootOrchestrationPlane>[0]> = {}) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake', script });
  const handle = await bootOrchestrationPlane({
    dolt: store as never,
    beadsStore: store as never,
    provider,
    persistEvents: false,
    runDriftAuditOnBoot: false,
    stepTickIntervalMs: 10,
    ...extra,
  });
  handles.push(handle);
  const events: Event[] = [];
  handle.bus.subscribe((e) => events.push(e));
  return { handle, store, provider, events };
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.shutdown();
});

describe('the dispatcher no longer drives its own molecules (vibesync-efee)', () => {
  it('cooks and waits: with nothing ticking, run() starts NO step and the old loop entry points are gone', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script });
    const walker = new MoleculeWalker(store);
    const dispatcher = new FormulaDispatcher({ idPrefix: 'mol', provider, walker, eventBus: new EventBus({ noPersist: true }) });
    let settled = false;
    const run = dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });
    run.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toBe(false);
    expect(provider.recorder.starts).toHaveLength(0); // no step ran: nothing in the dispatcher decides "what's next"
    expect(dispatcher.liveMoleculeIds()).toHaveLength(1); // cooked, waiting for the bead graph to say "ready"
    expect('findReady' in walker).toBe(false);
    expect(Object.getOwnPropertyNames(FormulaDispatcher.prototype)).not.toContain('runNow');

    // ...and one StepDispatcher offer (the scheduler's job) is all it takes.
    const steps = new StepDispatcher({
      source: { readySteps: async () => (await store.findReadyStepsForMolecule(dispatcher.liveMoleculeIds()[0]!)).map((step) => ({ moleculeId: dispatcher.liveMoleculeIds()[0]!, step })) },
      runner: dispatcher,
    });
    steps.setWake(() => undefined); // explicit ticks only, to see one wave at a time
    await steps.tick();
    await steps.drain();
    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['reviewer']);
    await steps.tick();
    await steps.drain();
    await steps.tick();
    await steps.drain();
    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
    expect((await run).outputs).toEqual({ reviewer: 'reviewer-out', coder: 'coder-out', tester: 'tester-out' });
  });
});

describe('scheduler ON: all three steps are dispatched by the scheduler loop', () => {
  it('a formula run completes through daemon ticks; the step loop never ticks on its own', async () => {
    const bd = fakeBd();
    // Spy BEFORE boot: boot is what would start the fallback timer.
    const selfTick = vi.spyOn(StepDispatcher.prototype, 'start');
    const { handle, store, provider, events } = await boot({ scheduler: schedulerOptions(bd) });
    expect(handle.scheduler).not.toBeNull();

    const result = await handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });

    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
    expect(result.outputs).toEqual({ reviewer: 'reviewer-out', coder: 'coder-out', tester: 'tester-out' });
    for (const name of ['reviewer', 'coder', 'tester']) {
      expect((await store.getBead(newMoleculeStepId(result.moleculeId, name)))?.status).toBe('closed');
    }
    expect((await store.getBead(result.moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
    expect(selfTick).not.toHaveBeenCalled(); // the scheduler owns the loop
    selfTick.mockRestore();
    // The steps were run by daemon ticks, woken by the cook / step settle - not by the 600 s interval.
    const ticks = events.filter((e) => e.kind === TICK);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.every((t) => t.payload['reason'] !== 'interval')).toBe(true);
    // Step readiness never touched `bd ready` (that source is for WORK beads only).
    expect(bd.calls.filter((c) => c[0] === 'ready' && c.includes('--mol'))).toEqual([]);
  });

  it('a paused scheduler dispatches no steps either', async () => {
    const bd = fakeBd();
    const opts = schedulerOptions(bd);
    const { handle, provider } = await boot({ scheduler: { ...opts, config: { ...opts.config, paused: true } } });
    let settled = false;
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });
    run.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(provider.recorder.starts).toHaveLength(0);
    await handle.shutdown(); // the cooked-but-never-started run is simply left open, as a crashed one would be
  });
});

describe('scheduler OFF (the production default): formula runs still execute', () => {
  it('a formula run completes with scheduler=null via the step loop boot starts', async () => {
    const selfTick = vi.spyOn(StepDispatcher.prototype, 'start');
    const { handle, store, provider } = await boot();
    expect(selfTick).toHaveBeenCalledTimes(1); // boot started the fallback timer
    selfTick.mockRestore();
    expect(handle.scheduler).toBeNull();

    const result = await handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });

    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
    expect((await store.getBead(result.moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
  });

  it('a scheduler that failed to start leaves the step loop running (formulas must not stall)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bd = fakeBd();
    const { handle } = await boot({ scheduler: { ...schedulerOptions(bd), listPoolMembers: () => [] } });
    expect(handle.scheduler).toBeNull();
    const result = await handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });
    expect(result.outputs['tester']).toBe('tester-out');
    errSpy.mockRestore();
  });

  it('POST /formulas/:name/run cooks and returns the moleculeId immediately; execution proceeds via the loop', async () => {
    const { handle, store, provider } = await boot();
    const routes: Array<{ match(c: RouteContext): boolean; handle(c: HandleContext): Promise<void> }> = [];
    const app: App = { registerRoute: (r) => { routes.push(r as never); } };
    const sendJson = vi.fn();
    const sendError = vi.fn();
    registerFormulaRoutes(app, {
      orchestration: handle as unknown as OrchestrationApi,
      parseJsonBody: async () => ({ input: 'review this' }) as never,
      sendJson, sendError,
      sseManager: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    const route = routes.find((r) => r.match({ method: 'POST', pathname: '/formulas/code-review/run' } as RouteContext))!;
    delete process.env['VIBESYNC_ORCHESTRATION_TOKEN'];
    const pathname = '/formulas/code-review/run';
    await route.handle({ req: { headers: {} } as never, res: {} as never, url: new URL(`http://x${pathname}`), pathname });

    expect(sendError).not.toHaveBeenCalled();
    const [, status, body] = sendJson.mock.calls[0]!;
    expect(status).toBe(202);
    const moleculeId = (body as { moleculeId: string }).moleculeId;
    expect(moleculeId).toMatch(/^mol-mol-/);

    // The response came back on cook; the steps then run through the loop.
    const deadline = Date.now() + 5_000;
    while ((await store.getBead(moleculeId))?.status !== 'closed') {
      if (Date.now() > deadline) throw new Error('molecule did not complete');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await store.getBead(moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
  });
});

describe('cancel and failure (the bead graph unblocks dependents; the run context must not start them)', () => {
  it('cancelling a running molecule starts no dependent step, keeps the root `cancelled`, and releases run()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { handle, store, provider } = await boot({
      provider: newFakeProvider({
        kind: 'fake',
        script: (spec) => (async function* () {
          const ts = new Date().toISOString();
          yield { kind: 'started', ts } as SessionEvent;
          if (spec.role === 'reviewer') await gate;
          yield { kind: 'message-delta', ts, text: 'x' } as SessionEvent;
          yield { kind: 'turn-done', ts } as SessionEvent;
        })(),
      }),
    });
    const run = handle.dispatcher.run({ formula: formula(), pack: pack(), input: 'go' });
    const settled = run.then(() => 'ok', (e: unknown) => String((e as Error).message));
    const deadline = Date.now() + 5_000;
    while ((await store.findRunningStepsForMolecule(handle.dispatcher.liveMoleculeIds()[0] ?? 'none')).length === 0) {
      if (Date.now() > deadline) throw new Error('reviewer never started');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const moleculeId = handle.dispatcher.liveMoleculeIds()[0]!;
    await handle.dispatcher.cancel(moleculeId);
    release();
    expect(await settled).toMatch(/was cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider).toBeDefined();
    expect((await store.getBead(moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'cancelled' } });
    expect((await store.getBead(newMoleculeStepId(moleculeId, 'coder')))?.status).toBe('open');
    expect(handle.dispatcher.liveMoleculeIds()).toEqual([]);
  });
});

describe('StepDispatcher', () => {
  function fakeSource(ids: string[]): ReadyStepSource {
    return { readySteps: async () => ids.map((id) => ({ moleculeId: 'm', step: { id } as never })) };
  }

  it('never offers a step that is still in flight, and offers it again only if the graph still says ready', async () => {
    const release: Array<() => void> = [];
    const runner = { runReadyStep: vi.fn(() => new Promise<'finished'>((resolve) => { release.push(() => resolve('finished')); })) };
    const steps = new StepDispatcher({ source: fakeSource(['s1']), runner });
    expect((await steps.tick()).offered).toEqual(['s1']);
    expect((await steps.tick()).offered).toEqual([]); // in flight
    expect(runner.runReadyStep).toHaveBeenCalledTimes(1);
    release[0]!();
    await steps.drain();
    expect((await steps.tick()).offered).toEqual(['s1']); // settled, graph (fake) still lists it
    release[1]!();
    await steps.drain();
  });

  it('a skipped step does not kick (no spin); a finished one does', async () => {
    const wake = vi.fn();
    const outcomes: Array<'skipped' | 'finished'> = ['skipped', 'finished'];
    const steps = new StepDispatcher({ source: fakeSource(['s1']), runner: { runReadyStep: async () => outcomes.shift()! } });
    steps.setWake(wake);
    await steps.tick(); await steps.drain();
    expect(wake).not.toHaveBeenCalled();
    await steps.tick(); await steps.drain();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a throwing runner is contained and still wakes the loop', async () => {
    const wake = vi.fn();
    const warn = vi.fn();
    const steps = new StepDispatcher({ source: fakeSource(['s1']), runner: { runReadyStep: async () => { throw new Error('boom'); } }, logger: { warn } });
    steps.setWake(wake);
    await steps.tick(); await steps.drain();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }), 'step-dispatcher: runner rejected');
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
