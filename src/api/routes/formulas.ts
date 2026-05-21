import { join } from 'node:path';
import { FormulaCancellationConflictError } from '../../orchestration/dispatcher/index.js';
import { discoverPacks, loadPack, type Pack } from '../../orchestration/packs/index.js';
import type { Event } from '../../orchestration/events/index.js';
import type { BeadRow } from '../../orchestration/store/index.js';
import { resolveFromAppRoot } from '../../runtimePaths.js';
import type { App, HandleContext, Logger, OrchestrationApi, ParseJsonBody, SendError, SendJson } from '../../types/api.js';
import type { SSEManager } from '../SSEManager.js';

interface FormulaRoutesDeps {
  readonly orchestration?: OrchestrationApi | null;
  readonly parseJsonBody: ParseJsonBody;
  readonly sendJson: SendJson;
  readonly sendError: SendError;
  readonly sseManager: SSEManager;
  readonly logger: Logger;
}

export function registerFormulaRoutes(app: App, deps: FormulaRoutesDeps): void {
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/formulas' && method === 'GET',
    handle: async ({ res }) => {
      const packs = loadAvailablePacks();
      const queueDepth = deps.orchestration?.dispatcher.getQueueDepth();
      deps.sendJson(res, 200, {
        formulas: packs.flatMap((pack) =>
          pack.formulas.map((formula) => ({
            name: formula.name,
            pack: pack.manifest.name,
            description: formula.description,
            whenToUse: formula.whenToUse,
            stepCount: formula.steps.length,
            roles: formula.steps.map((step) => step.role),
          })),
        ),
        ...(queueDepth === undefined ? {} : { queue: { depth: queueDepth } }),
      });
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => /^\/formulas\/[^/]+\/run$/.test(pathname) && method === 'POST',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const formulaName = decodeURIComponent(ctx.pathname.split('/')[2] ?? '');
      const body = await deps.parseJsonBody(ctx.req);
      if (typeof body.input !== 'string' || body.input.length === 0) {
        deps.sendError(ctx.res, 400, 'Missing required field: input');
        return;
      }
      const packName = typeof body.pack === 'string' && body.pack.length > 0 ? body.pack : 'gastown';
      const pack = loadNamedPack(packName);
      if (!pack) {
        deps.sendError(ctx.res, 404, 'Pack not found', { pack: packName });
        return;
      }
      const formula = pack.formulas.find((candidate) => candidate.name === formulaName);
      if (!formula) {
        deps.sendError(ctx.res, 404, 'Formula not found', { formulaName, pack: packName });
        return;
      }

      try {
        const moleculeId = await startRunAndCaptureMoleculeId(orchestration, {
          formula,
          pack,
          input: body.input,
          ...(typeof body.motivatingBeadId === 'string' ? { motivatingBeadId: body.motivatingBeadId } : {}),
        });
        deps.sendJson(ctx.res, 202, { moleculeId, formulaName, pack: pack.manifest.name });
      } catch (error) {
        deps.logger.error({ err: error }, 'Failed to start formula run');
        deps.sendError(ctx.res, 500, 'Failed to start formula run', { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => /^\/molecules\/[^/]+$/.test(pathname) && method === 'GET',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const moleculeId = decodeURIComponent(ctx.pathname.split('/')[2] ?? '');
      const view = await orchestration.walker.load(moleculeId);
      if (!view) {
        deps.sendError(ctx.res, 404, 'Molecule not found', { moleculeId });
        return;
      }
      deps.sendJson(ctx.res, 200, serializeMolecule(view.rootId, view.root, view.steps));
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => /^\/molecules\/[^/]+\/resume$/.test(pathname) && method === 'POST',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const moleculeId = decodeURIComponent(ctx.pathname.split('/')[2] ?? '');
      try {
        const result = await orchestration.dispatcher.resume(moleculeId);
        deps.sendJson(ctx.res, 202, { moleculeId: result.moleculeId, outputs: result.outputs });
      } catch (error) {
        deps.logger.error({ err: error, moleculeId }, 'Failed to resume formula molecule');
        deps.sendError(ctx.res, 500, 'Failed to resume formula molecule', { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => /^\/molecules\/[^/]+$/.test(pathname) && method === 'DELETE',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const moleculeId = decodeURIComponent(ctx.pathname.split('/')[2] ?? '');
      try {
        const result = await orchestration.dispatcher.cancel(moleculeId);
        deps.sendJson(ctx.res, 202, { moleculeId: result.moleculeId, status: 'cancelled', cancelledStepCount: result.cancelledStepCount });
      } catch (error) {
        if (error instanceof FormulaCancellationConflictError) {
          deps.sendError(ctx.res, 409, 'Molecule is not cancellable', { moleculeId, error: error.message });
          return;
        }
        deps.logger.error({ err: error, moleculeId }, 'Failed to cancel formula molecule');
        deps.sendError(ctx.res, 500, 'Failed to cancel formula molecule', { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => /^\/molecules\/[^/]+\/events$/.test(pathname) && method === 'GET',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const moleculeId = decodeURIComponent(ctx.pathname.split('/')[2] ?? '');
      streamMoleculeEvents(ctx, deps, orchestration, moleculeId);
    },
  });
}

function authorize(ctx: HandleContext, deps: FormulaRoutesDeps): boolean {
  const expected = process.env['VIBESYNC_ORCHESTRATION_TOKEN'];
  if (!expected) return true;
  const header = ctx.req.headers.authorization;
  const actual = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (actual === expected) return true;
  deps.sendError(ctx.res, 401, 'Unauthorized');
  return false;
}

function requireOrchestration(deps: FormulaRoutesDeps, res: HandleContext['res']): OrchestrationApi | null {
  if (deps.orchestration) return deps.orchestration;
  deps.sendError(res, 503, 'Orchestration plane not booted');
  return null;
}

function loadAvailablePacks(): Pack[] {
  const packs = new Map<string, Pack>();
  const gastown = loadNamedPack('gastown');
  if (gastown) packs.set(gastown.manifest.name, gastown);
  for (const pack of discoverPacks()) packs.set(`${pack.scope}:${pack.manifest.name}`, pack);
  return [...packs.values()];
}

function loadNamedPack(name: string): Pack | null {
  try {
    return loadPack(resolveFromAppRoot('packs', name), 'global');
  } catch {
    try {
      return loadPack(join(process.cwd(), 'packs', name), 'global');
    } catch {
      return null;
    }
  }
}

async function startRunAndCaptureMoleculeId(
  orchestration: OrchestrationApi,
  input: Parameters<OrchestrationApi['dispatcher']['run']>[0],
): Promise<string> {
  let unsubscribe: (() => void) | null = null;
  const moleculeStarted = new Promise<string>((resolve) => {
    unsubscribe = orchestration.bus.subscribe((event) => {
      if (event.kind === 'dispatcher/formula.started' && event.payload?.formulaName === input.formula.name && event.molecule_id) {
        resolve(event.molecule_id);
      }
    });
  });
  const runPromise = orchestration.dispatcher.run(input);
  runPromise.catch(() => undefined).finally(() => unsubscribe?.());
  return Promise.race([
    moleculeStarted,
    runPromise.then((result) => result.moleculeId),
  ]);
}

function serializeMolecule(moleculeId: string, root: BeadRow, steps: readonly BeadRow[]): Record<string, unknown> {
  const anyFailed = steps.some((step) => Boolean(readExec(step).error_trace));
  const allClosed = steps.length > 0 && steps.every((step) => step.status === 'closed');
  return {
    moleculeId,
    formulaName: readString(readExec(root).formula),
    status: anyFailed ? 'failed' : allClosed ? 'completed' : 'running',
    steps: steps.map((step) => ({
      stepId: step.id,
      stepName: readString(readExec(step).step),
      role: readRoleFromTitle(step.title),
      status: step.status,
      output: readOutput(step),
    })),
  };
}

function streamMoleculeEvents(
  ctx: HandleContext,
  deps: FormulaRoutesDeps,
  orchestration: OrchestrationApi,
  moleculeId: string,
): void {
  const res = ctx.res as { writeHead: (code: number, headers: Record<string, string>) => void; write: (chunk: string) => void; end: () => void; on: (event: string, cb: () => void) => void };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  deps.sseManager.sendEvent(res, 'connected', { moleculeId });
  const unsubscribe = orchestration.bus.subscribe((event: Event) => {
    if (event.molecule_id !== moleculeId) return;
    deps.sseManager.sendEvent(res, event.kind, event as unknown as Record<string, unknown>);
    if (event.kind === 'dispatcher/formula.completed' || event.kind === 'dispatcher/formula.failed') {
      unsubscribe();
      res.end();
    }
  });
  res.on('close', unsubscribe);
}

function readExec(row: BeadRow): Record<string, unknown> {
  const exec = row.metadata.exec;
  return exec && typeof exec === 'object' ? exec as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOutput(row: BeadRow): unknown {
  const output = readExec(row).output_payload;
  if (!output || typeof output !== 'object') return output ?? null;
  return 'output' in output ? (output as { output?: unknown }).output : output;
}

function readRoleFromTitle(title: string): string | null {
  const match = /] (.+)$/.exec(title);
  return match?.[1] ?? null;
}
