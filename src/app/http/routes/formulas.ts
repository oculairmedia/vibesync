import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FormulaCancellationConflictError } from '../../../engine/dispatcher/index.js';
import { discoverPacks, loadPack, type Pack } from '../../../engine/packs/index.js';
import { defaultEventLogPath, queryEventLog } from '../../../engine/events/index.js';
import type { Event } from '../../../engine/events/index.js';
import type { BeadRow } from '../../../engine/store/index.js';
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
            delivers: formula.delivers ?? null,
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
      const found = findFormula(deps, ctx, formulaName, body);
      if (!found) return;
      const { pack, formula } = found;

      await startRunAndRespond(deps, ctx, orchestration, { formula, pack, input: body.input, formulaName, options: runOptions(body) });
    },
  });

  // lcp-61uj: fleet-status endpoint. GET /molecules — list active + recent
  // runs so a UI can render the rig dashboard without knowing ids in advance.
  // Query: ?status=open,in_progress (filter; default active only),
  //        ?status=all (include closed/recent), ?limit=N.
  app.registerRoute({
    match: ({ pathname, method }) => /^\/molecules\/?$/.test(pathname) && method === 'GET',
    handle: async (ctx) => {
      if (!authorize(ctx, deps)) return;
      const orchestration = requireOrchestration(deps, ctx.res);
      if (!orchestration) return;
      const molecules = await orchestration.walker.listMolecules(moleculeListQuery(ctx.url));
      deps.sendJson(ctx.res, 200, {
        molecules: molecules.map(serializeMoleculeSummary),
        fleet: {
          active: orchestration.dispatcher.getActiveMoleculeCount(),
          queueDepth: orchestration.dispatcher.getQueueDepth(),
        },
      });
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
    match: ({ pathname, method }) => /^\/molecules\/[^/]+\/trace$/.test(pathname) && method === 'GET',
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
      const eventResult = queryEventLog(defaultEventLogPath(), {
        moleculeId,
        limit: readTraceEventLimit(ctx),
      });
      deps.sendJson(ctx.res, 200, serializeMoleculeTrace(view.rootId, view.root, view.steps, view.edges, eventResult.items, eventResult.warnings));
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

/** Start the run and answer: 202 with the molecule id, 503 when the agent pool is full, 500 when the start fails. */
async function startRunAndRespond(
  deps: FormulaRoutesDeps,
  ctx: HandleContext,
  orchestration: OrchestrationApi,
  run: { formula: Pack['formulas'][number]; pack: Pack; input: string; formulaName: string; options: ReturnType<typeof runOptions> },
): Promise<void> {
  const { formula, pack, input, formulaName, options } = run;
  try {
    const result = await startRunAndCaptureMoleculeId(orchestration, { formula, pack, input, ...options });
    if (result === POOL_FULL) {
      // vibesync-9lzk.17: an HTTP run must not exceed the scheduler's pool cap.
      ctx.res.setHeader?.('Retry-After', String(POOL_FULL_RETRY_AFTER_S));
      deps.sendError(ctx.res, 503, 'Agent pool is full; retry later', { formulaName, retryAfterSeconds: POOL_FULL_RETRY_AFTER_S });
      return;
    }
    deps.sendJson(ctx.res, 202, { moleculeId: result, formulaName, pack: pack.manifest.name });
  } catch (error) {
    deps.logger.error({ err: error }, 'Failed to start formula run');
    deps.sendError(ctx.res, 500, 'Failed to start formula run', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** The pack and formula a run names, or null after sending the 404. */
function findFormula(
  deps: FormulaRoutesDeps,
  ctx: HandleContext,
  formulaName: string,
  body: Record<string, unknown>,
): { pack: Pack; formula: Pack['formulas'][number] } | null {
  const packName = typeof body.pack === 'string' && body.pack.length > 0 ? body.pack : 'gastown';
  const pack = loadNamedPack(packName);
  if (!pack) {
    deps.sendError(ctx.res, 404, 'Pack not found', { pack: packName });
    return null;
  }
  const formula = pack.formulas.find((candidate) => candidate.name === formulaName);
  if (!formula) {
    deps.sendError(ctx.res, 404, 'Formula not found', { formulaName, pack: packName });
    return null;
  }
  return { pack, formula };
}

/** The optional run fields a request may carry. */
function runOptions(body: Record<string, unknown>): { motivatingBeadId?: string; projectIdentifier?: string } {
  return {
    ...(typeof body.motivatingBeadId === 'string' ? { motivatingBeadId: body.motivatingBeadId } : {}),
    ...(typeof body.projectIdentifier === 'string' && body.projectIdentifier.length > 0 ? { projectIdentifier: body.projectIdentifier } : {}),
  };
}

/** ?status: a comma list, "all" (no filter), or open and in-progress by default. ?limit: 1..500, default 50. */
function moleculeListQuery(url: URL): { statuses?: string[]; limit: number } {
  const statuses = moleculeStatuses(url.searchParams.get('status'));
  const limit = moleculeLimit(url.searchParams.get('limit'));
  return statuses ? { statuses, limit } : { limit };
}

function moleculeStatuses(param: string | null): string[] | undefined {
  if (param === 'all') return undefined;
  if (!param) return ['open', 'in_progress'];
  return param.split(',').map((s) => s.trim()).filter(Boolean);
}

function moleculeLimit(raw: string | null): number {
  return raw && Number.isFinite(Number(raw)) ? Math.max(1, Math.min(500, Math.floor(Number(raw)))) : 50;
}

function serializeMoleculeSummary(m: Awaited<ReturnType<OrchestrationApi['walker']['listMolecules']>>[number]): Record<string, unknown> {
  return {
    id: m.id,
    formulaName: m.formulaName,
    motivatingBeadId: m.motivatingBeadId,
    status: m.status,
    title: m.title,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
    stepCounts: m.stepCounts,
    currentStep: m.currentStep,
    currentStepStatus: m.currentStepStatus,
  };
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

const POOL_FULL = Symbol('pool-full');
const POOL_FULL_RETRY_AFTER_S = 30;

/**
 * Start a run and resolve with its molecule id as soon as it is cooked. When
 * the scheduler is running, the run takes a slot in its agent pool like a
 * scheduled run does (vibesync-9lzk.17), so HTTP runs cannot push concurrency
 * past `poolSize`; resolves POOL_FULL when no slot is free.
 */
async function startRunAndCaptureMoleculeId(
  orchestration: OrchestrationApi,
  input: Parameters<OrchestrationApi['dispatcher']['run']>[0],
): Promise<string | typeof POOL_FULL> {
  // vibesync-9lzk.55.9: take the id from THIS run's own onStarted callback. A
  // shared bus subscription keyed by formula name could return another run's
  // molecule now that two projects can run the same formula at once.
  let reportStarted: (moleculeId: string) => void = () => undefined;
  const moleculeStarted = new Promise<string>((resolve) => { reportStarted = resolve; });
  const start = () => orchestration.dispatcher.run({
    ...input,
    onStarted: (moleculeId: string) => { reportStarted(moleculeId); input.onStarted?.(moleculeId); },
  });
  const daemon = input.projectIdentifier ? orchestration.schedulers.get(input.projectIdentifier)?.daemon : undefined;
  const runPromise = daemon ? daemon.startExternalRun(randomUUID(), start) : start();
  if (!runPromise) return POOL_FULL;
  runPromise.catch(() => undefined);
  return Promise.race([
    moleculeStarted,
    runPromise.then((result) => result.moleculeId),
  ]);
}

/**
 * lcp-40ru: extract PR/branch/commit artifacts from step outputs (typically
 * from a coder step). Returns { prUrl?, branch?, commitSha? } parsed from
 * the output_payload. Looks for common patterns in output (URLs, branch refs).
 */
type Artifacts = { prUrl?: string; branch?: string; commitSha?: string };

/** The PR, branch and commit the coder step reported, from its text or structured output (a later step wins). */
function extractArtifacts(steps: readonly BeadRow[]): Artifacts {
  const artifacts: Artifacts = {};
  for (const step of steps) {
    if (readRoleFromTitle(step.title) !== 'coder') continue;
    Object.assign(artifacts, artifactsFromOutput(readOutput(step)));
  }
  return artifacts;
}

function artifactsFromOutput(output: unknown): Artifacts {
  if (typeof output === 'string') return artifactsFromText(output);
  if (output && typeof output === 'object') return artifactsFromFields(output as Record<string, unknown>);
  return {};
}

/** A github.com pull URL, "branch: <name>" or "on branch <name>", and a 40-char hex commit. */
function artifactsFromText(output: string): Artifacts {
  const found: Artifacts = {};
  const prUrl = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.exec(output)?.[0];
  const branch = /(?:branch|on branch)[:\s]+([a-zA-Z0-9._/-]+)/i.exec(output)?.[1];
  const commitSha = /\b([0-9a-f]{40})\b/i.exec(output)?.[1];
  if (prUrl) found.prUrl = prUrl;
  if (branch) found.branch = branch;
  if (commitSha) found.commitSha = commitSha;
  return found;
}

/** Structured output: pullRequestUrl wins over prUrl, commit over commitSha. */
function artifactsFromFields(obj: Record<string, unknown>): Artifacts {
  const found: Artifacts = {};
  const prUrl = readString(obj.pullRequestUrl) ?? readString(obj.prUrl);
  const branch = readString(obj.branch);
  const commitSha = readString(obj.commit) ?? readString(obj.commitSha);
  if (prUrl !== null) found.prUrl = prUrl;
  if (branch !== null) found.branch = branch;
  if (commitSha !== null) found.commitSha = commitSha;
  return found;
}

function serializeMolecule(moleculeId: string, root: BeadRow, steps: readonly BeadRow[]): Record<string, unknown> {
  const anyFailed = steps.some((step) => Boolean(readExec(step).error_trace));
  const allClosed = steps.length > 0 && steps.every((step) => step.status === 'closed');
  // lcp-40ru: compute progress counts + current-step for UI run-card.
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'closed').length;
  const running = steps.filter((s) => s.status === 'in_progress').length;
  const currentStepBead = steps.find((s) => s.status === 'in_progress') ?? [...steps].reverse().find((s) => s.status !== 'open');
  const currentStepName = currentStepBead ? readString(readExec(currentStepBead).step) : null;
  const currentStepStatus = currentStepBead?.status ?? null;
  // lcp-40ru: createdAt + elapsed time.
  const createdAt = rowDate(root.created_at);
  const elapsedMs = createdAt ? Date.now() - new Date(createdAt).getTime() : null;
  // lcp-40ru: errorSummary from the failed step.
  const failedStep = steps.find((s) => Boolean(readExec(s).error_trace));
  const errorSummary = failedStep ? sanitizeTraceText(readString(readExec(failedStep).error_trace) ?? 'Unknown error') : null;
  // lcp-40ru: producedArtifacts parsed from coder step output.
  const artifacts = extractArtifacts(steps);
  return {
    moleculeId,
    formulaName: readString(readExec(root).formula),
    status: anyFailed ? 'failed' : allClosed ? 'completed' : 'running',
    progress: { total, done, running },
    currentStep: currentStepName,
    currentStepStatus,
    createdAt,
    elapsedMs,
    errorSummary,
    producedArtifacts: artifacts,
    steps: steps.map((step) => ({
      stepId: step.id,
      stepName: readString(readExec(step).step),
      role: readRoleFromTitle(step.title),
      status: step.status,
      output: readOutput(step),
    })),
  };
}

function serializeMoleculeTrace(
  moleculeId: string,
  root: BeadRow,
  steps: readonly BeadRow[],
  edges: readonly { readonly issue_id: string; readonly depends_on_id: string; readonly type: string }[],
  events: readonly Event[],
  warnings: readonly { readonly line: number; readonly message: string }[],
): Record<string, unknown> {
  const health = normalizeMoleculeHealth(root, steps, events);
  const stepTraces = steps.map((step) => serializeStepTrace(step, edges, events));
  const usage = aggregateUsage(events);
  // lcp-40ru: enrich trace with UI-card fields (additive, backward-compat).
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'closed').length;
  const running = steps.filter((s) => s.status === 'in_progress').length;
  const currentStepBead = steps.find((s) => s.status === 'in_progress') ?? [...steps].reverse().find((s) => s.status !== 'open');
  const currentStepName = currentStepBead ? readString(readExec(currentStepBead).step) : null;
  const currentStepStatus = currentStepBead?.status ?? null;
  const createdAtDate = rowDate(root.created_at);
  const elapsedMs = createdAtDate ? Date.now() - new Date(createdAtDate).getTime() : null;
  const failedStep = steps.find((s) => Boolean(readExec(s).error_trace));
  const errorSummary = failedStep ? sanitizeTraceText(readString(readExec(failedStep).error_trace) ?? 'Unknown error') : null;
  const artifacts = extractArtifacts(steps);
  return {
    moleculeId,
    rootBeadId: root.id,
    formulaName: readString(readExec(root).formula),
    status: health.state,
    health,
    createdAt: rowDate(root.created_at),
    updatedAt: rowDate(root.updated_at),
    progress: { total, done, running },
    currentStep: currentStepName,
    currentStepStatus,
    elapsedMs,
    errorSummary,
    producedArtifacts: artifacts,
    steps: stepTraces,
    runtimeEvents: events.map(serializeTraceEvent),
    toolCalls: events.filter((event) => event.kind === 'runtime/session.tool_call').map(serializeToolEvent),
    errors: collectTraceErrors(steps, events),
    usage,
    availableActions: availableTraceActions(health.state),
    data_freshness: {
      status: warnings.length > 0 ? 'warning' : 'ok',
      last_sync_at: new Date().toISOString(),
      warnings,
    },
  };
}

function serializeStepTrace(
  step: BeadRow,
  edges: readonly { readonly issue_id: string; readonly depends_on_id: string; readonly type: string }[],
  events: readonly Event[],
): Record<string, unknown> {
  const exec = readExec(step);
  const stepEvents = events.filter((event) => event.payload?.stepId === step.id || event.task_id === readString(exec.task_id));
  const started = firstEvent(stepEvents, 'dispatcher/step.started') ?? firstEvent(stepEvents, 'runtime/session.started');
  const finished = firstEvent(stepEvents, 'dispatcher/step.finished') ?? firstEvent(stepEvents, 'dispatcher/step.failed');
  return {
    stepId: step.id,
    stepName: readString(exec.step),
    role: readRoleFromTitle(step.title),
    status: step.status,
    health: normalizeStepHealth(step, stepEvents),
    attempts: readNumber(exec.attempts),
    dependsOn: edges.filter((edge) => edge.issue_id === step.id && edge.type === 'blocks').map((edge) => edge.depends_on_id),
    taskId: readString(exec.task_id),
    sessionId: readString(exec.session_id),
    conversationId: readString(exec.conversation_id),
    providerKind: readString(exec.provider_kind),
    durationMs: started && finished ? new Date(finished.ts).getTime() - new Date(started.ts).getTime() : null,
    output: readOutput(step),
    outputSummary: summarizeOutput(readOutput(step)),
    toolCalls: stepEvents.filter((event) => event.kind === 'runtime/session.tool_call').map(serializeToolEvent),
    toolResults: stepEvents.filter((event) => event.kind === 'runtime/session.tool_result').map(serializeToolEvent),
    errors: collectStepErrors(step, stepEvents),
    events: stepEvents.map(serializeTraceEvent),
  };
}

function readTraceEventLimit(ctx: HandleContext): number {
  const raw = ctx.url.searchParams.get('event_limit') ?? ctx.url.searchParams.get('limit');
  const value = raw ? Number(raw) : 500;
  return Number.isFinite(value) ? Math.max(1, Math.min(1000, Math.floor(value))) : 500;
}

function normalizeMoleculeHealth(root: BeadRow, steps: readonly BeadRow[], events: readonly Event[]): Record<string, unknown> {
  return eventHealth(events) ?? stepHealth(root, steps, events);
}

/** A state an event decides on its own, checked in precedence order (a failure wins over a later cancel). */
function eventHealth(events: readonly Event[]): Record<string, unknown> | null {
  const evidence: string[] = [];
  const latest = (kind: string): Event | null => latestEvent(events, kind);
  const failed = latest('dispatcher/formula.failed');
  if (failed) {
    evidence.push(failed.id);
    return {
      state: 'failed',
      message: 'Formula execution failed.',
      recommendedAction: 'Open the trace errors and retry after fixing the failing step.',
      evidenceEventIds: evidence,
    };
  }
  const approval = [...events].reverse().find((event) => event.kind === 'runtime/session.turn_done' && event.payload?.stopReason === 'requires_approval');
  if (approval) {
    evidence.push(approval.id);
    return {
      state: 'waiting_for_approval',
      message: 'Runtime stopped for tool approval.',
      recommendedAction: 'Approve or reject the pending runtime action, then resume the molecule.',
      evidenceEventIds: evidence,
    };
  }
  const noReady = latest('dispatcher/formula.resume.paused');
  if (noReady) {
    evidence.push(noReady.id);
    return {
      state: 'no_ready_steps',
      message: 'No ready step can continue in the current resume context.',
      recommendedAction: 'Start a fresh formula run or inspect missing step metadata.',
      evidenceEventIds: evidence,
    };
  }
  const cancelled = latest('dispatcher/formula.cancelled');
  if (cancelled) {
    evidence.push(cancelled.id);
    return { state: 'cancelled', message: 'Molecule was cancelled.', recommendedAction: 'Retry if work is still required.', evidenceEventIds: evidence };
  }
  return null;
}

/** With no deciding event, the state follows the steps. */
function stepHealth(root: BeadRow, steps: readonly BeadRow[], events: readonly Event[]): Record<string, unknown> {
  const evidence: string[] = [];
  if (allStepsSucceeded(steps)) {
    const completed = latestEvent(events, 'dispatcher/formula.completed');
    if (completed) evidence.push(completed.id);
    return { state: 'completed', message: 'Formula completed successfully.', recommendedAction: null, evidenceEventIds: evidence };
  }
  if (steps.some((step) => step.status === 'in_progress')) {
    return { state: 'running', message: 'Formula has active runtime work.', recommendedAction: 'Watch live events or cancel if it is stuck.', evidenceEventIds: evidence };
  }
  // vibesync-9lzk.59.3: a cancel fails each open step with "cancelled" and
  // records the outcome on the root, so the root decides before the step rule.
  if (readString(readExec(root).outcome) === 'cancelled') {
    return { state: 'cancelled', message: 'Molecule was cancelled.', recommendedAction: 'Retry if work is still required.', evidenceEventIds: evidence };
  }
  // vibesync-9lzk.59.2: a run from an earlier release has no events in this
  // release's log, so a failed step must decide "failed" on its own. Only a
  // CLOSED step counts: a step reopened for retry keeps its old error_trace.
  if (steps.some(isFailedStep)) {
    return {
      state: 'failed',
      message: 'Formula execution failed.',
      recommendedAction: 'Open the trace errors and retry after fixing the failing step.',
      evidenceEventIds: evidence,
    };
  }
  if (readString(readExec(root).formula) === null) {
    return { state: 'missing_metadata', message: 'Molecule root is missing formula metadata.', recommendedAction: 'Inspect the Beads row before retrying.', evidenceEventIds: evidence };
  }
  return { state: 'idle', message: 'Molecule is waiting for dispatch progress.', recommendedAction: 'Resume the molecule or inspect step dependencies.', evidenceEventIds: evidence };
}

function isFailedStep(step: BeadRow): boolean {
  return step.status === 'closed' && Boolean(readExec(step).error_trace);
}

function allStepsSucceeded(steps: readonly BeadRow[]): boolean {
  return steps.length > 0 && steps.every((step) => step.status === 'closed') && !steps.some((step) => readExec(step).error_trace);
}

/** The most recent event of a kind. */
function latestEvent(events: readonly Event[], kind: string): Event | null {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.kind === kind) return events[index]!;
  }
  return null;
}

function normalizeStepHealth(step: BeadRow, events: readonly Event[]): string {
  if (readExec(step).error_trace) return 'failed';
  if (events.some((event) => event.kind === 'runtime/session.turn_done' && event.payload?.stopReason === 'requires_approval')) return 'waiting_for_approval';
  if (step.status === 'closed') return 'completed';
  if (step.status === 'in_progress') return 'running';
  return 'idle';
}

function aggregateUsage(events: readonly Event[]): Record<string, number> {
  let prompt = 0;
  let completion = 0;
  for (const event of events) {
    if (event.kind !== 'runtime/session.usage') continue;
    prompt += readNumber(event.payload?.prompt);
    completion += readNumber(event.payload?.completion);
  }
  return { prompt, completion };
}

/** Errors from the steps and from failure events, first line each, without repeats. (Only steps carry an error_trace.) */
function collectTraceErrors(steps: readonly BeadRow[], events: readonly Event[]): string[] {
  const fromSteps = steps.flatMap((step) => collectStepErrors(step, events));
  const fromEvents = events.filter(isErrorEvent).flatMap((event) => {
    const message = eventErrorMessage(event);
    return message ? [sanitizeTraceText(message)] : [];
  });
  return [...new Set([...fromSteps, ...fromEvents])];
}

function isErrorEvent(event: Event): boolean {
  return event.kind.includes('failed') || event.kind === 'runtime/session.error';
}

function eventErrorMessage(event: Event): string | null {
  return readString(event.payload?.error) ?? readString(event.payload?.message);
}

function collectStepErrors(step: BeadRow, events: readonly Event[]): string[] {
  const errors = new Set<string>();
  const trace = readString(readExec(step).error_trace);
  if (trace) errors.add(sanitizeTraceText(trace));
  for (const event of events) {
    const message = eventErrorMessage(event);
    if (message) errors.add(sanitizeTraceText(message));
  }
  return [...errors];
}

function availableTraceActions(state: unknown): string[] {
  switch (state) {
    case 'running':
    case 'stalled':
    case 'waiting_for_approval':
      return ['cancel', 'resume'];
    case 'failed':
    case 'no_ready_steps':
      return ['resume', 'retry'];
    case 'cancelled':
      return ['retry'];
    default:
      return [];
  }
}

function serializeTraceEvent(event: Event): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    layer: event.layer,
    kind: event.kind,
    ...(event.task_id ? { taskId: event.task_id } : {}),
    ...(event.molecule_id ? { moleculeId: event.molecule_id } : {}),
    ...(event.teammate ? { teammate: event.teammate } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
  };
}

function serializeToolEvent(event: Event): Record<string, unknown> {
  return {
    eventId: event.id,
    ts: event.ts,
    stepId: event.payload?.stepId ?? null,
    stepName: event.payload?.stepName ?? null,
    tool: event.payload?.tool ?? 'unknown',
    args: event.payload?.args ?? null,
    result: event.payload?.result ?? null,
    ok: event.payload?.ok ?? null,
  };
}

function firstEvent(events: readonly Event[], kind: string): Event | null {
  return events.find((event) => event.kind === kind) ?? null;
}

function rowDate(value: Date | string | number | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summarizeOutput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function sanitizeTraceText(value: string): string {
  const firstLine = value.split('\n').find((line) => line.trim().length > 0) ?? value;
  return firstLine.length > 500 ? `${firstLine.slice(0, 497)}...` : firstLine;
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
