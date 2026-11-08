import type { MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { RuntimeProvider } from '../runtime/index.js';
import type { DeliveryVerifier } from './delivery.js';
import { FormulaCancellationConflictError, FormulaDispatchError, type CancelResult, type MoleculeRun } from './types.js';
import { readExec, readStepName, readStepRole, readString, stringifyError } from './util.js';

export interface MoleculeSettlerDeps {
  readonly walker: MoleculeWalker;
  readonly live: Map<string, MoleculeRun>;
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly defaultProvider: RuntimeProvider;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
}

export class MoleculeSettler {
  constructor(private readonly deps: MoleculeSettlerDeps) {}

  /**
   * Finalize a molecule once none of its steps is running: failed if any step
   * failed (siblings in flight finish first), completed once every step bead is
   * closed. Otherwise the next ready steps are the StepDispatcher's to offer.
   */
  async settleMolecule(run: MoleculeRun): Promise<void> {
    if (run.finalized || run.running > 0) return;
    try {
      await this.settleMoleculeOutcome(run);
    } catch (error) {
      this.rejectSettlementError(run, error);
    }
  }

  private async settleMoleculeOutcome(run: MoleculeRun): Promise<void> {
    if (await this.settleKnownMoleculeOutcome(run)) return;
    if (!(await this.deps.walker.isComplete(run.moleculeId)) || run.finalized) return;
    // vibesync-9lzk.21: every step finished, but a formula that declares a
    // delivery only completes once that artifact verifiably exists.
    const undelivered = await this.checkDelivery(run);
    if (undelivered !== null) {
      if (run.finalized) return;
      run.failed = true;
      run.failure = new FormulaDispatchError(`FormulaDispatcher: ${undelivered}`, run.moleculeId);
      await this.settleMolecule(run);
      return;
    }
    await this.completeMolecule(run);
  }

  private rejectSettlementError(run: MoleculeRun, error: unknown): void {
    // Persisting the outcome failed: settle the caller's promise anyway so a
    // run (and the pool slot / molecule slot behind it) is never stuck.
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    run.reject(error);
  }

  private async settleKnownMoleculeOutcome(run: MoleculeRun): Promise<boolean> {
    if (run.cancelled) {
      this.rejectCancelledMolecule(run);
      return true;
    }
    if (!run.failed) return false;
    await this.rejectFailedMolecule(run);
    return true;
  }

  private rejectCancelledMolecule(run: MoleculeRun): void {
    // cancel() already closed the root as 'cancelled' and emitted
    // formula.cancelled. The step it stopped may well have thrown on the way
    // down; that must not turn the cancelled root into a 'failed' one.
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    run.reject(new FormulaDispatchError(`FormulaDispatcher: molecule ${run.moleculeId} was cancelled`, run.moleculeId));
  }

  private async rejectFailedMolecule(run: MoleculeRun): Promise<void> {
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    await this.deps.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'failed');
    this.deps.emit('dispatcher/formula.failed', run.moleculeId, undefined, {
      moleculeId: run.moleculeId,
      error: stringifyError(run.failure),
      // vibesync-u32z: carry the motivating bead on the completion event so
      // the writeback hook can resolve it directly from the event, without
      // depending solely on re-reading the persisted molecule_root row (a
      // single point of failure if any dispatch path or Dolt write dropped
      // the exec.motivating_bead stamp).
      ...(run.input.motivatingBeadId ? { motivating_bead: run.input.motivatingBeadId } : {}),
    });
    run.reject(run.failure);
  }

  private async completeMolecule(run: MoleculeRun): Promise<void> {
    if (run.finalized) return;
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    await this.deps.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'completed');
    this.deps.emit('dispatcher/formula.completed', run.moleculeId, undefined, {
      moleculeId: run.moleculeId,
      durationMs: Date.now() - run.startedAt,
      // vibesync-u32z: see the failure branch above — the completion event is
      // now self-describing so the writeback hook never has to reverse-engineer
      // the motivating bead from a row that may not carry it.
      ...(run.input.motivatingBeadId ? { motivating_bead: run.input.motivatingBeadId } : {}),
    });
    run.resolve({ moleculeId: run.moleculeId, outputs: run.outputs });
  }

  /**
   * Null when the formula declares no delivery or the verifier confirms it;
   * otherwise the reason the run must fail. Verifier errors fail closed.
   */
  private async checkDelivery(run: MoleculeRun): Promise<string | null> {
    const kind = run.input.formula.delivers;
    if (kind === undefined) return null;
    if (!this.deps.deliveryVerifier) return `formula "${run.input.formula.name}" declares delivers = "${kind}" but no delivery verifier is configured`;
    try {
      const verdict = await this.deps.deliveryVerifier.verify({
        kind, outputs: run.outputs, moleculeId: run.moleculeId, startedAt: new Date(run.startedAt),
        ...(run.input.motivatingBeadId ? { motivatingBeadId: run.input.motivatingBeadId } : {}),
      });
      // `in` narrowing works under the test tree's non-strict config too.
      if ('reason' in verdict) return `declared delivery not met: ${verdict.reason}`;
      this.deps.emit('dispatcher/formula.delivered', run.moleculeId, undefined, { moleculeId: run.moleculeId, kind, artifact: verdict.artifact });
      return null;
    } catch (err) {
      return `declared delivery could not be verified: ${stringifyError(err)}`;
    }
  }

  async cancel(moleculeId: string): Promise<CancelResult> {
    const view = await this.deps.walker.load(moleculeId);
    if (!view) throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    const running = await this.deps.walker.findRunning(moleculeId);
    if (running.length === 0) throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to cancel`, moleculeId);

    // Closing the running steps below unblocks their dependents in the bead
    // graph; mark the run so none of them is started.
    const liveRun = this.deps.live.get(moleculeId);
    if (liveRun) liveRun.cancelled = true;
    const cancelledStepCount = await this.cancelRunningSteps(moleculeId, running);
    await this.deps.walker.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled');
    this.deps.emit('dispatcher/formula.cancelled', moleculeId, undefined, {
      moleculeId,
      cancelledStepCount,
    });
    // Release the run() caller now if no step of this process is still unwinding.
    if (liveRun) await this.settleMolecule(liveRun);
    return { moleculeId, cancelledStepCount };
  }

  private async cancelRunningSteps(moleculeId: string, running: readonly BeadRow[]): Promise<number> {
    let cancelledStepCount = 0;
    for (const step of running) {
      const stepName = readStepName(step);
      const role = readStepRole(step);
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      const providerKind = readString(exec.provider_kind);
      const taskId = readString(exec.task_id) ?? undefined;
      if (sessionId && providerKind) {
        await this.deps.defaultProvider.stop({ id: sessionId, providerKind });
      }
      await this.deps.walker.failStep(step.id, 'cancelled');
      cancelledStepCount++;
      this.deps.emit('dispatcher/step.cancelled', moleculeId, taskId, {
        stepName,
        role,
        stepId: step.id,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return cancelledStepCount;
  }
}
