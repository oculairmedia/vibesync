import type { MoleculeOutcome } from '../../src/engine/molecule/molecule.js';
import type { BeadRow, DependencyRow } from '../../src/engine/store/index.js';

export interface BeadNote {
  readonly beadId: string;
  readonly note: string;
}

interface RootInsert {
  readonly id: string;
  readonly formulaName: string;
  readonly title: string;
  readonly motivatingBeadId?: string;
  readonly projectIdentifier?: string;
  readonly delivers?: string;
  readonly metadata?: Record<string, unknown>;
}

interface StepInsert {
  readonly id: string;
  readonly parentRootId: string;
  readonly stepName: string;
  readonly title: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly inputPayload?: unknown;
}

export class InMemoryDoltClient {
  readonly beads = new Map<string, BeadRow>();
  readonly dependencies: DependencyRow[] = [];
  readonly notes: BeadNote[] = [];

  /** Test fault-injection: when > 0, the next N appendNoteToBead calls throw
   *  a transient store error (simulates Dolt flakiness during a run). Each
   *  failing call decrements the counter. Used to prove the writeback is
   *  retryable rather than permanently lost (vibesync-er21). */
  failNextAppends = 0;
  /** Test observability: total appendNoteToBead attempts (including failed). */
  appendAttempts = 0;

  /** Mirrors DoltClient.readIssuePrefix; the historic default keeps existing fixture ids stable. */
  async readIssuePrefix(): Promise<string> {
    return 'mol';
  }

  async getBead(id: string): Promise<BeadRow | null> {
    return this.beads.get(id) ?? null;
  }

  async getBeadDependencies(id: string): Promise<DependencyRow[]> {
    return this.dependencies.filter((edge) => edge.issue_id === id || edge.depends_on_id === id);
  }

  async insertMoleculeRoot(args: RootInsert): Promise<void> {
    const metadata = {
      ...(args.metadata ?? {}),
      exec: {
        formula: args.formulaName,
        ...(args.motivatingBeadId ? { motivating_bead: args.motivatingBeadId } : {}),
        ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
        ...(args.delivers ? { delivers: args.delivers } : {}),
      },
    };
    this.beads.set(
      args.id,
      newBead({
        id: args.id,
        title: args.title,
        issueType: 'molecule_root',
        metadata,
      }),
    );
  }

  async insertMoleculeStep(args: StepInsert): Promise<void> {
    this.beads.set(
      args.id,
      newBead({
        id: args.id,
        title: args.title,
        issueType: 'molecule_step',
        metadata: {
          exec: {
            step: args.stepName,
            molecule: args.parentRootId,
            input_payload: args.inputPayload,
          },
        },
      }),
    );
    this.dependencies.push({ issue_id: args.id, depends_on_id: args.parentRootId, type: 'parent-child' });
    for (const dependsOnId of args.dependsOnStepIds ?? []) {
      this.dependencies.push({ issue_id: args.id, depends_on_id: dependsOnId, type: 'blocks' });
    }
  }

  async findReadyStepsForMolecule(rootId: string): Promise<BeadRow[]> {
    const stepIds = this.dependencies
      .filter((edge) => edge.type === 'parent-child' && edge.depends_on_id === rootId)
      .map((edge) => edge.issue_id);

    return stepIds
      .map((id) => this.beads.get(id))
      .filter((row): row is BeadRow => row?.issue_type === 'molecule_step' && row.status === 'open')
      .filter((row) => this.blockingEdges(row.id).every((edge) => this.beads.get(edge.depends_on_id)?.status === 'closed'));
  }

  async findRunningStepsForMolecule(rootId: string): Promise<BeadRow[]> {
    const stepIds = this.dependencies
      .filter((edge) => edge.type === 'parent-child' && edge.depends_on_id === rootId)
      .map((edge) => edge.issue_id);

    return stepIds
      .map((id) => this.beads.get(id))
      .filter((row): row is BeadRow => row?.issue_type === 'molecule_step' && row.status === 'in_progress');
  }

  async findStepsForMolecule(rootId: string): Promise<BeadRow[]> {
    const stepIds = this.dependencies
      .filter((edge) => edge.type === 'parent-child' && edge.depends_on_id === rootId)
      .map((edge) => edge.issue_id);
    return stepIds.map((id) => this.beads.get(id)).filter((row): row is BeadRow => row?.issue_type === 'molecule_step');
  }

  // lcp-61uj: list molecule-root beads for the fleet-status endpoint.
  /** As DoltClient.listIssueStatusSince: issues updated at or after the cursor, run beads excluded, keyset-paged. */
  async listIssueStatusSince(
    cursor: Date,
    limit: number,
    after?: { readonly updatedAt: Date; readonly id: string } | null,
  ): Promise<Array<{ id: string; status: string; updated_at: Date }>> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
    const engineOwned = new Set(['molecule_root', 'molecule_step', 'gate']);
    const at = (row: BeadRow) => new Date(row.updated_at).getTime();
    return [...this.beads.values()]
      .filter((row) => !engineOwned.has(String(row.issue_type)) && at(row) >= cursor.getTime())
      .filter((row) => after == null || at(row) > after.updatedAt.getTime() || (at(row) === after.updatedAt.getTime() && row.id > after.id))
      .sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, bounded)
      .map((row) => ({ id: row.id, status: String(row.status ?? 'open'), updated_at: new Date(row.updated_at) }));
  }

  async listMoleculeRoots(opts: { statuses?: readonly string[]; limit?: number } = {}): Promise<BeadRow[]> {
    const statuses = opts.statuses;
    const limit = opts.limit ?? 50;
    return [...this.beads.values()]
      .filter((row): row is BeadRow => row.issue_type === 'molecule_root')
      .filter((row) => !statuses || statuses.includes(row.status))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit);
  }

  /** As BdMoleculeWriter.markStepRunning (`--if-status open`): a step that is no longer open is not started. */
  async markStepRunning(stepId: string): Promise<boolean> {
    if (this.requireBead(stepId).status !== 'open') return false;
    this.updateBead(stepId, { status: 'in_progress' });
    return true;
  }

  async recordStepTask(stepId: string, task: {
    readonly taskId?: string;
    readonly providerKind: string;
    readonly sessionId: string;
    readonly conversationId?: string;
  }): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      metadata: mergeExec(row.metadata, {
        ...(task.taskId ? { task_id: task.taskId } : {}),
        provider_kind: task.providerKind,
        session_id: task.sessionId,
        ...(task.conversationId ? { conversation_id: task.conversationId } : {}),
      }),
    });
  }

  async recordStepAttempt(stepId: string, attempt: number): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      metadata: { ...mergeExec(row.metadata, { attempts: attempt }), 'gc.retry_attempt': attempt },
    });
  }

  async reopenStepForRound(stepId: string, args: { readonly round: number; readonly note: string }): Promise<void> {
    const row = this.requireBead(stepId);
    const exec = (row.metadata['exec'] ?? {}) as Record<string, unknown>;
    const { output_payload: _o, task_id: _t, session_id: _s, error_trace: _e, ...keep } = exec;
    const { 'gc.retry_outcome': _ro, failure_class: _fc, ...rest } = row.metadata;
    this.updateBead(stepId, {
      status: 'open',
      closed_at: null,
      metadata: { ...rest, exec: { ...keep, attempts: 1, round_note: args.note }, 'gc.retry_attempt': 1, 'gc.infra_retries': 0, 'gc.review_round': args.round },
    });
  }

  async reopenStepForRetry(
    stepId: string,
    args: { readonly attempt: number; readonly infraRetries: number; readonly failureClass: string | null; readonly errorTrace: string },
  ): Promise<void> {
    const row = this.requireBead(stepId);
    const { failure_class: _declared, ...rest } = mergeExec(row.metadata, { attempts: args.attempt, error_trace: args.errorTrace });
    this.updateBead(stepId, {
      status: 'open',
      closed_at: null,
      metadata: {
        ...rest,
        'gc.retry_attempt': args.attempt,
        'gc.infra_retries': args.infraRetries,
        ...(args.failureClass ? { 'gc.last_failure_class': args.failureClass } : {}),
      },
    });
  }

  /** Test helper: what an agent does with `bd update <step> --set-metadata key=value`. */
  setStepMetadata(stepId: string, patch: Record<string, unknown>): void {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, { metadata: { ...row.metadata, ...patch } });
  }

  async markStepDone(stepId: string, output: unknown): Promise<void> {
    const row = this.requireBead(stepId);
    // As the real writer: a step that succeeds drops an old error_trace.
    const metadata = mergeExec(row.metadata, { output_payload: output });
    delete (metadata.exec as Record<string, unknown>).error_trace;
    this.updateBead(stepId, {
      status: 'closed',
      closed_at: new Date(),
      metadata,
    });
  }

  async markStepFailed(stepId: string, errorTrace: string, retryOutcome?: string): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      status: 'closed',
      closed_at: new Date(),
      metadata: { ...mergeExec(row.metadata, { error_trace: errorTrace }), ...(retryOutcome ? { 'gc.retry_outcome': retryOutcome } : {}) },
    });
  }

  async closeOpenStep(stepId: string, reason: string, force = false): Promise<void> {
    const row = this.requireBead(stepId);
    // Real bd closes an in_progress bead as well as an open one (checked 2026-11-15, with and without --force);
    // only an already-closed one is refused here.
    if (row.status === 'closed') throw new Error(`InMemoryDoltClient: ${stepId} is already closed`);
    const blocker = !force ? this.blockingEdges(stepId).find((edge) => this.beads.get(edge.depends_on_id)?.status !== 'closed') : undefined;
    if (blocker) throw new Error(`cannot close blocked issue: ${stepId} is blocked by [${blocker.depends_on_id}]`);
    this.updateBead(stepId, { status: 'closed', closed_at: new Date(), metadata: { ...row.metadata, close_reason: reason } });
  }

  async appendNoteToBead(beadId: string, note: string): Promise<void> {
    this.appendAttempts += 1;
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      throw new Error('InMemoryDoltClient: transient Dolt failure (injected)');
    }
    if (!this.beads.has(beadId)) throw new Error(`InMemoryDoltClient: unknown bead ${beadId}`);
    this.notes.push({ beadId, note });
  }

  async addCommentToBead(beadId: string, comment: string): Promise<void> {
    if (!this.beads.has(beadId)) throw new Error(`InMemoryDoltClient: unknown bead ${beadId}`);
    this.notes.push({ beadId, note: comment });
  }

  async recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed' | 'interrupted'): Promise<string | undefined> {
    const row = this.requireBead(rootId);
    const exec = (row.metadata.exec && typeof row.metadata.exec === 'object'
      ? (row.metadata.exec as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const previous = typeof exec.writeback_status === 'string' ? (exec.writeback_status as string) : undefined;
    this.updateBead(rootId, {
      metadata: { ...row.metadata, exec: { ...exec, writeback_status: status } },
    });
    return previous;
  }

  async markMoleculeRootStatus(
    rootId: string,
    status: 'closed',
    outcome: MoleculeOutcome,
  ): Promise<boolean> {
    const row = this.requireBead(rootId);
    // As the real writer does (`--if-status open`): a root already closed is not written again.
    if (row.status === 'closed') return false;
    // As the real writer does (BdMoleculeWriter.closeOpenSteps, vibesync-9lzk.60): a run that
    // fails or is cancelled closes its steps that are still open, with the reason `run <outcome>`.
    // Without this the stand-in left a step open under a closed root where real bd does not.
    if (outcome === 'failed' || outcome === 'cancelled') {
      for (const step of await this.findStepsForMolecule(rootId)) {
        if (step.status !== 'closed') await this.closeOpenStep(step.id, `run ${outcome}`, true);
      }
    }
    this.updateBead(rootId, {
      status,
      closed_at: new Date(),
      metadata: mergeExec(row.metadata, { outcome }),
    });
    return true;
  }

  private blockingEdges(stepId: string): DependencyRow[] {
    return this.dependencies.filter((edge) => edge.issue_id === stepId && edge.type === 'blocks');
  }

  private requireBead(id: string): BeadRow {
    const row = this.beads.get(id);
    if (!row) throw new Error(`InMemoryDoltClient: unknown bead ${id}`);
    return row;
  }

  private updateBead(id: string, patch: Partial<BeadRow>): void {
    const row = this.requireBead(id);
    this.beads.set(id, { ...row, ...patch, updated_at: new Date() });
  }
}

function newBead(args: {
  readonly id: string;
  readonly title: string;
  readonly issueType: string;
  readonly metadata: Record<string, unknown>;
}): BeadRow {
  const now = new Date();
  return {
    id: args.id,
    title: args.title,
    description: '',
    status: 'open',
    priority: 2,
    issue_type: args.issueType,
    created_at: now,
    updated_at: now,
    closed_at: null,
    metadata: args.metadata,
  };
}

function mergeExec(metadata: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const exec = metadata.exec && typeof metadata.exec === 'object' ? metadata.exec : {};
  return { ...metadata, exec: { ...exec, ...patch } };
}

/**
 * Boot options for an in-memory store: the same object serves reads (`dolt`)
 * and the Beads gateway (`beadsStore`), so no bd binary is invoked.
 */
export function inMemoryBeads(client: InMemoryDoltClient = new InMemoryDoltClient()): { dolt: never; beadsStore: never } {
  return { dolt: client as never, beadsStore: client as never };
}
