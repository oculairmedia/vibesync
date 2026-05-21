import type { BeadRow, DependencyRow } from '../../src/orchestration/store/index.js';

export interface BeadNote {
  readonly beadId: string;
  readonly note: string;
}

interface RootInsert {
  readonly id: string;
  readonly formulaName: string;
  readonly title: string;
  readonly motivatingBeadId?: string;
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

  async markStepRunning(stepId: string): Promise<void> {
    this.updateBead(stepId, { status: 'in_progress' });
  }

  async recordStepTask(stepId: string, task: { readonly taskId: string; readonly providerKind: string; readonly sessionId: string }): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      metadata: mergeExec(row.metadata, {
        task_id: task.taskId,
        provider_kind: task.providerKind,
        session_id: task.sessionId,
      }),
    });
  }

  async recordStepAttempt(stepId: string, attempt: number): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      metadata: mergeExec(row.metadata, { attempts: attempt }),
    });
  }

  async markStepDone(stepId: string, output: unknown): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      status: 'closed',
      closed_at: new Date(),
      metadata: mergeExec(row.metadata, { output_payload: output }),
    });
  }

  async markStepFailed(stepId: string, errorTrace: string): Promise<void> {
    const row = this.requireBead(stepId);
    this.updateBead(stepId, {
      status: 'closed',
      closed_at: new Date(),
      metadata: mergeExec(row.metadata, { error_trace: errorTrace }),
    });
  }

  async appendNoteToBead(beadId: string, note: string): Promise<void> {
    if (!this.beads.has(beadId)) throw new Error(`InMemoryDoltClient: unknown bead ${beadId}`);
    this.notes.push({ beadId, note });
  }

  async recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed'): Promise<string | undefined> {
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
