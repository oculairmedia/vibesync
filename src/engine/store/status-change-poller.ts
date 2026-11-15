import type { EventBus } from '../events/bus.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../events/beads.js';

export interface IssueStatusRow {
  readonly id: string;
  readonly status: string;
  readonly updated_at: Date;
}

export interface IssueStatusReader {
  listIssueStatusSince(cursor: Date, limit: number, after?: { readonly updatedAt: Date; readonly id: string } | null): Promise<IssueStatusRow[]>;
}

export interface StatusChangePollerOptions {
  readonly store: IssueStatusReader;
  readonly bus: EventBus;
  readonly intervalMs?: number;
  readonly logger?: { warn?(obj: unknown, message: string): void };
}

const DEFAULT_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 500;

/** Publishes human-work bead transitions to the engine event bus. */
export class StatusChangePoller {
  private readonly statuses = new Map<string, string>();
  private cursor: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private warned = false;
  private stopped = false;

  constructor(private readonly opts: StatusChangePollerOptions) {}

  start(): void {
    if (this.timer || this.opts.intervalMs === 0 || this.stopped) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling;
  }

  /** Exposed for deterministic tests and for callers that need an immediate scan. */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.readBatch().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async readBatch(initialPass = this.cursor === null): Promise<void> {
    try {
      const rows = await this.readAllPages();
      for (const row of rows) {
        const previous = this.statuses.get(row.id);
        if (!initialPass && previous !== undefined && previous !== row.status) {
          this.opts.bus.emit({
            layer: 'molecule',
            kind: BEADS_ISSUE_STATUS_CHANGED_EVENT,
            task_id: row.id,
            payload: { issueId: row.id, from: previous, to: row.status },
          });
        }
        this.statuses.set(row.id, row.status);
      }
      for (const row of rows) {
        if (!this.cursor || row.updated_at > this.cursor) this.cursor = row.updated_at;
      }
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.opts.logger?.warn?.({ error: err instanceof Error ? err.message : String(err) }, 'status-change-poller: Dolt read failed; will retry');
      }
    }
  }

  /** Page by id inside a timestamp while retaining the inclusive time cursor. */
  private async readAllPages(): Promise<IssueStatusRow[]> {
    const all: IssueStatusRow[] = [];
    const startCursor = this.cursor ?? new Date(0);
    let pageCursor = startCursor;
    let after: { updatedAt: Date; id: string } | null = null;
    while (!this.stopped) {
      const page = await this.opts.store.listIssueStatusSince(pageCursor, BATCH_LIMIT, after);
      all.push(...page);
      if (page.length < BATCH_LIMIT) break;
      const last = page[page.length - 1]!;
      pageCursor = startCursor;
      after = { updatedAt: last.updated_at, id: last.id };
    }
    return all;
  }
}
