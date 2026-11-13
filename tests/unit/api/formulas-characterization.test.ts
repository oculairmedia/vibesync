/**
 * Characterisation tests for the formula and molecule routes (vibesync-9lzk.59),
 * written BEFORE refactoring src/app/http/routes/formulas.ts (CodeScene 7.37;
 * the suite takes 102 of its 324 branch arms). The helpers are not exported, so
 * every case goes through a real route: molecules are seeded through the real
 * MoleculeWalker on the in-memory tracker, and the trace route's events come
 * from a scratch .beads/events.jsonl (vitest runs each file in its own process,
 * so changing the working directory here touches nothing else).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerFormulaRoutes } from '../../../src/app/http/routes/formulas.js';
import { EventBus } from '../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../src/engine/molecule/index.js';
import type { App, HandleContext, OrchestrationApi, RouteContext } from '../../../src/app/types/api.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

type Route = { match: (ctx: RouteContext) => boolean; handle: (ctx: HandleContext) => Promise<void> };
/** A JSON response body, read loosely: the tests index into it by field name. */
type Body = { readonly [key: string]: Body };

const scratch = mkdtempSync(join(tmpdir(), 'formula-routes-'));
const startDir = process.cwd();
beforeAll(() => {
  mkdirSync(join(scratch, '.beads'), { recursive: true });
  // The trace route reads ./.beads/events.jsonl; packs are found from the app
  // root, which falls back to the working directory. Pin it to the repo first.
  process.env.VIBESYNC_APP_ROOT = startDir;
  process.chdir(scratch);
});
afterAll(() => {
  delete process.env.VIBESYNC_APP_ROOT;
  process.chdir(startDir);
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.VIBESYNC_ORCHESTRATION_TOKEN;
  writeFileSync(join(scratch, '.beads', 'events.jsonl'), '');
});

function harness(walker: MoleculeWalker | null, opts: { active?: number; queueDepth?: number } = {}) {
  const routes: Route[] = [];
  const app: App = { registerRoute: (route) => { routes.push(route); } };
  const sendJson = vi.fn();
  const sendError = vi.fn();
  const orchestration = walker
    ? {
      bus: new EventBus({ noPersist: true }),
      walker,
      dispatcher: {
        run: vi.fn(async (input: { onStarted?: (id: string) => void }) => { input.onStarted?.('mol-run'); return { moleculeId: 'mol-run', outputs: {} }; }),
        resume: vi.fn(), cancel: vi.fn(), getQueueDepth: () => opts.queueDepth ?? 0, getActiveMoleculeCount: () => opts.active ?? 0,
      },
      schedulers: new Map(),
      provider: {}, patrol: {}, shutdown: vi.fn(),
    }
    : null;
  const parseJsonBody = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
  registerFormulaRoutes(app, {
    orchestration: orchestration as unknown as OrchestrationApi | null,
    parseJsonBody, sendJson, sendError,
    sseManager: { sendEvent: vi.fn() } as never,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as never);
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const url = new URL(`http://localhost${path}`);
    const route = routes.find((r) => r.match({ method, pathname: url.pathname }))!;
    await route.handle({ req: { headers } as never, res: {} as never, url, pathname: url.pathname });
    const ok = sendJson.mock.calls.at(-1);
    const err = sendError.mock.calls.at(-1);
    return { status: (ok ?? err)?.[1] as number, body: ok?.[2] as Body | undefined, error: err?.[2] as string | undefined };
  };
  return { call, sendJson, sendError, parseJsonBody, run: orchestration?.dispatcher.run };
}

async function molecule(walker: MoleculeWalker, steps: { name: string; role: string }[]) {
  return walker.dispatch({ prefix: 'mol', formulaName: 'onboard-feature', title: '[formula:onboard-feature] Work', steps });
}

function events(lines: Record<string, unknown>[]) {
  writeFileSync(join(scratch, '.beads', 'events.jsonl'), lines.map((l, i) => JSON.stringify({ id: `e-${i}`, ts: new Date(1000 + i).toISOString(), layer: 'dispatcher', ...l })).join('\n') + '\n');
}

describe('guards on the molecule routes', () => {
  it.each([
    ['GET', '/molecules'], ['GET', '/molecules/m-1'], ['GET', '/molecules/m-1/trace'],
    ['POST', '/molecules/m-1/resume'], ['DELETE', '/molecules/m-1'],
  ])('%s %s: 503 when orchestration is not booted', async (method, path) => {
    expect((await harness(null).call(method, path)).status).toBe(503);
  });

  it.each([['GET', '/molecules'], ['GET', '/molecules/m-1/trace']])('%s %s: 401 with a wrong token when one is set', async (method, path) => {
    process.env.VIBESYNC_ORCHESTRATION_TOKEN = 'secret';
    const h = harness(new MoleculeWalker(new InMemoryDoltClient()));
    expect((await h.call(method, path, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await h.call(method, path, { authorization: 'Bearer secret' })).status).not.toBe(401);
  });

  it('GET /molecules/:id and /trace: 404 for an unknown molecule', async () => {
    const h = harness(new MoleculeWalker(new InMemoryDoltClient()));
    expect((await h.call('GET', '/molecules/nope')).status).toBe(404);
    expect((await h.call('GET', '/molecules/nope/trace')).status).toBe(404);
  });
});

describe('GET /molecules', () => {
  it('defaults to open and in-progress molecules, accepts a status list and "all", and reports the fleet', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const listed = vi.spyOn(walker, 'listMolecules');
    const h = harness(walker, { active: 2, queueDepth: 5 });
    const r = await h.call('GET', '/molecules');
    expect(r.body!.fleet).toEqual({ active: 2, queueDepth: 5 });
    expect(listed).toHaveBeenLastCalledWith({ statuses: ['open', 'in_progress'], limit: 50 });
    await h.call('GET', '/molecules?status=closed, open,');
    expect(listed).toHaveBeenLastCalledWith({ statuses: ['closed', 'open'], limit: 50 });
    await h.call('GET', '/molecules?status=all');
    expect(listed).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('clamps the limit to 1..500, floors it, and ignores one that is not a number', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const listed = vi.spyOn(walker, 'listMolecules');
    const h = harness(walker);
    for (const [raw, expected] of [['0', 1], ['9999', 500], ['12.9', 12], ['abc', 50]] as const) {
      await h.call('GET', `/molecules?limit=${raw}`);
      expect(listed).toHaveBeenLastCalledWith({ statuses: ['open', 'in_progress'], limit: expected });
    }
  });
});

describe('GET /molecules/:id: progress, current step and artifacts', () => {
  it('reads a PR url, branch and commit from the coder step\'s text output', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }, { name: 'reviewer', role: 'reviewer' }]);
    const sha = 'a'.repeat(40);
    await walker.finishStep(`${view.rootId}-coder`, `Pushed on branch feat/x-1, commit ${sha}. PR https://github.com/o/r/pull/42 is open.`);
    const body = (await harness(walker).call('GET', `/molecules/${view.rootId}`)).body!;
    expect(body.producedArtifacts).toEqual({ prUrl: 'https://github.com/o/r/pull/42', branch: 'feat/x-1', commitSha: sha });
  });

  it('reads artifacts from a structured coder output (pullRequestUrl and commit win over prUrl and commitSha)', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    await walker.finishStep(`${view.rootId}-coder`, { prUrl: 'p1', pullRequestUrl: 'p2', branch: 'b', commitSha: 'c1', commit: 'c2' });
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}`)).body!.producedArtifacts).toEqual({ prUrl: 'p2', branch: 'b', commitSha: 'c2' });
  });

  it('ignores output from steps that are not the coder', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'reviewer', role: 'reviewer' }]);
    await walker.finishStep(`${view.rootId}-reviewer`, 'see https://github.com/o/r/pull/7');
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}`)).body!.producedArtifacts).toEqual({});
  });

  it('reports progress, the running step as current, and a failed step\'s first error line', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }, { name: 'reviewer', role: 'reviewer' }, { name: 'tester', role: 'tester' }]);
    await walker.finishStep(`${view.rootId}-coder`, 'done');
    await walker.startStep(`${view.rootId}-reviewer`);
    const running = (await harness(walker).call('GET', `/molecules/${view.rootId}`)).body!;
    expect(running.progress).toEqual({ total: 3, done: 1, running: 1 });
    expect(running.currentStepStatus).toBe('in_progress');
    expect(running.status).toBe('running');
    await walker.failStep(`${view.rootId}-reviewer`, '\n  \nBoom: it broke\nstack line');
    const failed = (await harness(walker).call('GET', `/molecules/${view.rootId}`)).body!;
    expect(failed.status).toBe('failed');
    expect(failed.errorSummary).toBe('Boom: it broke');
  });
});

describe('the current step after a review loop-back (an earlier step running, a later one closed)', () => {
  it.each(['/molecules/ID', '/molecules/ID/trace'])('%s reports the running step, not the last closed one', async (path) => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }, { name: 'reviewer', role: 'reviewer' }]);
    await walker.finishStep(`${view.rootId}-reviewer`, 'changes requested');
    await walker.startStep(`${view.rootId}-coder`);
    const body = (await harness(walker).call('GET', path.replace('ID', view.rootId))).body!;
    expect(body.currentStep).toBe('coder');
    expect(body.currentStepStatus).toBe('in_progress');
  });
});

describe('GET /molecules/:id/trace: health, actions, errors and events', () => {
  it.each([
    ['dispatcher/formula.failed', 'failed', ['resume', 'retry']],
    ['dispatcher/formula.resume.paused', 'no_ready_steps', ['resume', 'retry']],
    ['dispatcher/formula.cancelled', 'cancelled', ['retry']],
  ])('an event %s makes the health %s, offering %j', async (kind, state, actions) => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    events([{ kind, molecule_id: view.rootId }]);
    const body = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(body.health.state).toBe(state);
    expect(body.health.evidenceEventIds).toEqual(['e-0']);
    expect(body.availableActions).toEqual(actions);
  });

  it('a turn that stopped for approval makes the health waiting_for_approval, offering cancel and resume', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    // Not tied to a step: the molecule waits, the step's own health does not see it.
    events([{ layer: 'runtime', kind: 'runtime/session.turn_done', molecule_id: view.rootId, payload: { stopReason: 'requires_approval' } }]);
    const body = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(body.health.state).toBe('waiting_for_approval');
    expect(body.availableActions).toEqual(['cancel', 'resume']);
    expect(body.steps[0].health).toBe('idle');
    // Tied to the step by its id: the step waits too.
    events([{ layer: 'runtime', kind: 'runtime/session.turn_done', molecule_id: view.rootId, payload: { stopReason: 'requires_approval', stepId: `${view.rootId}-coder` } }]);
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.steps[0].health).toBe('waiting_for_approval');
  });

  it('a failure wins over a later cancellation; with no events the states follow the steps', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    events([{ kind: 'dispatcher/formula.failed', molecule_id: view.rootId }, { kind: 'dispatcher/formula.cancelled', molecule_id: view.rootId }]);
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.health.state).toBe('failed');
    events([]);
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.health.state).toBe('idle');
    await walker.startStep(`${view.rootId}-coder`);
    const running = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(running.health.state).toBe('running');
    expect(running.availableActions).toEqual(['cancel', 'resume']);
    await walker.finishStep(`${view.rootId}-coder`, 'ok');
    const done = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(done.health.state).toBe('completed');
    expect(done.availableActions).toEqual([]);
  });

  it('collects errors from failed events and session errors (first line only), sums usage, and lists tool calls', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    events([
      { kind: 'dispatcher/step.failed', molecule_id: view.rootId, payload: { error: 'step blew up\ntrace' } },
      { layer: 'runtime', kind: 'runtime/session.error', molecule_id: view.rootId, payload: { message: 'session lost' } },
      { layer: 'runtime', kind: 'runtime/session.usage', molecule_id: view.rootId, payload: { prompt: 10, completion: 3 } },
      { layer: 'runtime', kind: 'runtime/session.usage', molecule_id: view.rootId, payload: { prompt: '5', completion: 2 } },
      { layer: 'runtime', kind: 'runtime/session.tool_call', molecule_id: view.rootId, task_id: 't-1', payload: { tool: 'Bash', stepName: 'coder' } },
      { layer: 'runtime', kind: 'runtime/session.tool_call', molecule_id: view.rootId },
    ]);
    const body = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(body.errors).toEqual(expect.arrayContaining(['step blew up', 'session lost']));
    expect(body.usage).toEqual({ prompt: 10, completion: 5 });
    expect(body.toolCalls).toEqual([
      expect.objectContaining({ eventId: 'e-4', tool: 'Bash', stepName: 'coder', stepId: null, args: null, result: null, ok: null }),
      expect.objectContaining({ eventId: 'e-5', tool: 'unknown', stepName: null }),
    ]);
    expect(body.runtimeEvents[4]).toMatchObject({ taskId: 't-1', moleculeId: view.rootId, payload: { tool: 'Bash', stepName: 'coder' } });
    expect(body.runtimeEvents[5]).not.toHaveProperty('taskId');
    expect(body.runtimeEvents[5]).not.toHaveProperty('payload');
  });

  it('clamps the event limit to 1..1000 and accepts event_limit or limit', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    events([0, 1, 2, 3].map(() => ({ kind: 'dispatcher/step.started', molecule_id: view.rootId })));
    const h = harness(walker);
    expect((await h.call('GET', `/molecules/${view.rootId}/trace?event_limit=2`)).body!.runtimeEvents).toHaveLength(2);
    expect((await h.call('GET', `/molecules/${view.rootId}/trace?limit=0`)).body!.runtimeEvents).toHaveLength(1);
    expect((await h.call('GET', `/molecules/${view.rootId}/trace?limit=abc`)).body!.runtimeEvents).toHaveLength(4);
  });
});

describe('POST /formulas/:name/run', () => {
  it('404 for a pack that does not exist, and for a formula the pack does not have', async () => {
    const h = harness(new MoleculeWalker(new InMemoryDoltClient()));
    h.parseJsonBody.mockResolvedValueOnce({ input: 'do it', pack: 'no-such-pack' });
    expect(await h.call('POST', '/formulas/code-review/run')).toMatchObject({ status: 404, error: 'Pack not found' });
    h.parseJsonBody.mockResolvedValueOnce({ input: 'do it' });
    expect(await h.call('POST', '/formulas/no-such-formula/run')).toMatchObject({ status: 404, error: 'Formula not found' });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('passes a project identifier and a motivating bead on, but not an empty project identifier', async () => {
    const h = harness(new MoleculeWalker(new InMemoryDoltClient()));
    h.parseJsonBody.mockResolvedValueOnce({ input: 'do it', projectIdentifier: '', motivatingBeadId: 'b-1' });
    expect((await h.call('POST', '/formulas/code-review/run')).status).toBe(202);
    expect(h.run!.mock.calls[0]![0]).not.toHaveProperty('projectIdentifier');
    expect(h.run!.mock.calls[0]![0]).toMatchObject({ motivatingBeadId: 'b-1', input: 'do it' });
    h.parseJsonBody.mockResolvedValueOnce({ input: 'do it', projectIdentifier: 'p-1' });
    await h.call('POST', '/formulas/code-review/run');
    expect(h.run!.mock.calls[1]![0]).toMatchObject({ projectIdentifier: 'p-1' });
  });
});

describe('the trace uses the latest event of a kind, and lists each error once', () => {
  it('evidence is the most recent matching event', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    await walker.finishStep(`${view.rootId}-coder`, 'ok');
    events([{ kind: 'dispatcher/formula.completed', molecule_id: view.rootId }, { kind: 'dispatcher/formula.completed', molecule_id: view.rootId }]);
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.health.evidenceEventIds).toEqual(['e-1']);
    events([{ kind: 'dispatcher/formula.failed', molecule_id: view.rootId }, { kind: 'dispatcher/formula.failed', molecule_id: view.rootId }]);
    expect((await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.health.evidenceEventIds).toEqual(['e-1']);
  });

  it('the same error from several events appears once', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    events([
      { kind: 'dispatcher/step.failed', molecule_id: view.rootId, payload: { error: 'same failure' } },
      { kind: 'dispatcher/step.failed', molecule_id: view.rootId, payload: { error: 'same failure' } },
    ]);
    const errors = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!.errors as unknown as string[];
    expect(errors.filter((e) => e === 'same failure')).toHaveLength(1);
  });
});

describe('a failed step\'s own error reaches the trace', () => {
  it('with no events at all, the trace errors still carry the step\'s first error line', async () => {
    const walker = new MoleculeWalker(new InMemoryDoltClient());
    const view = await molecule(walker, [{ name: 'coder', role: 'coder' }]);
    await walker.failStep(`${view.rootId}-coder`, 'compile error in foo.ts\nat line 3');
    events([]);
    const body = (await harness(walker).call('GET', `/molecules/${view.rootId}/trace`)).body!;
    expect(body.errors as unknown as string[]).toEqual(['compile error in foo.ts']);
  });
});
