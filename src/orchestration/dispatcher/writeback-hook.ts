/**
 * Molecule → motivating-bead writeback hook (vibesync-0xo).
 *
 * When the dispatcher emits `dispatcher/formula.completed` or
 * `dispatcher/formula.failed`, append a structured note to the bead
 * that motivated the run. The motivating bead id is captured at
 * /formulas/:name/run time and stored on the molecule_root bead's
 * `metadata.exec.motivating_bead`.
 *
 * Side-effect contract:
 *   - On completion: append timestamp + moleculeId + formula name +
 *     per-step output excerpt to the motivating bead's `notes` column.
 *   - On failure: append timestamp + moleculeId + formula name +
 *     failing role + error_trace.
 *   - No-op when motivating_bead is absent or when the molecule_root
 *     bead has been GC'd.
 *   - Status of the motivating bead is NEVER touched — that decision
 *     belongs to the PM agent.
 *   - Idempotent: writeback_status is stamped on the molecule_root
 *     metadata. A replay of the same event finds the stamp and
 *     short-circuits before touching the motivating bead's notes.
 *
 * The hook reads everything it needs through the MoleculeWalker (the
 * existing materialized view) and writes via the store's
 * appendNoteToBead + recordMoleculeWriteback. It does not call back
 * into the dispatcher.
 */

import type { Event, EventBus } from '../events/index.js';
import type { MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';

const OUTPUT_EXCERPT_LIMIT = 400;

export interface WritebackStore {
  appendNoteToBead(beadId: string, note: string): Promise<void>;
  recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed'): Promise<string | undefined>;
}

export interface WritebackHookDeps {
  readonly bus: EventBus;
  readonly walker: MoleculeWalker;
  readonly store: WritebackStore;
  /** Injectable so tests can pin the timestamp. Defaults to Date.now. */
  readonly now?: () => Date;
  /** Optional logger for swallowed errors. */
  readonly logger?: { warn(obj: unknown, msg: string): void };
}

/**
 * Subscribe to the dispatcher's completion events. Returns the
 * unsubscribe function so callers (boot) can detach during shutdown.
 */
export function installWritebackHook(deps: WritebackHookDeps): () => void {
  const now = deps.now ?? (() => new Date());
  return deps.bus.subscribe((event) => {
    if (event.kind !== 'dispatcher/formula.completed' && event.kind !== 'dispatcher/formula.failed') {
      return;
    }
    void handleEvent(event, deps, now).catch((err: unknown) => {
      deps.logger?.warn({ err, moleculeId: event.molecule_id }, 'writeback hook failed');
    });
  });
}

async function handleEvent(event: Event, deps: WritebackHookDeps, now: () => Date): Promise<void> {
  const moleculeId = event.molecule_id;
  if (!moleculeId) return;
  const view = await deps.walker.load(moleculeId);
  if (!view) return;

  const exec = readExec(view.root);
  const motivatingBeadId = typeof exec['motivating_bead'] === 'string' ? (exec['motivating_bead'] as string) : '';
  if (!motivatingBeadId) return;

  const status = event.kind === 'dispatcher/formula.completed' ? 'completed' : 'failed';
  const previous = await deps.store.recordMoleculeWriteback(moleculeId, status);
  if (previous === status) return;

  const formulaName = typeof exec['formula'] === 'string' ? (exec['formula'] as string) : 'unknown';
  const note = status === 'completed'
    ? buildCompletedNote({ moleculeId, formulaName, steps: view.steps, when: now() })
    : buildFailedNote({ moleculeId, formulaName, steps: view.steps, event, when: now() });

  try {
    await deps.store.appendNoteToBead(motivatingBeadId, note);
  } catch (err) {
    deps.logger?.warn(
      { err, moleculeId, motivatingBeadId },
      'writeback hook could not append note (motivating bead may have been removed)',
    );
  }
}

function buildCompletedNote(args: {
  readonly moleculeId: string;
  readonly formulaName: string;
  readonly steps: readonly BeadRow[];
  readonly when: Date;
}): string {
  const lines: string[] = [];
  lines.push(`[vibesync] formula ${args.formulaName} completed at ${args.when.toISOString()}`);
  lines.push(`moleculeId: ${args.moleculeId}`);
  for (const step of orderedSteps(args.steps)) {
    const role = stepRole(step);
    const excerpt = excerptStepOutput(step);
    lines.push(`- ${role}: ${excerpt}`);
  }
  return lines.join('\n');
}

function buildFailedNote(args: {
  readonly moleculeId: string;
  readonly formulaName: string;
  readonly steps: readonly BeadRow[];
  readonly event: Event;
  readonly when: Date;
}): string {
  const lines: string[] = [];
  lines.push(`[vibesync] formula ${args.formulaName} FAILED at ${args.when.toISOString()}`);
  lines.push(`moleculeId: ${args.moleculeId}`);

  const failingStep = args.steps.find((step) => Boolean(readExec(step).error_trace));
  if (failingStep) {
    const role = stepRole(failingStep);
    const errorTrace = String(readExec(failingStep).error_trace ?? '').slice(0, OUTPUT_EXCERPT_LIMIT);
    lines.push(`failing step: ${role}`);
    if (errorTrace) lines.push(`error: ${errorTrace}`);
  } else {
    const errorFromEvent = typeof args.event.payload?.error === 'string' ? args.event.payload.error : '';
    if (errorFromEvent) lines.push(`error: ${errorFromEvent.slice(0, OUTPUT_EXCERPT_LIMIT)}`);
  }

  const closedSteps = orderedSteps(args.steps).filter((step) => step.status === 'closed' && !readExec(step).error_trace);
  for (const step of closedSteps) {
    lines.push(`- ${stepRole(step)}: ${excerptStepOutput(step)}`);
  }
  return lines.join('\n');
}

function orderedSteps(steps: readonly BeadRow[]): readonly BeadRow[] {
  return [...steps].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

function readExec(row: BeadRow): Record<string, unknown> {
  const exec = row.metadata.exec;
  return exec && typeof exec === 'object' ? (exec as Record<string, unknown>) : {};
}

function stepRole(step: BeadRow): string {
  const fromExec = readExec(step).step;
  if (typeof fromExec === 'string' && fromExec.length > 0) return fromExec;
  const match = /] (.+)$/.exec(step.title);
  return match?.[1] ?? step.id;
}

function excerptStepOutput(step: BeadRow): string {
  const payload = readExec(step).output_payload;
  if (!payload) return '(no output)';
  if (typeof payload === 'string') return truncate(payload);
  if (typeof payload === 'object' && payload !== null) {
    const output = (payload as { output?: unknown }).output;
    if (typeof output === 'string') return truncate(output);
    return truncate(JSON.stringify(payload));
  }
  return truncate(String(payload));
}

function truncate(input: string): string {
  const trimmed = input.replace(/\s+/g, ' ').trim();
  return trimmed.length <= OUTPUT_EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, OUTPUT_EXCERPT_LIMIT)}…`;
}
