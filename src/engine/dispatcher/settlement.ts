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
  /**
   * Molecules a cancel() is working on right now, live run or not (after a restart there is none). Claimed
   * synchronously, before cancel()'s first await, and released when it returns (review on PR #188, round 2).
   */
  private readonly cancelling = new Set<string>();
  /**
   * Molecules whose final outcome (completed or failed) is being written. The run has already left `live`, so a
   * cancel() in that window would take the restart path and could close the root over the outcome run() was told
   * (second outside review of PR #188). cancel() refuses while a molecule is here.
   */
  private readonly finalizing = new Set<string>();

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
    // A cancel accepted during that read wins, before the delivery check: it can call a verifier (and wait on CI) and
    // emit formula.delivered, neither of which a cancelled run should do (third outside review of PR #188). The cancel
    // is still in progress; its own release settles the run as cancelled.
    if (run.cancelled) return;
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
    // Asked again after the delivery check, which awaits: a cancel accepted meanwhile must win (second outside review of
    // PR #188). It is still in progress, and its own release settles the run as cancelled.
    if (run.cancelled) return;
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
      // cancel() may have failed part-way, before the root was closed. The outcome stays `cancelled` (the run was
      // cancelled: un-cancelling it would hand its steps back to turns that have already given them up), and
      // closing the root is retried here, as the last writer. If it fails again, rejectSettlementError gives up
      // the live run and boot recovery finishes the root.
      // cancelledStepCount 0: cancel() failed before it could count what it recorded; the root close swept the rest.
      if (!run.rootClosed) {
        await this.closeCancelledRoot(run.moleculeId, 0);
        run.rootClosed = true;
      }
      this.rejectCancelledMolecule(run);
      return true;
    }
    if (run.claimedElsewhere) {
      this.rejectClaimedElsewhere(run);
      return true;
    }
    if (run.closedUnder) {
      await this.settleClosedUnder(run);
      return true;
    }
    if (!run.failed) return false;
    await this.rejectFailedMolecule(run);
    return true;
  }

  /**
   * A step of this run is held by another dispatcher, which owns that work and will settle the root. This run stops:
   * it writes and announces nothing, and tells run() why (CodeRabbit on PR #188).
   */
  private rejectClaimedElsewhere(run: MoleculeRun): void {
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    // Visible, so a run left with no owner (the other dispatcher claimed the step and then died) can be traced: losing
    // the claim does not prove the other dispatcher is alive (outside review of PR #188). Boot recovery or a cancel
    // closes such a run.
    this.deps.emit('dispatcher/run.claimed_elsewhere', run.moleculeId, undefined, { moleculeId: run.moleculeId });
    run.reject(new FormulaDispatchError(`FormulaDispatcher: a step of molecule ${run.moleculeId} is held by another writer (its start was refused); this run stopped without writing`, run.moleculeId));
  }

  /**
   * A step was closed under this run by someone else (another dispatcher's cancel). Its steps may all be closed, but
   * not because they ran, so the run must never complete (fourth outside review of PR #188). The other closer is
   * normally mid-way through closing the root: wait for it briefly, then report the outcome it recorded. If it never
   * closes the root, the run fails, through the conditional close.
   */
  private async settleClosedUnder(run: MoleculeRun): Promise<void> {
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    const deadline = Date.now() + (this.deps.cancelUnwindMs ?? DEFAULT_CANCEL_UNWIND_MS);
    for (;;) {
      const root = await this.deps.walker.readStep(run.moleculeId);
      if (root?.status === 'closed') { await this.rejectClosedElsewhere(run); return; }
      if (Date.now() >= deadline) break;
      await sleep(CANCEL_UNWIND_POLL_MS);
    }
    run.failure = new FormulaDispatchError(`FormulaDispatcher: a step of molecule ${run.moleculeId} was closed by another writer, which did not close the root`, run.moleculeId);
    this.finalizing.add(run.moleculeId);
    let closedHere: boolean;
    try {
      closedHere = await this.deps.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'failed');
    } finally {
      this.finalizing.delete(run.moleculeId);
    }
    if (!closedHere) { await this.rejectClosedElsewhere(run); return; }
    this.deps.emit('dispatcher/formula.failed', run.moleculeId, undefined, { moleculeId: run.moleculeId, error: stringifyError(run.failure) });
    run.reject(run.failure);
  }

  private rejectCancelledMolecule(run: MoleculeRun): void {
    // The root has been closed as 'cancelled' and formula.cancelled emitted (closeCancelledRoot, by cancel() or above)
    // (settleMolecule does not get here while cancelInProgress). The step it
    // stopped may well have thrown on the way down; that must not turn the
    // cancelled root into a 'failed' one.
    run.finalized = true;
    this.deps.live.delete(run.moleculeId);
    run.reject(new FormulaDispatchError(`FormulaDispatcher: molecule ${run.moleculeId} was cancelled`, run.moleculeId));
  }

  private async rejectFailedMolecule(run: MoleculeRun): Promise<void> {
    run.finalized = true;
    this.finalizing.add(run.moleculeId);
    this.deps.live.delete(run.moleculeId);
    let closedHere: boolean;
    try {
      closedHere = await this.deps.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'failed');
    } finally {
      this.finalizing.delete(run.moleculeId);
    }
    if (!closedHere) { await this.rejectClosedElsewhere(run); return; }
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
    this.finalizing.add(run.moleculeId);
    this.deps.live.delete(run.moleculeId);
    let closedHere: boolean;
    try {
      closedHere = await this.deps.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'completed');
    } finally {
      this.finalizing.delete(run.moleculeId);
    }
    if (!closedHere) { await this.rejectClosedElsewhere(run); return; }
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
    try {
      return liveRun ? await this.cancelLiveRun(liveRun) : await this.cancelWithoutLiveRun(moleculeId);
    } finally {
      this.cancelling.delete(moleculeId);
    }
  }

  /**
   * A run of this process. Its `cancelled` flag was set in claimCancel and is NEVER cleared: a turn that saw it
   * has given its step up to cancel(), and that promise cannot be taken back (outside review of PR #188). So a
   * live run is never refused for having nothing in_progress (a cancel between two steps is still a cancel), and
   * a cancel that fails part-way stays a cancel: settlement closes the root as `cancelled`, retryably.
   */
  private async cancelLiveRun(run: MoleculeRun): Promise<CancelResult> {
    const moleculeId = run.moleculeId;
    try {
      await this.markCancelRequested(moleculeId);
      const running = await this.deps.walker.findRunning(moleculeId);
      // The stops are asked for, not waited on: a stop that never settles must not hold the run open (outside review
      // of PR #188). The bounded wait for the turns below is what decides when cancel() moves on.
      this.requestStops(running, run.provider);
      run.cancelController.abort();
      await this.waitForTurnsToReturn(run);
      // Read fresh after the wait: a step admitted just before the flag can land as in_progress after the first read.
      const cancelledStepCount = await this.recordStepsStillRunning(moleculeId, await this.deps.walker.findRunning(moleculeId));
      await this.closeCancelledRoot(moleculeId, cancelledStepCount);
      run.rootClosed = true;
      return { moleculeId, cancelledStepCount };
    } finally {
      run.cancelController.abort();
      // Also when cancel() failed part-way: the run settles as cancelled, and closes its root if cancel() did not.
      await this.releaseAfterCancel(run);
    }
  }

  /**
   * No run of this process (after a restart). Here "nothing in_progress" does mean there is nothing to stop; the
   * root is closed all the same if it is still open, so a cancel whose root write failed can be retried.
   */
  private async cancelWithoutLiveRun(moleculeId: string): Promise<CancelResult> {
    await this.markCancelRequested(moleculeId);
    const view = await this.deps.walker.load(moleculeId);
    if (!view) throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    const running = await this.deps.walker.findRunning(moleculeId);
    if (running.length === 0 && view.root.status === 'closed') {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to cancel`, moleculeId);
    }
    const provider = await this.resolveCancelProvider(undefined, view.root, running);
    // Asked for, not waited on, as on the live-run path: a stop that never settles must not hold cancel() open.
    this.requestStops(running, provider);
    const cancelledStepCount = await this.recordStepsStillRunning(moleculeId, await this.deps.walker.findRunning(moleculeId));
    await this.closeCancelledRoot(moleculeId, cancelledStepCount);
    return { moleculeId, cancelledStepCount };
  }

  private async markCancelRequested(moleculeId: string): Promise<void> {
    try {
      await this.deps.walker.markMoleculeRootCancelRequested(moleculeId);
    } catch (error) {
      this.deps.emit('dispatcher/formula.cancel_marker_failed', moleculeId, undefined, {
        moleculeId,
        error: stringifyError(error),
      });
    }
  }

  /**
   * Close the root as cancelled and announce it with formula.cancelled. The ONLY place either happens, so the event
   * cannot go missing on one path (it did when settlement closed the root after a part-way failure; second outside
   * review of PR #188). The writer also closes every step that is not closed yet (open or in_progress).
   */
  private async closeCancelledRoot(moleculeId: string, cancelledStepCount: number): Promise<void> {
    // A root someone else already closed keeps its outcome, and this cancel announces nothing for it.
    if (!(await this.deps.walker.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled'))) return;
    this.deps.emit('dispatcher/formula.cancelled', moleculeId, undefined, { moleculeId, cancelledStepCount });
  }

  /**
   * The root was already closed by another closer (a second dispatcher, the restart path) when this run went to close
   * it: its outcome stands. Tell run() that outcome, as an error naming it, and write and announce nothing (third
   * outside review of PR #188: the two closers used to overwrite each other's outcome).
   */
  private async rejectClosedElsewhere(run: MoleculeRun): Promise<void> {
    const root = await this.deps.walker.readStep(run.moleculeId).catch(() => null);
    const outcome = readString(readExec(root ?? ({ metadata: {} } as BeadRow)).outcome) ?? 'unknown';
    run.reject(new FormulaDispatchError(`FormulaDispatcher: molecule ${run.moleculeId} was already closed elsewhere (outcome: ${outcome})`, run.moleculeId));
  }

  /**
   * Claim the molecule for this cancel(), synchronously; refuse if another cancel() holds it, or if its live run
   * was already cancelled. For a live run, set `cancelled` now and for good.
   */
  private claimCancel(moleculeId: string): MoleculeRun | undefined {
    const liveRun = this.deps.live.get(moleculeId);
    if (this.finalizing.has(moleculeId)) {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} is already finishing`, moleculeId);
    }
    if (this.cancelling.has(moleculeId) || liveRun?.cancelInProgress) {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} is already being cancelled`, moleculeId);
    }
    if (liveRun?.cancelled) {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} was already cancelled`, moleculeId);
    }
    this.cancelling.add(moleculeId);
    if (!liveRun) return undefined;
    liveRun.cancelInProgress = true;
    liveRun.cancelled = true;
    return liveRun;
  }

  /** cancel() is over: the run may settle. Tells the run() caller unless a turn outlived the wait; that turn's return will. */
  private async releaseAfterCancel(run: MoleculeRun): Promise<void> {
    run.cancelInProgress = false;
    await this.settleMolecule(run);
  }

  /** Ask each running step's session to stop, without waiting; a failure or a stop that never returns is logged. */
  private requestStops(running: readonly BeadRow[], provider: RuntimeProvider): void {
    for (const step of running) {
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      const providerKind = readString(exec.provider_kind);
      if (!sessionId || !providerKind) continue;
      provider.stop({ id: sessionId, providerKind }).catch((error: unknown) => {
        this.deps.emit('dispatcher/cancel.stop_failed', readString(readExec(step).molecule) ?? undefined, undefined, {
          stepId: step.id,
          sessionId,
          error: stringifyError(error),
        });
      });
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
