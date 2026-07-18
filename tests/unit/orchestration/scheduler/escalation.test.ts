import { describe, expect, it } from 'vitest';

import {
  EscalationManager,
  severityPriority,
  markerLine,
  type EscalationStore,
  type EscalationRecord,
  type EscalationSeverity,
  type NotificationTransport,
} from '../../../../src/orchestration/scheduler/index.js';

/** In-memory escalation store: records the marker comments + records. */
class FakeStore implements EscalationStore {
  readonly records = new Map<string, EscalationRecord>();
  readonly markers: Array<{ workBeadId: string; marker: string }> = [];
  private seq = 0;

  async createEscalation(input: {
    workBeadId: string; runId: string; severity: EscalationSeverity;
    summary: string; marker: string; createdAt: string;
  }): Promise<EscalationRecord> {
    const id = `esc-${++this.seq}`;
    this.markers.push({ workBeadId: input.workBeadId, marker: input.marker });
    const rec: EscalationRecord = {
      id, workBeadId: input.workBeadId, runId: input.runId, severity: input.severity,
      summary: input.summary, state: 'open', createdAt: input.createdAt,
      lastNotifiedAt: input.createdAt, reescalationCount: 0,
    };
    this.records.set(id, rec);
    return rec;
  }
  async findOpenForWorkBead(workBeadId: string): Promise<EscalationRecord | null> {
    return [...this.records.values()].find((r) => r.state === 'open' && r.workBeadId === workBeadId) ?? null;
  }
  async listOpen(): Promise<EscalationRecord[]> {
    return [...this.records.values()].filter((r) => r.state === 'open');
  }
  async markReescalated(id: string, at: string): Promise<EscalationRecord> {
    const r = this.records.get(id)!;
    const updated = { ...r, reescalationCount: r.reescalationCount + 1, lastNotifiedAt: at };
    this.records.set(id, updated);
    return updated;
  }
  async closeEscalation(id: string, _reason: string): Promise<void> {
    const r = this.records.get(id);
    if (r) this.records.set(id, { ...r, state: 'closed' });
  }
}

class FakeTransport implements NotificationTransport {
  readonly sent: Array<{ workBeadId: string; severity: string; reescalation: boolean }> = [];
  async notifyMeridian(input: { workBeadId: string; severity: EscalationSeverity; summary: string; reescalation: boolean }): Promise<void> {
    this.sent.push({ workBeadId: input.workBeadId, severity: input.severity, reescalation: input.reescalation });
  }
}

const HOUR = 60 * 60 * 1000;

describe('severity routing (vibesync-63zx.5)', () => {
  it('maps severity to bead priority (P0/P1/P2)', () => {
    expect(severityPriority('CRITICAL')).toBe(0);
    expect(severityPriority('HIGH')).toBe(1);
    expect(severityPriority('MEDIUM')).toBe(2);
  });
  it('markerLine builds the NEEDS-MERIDIAN-DECISION first line', () => {
    expect(markerLine('pick db')).toBe('NEEDS-MERIDIAN-DECISION: pick db');
  });
});

describe('EscalationManager.escalate (vibesync-63zx.5)', () => {
  it('PROBE: an escalation lands as a marker comment AND a message to Meridian', async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const mgr = new EscalationManager({ store, transport, now: () => new Date('2026-07-17T20:00:00Z') });

    const rec = await mgr.escalate({ workBeadId: 'w1', runId: 'mol-1', summary: 'pick A or B', severity: 'HIGH' });

    expect(rec.state).toBe('open');
    expect(rec.severity).toBe('HIGH');
    // Marker comment landed on the work bead.
    expect(store.markers).toHaveLength(1);
    expect(store.markers[0]).toEqual({ workBeadId: 'w1', marker: 'NEEDS-MERIDIAN-DECISION: pick A or B' });
    // Meridian was notified (agent-messaging transport), not a re-escalation.
    expect(transport.sent).toEqual([{ workBeadId: 'w1', severity: 'HIGH', reescalation: false }]);
  });

  it('defaults to MEDIUM severity when unspecified', async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const mgr = new EscalationManager({ store, transport });
    const rec = await mgr.escalate({ workBeadId: 'w1', runId: 'r', summary: 's' });
    expect(rec.severity).toBe('MEDIUM');
  });

  it('idempotent per work bead: a re-blocked agent does not post a duplicate marker or re-notify Meridian', async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    const mgr = new EscalationManager({ store, transport });
    const first = await mgr.escalate({ workBeadId: 'w1', runId: 'r', summary: 's' });
    const second = await mgr.escalate({ workBeadId: 'w1', runId: 'r', summary: 's again' });
    expect(second.id).toBe(first.id);
    expect(store.markers).toHaveLength(1); // no duplicate marker
    expect(transport.sent).toHaveLength(1); // no re-notification
  });
});

describe('EscalationManager.sweepStale (vibesync-63zx.5)', () => {
  it('PROBE: a stale (unanswered) escalation re-fires ONCE, then never again', async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    let clock = new Date('2026-07-17T20:00:00Z');
    const mgr = new EscalationManager({
      store, transport,
      config: { staleThresholdMs: 4 * HOUR, maxReescalations: 1 },
      now: () => clock,
    });
    await mgr.escalate({ workBeadId: 'w1', runId: 'r', summary: 's' });
    expect(transport.sent).toHaveLength(1); // initial notify

    // Not yet stale (2h < 4h): sweep is a no-op.
    clock = new Date('2026-07-17T22:00:00Z');
    let r = await mgr.sweepStale();
    expect(r.reescalated).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);

    // Past threshold (5h): re-fires exactly once.
    clock = new Date('2026-07-18T01:00:00Z');
    r = await mgr.sweepStale();
    expect(r.reescalated).toHaveLength(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.reescalation).toBe(true);

    // Much later (another 5h): already at maxReescalations=1 → NOT re-fired again.
    clock = new Date('2026-07-18T06:00:00Z');
    r = await mgr.sweepStale();
    expect(r.reescalated).toHaveLength(0);
    expect(transport.sent).toHaveLength(2); // still just the one re-fire
  });

  it('PROBE: a ruled (resolved) escalation clears — sweepStale never re-fires it', async () => {
    const store = new FakeStore();
    const transport = new FakeTransport();
    let clock = new Date('2026-07-17T20:00:00Z');
    const mgr = new EscalationManager({
      store, transport, config: { staleThresholdMs: 4 * HOUR, maxReescalations: 1 }, now: () => clock,
    });
    const rec = await mgr.escalate({ workBeadId: 'w1', runId: 'r', summary: 's' });

    // Meridian rules → clear.
    await mgr.resolve(rec.id, 'go with option A');
    expect(store.records.get(rec.id)!.state).toBe('closed');

    // Even long past the stale threshold, a closed escalation is never re-fired.
    clock = new Date('2026-07-18T02:00:00Z');
    const r = await mgr.sweepStale();
    expect(r.reescalated).toHaveLength(0);
    expect(transport.sent).toHaveLength(1); // only the original notify
  });
});
