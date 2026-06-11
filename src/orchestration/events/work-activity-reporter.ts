/**
 * WorkActivityReporter — POST molecule/step lifecycle to shim registry
 * (vibesync-ryhc).
 *
 * Subscribes to the EventBus LIVE tier, filters dispatcher/step.*
 * events (started/finished/failed), and POSTs fire-and-forget to
 * `POST {shimBaseUrl}/v1/work-activity`. The shim ingests these into
 * its active-subagent registry (lcp-zncq) so the mobile ActiveSubagentBar
 * can track vibesync workers alongside direct letta-code Agent dispatches.
 *
 * # Design requirements (from vibesync-ryhc conformance audit)
 *
 * 1. **FAIL-OPEN**: reporting MUST NEVER block or fail a dispatch.
 *    Fire-and-forget with ~2s timeout, swallow+log errors, no retry queues.
 * 2. **REPLAY-SAFE**: subscribe to the LIVE tier only — events.jsonl
 *    replay on restart must NOT re-report historical events.
 * 3. **Config-gated**: enabled only when shimBaseUrl is configured;
 *    VIBESYNC_WORK_ACTIVITY_REPORT=0 disables.
 *
 * # Field mapping (from conformance audit)
 *
 * | SubagentEntry field | vibesync source |
 * |---|---|
 * | external_id | molecule_id + stepId (dispatcher/step.* events) |
 * | description | payload.stepName + payload.role (e.g. "coder: implement X") |
 * | status running | dispatcher/step.started |
 * | status completed | dispatcher/step.finished |
 * | status failed | dispatcher/step.failed (payload.error → failure_reason) |
 * | started_at | event.ts |
 * | task_ref | event.task_id (bead id) |
 * | source | constant "vibesync" |
 *
 * # Usage
 *
 * ```ts
 * const reporter = new WorkActivityReporter({
 *   eventBus: bus,
 *   shimBaseUrl: 'http://localhost:8291',
 *   password: 'optional-bearer-token',
 * });
 * reporter.start();
 * // ... later
 * reporter.stop();
 * ```
 *
 * See vibesync-ryhc.
 */

import type { Event, EventBus } from './bus.js';

export interface WorkActivityReporterOptions {
  /** EventBus instance to subscribe to. */
  readonly eventBus: EventBus;
  /** Base URL of the admin-shim (e.g. http://localhost:8291). */
  readonly shimBaseUrl: string;
  /** Optional bearer token for shim auth. */
  readonly password?: string | undefined;
  /** Injectable fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Fire-and-forget POST timeout (ms). Default 2000ms. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Shape of the POST /v1/work-activity payload sent to the shim.
 * Matches the shim's SubagentEntry contract (lcp-zncq).
 */
interface WorkActivityPayload {
  /** Unique external identifier: ext-vibesync-<molecule_id>-<stepId> */
  external_id: string;
  /** Human-facing description: "<role>: <stepName>" */
  description: string;
  /** Status: running | completed | failed */
  status: 'running' | 'completed' | 'failed';
  /** ISO timestamp when the step started */
  started_at: string;
  /** Optional bead id (from event.task_id) */
  task_ref?: string | undefined;
  /** Optional failure reason (from payload.error when status=failed) */
  failure_reason?: string | undefined;
  /** Constant source identifier */
  source: 'vibesync';
}

export class WorkActivityReporter {
  private readonly bus: EventBus;
  private readonly shimBaseUrl: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: WorkActivityReporterOptions) {
    this.bus = opts.eventBus;
    this.shimBaseUrl = opts.shimBaseUrl.replace(/\/+$/, '');
    this.password = opts.password ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  /**
   * Subscribe to the EventBus and start reporting dispatcher/step.*
   * events. Idempotent — calling start() multiple times is safe.
   */
  start(): void {
    if (this.unsubscribe !== null) {
      // Already started.
      return;
    }
    this.unsubscribe = this.bus.subscribe((event) => {
      // REPLAY-SAFE: only process events emitted after subscribe() —
      // the EventBus live tier does not replay historical events.
      if (this.shouldReport(event)) {
        this.reportEvent(event);
      }
    });
  }

  /**
   * Stop reporting and unsubscribe from the EventBus. Idempotent.
   */
  stop(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Determine if an event should be reported. We filter for
   * dispatcher/step.started, dispatcher/step.finished, and
   * dispatcher/step.failed. Also include retry and cancelled if
   * wanted (bead says "plus retry/cancelled if cheap" — including
   * them here for completeness; they map to running/failed
   * respectively).
   */
  private shouldReport(event: Event): boolean {
    if (event.layer !== 'dispatcher') return false;
    const kind = event.kind;
    return (
      kind === 'dispatcher/step.started' ||
      kind === 'dispatcher/step.finished' ||
      kind === 'dispatcher/step.failed' ||
      kind === 'dispatcher/step.retry' ||
      kind === 'dispatcher/step.cancelled'
    );
  }

  /**
   * Map an Event to a WorkActivityPayload and POST it to the shim.
   * Fire-and-forget with timeout and error swallowing.
   */
  private reportEvent(event: Event): void {
    const payload = this.mapEventToPayload(event);
    if (payload === null) {
      // Event lacks required fields (e.g. no molecule_id + stepId).
      // Log at debug level and skip.
      return;
    }
    // Fire-and-forget: do NOT await, do NOT block the EventBus callback.
    void this.postWorkActivity(payload);
  }

  /**
   * Map an Event to a WorkActivityPayload. Returns null if the event
   * lacks required fields (molecule_id, stepId).
   */
  private mapEventToPayload(event: Event): WorkActivityPayload | null {
    const moleculeId = event.molecule_id;
    const payload = event.payload ?? {};
    const stepId = readString(payload['stepId']);
    if (!moleculeId || !stepId) {
      // Required fields missing — cannot construct external_id.
      return null;
    }
    const stepName = readString(payload['stepName']) ?? 'unknown';
    const role = readString(payload['role']) ?? 'worker';
    const description = `${role}: ${stepName}`;
    const externalId = `ext-vibesync-${moleculeId}-${stepId}`;
    let status: 'running' | 'completed' | 'failed';
    let failureReason: string | undefined;
    switch (event.kind) {
      case 'dispatcher/step.started':
        status = 'running';
        break;
      case 'dispatcher/step.finished':
        status = 'completed';
        break;
      case 'dispatcher/step.failed':
        status = 'failed';
        failureReason = readString(payload['error']) ?? 'step failed';
        break;
      case 'dispatcher/step.retry':
        // Retry means the step is still running (will retry).
        status = 'running';
        break;
      case 'dispatcher/step.cancelled':
        // Cancelled is a terminal failure.
        status = 'failed';
        failureReason = 'cancelled';
        break;
      default:
        // Should never reach here due to shouldReport filter.
        return null;
    }
    return {
      external_id: externalId,
      description,
      status,
      started_at: event.ts,
      task_ref: event.task_id,
      failure_reason: failureReason,
      source: 'vibesync',
    };
  }

  /**
   * POST a WorkActivityPayload to the shim's /v1/work-activity endpoint.
   * Fire-and-forget with timeout. Errors are logged at warn level and
   * swallowed — reporting must NEVER fail a dispatch.
   */
  private async postWorkActivity(payload: WorkActivityPayload): Promise<void> {
    const url = `${this.shimBaseUrl}/v1/work-activity`;
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.password ? { Authorization: `Bearer ${this.password}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      clearTimeout(timeoutHandle);
      if (!res.ok) {
        // Non-2xx response. Log and swallow.
        const body = await safeReadText(res);
        // eslint-disable-next-line no-console
        console.warn(
          `[WorkActivityReporter] POST /v1/work-activity failed (${res.status}): ${body.slice(0, 200)} — external_id=${payload.external_id}`,
        );
      }
      // Success — drain the body to avoid connection-pool leaks.
      await res.body?.cancel();
    } catch (err) {
      // Fetch error (network, timeout, etc.). Log and swallow.
      clearTimeout(timeoutHandle);
      // eslint-disable-next-line no-console
      console.warn(
        `[WorkActivityReporter] POST /v1/work-activity error: ${errorMessage(err)} — external_id=${payload.external_id}`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
