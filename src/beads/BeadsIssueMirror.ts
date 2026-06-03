import { classifyBeadsFailure } from './error-classification.js';
import { logger as rootLogger } from '../logger.js';
import type { ProjectRow } from '../types/db.js';
import type { NormalizedBeadsIssue } from '../types/beads.js';
import type { BeadsAdapterApi, BeadsListFilters } from '../types/api.js';
import type { BeadsIssueInput } from '../database/repositories/IssueRepository.js';

type MirrorProject = Pick<ProjectRow, 'identifier' | 'name' | 'filesystem_path' | 'status'>;

interface MirrorDb {
  getAllProjects: () => MirrorProject[];
  getProject: (id: string) => MirrorProject | null;
  upsertBeadsIssue: (projectId: string, issue: BeadsIssueInput) => void;
  getMaxBeadsUpdatedAt: (projectId: string) => number | null;
  getBeadsMirrorSyncedAt: (projectId: string) => number | null;
  setBeadsMirrorSyncedAt: (projectId: string, ts: number, error?: string | null) => void;
}

type MirrorBeadsAdapter = Pick<BeadsAdapterApi, 'listIssues'>;

interface MirrorOptions {
  freshnessMs?: number;
  preloadConcurrency?: number;
  perCallTimeoutMs?: number;
}

interface SyncResult {
  changed: number;
  source: 'full' | 'incremental' | 'cached' | 'skipped';
  error: string | null;
  durationMs: number;
}

const log = rootLogger.child({ module: 'beads-mirror' });

interface FailureBackoff {
  consecutiveFailures: number;
  lastFailureAt: number;
  nextRetryAt: number;
}

export class BeadsIssueMirror {
  private db: MirrorDb;
  private adapter: MirrorBeadsAdapter;
  private freshnessMs: number;
  private inflight: Map<string, Promise<SyncResult>> = new Map();
  private failureBackoffs: Map<string, FailureBackoff> = new Map();

  constructor(deps: { db: MirrorDb; beadsAdapter: MirrorBeadsAdapter }, options: MirrorOptions = {}) {
    this.db = deps.db;
    this.adapter = deps.beadsAdapter;
    this.freshnessMs = options.freshnessMs ?? 30_000;
  }

  async ensureFresh(projectIdentifier: string, maxAgeMs?: number): Promise<SyncResult> {
    const project = this.db.getProject(projectIdentifier);
    if (!project || !project.filesystem_path) {
      return { changed: 0, source: 'skipped', error: 'project_missing_or_no_filesystem_path', durationMs: 0 };
    }
    
    // Check if project is in backoff
    if (this._isInBackoff(projectIdentifier)) {
      return { changed: 0, source: 'skipped', error: 'backoff', durationMs: 0 };
    }
    
    const ttl = maxAgeMs ?? this.freshnessMs;
    const syncedAt = this.db.getBeadsMirrorSyncedAt(projectIdentifier);
    const age = syncedAt ? Date.now() - syncedAt : Infinity;
    if (syncedAt && age < ttl) {
      return { changed: 0, source: 'cached', error: null, durationMs: 0 };
    }
    return this.syncProject(project);
  }

  async syncProject(project: MirrorProject): Promise<SyncResult> {
    const key = project.identifier;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const job = (async () => {
      const start = Date.now();
      const hasMirror = (this.db.getBeadsMirrorSyncedAt(project.identifier) ?? 0) > 0;
      try {
        if (!hasMirror) {
          const r = await this.fullSync(project);
          return { ...r, durationMs: Date.now() - start };
        }
        const since = this.db.getMaxBeadsUpdatedAt(project.identifier) || this.db.getBeadsMirrorSyncedAt(project.identifier);
        const r = await this.incrementalSync(project, since);
        return { ...r, durationMs: Date.now() - start };
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  private async fullSync(project: MirrorProject): Promise<SyncResult> {
    log.info({ project: project.identifier }, 'Full mirror sync starting');
    try {
      const items = await this._fetch(project, {});
      for (const issue of items) {
        this.db.upsertBeadsIssue(project.identifier, issue);
      }
      this.db.setBeadsMirrorSyncedAt(project.identifier, Date.now(), null);
      this._clearBackoff(project.identifier);
      log.info({ project: project.identifier, count: items.length }, 'Full mirror sync complete');
      return { changed: items.length, source: 'full', error: null, durationMs: 0 };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const reason = this._classifyError(msg);
      this._recordFailure(project.identifier);
      
      if (reason) {
        // Expected error - log concisely without stack trace
        log.warn({ project: project.identifier, reason }, 'Full mirror sync failed');
      } else {
        // Unexpected error - log with details
        log.error({ project: project.identifier, err }, 'Full mirror sync failed (unexpected)');
      }
      
      this.db.setBeadsMirrorSyncedAt(project.identifier, Date.now(), msg);
      return { changed: 0, source: 'full', error: msg, durationMs: 0 };
    }
  }

  private async incrementalSync(project: MirrorProject, since: number | null): Promise<SyncResult> {
    if (!since) return this.fullSync(project);
    const sinceIso = new Date(since).toISOString();
    log.debug({ project: project.identifier, since: sinceIso }, 'Incremental mirror sync starting');
    try {
      const items = await this._fetch(project, { updated_after: sinceIso });
      for (const issue of items) {
        this.db.upsertBeadsIssue(project.identifier, issue);
      }
      this.db.setBeadsMirrorSyncedAt(project.identifier, Date.now(), null);
      this._clearBackoff(project.identifier);
      if (items.length > 0) {
        log.info({ project: project.identifier, count: items.length, since: sinceIso }, 'Incremental mirror sync applied');
      }
      return { changed: items.length, source: 'incremental', error: null, durationMs: 0 };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const reason = this._classifyError(msg);
      this._recordFailure(project.identifier);
      
      if (reason) {
        // Expected error - log concisely without stack trace
        log.warn({ project: project.identifier, reason, since: sinceIso }, 'Incremental mirror sync failed');
      } else {
        // Unexpected error - log with details
        log.error({ project: project.identifier, err, since: sinceIso }, 'Incremental mirror sync failed (unexpected)');
      }
      
      this.db.setBeadsMirrorSyncedAt(project.identifier, Date.now(), msg);
      return { changed: 0, source: 'incremental', error: msg, durationMs: 0 };
    }
  }

  private async _fetch(project: MirrorProject, filters: BeadsListFilters): Promise<NormalizedBeadsIssue[]> {
    const result = await this.adapter.listIssues(
      { identifier: project.identifier, filesystem_path: project.filesystem_path ?? null },
      filters,
      { forceRefresh: true },
    );
    return result.items || [];
  }

  async preloadAll(options: { concurrency?: number } = {}): Promise<{ projects: number; ok: number; failed: number; skipped: number; durationMs: number }> {
    const start = Date.now();
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const projects = this.db.getAllProjects().filter((p) => p.status !== 'archived' && p.filesystem_path);
    log.info({ projects: projects.length, concurrency }, 'Beads mirror preload starting');

    const queue = projects.slice();
    let ok = 0;
    let failed = 0;
    let skipped = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const project = queue.shift();
        if (!project) return;
        try {
          const r = await this.syncProject(project);
          if (r.error === 'backoff') {
            skipped++;
          } else if (r.error) {
            failed++;
          } else {
            ok++;
          }
        } catch {
          failed++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
    const durationMs = Date.now() - start;
    log.info({ projects: projects.length, ok, failed, skipped, durationMs }, 'Beads mirror preload complete');
    return { projects: projects.length, ok, failed, skipped, durationMs };
  }

  private _classifyError(errorMsg: string): string | null {
    return classifyBeadsFailure(errorMsg);
  }

  private _isInBackoff(projectId: string): boolean {
    const backoff = this.failureBackoffs.get(projectId);
    if (!backoff) return false;
    return Date.now() < backoff.nextRetryAt;
  }

  private _recordFailure(projectId: string): void {
    const existing = this.failureBackoffs.get(projectId);
    const now = Date.now();
    
    if (!existing) {
      // First failure: retry after 30 seconds
      this.failureBackoffs.set(projectId, {
        consecutiveFailures: 1,
        lastFailureAt: now,
        nextRetryAt: now + 30_000,
      });
    } else {
      // Exponential backoff after the first failure: 1m, 2m, 4m, 8m, 16m, capped at 30m.
      const backoffMs = Math.min(
        30_000 * Math.pow(2, existing.consecutiveFailures),
        30 * 60_000
      );
      this.failureBackoffs.set(projectId, {
        consecutiveFailures: existing.consecutiveFailures + 1,
        lastFailureAt: now,
        nextRetryAt: now + backoffMs,
      });
      
      const backoffMin = Math.round(backoffMs / 60_000);
      log.debug({ project: projectId, consecutiveFailures: existing.consecutiveFailures + 1, backoffMin }, 'Project in backoff after repeated failures');
    }
  }

  private _clearBackoff(projectId: string): void {
    const had = this.failureBackoffs.has(projectId);
    this.failureBackoffs.delete(projectId);
    if (had) {
      log.debug({ project: projectId }, 'Project backoff cleared after successful sync');
    }
  }
}

export function createBeadsIssueMirror(
  deps: { db: MirrorDb; beadsAdapter: MirrorBeadsAdapter },
  options?: MirrorOptions,
): BeadsIssueMirror {
  return new BeadsIssueMirror(deps, options);
}
