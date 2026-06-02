import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { logger as rootLogger } from '../logger.js';
import type {
  NormalizedBeadsIssue,
  NormalizedWorkItems,
  BeadsProject,
} from '../types/beads';

const log = rootLogger.child({ module: 'beads-adapter' });

type RawBeadsIssue = Record<string, unknown>;

interface CacheEntry {
  value: unknown;
  timestamp: number;
  insertOrder: number;
}

interface BeadsAdapterOptions {
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  commandTimeoutMs?: number;
  maxBuffer?: number;
  runCommand?: RunCommand;
  beadsDb?: string;
  actor?: string;
  readonly?: boolean;
}

type RunCommand = (command: string, args: string[]) => unknown;

interface GetOptions {
  forceRefresh?: boolean;
}

interface ListFilters {
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  updated_after?: string;
}

interface WorkItemOptions {
  forceRefresh?: boolean;
  status?: string;
}

interface CreateOptions {
  description?: string;
  priority?: string;
  type?: string;
  checkDuplicate?: boolean;
}

interface UpdateOptions {
  skipIdempotencyCheck?: boolean;
}

export interface IssueUpdates {
  status?: string;
  priority?: string | number;
  type?: string;
  title?: string;
  description?: string;
  labels?: string[];
  assignee?: string | null;
}

interface CloseOptions {
  reason?: string;
}

interface NoteOptions {
  checkDuplicate?: boolean;
}

interface CommentOptions {
  checkDuplicate?: boolean;
}

export class BeadsAdapter {
  private cacheTtlMs: number;
  private cacheMaxEntries: number;
  private commandTimeoutMs: number;
  private maxBuffer: number;
  private runCommand: RunCommand;
  private beadsDb: string;
  private actor: string;
  private readonly: boolean;
  private cache: Map<string, CacheEntry>;
  private insertOrder: number;

  constructor(options: BeadsAdapterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 100;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;
    this.runCommand = options.runCommand ?? this._defaultRunCommand.bind(this);
    this.beadsDb = options.beadsDb ?? process.env.BEADS_DB ?? '.beads';
    this.actor = options.actor ?? process.env.BEADS_ACTOR ?? process.env.USER ?? 'unknown';
    this.readonly = options.readonly ?? process.env.BEADS_READONLY === '1';
    this.cache = new Map();
    this.insertOrder = 0;
  }

  private _defaultRunCommand(command: string, args: string[] = []): unknown {
    const { cliArgs, beadsDir } = this._extractBeadsDirArg(args);
    const argv = [command, ...cliArgs, '--json'];
    const displayCommand = ['bd', ...argv].join(' ');
    try {
      const output = execFileSync('bd', argv, {
        encoding: 'utf-8',
        maxBuffer: this.maxBuffer,
        timeout: this.commandTimeoutMs,
        env: {
          ...process.env,
          BEADS_DIR: beadsDir ?? process.env.BEADS_DIR ?? this.beadsDb,
          BEADS_DB: this.beadsDb,
          BEADS_ACTOR: this.actor,
          BEADS_READONLY: this.readonly ? '1' : '0',
        },
      });
      return JSON.parse(output) as unknown;
    } catch (error) {
      const errorMsg = (error as Error).message;
      // Classify expected recurring mirror failures
      const isExpectedFailure = this._isExpectedMirrorFailure(errorMsg);
      
      if (isExpectedFailure) {
        // Log concisely without stack trace for expected failures
        log.warn({ command: displayCommand, reason: this._extractFailureReason(errorMsg) }, 'Beads command failed (expected)');
      } else {
        // Log unexpected errors with full details
        log.error({ command: displayCommand, err: error }, 'Beads command failed (unexpected)');
      }
      
      throw new Error(
        `Beads command failed: ${displayCommand}\n${errorMsg}`,
      );
    }
  }

  private _isExpectedMirrorFailure(errorMsg: string): boolean {
    const expectedPatterns = [
      'connection refused',
      'ECONNREFUSED',
      'database not found',
      'database does not exist',
      'no such database',
      'failed to connect to dolt',
      'dolt server not running',
      'no beads database',
      '.beads directory not found',
      'BEADS_DIR does not exist',
    ];
    const lowerMsg = errorMsg.toLowerCase();
    return expectedPatterns.some(pattern => lowerMsg.includes(pattern.toLowerCase()));
  }

  private _extractFailureReason(errorMsg: string): string {
    if (errorMsg.toLowerCase().includes('connection refused') || errorMsg.toLowerCase().includes('econnrefused')) {
      return 'dolt_unreachable';
    }
    if (errorMsg.toLowerCase().includes('database not found') || errorMsg.toLowerCase().includes('database does not exist') || errorMsg.toLowerCase().includes('no such database')) {
      return 'db_not_found';
    }
    if (errorMsg.toLowerCase().includes('no beads database') || errorMsg.toLowerCase().includes('.beads directory not found') || errorMsg.toLowerCase().includes('beads_dir does not exist')) {
      return 'no_beads_db';
    }
    if (errorMsg.toLowerCase().includes('dolt server not running')) {
      return 'dolt_not_running';
    }
    return 'unknown_expected';
  }

  private _extractBeadsDirArg(args: string[]): {
    cliArgs: string[];
    beadsDir: string | null;
  } {
    const prefix = '--beads-dir=';
    const beadsDirArg = args.find(
      (arg) => typeof arg === 'string' && arg.startsWith(prefix),
    );
    return {
      cliArgs: args.filter((arg) => arg !== beadsDirArg),
      beadsDir: beadsDirArg ? beadsDirArg.slice(prefix.length) : null,
    };
  }

  private _addProjectBeadsDir(args: string[], project: BeadsProject): string[] {
    if (project.filesystem_path) {
      args.push(`--beads-dir=${path.join(project.filesystem_path, '.beads')}`);
    }
    return args;
  }

  private _readonlyGuard(operation: string): void {
    if (this.readonly) {
      throw new Error(`Cannot ${operation} in readonly mode`);
    }
  }

  setCache(key: string, value: unknown): void {
    this._evictExpired();

    if (this.cache.size >= this.cacheMaxEntries && !this.cache.has(key)) {
      let oldestKey: string | null = null;
      let oldestOrder = Infinity;
      for (const [k, v] of this.cache.entries()) {
        if (v.insertOrder < oldestOrder) {
          oldestOrder = v.insertOrder;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      insertOrder: this.insertOrder++,
    });
  }

  getCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.value as T;
  }

  private _evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.cacheTtlMs) {
        this.cache.delete(key);
      }
    }
  }

  private _invalidateCachePattern(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  async getReadyWork(
    project: BeadsProject,
    options: GetOptions = {},
  ): Promise<NormalizedWorkItems> {
    const cacheKey = `${project.identifier}:ready-work`;

    if (!options.forceRefresh) {
      const cached = this.getCache<NormalizedWorkItems>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('ready', args)) as
      | RawBeadsIssue[]
      | { items: RawBeadsIssue[] };
    const normalized = this._normalizeWorkItems(result);

    this.setCache(cacheKey, normalized);
    return normalized;
  }

  async getIssue(
    issueId: string,
    project: BeadsProject,
    options: GetOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    const cacheKey = `${project.identifier}:issue:${issueId}`;

    if (!options.forceRefresh) {
      const cached = this.getCache<NormalizedBeadsIssue>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [issueId];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('show', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this.setCache(cacheKey, normalized);
    return normalized;
  }

  async listIssues(
    project: BeadsProject,
    filters: ListFilters = {},
    options: GetOptions = {},
  ): Promise<NormalizedWorkItems> {
    const cacheKey = `${project.identifier}:issues:${JSON.stringify(filters)}`;

    if (!options.forceRefresh) {
      const cached = this.getCache<NormalizedWorkItems>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [];
    if (filters.status) {
      args.push(`--status=${filters.status}`);
    } else {
      args.push('--all');
    }
    if (filters.priority) args.push(`--priority=${filters.priority}`);
    if (filters.type) args.push(`--type=${filters.type}`);
    if (filters.assignee) args.push(`--assignee=${filters.assignee}`);
    if (filters.updated_after) args.push(`--updated-after=${filters.updated_after}`);
    args.push('--limit=0');
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('list', args)) as
      | RawBeadsIssue[]
      | { items: RawBeadsIssue[] };
    const normalized: NormalizedBeadsIssue[] = Array.isArray(result)
      ? result.map((item) => this._normalizeIssue(item))
      : 'items' in result
        ? result.items.map((item) => this._normalizeIssue(item))
        : [];

    const response: NormalizedWorkItems = { items: normalized };
    this.setCache(cacheKey, response);
    return response;
  }

  async getProjectWorkItems(
    project: BeadsProject,
    options: WorkItemOptions = {},
  ): Promise<NormalizedWorkItems> {
    const cacheKey = `${project.identifier}:work-items`;

    if (!options.forceRefresh) {
      const cached = this.getCache<NormalizedWorkItems>(cacheKey);
      if (cached) {
        if (options.status) {
          return {
            items: cached.items.filter((item) => item.status === options.status),
          };
        }
        return cached;
      }
    }

    const result = await this.listIssues(project, {}, { forceRefresh: true });
    this.setCache(cacheKey, result);

    if (options.status) {
      return {
        items: result.items.filter((item) => item.status === options.status),
      };
    }

    return result;
  }

  async createIssue(
    project: BeadsProject,
    title: string,
    options: CreateOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('create issue');

    if (options.checkDuplicate) {
      const existing = await this.listIssues(project, {});
      if (existing.items.some((item) => item.title === title)) {
        throw new Error(`Issue with title "${title}" already exists`);
      }
    }

    const args: string[] = [`"${title}"`];
    if (options.description)
      args.push(`--description="${options.description}"`);
    if (options.priority) args.push(`--priority=${options.priority}`);
    if (options.type) args.push(`--type=${options.type}`);
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('create', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issues`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return normalized;
  }

  async updateIssue(
    issueId: string,
    project: BeadsProject,
    updates: IssueUpdates = {},
    options: UpdateOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('update issue');

    const args: string[] = [issueId];

    if (updates.status !== undefined)
      args.push(`--status=${String(updates.status)}`);
    if (updates.priority !== undefined)
      args.push(`--priority=${String(updates.priority)}`);
    if (updates.type !== undefined)
      args.push(`--type=${String(updates.type)}`);
    if (updates.title !== undefined)
      args.push(`--title="${String(updates.title)}"`);
    if (updates.description !== undefined)
      args.push(`--description="${String(updates.description)}"`);

    if (updates.labels && !options.skipIdempotencyCheck) {
      const current = await this.getIssue(issueId, project);
      const newLabels = updates.labels.filter((l) => !current.labels?.includes(l));
      if (newLabels.length > 0) {
        args.push(`--add-label=${newLabels.join(',')}`);
      }
    } else if (updates.labels) {
      args.push(`--add-label=${updates.labels.join(',')}`);
    }

    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('update', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);
    this._invalidateCachePattern(`${project.identifier}:issues`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return normalized;
  }

  async claimIssue(
    issueId: string,
    project: BeadsProject,
    actor: string | null = null,
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('claim issue');

    const claimActor = actor ?? this.actor;
    const args: string[] = [issueId, `--claim=${claimActor}`];
    this._addProjectBeadsDir(args, project);

    try {
      const result = (await this.runCommand('update', args)) as Record<
        string,
        unknown
      >;
      const normalized = this._normalizeIssue(result);

      this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);
      this._invalidateCachePattern(`${project.identifier}:ready-work`);

      return normalized;
    } catch (error) {
      if ((error as Error).message.includes('already claimed')) {
        throw new Error(
          `Issue ${issueId} is already claimed by another user`,
        );
      }
      throw error;
    }
  }

  async closeIssue(
    issueId: string,
    project: BeadsProject,
    options: CloseOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('close issue');

    const args: string[] = [issueId];
    if (options.reason) args.push(`--reason="${options.reason}"`);
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('close', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return normalized;
  }

  async reopenIssue(
    issueId: string,
    project: BeadsProject,
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('reopen issue');

    const args: string[] = [issueId];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('reopen', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return normalized;
  }

  async addNote(
    issueId: string,
    project: BeadsProject,
    text: string,
    options: NoteOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('add note');

    if (options.checkDuplicate) {
      const issue = await this.getIssue(issueId, project);
      if (issue.notes?.some((n) => (n as unknown as { text?: string }).text === text)) {
        throw new Error(
          `Note with text "${text}" already exists on issue ${issueId}`,
        );
      }
    }

    const args: string[] = [issueId, `"${text}"`];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('note', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);

    return normalized;
  }

  async addComment(
    issueId: string,
    project: BeadsProject,
    text: string,
    options: CommentOptions = {},
  ): Promise<NormalizedBeadsIssue> {
    this._readonlyGuard('add comment');

    if (options.checkDuplicate) {
      const issue = await this.getIssue(issueId, project);
      if (issue.comments?.some((c) => (c as unknown as { text?: string }).text === text)) {
        throw new Error(
          `Comment with text "${text}" already exists on issue ${issueId}`,
        );
      }
    }

    const args: string[] = [issueId, 'add', `"${text}"`];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('comments', args)) as Record<
      string,
      unknown
    >;
    const normalized = this._normalizeIssue(result);

    this._invalidateCachePattern(`${project.identifier}:issue:${issueId}`);

    return normalized;
  }

  async getDependencies(
    issueId: string,
    project: BeadsProject,
    options: GetOptions = {},
  ): Promise<unknown[]> {
    const cacheKey = `${project.identifier}:deps:${issueId}`;

    if (!options.forceRefresh) {
      const cached = this.getCache<unknown[]>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [issueId, 'list'];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('dep', args)) as
      | unknown[]
      | { dependencies: unknown[] };
    const normalized = Array.isArray(result)
      ? result
      : result.dependencies || [];

    this.setCache(cacheKey, normalized);
    return normalized;
  }

  async addDependency(
    issueId: string,
    dependsOnId: string,
    project: BeadsProject,
    type: string = 'blocks',
  ): Promise<unknown> {
    this._readonlyGuard('add dependency');

    const args: string[] = [issueId, 'add', dependsOnId, `--type=${type}`];
    this._addProjectBeadsDir(args, project);

    const result = await this.runCommand('dep', args);

    this._invalidateCachePattern(`${project.identifier}:deps:${issueId}`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return result;
  }

  async removeDependency(
    issueId: string,
    dependsOnId: string,
    project: BeadsProject,
  ): Promise<unknown> {
    this._readonlyGuard('remove dependency');

    const args: string[] = [issueId, 'remove', dependsOnId];
    this._addProjectBeadsDir(args, project);

    const result = await this.runCommand('dep', args);

    this._invalidateCachePattern(`${project.identifier}:deps:${issueId}`);
    this._invalidateCachePattern(`${project.identifier}:ready-work`);

    return result;
  }

  async checkCycles(
    project: BeadsProject,
    options: GetOptions = {},
  ): Promise<unknown[]> {
    const cacheKey = `${project.identifier}:cycles`;

    if (!options.forceRefresh) {
      const cached = this.getCache<unknown[]>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [];
    this._addProjectBeadsDir(args, project);

    const result = (await this.runCommand('dep', ['cycles', ...args])) as
      | unknown[]
      | { cycles: unknown[] };
    const normalized = Array.isArray(result)
      ? result
      : result.cycles || [];

    this.setCache(cacheKey, normalized);
    return normalized;
  }

  async getGraph(
    issueId: string,
    project: BeadsProject,
    options: GetOptions = {},
  ): Promise<unknown> {
    const cacheKey = `${project.identifier}:graph:${issueId}`;

    if (!options.forceRefresh) {
      const cached = this.getCache<unknown>(cacheKey);
      if (cached) return cached;
    }

    const args: string[] = [issueId];
    this._addProjectBeadsDir(args, project);

    const result = await this.runCommand('graph', args);

    this.setCache(cacheKey, result);
    return result;
  }

  private _normalizeIssue(issue: Record<string, unknown>): NormalizedBeadsIssue {
    const dependencies = Array.isArray(issue.dependencies)
      ? (issue.dependencies as Array<Record<string, unknown>>)
      : [];
    const blockedBy = dependencies
      .filter((dependency) =>
        ['blocks', 'blocked_by', 'depends_on'].includes(
          String(dependency.type),
        ),
      )
      .map((dependency) => String(dependency.depends_on_id))
      .filter(Boolean);
    const parentDependency = dependencies.find((dependency) =>
      ['parent', 'parent-child', 'parent_child'].includes(
        String(dependency.type),
      ),
    );

    return {
      id: String(issue.id ?? ''),
      identifier: String(issue.identifier ?? issue.id ?? ''),
      title: String(issue.title ?? ''),
      status: String(issue.status ?? 'todo'),
      priority: String(issue.priority ?? 'P3'),
      type: String(issue.issue_type ?? issue.type ?? 'task'),
      issue_type: String(issue.issue_type ?? issue.type ?? 'task'),
      description: String(issue.description ?? ''),
      assignee: (issue.assignee ?? issue.owner ?? null) as string | null,
      labels: (issue.labels ?? []) as string[],
      notes: (issue.notes ?? []) as string[],
      comments: (issue.comments ?? []) as string[],
      blockedBy,
      blocked_by: blockedBy,
      blocks: (issue.blocks ?? []) as string[],
      parent_huly_id:
        (issue.parent_huly_id ??
          issue.parent ??
          parentDependency?.depends_on_id ??
          null) as string | null,
      parent_vibe_id: (issue.parent_vibe_id ?? null) as string | null,
      sub_issue_count: Number(
        issue.sub_issue_count ?? issue.dependent_count ?? 0,
      ),
      createdAt: String(issue.created_at ?? ''),
      updatedAt: String(issue.updated_at ?? ''),
      closedAt: issue.closed_at as string | undefined,
      created_at: String(issue.created_at ?? ''),
      updated_at: String(issue.updated_at ?? ''),
      closed_at: issue.closed_at as string | undefined,
      acceptance_criteria: issue.acceptance_criteria as string | undefined,
      dependency_count: issue.dependency_count as number | undefined,
      dependent_count: issue.dependent_count as number | undefined,
      comment_count: issue.comment_count as number | undefined,
    };
  }

  private _normalizeWorkItems(
    items: RawBeadsIssue[] | { items: RawBeadsIssue[] },
  ): NormalizedWorkItems {
    return {
      items: (Array.isArray(items)
        ? items
        : items.items || []
      ).map((item) => this._normalizeIssue(item)),
    };
  }
}
