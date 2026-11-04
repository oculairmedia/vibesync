/**
 * Molecule — runtime workflow instance built on bd as root + step beads.
 *
 * A molecule represents one running formula. The root bead (issue_type =
 * 'molecule_root') holds the formula name + motivating bead reference;
 * each step bead (issue_type = 'molecule_step') is linked to the root by
 * a `parent-child` dependency edge and to its predecessors by `blocks`
 * edges. All persistence is in the bd Dolt database; this module just
 * adds the structural model + walker on top.
 *
 * Co-location decision (vibesync-uxx, recorded 2026-05-17):
 *   - Molecule beads live in the SAME bd database as human work
 *   - Structural fields (parent, depends_on, type) use bd's existing
 *     issues/dependencies tables verbatim
 *   - Execution-specific fields (input/output payload, retry_count,
 *     error_trace) live in the bead's `metadata.exec.*` JSON namespace
 *   - This is the hybrid path described in the bead description: bd's
 *     schema covers structural concerns; metadata covers execution
 *
 * See vibesync-uxx, vibesync-93h, vibesync-w5z, and
 * docs/architecture/bd-conventions.md.
 */

import type { BeadRow, DependencyRow } from '../store/index.js';
import type { RetryPolicy } from '../retry/policy.js';

/** How a molecule root was closed; `interrupted` = a restart orphaned it (vibesync-9lzk.9). */
export type MoleculeOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Step spec — what to do at each node of a formula. Provided by the
 * formula parser (vibesync-k6h); consumed by the daemon walker.
 */
export interface StepSpec {
  readonly name: string;
  readonly role: string;
  readonly promptTemplate?: string;
  readonly dependsOn?: readonly string[];
  readonly waitFor?: 'completion';
  /**
   * Per-step retry policy (`[steps.retry]`, vibesync-ynmp). Absent = the step
   * gets one try unless the deprecated `retries` alias below says otherwise
   * (see retry/policy.ts `resolveRetryPolicy`).
   */
  readonly retry?: RetryPolicy;
  /** @deprecated alias of `retry`: max_attempts = retries + 1, on_exhausted = "fail". */
  readonly retries?: number;
  /** @deprecated alias of `retry.backoffMs`. */
  readonly retryBackoffMs?: number;
  /**
   * Per-step turn timeout in milliseconds (vibesync-lcp-98y8). When
   * set, overrides the provider's default turnTimeoutMs for this
   * specific step. Use for steps that legitimately run long (e.g.
   * coder/implementer refactors). When omitted, the provider uses
   * its configured default (10min for LettaCodeSubagentProvider,
   * or VIBESYNC_TURN_TIMEOUT_MS env var if set).
   */
  readonly turnTimeoutMs?: number;
}

/**
 * The Dolt-backed representation of a molecule as the walker sees it.
 *
 * `byName` maps step name → BeadRow for ergonomic lookup; `rootId` and
 * the row arrays are the canonical persistence handles.
 */
export interface MoleculeView {
  readonly rootId: string;
  readonly root: BeadRow;
  readonly steps: readonly BeadRow[];
  readonly byName: ReadonlyMap<string, BeadRow>;
  readonly edges: readonly DependencyRow[];
}

/**
 * lcp-61uj: lightweight per-run summary for the fleet-status endpoint
 * (GET /molecules). Enough to render a run card without fetching each
 * molecule's full trace.
 */
export interface MoleculeSummary {
  readonly id: string;
  readonly formulaName: string | null;
  readonly motivatingBeadId: string | null;
  readonly status: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stepCounts: { readonly total: number; readonly done: number; readonly running: number };
  readonly currentStep: string | null;
  readonly currentStepStatus: string | null;
}

export interface MoleculeStore {
  getBead(id: string): Promise<BeadRow | null>;
  getBeadDependencies(id: string): Promise<DependencyRow[]>;
  insertMoleculeRoot(args: {
    readonly id: string;
    readonly formulaName: string;
    readonly title: string;
    readonly motivatingBeadId?: string;
  }): Promise<void>;
  insertMoleculeStep(args: {
    readonly id: string;
    readonly parentRootId: string;
    readonly stepName: string;
    readonly title: string;
    readonly dependsOnStepIds?: readonly string[];
  }): Promise<void>;
  findReadyStepsForMolecule(rootId: string): Promise<readonly BeadRow[]>;
  findRunningStepsForMolecule(rootId: string): Promise<readonly BeadRow[]>;
  // lcp-61uj: list molecule-root beads (rig runs) for the fleet-status endpoint.
  listMoleculeRoots(opts?: { statuses?: readonly string[]; limit?: number }): Promise<readonly BeadRow[]>;
  markStepRunning(stepId: string): Promise<void>;
  recordStepTask(stepId: string, task: {
    /**
     * Provider-opaque task id for restart re-attachment (f5g).
     * Optional because providers that surface their task id
     * asynchronously via the SSE stream (e.g. LettaCodeSubagentProvider)
     * may not have it synchronously available at prompt() return
     * time; for those, the dispatcher persists conversation_id
     * alone and the resume path falls back to conversation
     * re-attachment.
     */
    readonly taskId?: string;
    readonly providerKind: string;
    readonly sessionId: string;
    /**
     * Optional persistent-subagent conversation id (vibesync-mcz
     * Phase D). When present, persisted as metadata.exec.conversation_id
     * alongside task_id so a future resume can re-attach to the
     * same conversation on the persistent role agent.
     */
    readonly conversationId?: string;
  }): Promise<void>;
  recordStepAttempt(stepId: string, attempt: number): Promise<void>;
  /** vibesync-ynmp: reopen a failed try so the bead graph re-offers the step; the counters live on the bead. */
  reopenStepForRetry(stepId: string, args: {
    readonly attempt: number;
    readonly infraRetries: number;
    readonly failureClass: string | null;
    readonly errorTrace: string;
  }): Promise<void>;
  markStepDone(stepId: string, output: unknown): Promise<void>;
  markStepFailed(stepId: string, errorTrace: string, retryOutcome?: string): Promise<void>;
  // lcp-s0wi: mark a molecule root bead as terminal with an outcome.
  markMoleculeRootStatus(rootId: string, status: 'closed', outcome: MoleculeOutcome): Promise<void>;
}

/**
 * Generate an id for a new molecule root. Convention:
 *   <repo-prefix>-mol-<short-ulid-ish>
 *
 * The caller passes the repo's bd prefix. The
 * suffix is a 12-char random token; collision probability is negligible
 * for the volumes a single repo's orchestration produces.
 */
export function newMoleculeRootId(prefix: string): string {
  const suffix = randomToken(12);
  return `${prefix}-mol-${suffix}`;
}

/**
 * Generate an id for a step within a molecule. Convention:
 *   <root-id>-<step-name>
 *
 * Keeps the step id visually attached to its molecule and stable across
 * retries (a retry overwrites the same step bead's metadata; it doesn't
 * mint a new id).
 */
export function newMoleculeStepId(rootId: string, stepName: string): string {
  const sanitized = stepName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `${rootId}-${sanitized}`;
}

function randomToken(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * The molecule walker: COOK (root + step beads with parent-child and `blocks`
 * edges) and WRITEBACK (step/root lifecycle writes, loads). It does NOT decide
 * what runs next (vibesync-efee): the bead graph does, read per molecule by
 * the scheduler's StepDispatcher (scheduler/step-dispatcher.ts).
 */
export class MoleculeWalker {
  constructor(private readonly store: MoleculeStore) {}

  /**
   * Materialize a molecule from its root id. Reads the root, all step
   * beads (children via parent-child dep), and all dependency edges.
   */
  async load(rootId: string): Promise<MoleculeView | null> {
    const root = await this.store.getBead(rootId);
    if (!root || root.issue_type !== 'molecule_root') return null;
    const edges = await this.store.getBeadDependencies(rootId);
    const childIds = edges
      .filter((e) => e.type === 'parent-child' && e.depends_on_id === rootId)
      .map((e) => e.issue_id);
    const steps: BeadRow[] = [];
    for (const cid of childIds) {
      const row = await this.store.getBead(cid);
      if (row && row.issue_type === 'molecule_step') steps.push(row);
    }
    // Aggregate edges across all step beads (parent-child + blocks).
    const stepEdges: DependencyRow[] = [];
    for (const step of steps) {
      const sEdges = await this.store.getBeadDependencies(step.id);
      stepEdges.push(...sEdges);
    }
    const byName = new Map<string, BeadRow>();
    for (const step of steps) {
      const stepName = (step.metadata as { exec?: { step?: string } })?.exec?.step;
      if (stepName) byName.set(stepName, step);
    }
    return { rootId, root, steps, byName, edges: dedupeEdges([...edges, ...stepEdges]) };
  }

  /** Return step beads currently marked as running for this molecule. */
  async findRunning(rootId: string): Promise<readonly BeadRow[]> {
    return this.store.findRunningStepsForMolecule(rootId);
  }

  /**
   * lcp-61uj: list molecule runs (fleet status) with a lightweight per-run
   * summary so a UI can render run cards without N trace fetches. Each
   * summary carries: id, formulaName, motivatingBeadId, status, created/
   * updated, step counts (total/done/running), and the current/last step.
   * `statuses` filters molecule-root status (e.g. ['open','in_progress']
   * for active); omit for recent-all. `limit` caps results.
   */
  async listMolecules(opts: { statuses?: readonly string[]; limit?: number } = {}): Promise<MoleculeSummary[]> {
    const roots = await this.store.listMoleculeRoots(opts);
    const summaries: MoleculeSummary[] = [];
    for (const root of roots) {
      const view = await this.load(root.id);
      const steps = view?.steps ?? [];
      const total = steps.length;
      const done = steps.filter((s) => s.status === 'closed').length;
      const running = steps.filter((s) => s.status === 'in_progress').length;
      // current step: prefer a running step, else the last non-open step.
      const currentStep =
        steps.find((s) => s.status === 'in_progress') ??
        [...steps].reverse().find((s) => s.status !== 'open');
      const exec = (root.metadata as { exec?: { formula?: string; motivating_bead?: string } })?.exec ?? {};
      const stepExec = (currentStep?.metadata as { exec?: { step?: string } } | undefined)?.exec;
      summaries.push({
        id: root.id,
        formulaName: exec.formula ?? null,
        motivatingBeadId: exec.motivating_bead ?? null,
        status: root.status,
        title: root.title,
        createdAt: root.created_at,
        updatedAt: root.updated_at,
        stepCounts: { total, done, running },
        currentStep: currentStep ? (stepExec?.step ?? currentStep.title ?? null) : null,
        currentStepStatus: currentStep?.status ?? null,
      });
    }
    return summaries;
  }

  /**
   * Dispatch the molecule from a formula spec: create the root + every
   * step bead with the right edges, but do NOT run anything yet. The
   * scheduler's StepDispatcher offers steps as the graph makes them ready.
   *
   * Returns the materialized MoleculeView for follow-up.
   */
  async dispatch(args: {
    readonly prefix: string;
    readonly formulaName: string;
    readonly title: string;
    readonly motivatingBeadId?: string;
    readonly steps: readonly StepSpec[];
  }): Promise<MoleculeView> {
    const rootId = newMoleculeRootId(args.prefix);
    await this.store.insertMoleculeRoot({
      id: rootId,
      formulaName: args.formulaName,
      title: args.title,
      ...(args.motivatingBeadId ? { motivatingBeadId: args.motivatingBeadId } : {}),
    });
    // Insert steps in declared order so depends_on references already exist.
    const stepIdByName = new Map<string, string>();
    for (const step of args.steps) {
      const id = newMoleculeStepId(rootId, step.name);
      stepIdByName.set(step.name, id);
      const dependsOnIds = (step.dependsOn ?? []).map((name) => {
        const id = stepIdByName.get(name);
        if (!id) {
          throw new Error(
            `MoleculeWalker.dispatch: step "${step.name}" depends_on "${name}" which is not defined before it in the formula`,
          );
        }
        return id;
      });
      await this.store.insertMoleculeStep({
        id,
        parentRootId: rootId,
        stepName: step.name,
        title: `[formula:${args.formulaName}/step:${step.name}] ${step.role}`,
        dependsOnStepIds: dependsOnIds,
      });
    }
    const loaded = await this.load(rootId);
    if (!loaded) {
      throw new Error(`MoleculeWalker.dispatch: failed to read back molecule ${rootId}`);
    }
    return loaded;
  }

  /** Mark a step as running. Pass-through to the store. */
  async startStep(stepId: string): Promise<void> {
    await this.store.markStepRunning(stepId);
  }

  /**
   * Persist provider-opaque task metadata for restart re-attachment.
   * vibesync-mcz Phase D: also persists conversation_id when supplied
   * so a future resume can re-attach to the same persistent-subagent
   * conversation.
   */
  async recordStepTask(stepId: string, task: {
    readonly taskId?: string;
    readonly providerKind: string;
    readonly sessionId: string;
    readonly conversationId?: string;
  }): Promise<void> {
    await this.store.recordStepTask(stepId, task);
  }

  /** Persist the latest execution attempt count for retry-aware steps. */
  async recordStepAttempt(stepId: string, attempt: number): Promise<void> {
    await this.store.recordStepAttempt(stepId, attempt);
  }

  /** Mark a step as done. Pass-through. */
  async finishStep(stepId: string, output: unknown): Promise<void> {
    await this.store.markStepDone(stepId, output);
  }

  /** Mark a step as failed. Pass-through. `retryOutcome` is stamped as gc.retry_outcome when a retry policy ended it. */
  async failStep(stepId: string, errorTrace: string, retryOutcome?: string): Promise<void> {
    await this.store.markStepFailed(stepId, errorTrace, retryOutcome);
  }

  /** Re-read one bead (the retry counters and an agent's failure_class live on it). */
  async readStep(stepId: string): Promise<BeadRow | null> {
    return this.store.getBead(stepId);
  }

  /** The `blocks` predecessors of a step bead. */
  async blockersOf(stepId: string): Promise<readonly string[]> {
    const edges = await this.store.getBeadDependencies(stepId);
    return edges.filter((e) => e.type === 'blocks' && e.issue_id === stepId).map((e) => e.depends_on_id);
  }

  /** Put a failed try back in the ready set with its counters on the bead (vibesync-ynmp). */
  async reopenStepForRetry(stepId: string, args: {
    readonly attempt: number;
    readonly infraRetries: number;
    readonly failureClass: string | null;
    readonly errorTrace: string;
  }): Promise<void> {
    await this.store.reopenStepForRetry(stepId, args);
  }

  /**
   * Mark a molecule root as terminal with an outcome (lcp-s0wi). Called by
   * the dispatcher when a molecule finishes (all steps closed). Sets status
   * to 'closed' and records outcome in metadata.exec.outcome so GET /molecules
   * can filter out finished runs.
   */
  async markMoleculeRootStatus(
    rootId: string,
    status: 'closed',
    outcome: MoleculeOutcome,
  ): Promise<void> {
    await this.store.markMoleculeRootStatus(rootId, status, outcome);
  }

  /**
   * Has the molecule completed (success or failure)? True iff every
   * step bead is closed.
   */
  async isComplete(rootId: string): Promise<boolean> {
    const view = await this.load(rootId);
    if (!view) return false;
    return view.steps.every((s) => s.status === 'closed');
  }
}

function dedupeEdges(edges: readonly DependencyRow[]): DependencyRow[] {
  const seen = new Set<string>();
  const out: DependencyRow[] = [];
  for (const e of edges) {
    const k = `${e.issue_id}|${e.depends_on_id}|${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
