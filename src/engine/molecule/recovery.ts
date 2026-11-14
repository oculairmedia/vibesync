/**
 * Restart recovery for interrupted molecules (vibesync-9lzk.9).
 *
 * A molecule's run context (formula, pack, input) lives in process memory, so
 * a restart orphans every molecule that was cooking or running: its root stays
 * open and its steps stay open or in_progress, owned by nothing. Emmanuel's
 * decision (2026-11-04): close interrupted molecules and re-run the work rather
 * than resume them.
 *
 * Re-running needs nothing new. A scheduler run's sling context only closes
 * when the run settles, so a run killed by the restart leaves its context open
 * and the scheduler dispatches the work bead again. This module only retires
 * the dead molecule so it cannot be mistaken for live work, and emits
 * `dispatcher/formula.interrupted` so the writeback hook tells the motivating
 * bead what happened.
 *
 * Must run at boot, before anything can start a new molecule: every open
 * molecule root at that point is, by construction, orphaned.
 */
import type { BeadRow } from '../store/index.js';

export const INTERRUPTED_EVENT = 'dispatcher/formula.interrupted';

/** The reads and writes recovery needs; satisfied by the Beads gateway. */
export interface RecoveryStore {
  listMoleculeRoots(opts?: { statuses?: readonly string[]; limit?: number }): Promise<readonly BeadRow[]>;
  getBeadDependencies(id: string): Promise<ReadonlyArray<{ readonly issue_id: string; readonly depends_on_id: string; readonly type: string }>>;
  getBead(id: string): Promise<BeadRow | null>;
  markStepFailed(stepId: string, errorTrace: string, retryOutcome?: string): Promise<void>;
  markMoleculeRootStatus(rootId: string, status: 'closed', outcome: 'interrupted'): Promise<void>;
}

export interface RecoveryEmitter {
  (moleculeId: string, payload: Readonly<Record<string, unknown>>): void;
}

export interface RecoveryReport {
  readonly interrupted: readonly string[];
  readonly failed: ReadonlyArray<{ readonly moleculeId: string; readonly error: string }>;
}

const OPEN_STATUSES = ['open', 'in_progress'] as const;
const STEP_TRACE = 'interrupted: vibesync restarted while this step was pending; the work bead is re-run';
/** Generous ceiling; a host has a handful of live molecules at most. */
const MAX_ROOTS = 500;

/**
 * Close every open molecule root and its unfinished steps as `interrupted`.
 * One molecule failing to close is reported, not fatal: boot continues and the
 * remaining molecules are still retired.
 */
export async function recoverInterruptedMolecules(store: RecoveryStore, emit: RecoveryEmitter): Promise<RecoveryReport> {
  const roots = await store.listMoleculeRoots({ statuses: OPEN_STATUSES, limit: MAX_ROOTS });
  const interrupted: string[] = [];
  const failed: Array<{ moleculeId: string; error: string }> = [];
  for (const root of roots) {
    try {
      const steps = await unfinishedSteps(store, root.id);
      // bd refuses to close a step that is still blocked by an open step
      // ("cannot close blocked issue: B is blocked by [A]"), so close in
      // dependency order: every step after the steps it waits on.
      for (const step of await blockersFirst(store, steps)) await store.markStepFailed(step.id, STEP_TRACE, 'interrupted');
      await store.markMoleculeRootStatus(root.id, 'closed', 'interrupted');
      interrupted.push(root.id);
      const motivating = motivatingBead(root);
      emit(root.id, {
        moleculeId: root.id,
        error: STEP_TRACE,
        interruptedSteps: steps.map((s) => s.id),
        ...(motivating ? { motivating_bead: motivating } : {}),
      });
    } catch (err) {
      failed.push({ moleculeId: root.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { interrupted, failed };
}

/** Every child step that is not closed (ready, blocked, or in progress). */
async function unfinishedSteps(store: RecoveryStore, rootId: string): Promise<BeadRow[]> {
  const edges = await store.getBeadDependencies(rootId);
  const childIds = edges.filter((e) => e.type === 'parent-child' && e.depends_on_id === rootId).map((e) => e.issue_id);
  const steps: BeadRow[] = [];
  for (const id of childIds) {
    const step = await store.getBead(id);
    if (step && isUnfinishedStep(step)) steps.push(step);
  }
  return steps;
}

/**
 * Topological order over the `blocks` edges among the given steps: a step is
 * emitted only after every step it depends on. Throws on a cycle rather than
 * guessing, since bd could close neither side.
 */
async function blockersFirst(store: RecoveryStore, steps: readonly BeadRow[]): Promise<BeadRow[]> {
  const graph = await blockGraph(store, steps);
  const order = drainInDependencyOrder(steps, graph);
  if (order.length !== steps.length) throw new Error('step dependency cycle; cannot order closes');
  return order;
}

interface BlockGraph {
  /** Open blockers each step still waits on. */
  readonly waitingOn: Map<string, number>;
  /** The steps each step blocks. */
  readonly dependents: Map<string, string[]>;
}

/** The blocks edges among these steps only: a blocker outside the molecule, or any other edge type, is ignored. */
async function blockGraph(store: RecoveryStore, steps: readonly BeadRow[]): Promise<BlockGraph> {
  const ids = new Set(steps.map((s) => s.id));
  const waitingOn = new Map<string, number>(steps.map((s) => [s.id, 0]));
  const dependents = new Map<string, string[]>(steps.map((s) => [s.id, []]));
  for (const step of steps) {
    for (const edge of await store.getBeadDependencies(step.id)) {
      if (!isBlockerWithin(edge, step.id, ids)) continue;
      waitingOn.set(step.id, waitingOn.get(step.id)! + 1);
      dependents.get(edge.depends_on_id)!.push(step.id);
    }
  }
  return { waitingOn, dependents };
}

/** `edge` says this step is blocked by another step of the same molecule (edge.issue_id is blocked by edge.depends_on_id). */
function isBlockerWithin(edge: { readonly issue_id: string; readonly depends_on_id: string; readonly type: string }, stepId: string, ids: ReadonlySet<string>): boolean {
  return edge.type === 'blocks' && edge.issue_id === stepId && ids.has(edge.depends_on_id);
}

/** Emit each step once every step it waits on has been emitted; a step in a cycle is never emitted. */
function drainInDependencyOrder(steps: readonly BeadRow[], graph: BlockGraph): BeadRow[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const queue = steps.filter((s) => graph.waitingOn.get(s.id) === 0).map((s) => s.id);
  const order: BeadRow[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const dependent of graph.dependents.get(id)!) {
      const left = graph.waitingOn.get(dependent)! - 1;
      graph.waitingOn.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  return order;
}

function isUnfinishedStep(bead: BeadRow): boolean {
  return bead.issue_type === 'molecule_step' && bead.status !== 'closed';
}

function motivatingBead(root: BeadRow): string | undefined {
  const exec = root.metadata['exec'];
  const value = typeof exec === 'object' && exec !== null ? (exec as Record<string, unknown>)['motivating_bead'] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
