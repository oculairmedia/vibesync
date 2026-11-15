import type { MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { RuntimeProvider } from '../runtime/index.js';
import type { ProjectBindingResolver } from './project-binding-types.js';
import { FormulaCancellationConflictError, FormulaDispatchError, type CancelResult, type MoleculeRun, type ProviderResolver } from './types.js';
import { DEFAULT_CANCEL_UNWIND_MS, readExec, readProjectIdentifier, readStepName, readStepRole, readString, sleep, stringifyError, STEP_CANCELLED_TRACE } from './util.js';

export interface MoleculeSettlerDeps {
  readonly walker: MoleculeWalker;
  readonly live: Map<string, MoleculeRun>;
  readonly projectBindings: ProjectBindingResolver;
  readonly defaultProvider: RuntimeProvider;
  readonly providerResolver: ProviderResolver | null;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  /** How long cancel() waits for the turns it stopped to return (default DEFAULT_CANCEL_UNWIND_MS). */
  readonly cancelUnwindMs?: number;
}

/**
 * A run settles (its run() caller is told) only when it has not settled already,
 * none of its turns is in flight, and no cancel() is part-way through it.
 */
function canSettle(run: MoleculeRun): boolean {
  if (run.finalized) return false;
  if (run.running > 0) return false;
  return !run.cancelInProgress;
}

/** How often cancel() looks for the stopped turns to have returned. */
const CANCEL_UNWIND_POLL_MS = 20;

export class MoleculeSettler {
  constructor(private readonly deps: MoleculeSettlerDeps) {}

  /**
   * Finalize a molecule once none of its steps is running: failed if any step
   * failed (siblings in flight finish first), completed once every step bead is
   * closed. Otherwise the next ready steps are the StepDispatcher's to offer.
   */
  async settleMolecule(run: MoleculeRun): Promise<void> {
    if (!canSettle(run)) return;
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
    // cancel() has closed the root as 'cancelled' and emitted formula.cancelled
    // (settleMolecule does not get here while cancelInProgress). The step it
    // stopped may well have thrown on the way down; that must not turn the
    // cancelled root into a 'failed' one.
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
    try {
      const verifier = this.deps.projectBindings(run.input.projectIdentifier).deliveryVerifier;
      if (!verifier) return `formula "${run.input.formula.name}" declares delivers = "${kind}" but no delivery verifier is configured`;
      const verdict = await verifier.verify({
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

  /**
   * Cancel a run. One writer per step (specs/MoleculeLifecycle.tla, CancelMode =
   * "single_writer"; vibesync-6zos.3):
   *  1. the run is marked cancelled: no step starts, and a turn that returns
   *     from now on writes nothing (StepTurnRunner.runStep);
   *  2. the running steps' sessions are stopped, which is what makes those
   *     turns return;
   *  3. cancel() waits, bounded, for the turns of THIS process to return;
   *  4. it records as cancelled every one of those steps that is still
   *     in_progress, read fresh;
   *  5. the root is closed, and only then is the run() caller told.
   * cancel() used to record the steps and close the root at once, while the
   * turns it had just stopped were still returning; such a turn then wrote its
   * result over the `cancelled` record, or reopened the step under the closed
   * root.
   */
  async cancel(moleculeId: string): Promise<CancelResult> {
    // Claimed before the first await, so a second cancel() in the same tick is refused (review on PR #188).
    const liveRun = this.claimCancel(moleculeId);
    let root: BeadRow;
    let running: readonly BeadRow[];
    try {
      // The flag is set BEFORE the running steps are read: a step admitted after this point sees the run as
      // cancelled and does not start; one admitted before it is in_progress by the time it is read.
      ({ root, running } = await this.requireCancellable(moleculeId));
    } catch (error) {
      if (liveRun) this.unclaimCancel(liveRun);
      throw error;
    }
    let closed = false;
    try {
      const provider = await this.resolveCancelProvider(liveRun, root, running);
      await this.stopRunningSessions(running, provider);
      if (liveRun) await this.waitForTurnsToReturn(liveRun);
      // Read fresh after the wait, not the list read at the start: a step admitted just before the flag was set
      // can land as in_progress after that first read; its turn wrote nothing (the run is cancelled), so cancel()
      // is the only writer left for it (review on PR #188).
      const cancelledStepCount = await this.recordStepsStillRunning(moleculeId, await this.deps.walker.findRunning(moleculeId));
      await this.deps.walker.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled');
      closed = true;
      this.deps.emit('dispatcher/formula.cancelled', moleculeId, undefined, {
        moleculeId,
        cancelledStepCount,
      });
      return { moleculeId, cancelledStepCount };
    } catch (error) {
      // cancel() failed part-way (a stop, a tracker write): the run must not be discarded as if it had been
      // cancelled cleanly. It settles as FAILED, which closes the root with that outcome and tells run().
      if (liveRun && !closed) {
        liveRun.failed = true;
        liveRun.failure = error;
        liveRun.cancelled = false;
      }
      throw error;
    } finally {
      // Also when cancel() failed part-way: the run must not stay unsettled for ever.
      if (liveRun) await this.releaseAfterCancel(liveRun);
    }
  }

  /** Mark the live run as being cancelled, synchronously; refuse if a cancel already holds it. */
  private claimCancel(moleculeId: string): MoleculeRun | undefined {
    const liveRun = this.deps.live.get(moleculeId);
    if (!liveRun) return undefined;
    if (liveRun.cancelInProgress) throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} is already being cancelled`, moleculeId);
    liveRun.cancelInProgress = true;
    liveRun.cancelled = true;
    return liveRun;
  }

  /** cancel() refused after claiming (not found, nothing running): give the run back as it was. */
  private unclaimCancel(run: MoleculeRun): void {
    run.cancelInProgress = false;
    run.cancelled = false;
  }

  /** The molecule's root, its running steps and its live run; throws when there is nothing to cancel or a cancel is already under way. */
  private async requireCancellable(moleculeId: string): Promise<{ readonly root: BeadRow; readonly running: readonly BeadRow[] }> {
    const view = await this.deps.walker.load(moleculeId);
    if (!view) throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    const running = await this.deps.walker.findRunning(moleculeId);
    if (running.length === 0) throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to cancel`, moleculeId);
    return { root: view.root, running };
  }

  /** cancel() is over: the run may settle. Tells the run() caller unless a turn outlived the wait; that turn's return will. */
  private async releaseAfterCancel(run: MoleculeRun): Promise<void> {
    run.cancelInProgress = false;
    await this.settleMolecule(run);
  }

  private async stopRunningSessions(running: readonly BeadRow[], provider: RuntimeProvider): Promise<void> {
    for (const step of running) {
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      const providerKind = readString(exec.provider_kind);
      if (sessionId && providerKind) await provider.stop({ id: sessionId, providerKind });
    }
  }

  /**
   * Wait until NO turn of this run is in flight, or the bound runs out. Every
   * turn, not only those of the steps captured as running: a step its own role
   * closed is not in_progress, yet its turn may be about to rule on it (and
   * reopen it for a retry), and the root must not close under that.
   */
  private async waitForTurnsToReturn(run: MoleculeRun): Promise<void> {
    const waitMs = this.deps.cancelUnwindMs ?? DEFAULT_CANCEL_UNWIND_MS;
    const deadline = Date.now() + waitMs;
    while (run.inFlight.size > 0 && Date.now() < deadline) await sleep(CANCEL_UNWIND_POLL_MS);
    if (run.inFlight.size === 0) return;
    this.deps.emit('dispatcher/cancel.unwind_timeout', run.moleculeId, undefined, {
      moleculeId: run.moleculeId,
      stepIds: [...run.inFlight],
      waitedMs: waitMs,
    });
  }

  /**
   * Record as cancelled each of these steps that is STILL in_progress, and say
   * how many. Read fresh: a step whose result was written just before the run
   * was marked cancelled, or that its own role closed, keeps that record.
   */
  private async recordStepsStillRunning(moleculeId: string, running: readonly BeadRow[]): Promise<number> {
    let recorded = 0;
    for (const captured of running) {
      const step = await this.deps.walker.readStep(captured.id);
      if (step?.status !== 'in_progress') continue;
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      await this.deps.walker.failStep(step.id, STEP_CANCELLED_TRACE);
      recorded++;
      this.deps.emit('dispatcher/step.cancelled', moleculeId, readString(exec.task_id) ?? undefined, {
        stepName: readStepName(step),
        role: readStepRole(step),
        stepId: step.id,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return recorded;
  }

  private async resolveCancelProvider(liveRun: MoleculeRun | undefined, root: BeadRow, running: readonly BeadRow[]): Promise<RuntimeProvider> {
    if (liveRun?.provider) return liveRun.provider;
    const needsStop = running.some((s) => Boolean(readString(readExec(s).session_id) && readString(readExec(s).provider_kind)));
    return needsStop ? this.resolveProvider(root) : this.deps.defaultProvider;
  }

  private async resolveProvider(root: BeadRow): Promise<RuntimeProvider> {
    const projectIdentifier = readProjectIdentifier(root);
    if (!this.deps.providerResolver || !projectIdentifier) return this.deps.defaultProvider;
    return await this.deps.providerResolver.resolve({ projectIdentifier }) ?? this.deps.defaultProvider;
  }
}
