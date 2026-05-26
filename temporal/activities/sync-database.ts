import path from 'path';
import { createSyncDatabase } from '../../src/database.js';
import { computeIssueContentHash } from '../../src/database/utils.js';

type NullableNumber = number | null | undefined;

export interface PersistIssueStateInput {
  identifier: string;
  projectIdentifier: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  hulyId?: string;
  vibeTaskId?: string;
  hulyModifiedAt?: NullableNumber;
  vibeModifiedAt?: NullableNumber;
  vibeStatus?: string;
  parentHulyId?: string | null;
  parentVibeId?: string | null;
  subIssueCount?: number;
}

export interface PersistIssueStateBatchInput {
  issues: PersistIssueStateInput[];
}

export interface PersistIssueStateResult {
  success: boolean;
  updated: number;
  failed: number;
  errors: Array<{ identifier: string; error: string }>;
}

function resolveDbPath(): string {
  return process.env.DB_PATH || path.join(process.cwd(), 'logs', 'sync-state.db');
}

let dbInstance: any = null;
let isDbClosed = false;

export async function getDb(): Promise<any> {
  if (dbInstance && !isDbClosed) {
    return dbInstance;
  }
  dbInstance = createSyncDatabase(resolveDbPath());
  isDbClosed = false;
  return dbInstance;
}

async function closeDb(): Promise<void> {
  if (!dbInstance || isDbClosed) {
    return;
  }

  try {
    dbInstance.close();
  } catch {
  } finally {
    isDbClosed = true;
    dbInstance = null;
  }
}

/** Reset DB singleton — for testing only */
export async function resetDb(): Promise<void> {
  await closeDb();
}

process.on('exit', () => {
  if (dbInstance && !isDbClosed) {
    try {
      dbInstance.close();
    } catch {
    } finally {
      isDbClosed = true;
      dbInstance = null;
    }
  }
});

process.on('SIGTERM', () => {
  void closeDb().finally(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  void closeDb().finally(() => {
    process.exit(0);
  });
});

function normalizeModifiedAt(value: NullableNumber): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Number(value);
}

function defaultHulyId(identifier: string): string | null {
  return /^[A-Z]+-\d+$/i.test(identifier) ? identifier : null;
}

export interface IssueSyncTimestamps {
  huly_modified_at: number | null;
  vibe_modified_at: number | null;
}

export async function getIssueSyncTimestamps(input: {
  identifier: string;
}): Promise<IssueSyncTimestamps | null> {
  const db = await getDb();
  const issue = db.getIssue(input.identifier);
  if (!issue) return null;

  return {
    huly_modified_at: normalizeModifiedAt(issue.huly_modified_at),
    vibe_modified_at: normalizeModifiedAt(issue.vibe_modified_at),
  };
}

export async function hasIssueContentChanged(input: {
  hulyIdentifier: string;
  title: string;
  description?: string;
  status: string;
}): Promise<boolean> {
  try {
    const db = await getDb();
    const existing = db.getIssue(input.hulyIdentifier);
    if (!existing) return true;

    const storedHash = existing.content_hash;
    if (!storedHash) return true;

    const newHash = computeIssueContentHash({
      title: input.title,
      description: input.description || '',
      status: input.status,
      priority: '',
    });

    return newHash !== storedHash;
  } catch {
    return true;
  }
}

export async function getIssueSyncState(input: {
  hulyIdentifier: string;
}): Promise<{ status?: string } | null> {
  const db = await getDb();
  const issue = db.getIssue(input.hulyIdentifier);
  if (!issue) return null;
  return { status: issue.status };
}

export async function getIssueSyncStateBatch(input: {
  hulyIdentifiers: string[];
}): Promise<Record<string, { status?: string }>> {
  const db = await getDb();
  const result: Record<string, { status?: string }> = {};
  for (const id of input.hulyIdentifiers) {
    const issue = db.getIssue(id);
    if (issue) {
      result[id] = { status: issue.status };
    }
  }
  return result;
}

export async function persistIssueSyncState(
  input: PersistIssueStateInput
): Promise<PersistIssueStateResult> {
  return persistIssueSyncStateBatch({ issues: [input] });
}

export async function persistIssueSyncStateBatch(
  input: PersistIssueStateBatchInput
): Promise<PersistIssueStateResult> {
  const issues = input.issues || [];
  if (issues.length === 0) {
    return { success: true, updated: 0, failed: 0, errors: [] };
  }

  const db = await getDb();

  let updated = 0;
  let failed = 0;
  const errors: Array<{ identifier: string; error: string }> = [];

  for (const issue of issues) {
    try {
      if (!issue.identifier || !issue.projectIdentifier) {
        throw new Error('identifier and projectIdentifier are required');
      }

      const existing = db.getIssue(issue.identifier);

      db.upsertIssue({
        identifier: issue.identifier,
        project_identifier: issue.projectIdentifier,
        huly_id: issue.hulyId || existing?.huly_id || defaultHulyId(issue.identifier),
        vibe_task_id: issue.vibeTaskId || existing?.vibe_task_id || null,
        title: issue.title || existing?.title || issue.identifier,
        description: issue.description ?? existing?.description ?? '',
        status: issue.status || existing?.status || 'unknown',
        priority: issue.priority || existing?.priority || 'medium',
        huly_modified_at:
          normalizeModifiedAt(issue.hulyModifiedAt) ??
          normalizeModifiedAt(existing?.huly_modified_at),
        vibe_modified_at:
          normalizeModifiedAt(issue.vibeModifiedAt) ??
          normalizeModifiedAt(existing?.vibe_modified_at),
        vibe_status: issue.vibeStatus || existing?.vibe_status || null,
        parent_huly_id: issue.parentHulyId ?? existing?.parent_huly_id ?? null,
        parent_vibe_id: issue.parentVibeId ?? existing?.parent_vibe_id ?? null,
        sub_issue_count: issue.subIssueCount ?? existing?.sub_issue_count ?? 0,
      });

      updated++;
    } catch (error) {
      failed++;
      errors.push({
        identifier: issue.identifier || 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    success: failed === 0,
    updated,
    failed,
    errors,
  };
}
