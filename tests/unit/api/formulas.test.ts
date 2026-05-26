import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFormulaRoutes } from '../../../src/api/routes/formulas.js';
import { FormulaCancellationConflictError } from '../../../src/orchestration/dispatcher/index.js';
import { EventBus } from '../../../src/orchestration/events/index.js';
import { MoleculeWalker } from '../../../src/orchestration/molecule/index.js';
import type { Formula } from '../../../src/orchestration/formula/index.js';
import type { App, HandleContext, OrchestrationApi, RouteContext } from '../../../src/types/api.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

describe('formula routes', () => {
  afterEach(() => {
    delete process.env.VIBESYNC_ORCHESTRATION_TOKEN;
  });

  it('POST /formulas/:name/run returns moleculeId with 202', async () => {
    const harness = newHarness();
    const route = harness.find('POST', '/formulas/code-review/run');
    harness.parseJsonBody.mockResolvedValue({ input: 'review this' });

    await route.handle(ctx('/formulas/code-review/run'));

    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 202, expect.objectContaining({
      moleculeId: 'mol-123',
      formulaName: 'code-review',
      pack: 'gastown',
    }));
  });

  it('GET /formulas includes dispatcher queue depth when orchestration is booted', async () => {
    const harness = newHarness({ queueDepth: 3 });
    const route = harness.find('GET', '/formulas');

    await route.handle(ctx('/formulas'));

    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 200, expect.objectContaining({
      formulas: expect.arrayContaining([expect.objectContaining({ name: 'code-review' })]),
      queue: { depth: 3 },
    }));
  });

  it('GET /formulas exposes whenToUse catalog hint (vibesync-cy4)', async () => {
    const harness = newHarness();
    const route = harness.find('GET', '/formulas');

    await route.handle(ctx('/formulas'));

    const call = harness.sendJson.mock.calls.at(-1);
    expect(call).toBeDefined();
    const body = call![2] as { formulas: { name: string; whenToUse: string }[] };
    const codeReview = body.formulas.find((f) => f.name === 'code-review');
    expect(codeReview).toBeDefined();
    expect(typeof codeReview!.whenToUse).toBe('string');
    expect(codeReview!.whenToUse).toMatch(/when a bead represents a concrete code change/);
  });

  it('POST /formulas/:name/run rejects missing input', async () => {
    const harness = newHarness();
    const route = harness.find('POST', '/formulas/code-review/run');
    harness.parseJsonBody.mockResolvedValue({});

    await route.handle(ctx('/formulas/code-review/run'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 400, 'Missing required field: input');
  });

  it('POST /formulas/:name/run returns 404 for unknown formula', async () => {
    const harness = newHarness();
    const route = harness.find('POST', '/formulas/missing/run');
    harness.parseJsonBody.mockResolvedValue({ input: 'x' });

    await route.handle(ctx('/formulas/missing/run'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 404, 'Formula not found', expect.objectContaining({ formulaName: 'missing' }));
  });

  it('POST /formulas/:name/run returns 503 without orchestration plane', async () => {
    const harness = newHarness({ orchestration: null });
    const route = harness.find('POST', '/formulas/code-review/run');

    await route.handle(ctx('/formulas/code-review/run'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 503, 'Orchestration plane not booted');
  });

  it('POST /formulas/:name/run requires a valid bearer token when configured', async () => {
    process.env.VIBESYNC_ORCHESTRATION_TOKEN = 'secret';
    const harness = newHarness();
    const route = harness.find('POST', '/formulas/code-review/run');

    await route.handle(ctx('/formulas/code-review/run'));
    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 401, 'Unauthorized');

    harness.sendError.mockClear();
    harness.parseJsonBody.mockResolvedValue({ input: 'review this' });
    await route.handle(ctx('/formulas/code-review/run', harness.res, { authorization: 'Bearer secret' }));
    expect(harness.sendError).not.toHaveBeenCalled();
    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 202, expect.objectContaining({ moleculeId: 'mol-123' }));
  });

  it('GET /molecules/:id reflects walker state', async () => {
    const store = new InMemoryDoltClient();
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol',
      formulaName: 'code-review',
      title: '[formula:code-review] Code review',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
    });
    await walker.finishStep(`${view.rootId}-reviewer`, { output: 'LGTM', eventCount: 2 });
    const harness = newHarness({ walker });
    const route = harness.find('GET', `/molecules/${view.rootId}`);

    await route.handle(ctx(`/molecules/${view.rootId}`));

    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 200, expect.objectContaining({
      moleculeId: view.rootId,
      formulaName: 'code-review',
      status: 'completed',
      steps: [expect.objectContaining({ stepName: 'reviewer', role: 'reviewer', status: 'closed', output: 'LGTM' })],
    }));
  });

  it('POST /molecules/:id/resume delegates to dispatcher resume', async () => {
    const harness = newHarness();
    const route = harness.find('POST', '/molecules/mol-123/resume');

    await route.handle(ctx('/molecules/mol-123/resume'));

    if (!harness.orchestration) throw new Error('expected orchestration harness');
    expect(harness.orchestration.dispatcher.resume).toHaveBeenCalledWith('mol-123');
    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 202, {
      moleculeId: 'mol-123',
      outputs: { reviewer: 'recovered' },
    });
  });

  it('POST /molecules/:id/resume requires a valid bearer token when configured', async () => {
    process.env.VIBESYNC_ORCHESTRATION_TOKEN = 'secret';
    const harness = newHarness();
    const route = harness.find('POST', '/molecules/mol-123/resume');

    await route.handle(ctx('/molecules/mol-123/resume'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 401, 'Unauthorized');
    if (!harness.orchestration) throw new Error('expected orchestration harness');
    expect(harness.orchestration.dispatcher.resume).not.toHaveBeenCalled();
  });

  it('DELETE /molecules/:id delegates to dispatcher cancel', async () => {
    const harness = newHarness();
    const route = harness.find('DELETE', '/molecules/mol-123');

    await route.handle(ctx('/molecules/mol-123'));

    if (!harness.orchestration) throw new Error('expected orchestration harness');
    expect(harness.orchestration.dispatcher.cancel).toHaveBeenCalledWith('mol-123');
    expect(harness.sendJson).toHaveBeenCalledWith(harness.res, 202, {
      moleculeId: 'mol-123',
      status: 'cancelled',
      cancelledStepCount: 1,
    });
  });

  it('DELETE /molecules/:id requires a valid bearer token when configured', async () => {
    process.env.VIBESYNC_ORCHESTRATION_TOKEN = 'secret';
    const harness = newHarness();
    const route = harness.find('DELETE', '/molecules/mol-123');

    await route.handle(ctx('/molecules/mol-123'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 401, 'Unauthorized');
    if (!harness.orchestration) throw new Error('expected orchestration harness');
    expect(harness.orchestration.dispatcher.cancel).not.toHaveBeenCalled();
  });

  it('DELETE /molecules/:id returns 409 when the molecule is not cancellable', async () => {
    const harness = newHarness();
    if (!harness.orchestration) throw new Error('expected orchestration harness');
    harness.orchestration.dispatcher.cancel.mockRejectedValueOnce(new FormulaCancellationConflictError('not running', 'mol-123'));
    const route = harness.find('DELETE', '/molecules/mol-123');

    await route.handle(ctx('/molecules/mol-123'));

    expect(harness.sendError).toHaveBeenCalledWith(harness.res, 409, 'Molecule is not cancellable', expect.objectContaining({ moleculeId: 'mol-123' }));
  });

  it('GET /molecules/:id/events filters by molecule_id and closes on completion', async () => {
    const bus = new EventBus({ noPersist: true });
    const harness = newHarness({ bus });
    const route = harness.find('GET', '/molecules/mol-1/events');
    const sseRes = new MockSseResponse();

    await route.handle(ctx('/molecules/mol-1/events', sseRes));
    bus.emit({ layer: 'dispatcher', kind: 'dispatcher/step.started', molecule_id: 'other', payload: {} });
    bus.emit({ layer: 'dispatcher', kind: 'dispatcher/step.started', molecule_id: 'mol-1', payload: { stepName: 'reviewer' } });
    bus.emit({ layer: 'dispatcher', kind: 'dispatcher/formula.completed', molecule_id: 'mol-1', payload: {} });

    expect(sseRes.writes.join('')).toContain('event: dispatcher/step.started');
    expect(sseRes.writes.join('')).not.toContain('other');
    expect(sseRes.ended).toBe(true);
  });
});

function newHarness(overrides: { orchestration?: ReturnType<typeof newOrchestration> | null; bus?: EventBus; walker?: MoleculeWalker; queueDepth?: number } = {}) {
  const routes: Route[] = [];
  const app: App = { registerRoute: (route) => { routes.push(route); } };
  const orchestration = overrides.orchestration === undefined
    ? newOrchestration(overrides)
    : overrides.orchestration;
  const parseJsonBody = vi.fn();
  const sendJson = vi.fn();
  const sendError = vi.fn();
  const res = {};
  registerFormulaRoutes(app, {
    orchestration: orchestration as unknown as OrchestrationApi | null,
    parseJsonBody,
    sendJson,
    sendError,
    sseManager: { sendEvent: sendSseEvent } as never,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
  return {
    routes,
    parseJsonBody,
    sendJson,
    sendError,
    res,
    orchestration,
    find: (method: string, pathname: string) => routes.find((route) => route.match({ method, pathname }))!,
  };
}

function newOrchestration(overrides: { bus?: EventBus; walker?: MoleculeWalker; queueDepth?: number } = {}): TestOrchestration {
  const bus = overrides.bus ?? new EventBus({ noPersist: true });
  const walker = overrides.walker ?? new MoleculeWalker(new InMemoryDoltClient());
  return {
    bus,
    walker,
    dispatcher: {
      run: vi.fn(async (input: { formula: Formula }) => {
        bus.emit({
          layer: 'dispatcher',
          kind: 'dispatcher/formula.started',
          molecule_id: 'mol-123',
          payload: { formulaName: input.formula.name, moleculeId: 'mol-123' },
        });
        return { moleculeId: 'mol-123', outputs: {} };
      }),
      resume: vi.fn(async (moleculeId: string) => ({ moleculeId, outputs: { reviewer: 'recovered' } })),
      cancel: vi.fn(async (moleculeId: string) => ({ moleculeId, cancelledStepCount: 1 })),
      getQueueDepth: vi.fn(() => overrides.queueDepth ?? 0),
      getActiveMoleculeCount: vi.fn(() => 0),
    },
    provider: {},
    patrol: {},
    shutdown: vi.fn(async () => undefined),
  };
}

interface TestOrchestration {
  readonly bus: EventBus;
  readonly walker: MoleculeWalker;
  readonly dispatcher: {
    readonly run: ReturnType<typeof vi.fn>;
    readonly resume: ReturnType<typeof vi.fn>;
    readonly cancel: ReturnType<typeof vi.fn>;
    readonly getQueueDepth: ReturnType<typeof vi.fn>;
    readonly getActiveMoleculeCount: ReturnType<typeof vi.fn>;
  };
  readonly provider: Record<string, never>;
  readonly patrol: Record<string, never>;
  shutdown(): Promise<void>;
}

function ctx(pathname: string, res: unknown = {}, headers: Record<string, string> = {}): HandleContext {
  return { req: { headers } as never, res: res as never, url: new URL(`http://localhost${pathname}`), pathname };
}

function sendSseEvent(res: unknown, eventType: string, data: Record<string, unknown>): void {
  const out = res as MockSseResponse;
  out.write(`event: ${eventType}\n`);
  out.write(`data: ${JSON.stringify(data)}\n\n`);
}

class MockSseResponse extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;

  writeHead(): void {}
  write(chunk: string): void {
    this.writes.push(chunk);
  }
  end(): void {
    this.ended = true;
    this.emit('close');
  }
}

interface Route {
  match(ctx: RouteContext): boolean;
  handle(ctx: HandleContext): Promise<void>;
}
