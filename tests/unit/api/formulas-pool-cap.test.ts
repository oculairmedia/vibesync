/**
 * vibesync-9lzk.17: an HTTP-started run takes a slot in the scheduler's agent
 * pool, so HTTP and scheduled runs together never exceed poolSize. Drives the
 * real route against a real SchedulerDaemon (no mocked cap).
 */
import { describe, expect, it, vi } from 'vitest';

import { registerFormulaRoutes } from '../../../src/app/http/routes/formulas.js';
import { EventBus } from '../../../src/engine/events/index.js';
import { SchedulerDaemon, type SchedulerDaemonDeps } from '../../../src/engine/scheduler/daemon.js';
import type { SlingContextStore } from '../../../src/engine/scheduler/sling-context.js';
import type { App, HandleContext, OrchestrationApi, RouteContext } from '../../../src/app/types/api.js';

type Route = { match: (c: RouteContext) => boolean; handle: (c: HandleContext) => Promise<void> };

function memoryContexts(): SlingContextStore {
  const rows: Array<{ id: string; description: string; open: boolean }> = [];
  let seq = 0;
  return {
    async createSlingContext(i) { const id = `ctx-${++seq}`; rows.push({ id, description: i.description, open: true }); return id; },
    async listOpenSlingContexts() { return rows.filter((r) => r.open).map((r) => ({ id: r.id, description: r.description })); },
    async closeSlingContext(id) { const r = rows.find((x) => x.id === id); if (r) r.open = false; },
  };
}

function setup(opts: { poolSize: number; readyBeads: string[] }) {
  const bus = new EventBus({ noPersist: true });
  const pending: Array<() => void> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const dispatcher = {
    run: vi.fn((input: { formula: { name: string } }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const moleculeId = `mol-${dispatcher.run.mock.calls.length}`;
      bus.emit({ layer: 'dispatcher', kind: 'dispatcher/formula.started', molecule_id: moleculeId, payload: { formulaName: input.formula.name } });
      return new Promise<{ moleculeId: string; outputs: Record<string, string> }>((resolve) => {
        pending.push(() => { concurrent -= 1; resolve({ moleculeId, outputs: {} }); });
      });
    }),
  };
  const deps = {
    dispatcher: dispatcher as never,
    formulaResolver: { async resolve(id: string) { return { formula: { name: 'onboard' } as never, pack: { name: 'gastown' } as never, projectIdentifier: 'vibesync', input: id }; } },
    readyBeads: { async readyWorkBeadIds() { return new Set(opts.readyBeads); }, async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; } },
    contextStore: memoryContexts(),
    poolMembers: Array.from({ length: opts.poolSize }, (_, i) => ({ agentId: `a${i}`, role: 'coder', lettaBaseUrl: 'http://x' })),
    github: { async fetchFacts() { throw new Error('unused'); }, async merge() { throw new Error('unused'); } },
    allowedRepos: [],
    requiredCheckNames: () => [],
    livenessProbe: { async probe() { return 'alive' as const; } },
    escalation: { async onIsolated() {}, async onRepeatedRecovery() {}, async onBlocked() {} },
    config: () => ({ poolSize: opts.poolSize, batchSize: 10, paused: false }),
  } as unknown as SchedulerDaemonDeps;
  const daemon = new SchedulerDaemon(deps);

  const routes: Route[] = [];
  const app: App = { registerRoute: (r) => { routes.push(r as Route); } };
  const sendJson = vi.fn();
  const sendError = vi.fn();
  const res = { setHeader: vi.fn() };
  const parseJsonBody = vi.fn(async () => ({ input: 'do it' }));
  const orchestration = { bus, dispatcher, scheduler: { daemon } } as unknown as OrchestrationApi;
  registerFormulaRoutes(app, { orchestration, parseJsonBody, sendJson, sendError, sseManager: { sendEvent: vi.fn() } as never, logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } });
  const route = routes.find((r) => r.match({ method: 'POST', pathname: '/formulas/code-review/run' }))!;
  const post = () => route.handle({ req: { headers: {} } as never, res: res as never, url: new URL('http://l/formulas/code-review/run'), pathname: '/formulas/code-review/run' });
  return { daemon, dispatcher, post, sendJson, sendError, res, pending, maxConcurrent: () => maxConcurrent };
}

describe('HTTP formula runs respect the scheduler pool cap (vibesync-9lzk.17)', () => {
  it('with every slot held by scheduled runs, an HTTP run is refused with 503 + Retry-After and never starts', async () => {
    const h = setup({ poolSize: 2, readyBeads: ['w1', 'w2'] });
    await h.daemon.tick();
    expect(h.dispatcher.run).toHaveBeenCalledTimes(2); // pool full with scheduled work

    await h.post();

    expect(h.dispatcher.run).toHaveBeenCalledTimes(2);
    expect(h.sendError).toHaveBeenCalledWith(h.res, 503, 'Agent pool is full; retry later', expect.objectContaining({ retryAfterSeconds: 30 }));
    expect(h.res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(h.maxConcurrent()).toBe(2);
    await h.daemon.stop();
  });

  it('an HTTP run holds a slot until it settles: the scheduler cannot fill that slot meanwhile', async () => {
    const h = setup({ poolSize: 1, readyBeads: ['w1'] });
    await h.post();
    expect(h.sendJson).toHaveBeenCalledWith(h.res, 202, expect.objectContaining({ moleculeId: 'mol-1' }));

    await h.daemon.tick(); // the only slot is the HTTP run's
    expect(h.dispatcher.run).toHaveBeenCalledTimes(1);

    h.pending.shift()!(); // HTTP run finishes: slot released
    await new Promise((r) => setTimeout(r, 0));
    await h.daemon.tick();
    expect(h.dispatcher.run).toHaveBeenCalledTimes(2);
    expect(h.maxConcurrent()).toBe(1);
    await h.daemon.stop();
  });
});
