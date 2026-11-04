/**
 * Contract between whoever offers ready molecule steps (the scheduler's
 * StepDispatcher) and whoever runs them (the FormulaDispatcher). Lives in the
 * molecule model so neither side imports the other.
 */
import type { BeadRow } from '../store/index.js';

/** One runnable step: the bead graph says all its blockers are closed. */
export interface ReadyStep {
  readonly moleculeId: string;
  readonly step: BeadRow;
}

/** `skipped` = the runner declined (unknown molecule, failed/cancelled molecule, step already running, parallel cap). */
export type StepRunOutcome = 'finished' | 'failed' | 'skipped';

export interface ReadyStepRunner {
  /** Runs one step to its end. Resolves (never rejects) once the step has settled. */
  runReadyStep(ready: ReadyStep): Promise<StepRunOutcome>;
}
