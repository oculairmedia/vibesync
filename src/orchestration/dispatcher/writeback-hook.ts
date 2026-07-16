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
 *     metadata AFTER the note lands. A replay of the same event finds the
 *     stamp and short-circuits before touching the motivating bead's notes.
 *     Ordering matters (vibesync-er21): stamping only after a successful
 *     append means a transient store failure leaves the writeback pending
 *     (retryable on the next event replay / reboot re-emit) instead of
 *     being permanently lost.
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
  /** Look up a bead by id. Used to distinguish a GC'd motivating bead
   *  (permanent no-op) from a transient store failure (must retry). */
  getBead(id: string): Promise<BeadRow | null>;
  appendNoteToBead(beadId: string, note: string): Promise<void>;
  recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed'): Promise<string | undefined>;
}

/**
 * Structured logger surface for the writeback hook.
 *
 * `warn` carries swallowed failures (existing contract, vibesync-er21).
 * `info` (added for vibesync-er21 hook-wiring) carries the two
 * observability signals that were previously missing entirely:
 *   - a one-time subscription-confirmed line at install, so the daemon
 *     log proves the hook is wired to the EventBus, and
 *   - a per-invocation line every time a completion/failure event reaches
 *     the subscriber, recording the action taken (posted / skipped and
 *     why). Without this, a completed molecule that produced no note was
 *     indistinguishable from a hook that never subscribed — the exact
 *     symptom this bead chases.
 */
export interface WritebackLogger {
  warn(obj: unknown, msg: string): void;
  info?(obj: unknown, msg: string): void;
}

/** Outcome of handling one completion/failure event, for the per-invocation log. */
export type WritebackAction =
  | 'posted'
  | 'skipped-no-molecule-id'
  | 'skipped-molecule-not-found'
  | 'skipped-no-motivating-bead'
  | 'skipped-already-written'
  | 'skipped-motivating-bead-gc';

export interface WritebackHookDeps {
  readonly bus: EventBus;
  readonly walker: MoleculeWalker;
  readonly store: WritebackStore;
  /** Injectable so tests can pin the timestamp. Defaults to Date.now. */
  readonly now?: () => Date;
  /** Optional logger for swallowed errors and subscription/invocation traces. */
  readonly logger?: WritebackLogger;
}

function logInfo(logger: WritebackLogger | undefined, obj: unknown, msg: string): void {
  if (logger?.info) {
    logger.info(obj, msg);
    return;
  }
  // No structured logger at this call site — still surface the trace so the
  // subscription/invocation is never invisible in the daemon log. This is an
  // INFORMATIONAL trace, so log at info level (console.log) — logging it at
  // error level would pollute the log with false error signals (CodeRabbit).
  // eslint-disable-next-line no-console
  console.log(`[writeback] ${msg}`, obj);
}

/**
 * Subscribe to the dispatcher's completion events. Returns the
 * unsubscribe function so callers (boot) can detach during shutdown.
 */
export function installWritebackHook(deps: WritebackHookDeps): () => void {
  const now = deps.now ?? (() => new Date());
  // In-process guard against concurrent replays of the same completion
  // event (vibesync-er21). Because we stamp writeback_status only AFTER the
  // note lands (so a transient failure stays retryable), two events that
  // arrive before the first append resolves would both read "not stamped"
  // and each post a note. This set serializes handling per molecule+status
  // so at most one note is in flight; the persistent stamp then dedupes
  // across process restarts. On failure the key is released so a later
  // event can retry.
  const inFlight = new Set<string>();
  const unsubscribe = deps.bus.subscribe((event) => {
    if (event.kind !== 'dispatcher/formula.completed' && event.kind !== 'dispatcher/formula.failed') {
      return;
    }
    const key = `${event.molecule_id ?? ''}:${event.kind}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void handleEvent(event, deps, now)
      .then((action) => {
        // Per-invocation trace (vibesync-er21 hook-wiring): every completion
        // event that reaches the subscriber logs the action it took. A
        // "skipped-no-motivating-bead" line is how an operator now sees that
        // the hook DID fire but had no target — versus the old behaviour
        // where the same case produced no log line at all.
        logInfo(
          deps.logger,
          { moleculeId: event.molecule_id, kind: event.kind, action },
          `writeback hook fired: ${action}`,
        );
      })
      .catch((err: unknown) => {
        // Loud by design (vibesync-er21): a swallowed writeback failure is
        // how the loop-back to human-tracked work silently disappears. If no
        // logger was injected, fall back to console.error so the failure is
        // never invisible in the daemon log.
        logWritebackFailure(deps.logger, { err, moleculeId: event.molecule_id }, 'writeback hook failed — outcome NOT posted to motivating bead');
      })
      .finally(() => {
        inFlight.delete(key);
      });
  });

  // Subscription-confirmed trace (vibesync-er21 hook-wiring): prove at boot
  // that the hook is attached to the EventBus. Its absence in the daemon log
  // is the fastest signal that the writeback loop-back was never wired.
  logInfo(deps.logger, { subscriberCount: deps.bus.subscriberCount() }, 'writeback hook subscribed to EventBus (dispatcher/formula.completed|failed)');

  return unsubscribe;
}

function logWritebackFailure(
  logger: WritebackHookDeps['logger'],
  obj: { err: unknown; moleculeId?: string | undefined; motivatingBeadId?: string | undefined },
  msg: string,
): void {
  if (logger) {
    logger.warn(obj, msg);
    return;
  }
  // No structured logger wired at this call site — never stay silent.
  // eslint-disable-next-line no-console
  console.error(`[writeback] ${msg}`, obj);
}

async function handleEvent(event: Event, deps: WritebackHookDeps, now: () => Date): Promise<WritebackAction> {
  const moleculeId = event.molecule_id;
  if (!moleculeId) return 'skipped-no-molecule-id';
  const view = await deps.walker.load(moleculeId);
  if (!view) return 'skipped-molecule-not-found';

  const exec = readExec(view.root);
  const motivatingBeadId = typeof exec['motivating_bead'] === 'string' ? (exec['motivating_bead'] as string) : '';
  if (!motivatingBeadId) return 'skipped-no-motivating-bead';

  // Idempotency read (NOT a write): if a prior run already stamped the
  // writeback status, this event is a replay — short-circuit. Reading via
  // the molecule root's own metadata avoids stamping before the note lands.
  const alreadyDone = typeof exec['writeback_status'] === 'string' ? (exec['writeback_status'] as string) : undefined;
  const status = event.kind === 'dispatcher/formula.completed' ? 'completed' : 'failed';
  if (alreadyDone === status) return 'skipped-already-written';

  const formulaName = typeof exec['formula'] === 'string' ? (exec['formula'] as string) : 'unknown';
  const note = status === 'completed'
    ? buildCompletedNote({ moleculeId, formulaName, steps: view.steps, when: now() })
    : buildFailedNote({ moleculeId, formulaName, steps: view.steps, event, when: now() });

  // CONTRACT (vibesync-er21): the writeback stamp must be written ONLY
  // after the note successfully lands on the motivating bead. The previous
  // ordering (stamp first, then append) meant a transient Dolt failure on
  // append left the stamp set, so every subsequent replay/reboot re-emit
  // short-circuited and the outcome was lost forever. Now:
  //   1. Confirm the motivating bead still exists.
  //      - Gone (GC'd): permanent no-op — stamp so replays stop, warn once.
  //   2. Append the note. On failure: do NOT stamp, rethrow so the caller
  //      logs loudly and a later replay retries.
  //   3. Only after the note lands, stamp writeback_status for idempotency.
  const motivatingBead = await deps.store.getBead(motivatingBeadId);
  if (!motivatingBead) {
    await deps.store.recordMoleculeWriteback(moleculeId, status);
    deps.logger?.warn(
      { moleculeId, motivatingBeadId },
      'writeback hook: motivating bead is gone (GC\'d) — recording stamp and skipping note',
    );
    return 'skipped-motivating-bead-gc';
  }

  await deps.store.appendNoteToBead(motivatingBeadId, note);
  await deps.store.recordMoleculeWriteback(moleculeId, status);
  return 'posted';
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
