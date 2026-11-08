import type { MoleculeView, MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { RuntimeProvider, SessionEvent, SessionHandle } from '../runtime/index.js';
import { parseBlockedOutcome } from './step-outcome.js';
import type { DeliveryVerifier } from './delivery.js';
import {
  FormulaDispatchError,
  FormulaEscalationError,
  StepBlockedError,
  type DispatchResult,
  type ResumedDeliveryArgs,
  type RuntimeSessionEventContext,
} from './types.js';
import { readExec, readStepName, readStepRole, readString, softFailMarker, stringifyError } from './util.js';

export interface ResumeCoordinatorDeps {
  readonly walker: MoleculeWalker;
  readonly defaultProvider: RuntimeProvider;
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly emitRuntimeSessionEvent: (event: SessionEvent, context: RuntimeSessionEventContext) => void;
}

export class ResumeCoordinator {
  constructor(private readonly deps: ResumeCoordinatorDeps) {}

  async resume(moleculeId: string): Promise<DispatchResult> {
    const startedAt = Date.now();
    const view = await this.deps.walker.load(moleculeId);
    if (!view) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    }

    const outputs = outputsFromClosedSteps(view.steps);
    // vibesync-u32z: on resume, `input` is not in scope — recover the
    // motivating bead from the persisted molecule_root exec so the completion
    // event stays self-describing across a restart/resume too.
    const motivatingBeadId = readMotivatingBead(view.root);
    this.deps.emit('dispatcher/formula.resumed', moleculeId, undefined, {
      moleculeId,
      runningStepCount: view.steps.filter((step) => step.status === 'in_progress').length,
    });

    const running = await this.deps.walker.findRunning(moleculeId);
    if (running.length === 0) {
      await this.completeOrRejectWithoutRunningSteps({ view, moleculeId, outputs, startedAt, motivatingBeadId });
      return { moleculeId, outputs };
    }

    await this.resumeRunningSteps({ running, moleculeId, outputs, view, startedAt, motivatingBeadId });

    return { moleculeId, outputs };
  }

  /**
   * Finish a resumed molecule: verify its recorded delivery, then announce
   * completion. Both resume paths go through here, so a recorded delivery is
   * always checked before formula.completed is emitted.
   */
  private async completeResumedMolecule(args: {
    readonly view: { readonly root: BeadRow };
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly startedAt: number;
    readonly motivatingBeadId: string | null;
  }): Promise<void> {
    await this.requireResumedDelivery({
      root: args.view.root,
      moleculeId: args.moleculeId,
      outputs: args.outputs,
      startedAt: args.startedAt,
      motivatingBeadId: args.motivatingBeadId,
    });
    this.deps.emit('dispatcher/formula.completed', args.moleculeId, undefined, {
      moleculeId: args.moleculeId,
      durationMs: Date.now() - args.startedAt,
      resumed: true,
      ...(args.motivatingBeadId ? { motivating_bead: args.motivatingBeadId } : {}),
    });
  }

  /**
   * resume() has no formula in scope, so it reads the delivery the root
   * recorded at dispatch (vibesync-9lzk.21 review). Throws, after failing the
   * root and emitting formula.failed, when that delivery is not met.
   */
  private async requireResumedDelivery(
    args: ResumedDeliveryArgs,
  ): Promise<void> {
    const { root, moleculeId, motivatingBeadId } = args;
    const exec = root.metadata['exec'];
    const kind = typeof exec === 'object' && exec !== null ? (exec as Record<string, unknown>)['delivers'] : undefined;
    if (kind === undefined) return;
    const reason = await this.verifyResumedDelivery({ ...args, kind });
    if (reason === null) return;
    await this.deps.walker.markMoleculeRootStatus(moleculeId, 'closed', 'failed');
    this.deps.emit('dispatcher/formula.failed', moleculeId, undefined, {
      moleculeId, error: reason, resumed: true,
      ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
    });
    throw new FormulaDispatchError(`FormulaDispatcher: ${reason}`, moleculeId);
  }

  private async verifyResumedDelivery(
    args: ResumedDeliveryArgs & { readonly kind: unknown },
  ): Promise<string | null> {
    const { root, moleculeId, outputs, startedAt, motivatingBeadId, kind } = args;
    // The run this resumes began when the root was created, not at this resume.
    const runStarted = root.created_at instanceof Date ? root.created_at.getTime() : startedAt;
    if (kind !== 'pull_request') return `molecule records an unknown delivery kind ${JSON.stringify(kind)}`;
    if (!this.deps.deliveryVerifier) return 'molecule declares delivers = "pull_request" but no delivery verifier is configured';
    try {
      const verdict = await this.deps.deliveryVerifier.verify({
        kind, outputs, moleculeId, startedAt: new Date(runStarted),
        ...(motivatingBeadId ? { motivatingBeadId } : {}),
      });
      if ('reason' in verdict) return `declared delivery not met: ${verdict.reason}`;
      this.deps.emit('dispatcher/formula.delivered', moleculeId, undefined, { moleculeId, kind, artifact: verdict.artifact, resumed: true });
      return null;
    } catch (err) {
      return `declared delivery could not be verified: ${stringifyError(err)}`;
    }
  }

  private async completeOrRejectWithoutRunningSteps(args: {
    readonly view: MoleculeView;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly startedAt: number;
    readonly motivatingBeadId: string | null;
  }): Promise<void> {
    if (!(await this.deps.walker.isComplete(args.moleculeId))) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${args.moleculeId} has no running steps to resume`, args.moleculeId);
    }
    await this.completeResumedMolecule(args);
  }

  private async resumeRunningSteps(args: {
    readonly running: readonly BeadRow[];
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly view: MoleculeView;
    readonly startedAt: number;
    readonly motivatingBeadId: string | null;
  }): Promise<void> {
    try {
      for (const step of args.running) {
        await this.resumeStep({ step, moleculeId: args.moleculeId, outputs: args.outputs });
      }
    } catch (error) {
      this.deps.emit('dispatcher/formula.failed', args.moleculeId, undefined, {
        moleculeId: args.moleculeId,
        error: stringifyError(error),
        resumed: true,
        ...(args.motivatingBeadId ? { motivating_bead: args.motivatingBeadId } : {}),
      });
      throw error;
    }
    await this.settleResumedMolecule(args);
  }

  private async settleResumedMolecule(args: {
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly view: MoleculeView;
    readonly startedAt: number;
    readonly motivatingBeadId: string | null;
  }): Promise<void> {
    if (!(await this.deps.walker.isComplete(args.moleculeId))) {
      this.deps.emit('dispatcher/formula.resume.paused', args.moleculeId, undefined, {
        moleculeId: args.moleculeId,
        reason: 'running steps completed; open successors require a fresh formula run context',
      });
      return;
    }
    await this.completeResumedMolecule(args);
  }

  private async resumeStep(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
  }): Promise<void> {
    const stepName = readStepName(args.step);
    const role = readStepRole(args.step);
    const exec = readExec(args.step);
    const taskId = readString(exec.task_id);
    if (!taskId) {
      return this.failResumedStepWithoutTask({ ...args, stepName, role });
    }
    const resumedTaskId = taskId;

    let handle: SessionHandle | null = null;
    try {
      handle = await this.deps.defaultProvider.start({
        role,
        label: `resume/${args.moleculeId}/${stepName}`,
        extra: {
          moleculeId: args.moleculeId,
          stepName,
          resumeTaskId: resumedTaskId,
          memfsEnabled: false,
        },
      });
      this.deps.emit('dispatcher/step.reattached', args.moleculeId, resumedTaskId, {
        stepName,
        role,
        stepId: args.step.id,
        sessionId: handle.id,
      });
      const { output, eventCount } = await this.observeResumedStep({ ...args, stepName, role, taskId: resumedTaskId, handle });
      // vibesync-zvcm: a resumed step that reports itself blocked fails like a
      // fresh one; the catch below closes it failed and aborts the molecule.
      const blocker = parseBlockedOutcome(output);
      if (blocker !== null) throw new StepBlockedError(blocker);
      args.outputs[stepName] = output;
      await this.deps.walker.finishStep(args.step.id, { output, eventCount, resumed: true });
      this.deps.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
        stepName,
        role,
        stepId: args.step.id,
        outputLength: output.length,
        resumed: true,
      });
    } catch (error) {
      await this.reportResumedStepFailure({ step: args.step, moleculeId: args.moleculeId, stepName, role, error });
    } finally {
      if (handle) await this.deps.defaultProvider.stop(handle);
    }
  }

  private async reportResumedStepFailure(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepName: string;
    readonly role: string;
    readonly error: unknown;
  }): Promise<never> {
    const retryOutcome = args.error instanceof StepBlockedError ? 'not_retryable' : undefined;
    await this.deps.walker.failStep(args.step.id, stringifyError(args.error), retryOutcome);
    this.deps.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
      stepName: args.stepName,
      role: args.role,
      stepId: args.step.id,
      error: stringifyError(args.error),
      resumed: true,
      ...(retryOutcome ? { retryOutcome } : {}),
    });
    if (args.error instanceof StepBlockedError) {
      throw new FormulaEscalationError(`FormulaDispatcher: resumed step "${args.stepName}" escalated: ${args.error.reason}`, args.moleculeId, { cause: args.error });
    }
    throw new FormulaDispatchError(`FormulaDispatcher: resumed step "${args.stepName}" failed`, args.moleculeId, { cause: args.error });
  }

  private async failResumedStepWithoutTask(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepName: string;
    readonly role: string;
  }): Promise<never> {
    const error = `FormulaDispatcher.resume: running step ${args.step.id} has no metadata.exec.task_id`;
    await this.deps.walker.failStep(args.step.id, error);
    this.deps.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
      stepName: args.stepName, role: args.role, stepId: args.step.id, error,
    });
    throw new FormulaDispatchError(error, args.moleculeId);
  }

  private async observeResumedStep(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepName: string;
    readonly role: string;
    readonly taskId: string;
    readonly handle: SessionHandle;
  }): Promise<{ readonly output: string; readonly eventCount: number }> {
    let output = '';
    let eventCount = 0;
    for await (const event of this.deps.defaultProvider.observe(args.handle)) {
      eventCount++;
      this.deps.emitRuntimeSessionEvent(event, {
        moleculeId: args.moleculeId,
        stepId: args.step.id,
        stepName: args.stepName,
        role: args.role,
        providerKind: args.handle.providerKind,
        sessionId: args.handle.id,
        taskId: args.taskId,
        resumed: true,
      });
      if (event.kind === 'message-delta') output += event.text;
      if (event.kind === 'error') throw new Error(event.message);
      if (event.kind === 'stopped') throw new Error('runtime stopped before turn completion');
      if (event.kind === 'turn-done') break;
    }
    return { output, eventCount };
  }
}

function outputsFromClosedSteps(steps: readonly BeadRow[]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const step of steps) {
    if (step.status !== 'closed') continue;
    const stepName = readStepName(step);
    const payload = readExec(step).output_payload;
    if (hasOutputPayload(payload)) {
      outputs[stepName] = payload.output;
    } else if (isSoftFailedStep(step)) {
      outputs[stepName] = softFailMarker(stepName, readString(readExec(step).error_trace) ?? 'soft_fail');
    }
  }
  return outputs;
}

function hasOutputPayload(payload: unknown): payload is { readonly output: string } {
  return payload !== null && typeof payload === 'object' && 'output' in payload && typeof payload.output === 'string';
}

function isSoftFailedStep(step: BeadRow): boolean {
  return step.metadata['gc.retry_outcome'] === 'soft_failed';
}

/**
 * vibesync-u32z: recover the motivating bead id from a molecule_root row's
 * exec metadata. Used by resume() (where the original DispatchInput is not in
 * scope) so the completion event can still carry the motivating bead.
 */
function readMotivatingBead(row: BeadRow): string | null {
  return readString(readExec(row)['motivating_bead']);
}
