import type { BeadRow } from '../store/index.js';

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readStepName(row: BeadRow): string {
  const exec = readExec(row);
  if (!('step' in exec) || typeof exec.step !== 'string') {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing metadata.exec.step`);
  }
  return exec.step;
}

export function readStepRole(row: BeadRow): string {
  const match = /] (.+)$/.exec(row.title);
  if (!match?.[1]) {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing role in title`);
  }
  return match[1];
}

/**
 * The record cancel() leaves on a step it stopped (`exec.error_trace`). The
 * step turn reads it to discard a result that arrives after the cancel.
 */
export const STEP_CANCELLED_TRACE = 'cancelled';

/**
 * How long cancel() waits for the turns it stopped to return and record their
 * own steps. Past this, cancel() records what is left itself and closes the
 * root: a stop that hangs must not hold the cancel (or the scheduler slot
 * behind it) open. A turn that returns later still writes nothing but
 * `cancelled`.
 */
export const DEFAULT_CANCEL_UNWIND_MS = 5_000;

export function readExec(row: BeadRow): Record<string, unknown> {
  const exec = row.metadata.exec;
  return exec && typeof exec === 'object' ? exec as Record<string, unknown> : {};
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readProjectIdentifier(row: BeadRow): string | undefined {
  return readString(row.metadata['projectIdentifier']) ?? readString(readExec(row)['projectIdentifier']) ?? undefined;
}

/** What a dependent's prompt sees in place of the output of a step that soft-failed. */
export function softFailMarker(stepName: string, errorTrace: string): string {
  return `[step "${stepName}" soft-failed and produced no output: ${errorTrace}]`;
}
