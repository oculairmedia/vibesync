import type { SSEManager } from '../SSEManager.js';
import { defaultEventLogPath, queryEventLog } from '../../orchestration/events/index.js';
import type { Event, EventLogQuery } from '../../orchestration/events/index.js';
import type { App, HandleContext, OrchestrationApi, SendJson } from '../../types/api.js';

interface EventsDeps {
  readonly sseManager: SSEManager;
  readonly sendJson: SendJson;
  readonly orchestration?: OrchestrationApi | null;
  readonly eventLogPath?: string;
}

export function registerEventsRoutes(app: App, deps: EventsDeps): void {
  deps.orchestration?.bus.subscribe((event) => {
    deps.sseManager.broadcast(event.kind, event as unknown as Record<string, unknown>);
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/events' && method === 'GET',
    handle: async (ctx) => {
      const query = buildEventLogQuery(ctx);
      const result = queryEventLog(deps.eventLogPath ?? defaultEventLogPath(), query);
      deps.sendJson(ctx.res, 200, {
        items: result.items,
        page: result.page,
        data_freshness: {
          status: result.warnings.length > 0 ? 'warning' : 'ok',
          last_sync_at: new Date().toISOString(),
          warnings: result.warnings,
        },
      });
    },
  });

  // lcp-vugl: SSE stream with bootstrap snapshot. On connect, immediately send
  // current fleet state (active molecules + fleet counts) so the client can
  // render the current rig activity without waiting for the next event. Then
  // stream deltas as they occur.
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/api/events/stream' && method === 'GET',
    handle: async ({ res }) => {
      // Snapshot function: fetch current fleet state from walker
      const snapshotFn = async (): Promise<Record<string, unknown>> => {
        if (!deps.orchestration) {
          return { molecules: [], fleet: { active: 0, queueDepth: 0 } };
        }
        const molecules = await deps.orchestration.walker.listMolecules({
          statuses: ['open', 'in_progress'],
          limit: 100,
        });
        return {
          molecules: molecules.map((m) => ({
            id: m.id,
            formulaName: m.formulaName,
            projectIdentifier: m.motivatingBeadId,
            status: m.status,
            title: m.title,
            createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
            updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
            stepCounts: m.stepCounts,
            currentStep: m.currentStep,
            currentStepStatus: m.currentStepStatus,
          })),
          fleet: {
            active: deps.orchestration.dispatcher.getActiveMoleculeCount(),
            queueDepth: deps.orchestration.dispatcher.getQueueDepth(),
          },
        };
      };
      await deps.sseManager.addClient(res, snapshotFn);
    },
  });
}

function readLimit(ctx: HandleContext): number | undefined {
  const raw = ctx.url.searchParams.get('limit');
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function buildEventLogQuery(ctx: HandleContext): EventLogQuery {
  const after = ctx.url.searchParams.get('after');
  const limit = readLimit(ctx);
  const moleculeId = ctx.url.searchParams.get('molecule_id');
  const layer = readLayer(ctx.url.searchParams.get('layer'));
  const kind = ctx.url.searchParams.get('kind');
  return {
    ...(after ? { after } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(moleculeId ? { moleculeId } : {}),
    ...(layer ? { layer } : {}),
    ...(kind ? { kind } : {}),
  };
}

function readLayer(raw: string | null): Event['layer'] | null {
  if (!raw) return null;
  const layers: readonly Event['layer'][] = [
    'runtime',
    'daemon',
    'formula',
    'dispatcher',
    'molecule',
    'health-patrol',
    'pm-agent',
  ];
  return layers.includes(raw as Event['layer']) ? raw as Event['layer'] : null;
}
