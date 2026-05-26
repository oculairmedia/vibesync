import path from 'path';
import { ApplicationFailure } from '@temporalio/activity';
import { createSyncDatabase } from '../../src/database.js';

export type ReconciliationAction = 'mark_deleted' | 'hard_delete';

export interface ReconciliationInput {
  projectIdentifier?: string;
  action?: ReconciliationAction;
  dryRun?: boolean;
}

export interface ReconciliationResult {
  success: boolean;
  action: ReconciliationAction;
  dryRun: boolean;
  projectsProcessed: number;
  projectsChecked: number;
  staleIssues: Array<{ identifier: string; projectIdentifier: string; issueId: string }>;
  updated: { markedDeleted: number; deleted: number };
  errors: string[];
}

function resolveDbPath(): string {
  return process.env.DB_PATH || path.join(process.cwd(), 'logs', 'sync-state.db');
}

function handleReconciliationError(error: unknown, context: string): never {
  const message = error instanceof Error ? error.message : String(error);
  throw ApplicationFailure.retryable(
    `Reconciliation failed (${context}): ${message}`,
    'ReconcileError'
  );
}

export async function reconcileSyncData(
  input: ReconciliationInput = {}
): Promise<ReconciliationResult> {
  const action =
    input.action || (process.env.RECONCILIATION_ACTION as ReconciliationAction) || 'mark_deleted';
  const dryRun = input.dryRun ?? process.env.RECONCILIATION_DRY_RUN === 'true';

  const result: ReconciliationResult = {
    success: false,
    action,
    dryRun,
    projectsProcessed: 0,
    projectsChecked: 0,
    staleIssues: [],
    updated: { markedDeleted: 0, deleted: 0 },
    errors: [],
  };

  const dbPath = resolveDbPath();
  const db = createSyncDatabase(dbPath);

  try {
    const projects = input.projectIdentifier
      ? [db.getProject(input.projectIdentifier)].filter(Boolean)
      : db.getAllProjects();

    result.projectsProcessed = projects.length;

    console.log('[Reconcile] Legacy tracker reconciliation skipped; integration removed');

    console.log('[Reconcile] Summary', {
      projectsProcessed: result.projectsProcessed,
      projectsChecked: result.projectsChecked,
      staleIssues: result.staleIssues.length,
      action: result.action,
      dryRun: result.dryRun,
    });

    result.success = result.errors.length === 0;
    return result;
  } catch (error) {
    handleReconciliationError(error, 'reconcileSyncData');
  } finally {
    db.close();
  }
}
