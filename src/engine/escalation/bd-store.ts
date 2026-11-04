/** Escalation store and transport backed by the bd CLI and the log. */
import { parseJsonOutput, type CommandRunner } from '../beads/cli.js';
import type { EscalationRecord, EscalationStore, NotificationTransport } from './escalation.js';

type Row = Record<string, unknown>;

/** Minimal logger the log-only transport writes to. */
export interface EscalationLogger {
  warn?(o: unknown, m: string): void;
}

// ---------------------------------------------------------------------------
// Escalation: bead comments + log/bus. NO agent messages.
// ---------------------------------------------------------------------------

/**
 * Escalations are recorded as a `NEEDS-MERIDIAN-DECISION: ...` comment on the
 * work bead (the convention Meridian's scanner already reads). The open/closed
 * record set is held in memory; a restart cannot duplicate a marker because
 * the existing comments are checked first.
 */
export class BdCommentEscalationStore implements EscalationStore {
  private readonly records = new Map<string, EscalationRecord>();
  private seq = 0;

  constructor(private readonly bd: CommandRunner) {}

  async createEscalation(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly severity: EscalationRecord['severity'];
    readonly summary: string;
    readonly marker: string;
    readonly createdAt: string;
  }): Promise<EscalationRecord> {
    const existing = parseJsonOutput(await this.bd(['comments', input.workBeadId, '--json']), `bd comments ${input.workBeadId}`);
    const already = Array.isArray(existing) && existing.some((c) => (c as Row)['text'] === input.marker);
    if (!already) {
      await this.bd(['comments', 'add', input.workBeadId, input.marker]);
    }
    const record: EscalationRecord = {
      id: `esc-${++this.seq}`,
      workBeadId: input.workBeadId,
      runId: input.runId,
      severity: input.severity,
      summary: input.summary,
      state: 'open',
      createdAt: input.createdAt,
      lastNotifiedAt: input.createdAt,
      reescalationCount: 0,
    };
    this.records.set(record.id, record);
    return record;
  }

  async findOpenForWorkBead(workBeadId: string): Promise<EscalationRecord | null> {
    for (const r of this.records.values()) {
      if (r.state === 'open' && r.workBeadId === workBeadId) return r;
    }
    return null;
  }

  async listOpen(): Promise<EscalationRecord[]> {
    return [...this.records.values()].filter((r) => r.state === 'open');
  }

  async markReescalated(id: string, at: string): Promise<EscalationRecord> {
    const r = this.records.get(id);
    if (!r) throw new Error(`escalation ${id} not found`);
    const next: EscalationRecord = { ...r, lastNotifiedAt: at, reescalationCount: r.reescalationCount + 1 };
    this.records.set(id, next);
    return next;
  }

  async closeEscalation(id: string, _reason: string): Promise<void> {
    const r = this.records.get(id);
    if (r) this.records.set(id, { ...r, state: 'closed' });
  }
}

/**
 * Default transport: log only (the bus event is emitted by the composition).
 * Sending real agent messages requires an explicit transport to be injected.
 */
export function createLogNotificationTransport(logger: EscalationLogger | undefined): NotificationTransport {
  return {
    async notifyMeridian(input) {
      logger?.warn?.(
        { workBeadId: input.workBeadId, severity: input.severity, reescalation: input.reescalation },
        `scheduler escalation (log only, no agent message sent): ${input.summary}`,
      );
    },
  };
}
