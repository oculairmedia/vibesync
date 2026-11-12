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
