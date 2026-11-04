import { randomUUID } from 'node:crypto';

import type { CommandRunner } from './bd-adapters.js';
import { parseJsonOutput } from './bd-adapters.js';
import type { PmWakeInput, PmWakeOutcome, PmWakeSink } from './pm-waker.js';
import { formatWakeMessage } from './pm-waker.js';

export const PENDING_WAKE_LABEL = 'vibesync:pending-wake';
const ACTIVE_STATUSES = 'open,in_progress,blocked,deferred';
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OWNER = `vibesync-pending-wake-${process.pid}-${randomUUID()}`;
const HELD_CLAIMS = new Set<string>();
const CLAIM_IN_FLIGHT = new Set<string>();

export interface PendingWakePayload {
  readonly projectIdentifier: string;
  readonly agentId: string;
  readonly msgId: string;
  readonly reason: PmWakeInput['reason'];
  readonly detail: string;
  readonly body: string;
  readonly correlation?: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface PendingWakeReceipt {
  readonly accepted: boolean;
  readonly applicationDelivered: boolean;
  readonly reason?: string;
  readonly msgId: string;
  readonly observedAt: string;
}

export interface PendingWakeRecord {
  readonly id: string;
  readonly status: string;
  readonly payload: PendingWakePayload;
  readonly receipt?: PendingWakeReceipt;
  readonly owner?: string;
  readonly leaseExpiresAt?: number;
  readonly rawMetadata?: Record<string, unknown>;
}

export interface PendingWakeClaim {
  readonly authorized: boolean;
  readonly record: PendingWakeRecord | null;
}

export interface PendingWakeSendResult extends PendingWakeClaim {
  readonly receipt?: PendingWakeReceipt;
  readonly outcome?: PmWakeOutcome;
}

export interface PendingWakeStore {
  enqueue(input: PmWakeInput, at: number): Promise<PendingWakeRecord>;
  listPending(): Promise<PendingWakeRecord[]>;
  claim(id: string): Promise<PendingWakeClaim>;
  sendClaimed(record: PendingWakeRecord, sink: PmWakeSink, at: number): Promise<PendingWakeSendResult>;
}

export interface BdPendingWakeStoreOptions {
  readonly leaseMs?: number;
  readonly now?: () => number;
}

export class BdPendingWakeStore implements PendingWakeStore {
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(private readonly bd: CommandRunner, options: BdPendingWakeStoreOptions = {}) {
    this.leaseMs = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, options.leaseMs ?? DEFAULT_LEASE_MS));
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: PmWakeInput, at = this.now()): Promise<PendingWakeRecord> {
    const payload: PendingWakePayload = {
      projectIdentifier: input.projectIdentifier,
      agentId: input.agentId,
      msgId: input.wakeId,
      reason: input.reason,
      detail: input.detail,
      body: formatWakeMessage(input),
      ...(input.correlation ? { correlation: validateCorrelation(input.correlation) } : {}),
      createdAt: new Date(at).toISOString(),
    };
    const out = await this.bd([
      'create', '--type', 'gate', '--title', `pending PM wake ${payload.msgId}`,
      '--description', 'Durable PM inbox wake; immutable payload is in metadata.',
      '-l', PENDING_WAKE_LABEL, '--metadata', JSON.stringify({ v: 1, state: 'pending', payload, attempts: 0 }), '--silent',
    ]);
    const id = out.trim();
    assertId(id);
    const record = await this.get(id);
    if (!record) throw new Error(`bd did not persist pending wake ${payload.msgId}`);
    if (!samePayload(record.payload, payload)) throw new Error(`bd changed pending wake payload ${payload.msgId}`);
    return record;
  }

  async listPending(): Promise<PendingWakeRecord[]> {
    const out = await this.bd([
      'list', '--label', PENDING_WAKE_LABEL, '--status', ACTIVE_STATUSES,
      '--include-gates', '--include-ephemeral', '--limit', '0', '--json',
    ]);
    return rows(out, 'bd list (pending wakes)').flatMap((row) => {
      const record = toRecord(row);
      return record && record.status !== 'closed' ? [record] : [];
    });
  }

  async get(id: string): Promise<PendingWakeRecord | null> {
    assertId(id);
    const out = await this.bd([
      'list', '--id', id, '--all', '--include-gates', '--include-ephemeral', '--limit', '0', '--json',
    ]);
    const row = rows(out, `bd list (pending wake ${id})`)[0];
    return row ? toRecord(row) : null;
  }

  async claim(id: string): Promise<PendingWakeClaim> {
    assertId(id);
    if (HELD_CLAIMS.has(id) || CLAIM_IN_FLIGHT.has(id)) return { authorized: false, record: await this.get(id) };
    CLAIM_IN_FLIGHT.add(id);
    try {
      const record = await this.get(id);
      if (!record || record.status === 'closed') return { authorized: false, record };
      if (record.status === 'in_progress' && (record.leaseExpiresAt ?? Infinity) > this.now()) return { authorized: false, record };
      if (record.status === 'in_progress') {
        try {
          await this.bd(['reclaim', '--older-than', '0s', '--id', id]);
        } catch {
          return { authorized: false, record: await this.get(id) };
        }
      }

      try {
        await this.bd(['update', id, '--assignee', OWNER, '--status', 'in_progress']);
      } catch {
        return { authorized: false, record: await this.get(id) };
      }
      const claimed = await this.get(id);
      if (!claimed || claimed.status !== 'in_progress' || claimed.owner !== OWNER) return { authorized: false, record: claimed };
      const leaseExpiresAt = this.now() + this.leaseMs;
      await this.bd(['update', id, '--metadata', JSON.stringify({ ...metadataFromRow(claimed), leaseExpiresAt })]);
      HELD_CLAIMS.add(id);
      return { authorized: true, record: { ...claimed, leaseExpiresAt } };
    } finally {
      CLAIM_IN_FLIGHT.delete(id);
    }
  }

  async sendClaimed(record: PendingWakeRecord, sink: PmWakeSink, at = this.now()): Promise<PendingWakeSendResult> {
    const owned = await this.get(record.id);
    if (!owned || owned.status !== 'in_progress' || owned.owner !== OWNER) return { authorized: false, record: owned };
    let outcome: PmWakeOutcome;
    try {
      outcome = await sink.wake({
        agentId: owned.payload.agentId,
        projectIdentifier: owned.payload.projectIdentifier,
        reason: owned.payload.reason,
        detail: owned.payload.detail,
        wakeId: owned.payload.msgId,
        ...(owned.payload.correlation ? { correlation: owned.payload.correlation } : {}),
      });
    } catch (error) {
      outcome = { ok: false, error: errorMessage(error) };
    }
    const receipt: PendingWakeReceipt = {
      accepted: outcome.accepted ?? outcome.ok,
      applicationDelivered: outcome.applicationDelivered ?? false,
      ...(outcome.reason ?? outcome.error ? { reason: outcome.reason ?? outcome.error } : {}),
      msgId: owned.payload.msgId,
      observedAt: new Date(at).toISOString(),
    };
    const delivered = receipt.accepted && receipt.applicationDelivered;
    const metadata = metadataFromRow(owned);
    await this.bd(['update', record.id, '--metadata', JSON.stringify({
      ...metadata,
      state: delivered ? 'delivered' : 'pending',
      attempts: Number(metadata['attempts'] ?? 0) + 1,
      receipt,
      leaseExpiresAt: delivered ? null : this.now() + this.leaseMs,
    })]);
    if (delivered) await this.bd(['update', record.id, '--status', 'closed']);
    HELD_CLAIMS.delete(record.id);
    return { authorized: true, record: await this.get(record.id), outcome, receipt };
  }

  async claimAndSend(id: string, sink: PmWakeSink): Promise<PendingWakeSendResult> {
    const claim = await this.claim(id);
    if (!claim.authorized || !claim.record) return claim;
    return this.sendClaimed(claim.record, sink);
  }
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`pending wake: invalid bead id ${JSON.stringify(id)}`);
}

function validateCorrelation(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const allowed = new Set(['bead', 'step', 'moleculeRun', 'appServerRun', 'lease']);
  if (Object.keys(value).some((key) => !allowed.has(key) || typeof value[key] !== 'string')) {
    throw new Error('pending wake correlation contains an unknown key or non-string value');
  }
  return { ...value };
}

function rows(raw: string, context: string): Record<string, unknown>[] {
  const parsed = parseJsonOutput(raw, context);
  if (!Array.isArray(parsed)) throw new Error(`${context}: expected a JSON array`);
  return parsed.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

function toRecord(row: Record<string, unknown>): PendingWakeRecord | null {
  const id = String(row['id'] ?? '');
  const metadata = row['metadata'];
  if (!id || typeof metadata !== 'object' || metadata === null) return null;
  const md = metadata as Record<string, unknown>;
  const payload = md['payload'];
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['projectIdentifier'] !== 'string' || typeof p['agentId'] !== 'string' || typeof p['msgId'] !== 'string' || typeof p['body'] !== 'string' || typeof p['detail'] !== 'string') return null;
  const correlation = p['correlation'];
  if (correlation !== undefined && (typeof correlation !== 'object' || correlation === null || Array.isArray(correlation))) return null;
  const receipt = md['receipt'];
  return {
    id,
    status: String(row['status'] ?? ''),
    ...(typeof row['assignee'] === 'string' ? { owner: row['assignee'] } : typeof row['owner'] === 'string' ? { owner: row['owner'] } : {}),
    ...(typeof md['leaseExpiresAt'] === 'number' ? { leaseExpiresAt: md['leaseExpiresAt'] } : {}),
    rawMetadata: md,
    payload: {
      projectIdentifier: p['projectIdentifier'],
      agentId: p['agentId'],
      msgId: p['msgId'],
      reason: isWakeReason(p['reason']) ? p['reason'] : 'backstop',
      detail: p['detail'],
      body: p['body'],
      ...(isStringMap(correlation) ? { correlation } : {}),
      createdAt: typeof p['createdAt'] === 'string' ? p['createdAt'] : '',
    },
    ...(isReceipt(receipt) ? { receipt } : {}),
  };
}

function isWakeReason(value: unknown): value is PmWakeInput['reason'] {
  return value === 'event' || value === 'ready' || value === 'stall' || value === 'backstop';
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isReceipt(value: unknown): value is PendingWakeReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt['accepted'] === 'boolean' && typeof receipt['applicationDelivered'] === 'boolean' && typeof receipt['msgId'] === 'string' && typeof receipt['observedAt'] === 'string' && (receipt['reason'] === undefined || typeof receipt['reason'] === 'string');
}

function metadataFromRow(record: PendingWakeRecord): Record<string, unknown> {
  return record.rawMetadata ?? {};
}

function samePayload(left: PendingWakePayload, right: PendingWakePayload): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value !== 'object' || value === null) return JSON.stringify(value);
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  };
  return canonical(left) === canonical(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
