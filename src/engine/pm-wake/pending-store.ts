import { randomUUID } from 'node:crypto';

import type { CommandRunner } from '../beads/cli.js';
import { parseJsonOutput } from '../beads/cli.js';
import { formatWakeMessage, type PmWakeInput, type PmWakeOutcome, type PmWakeSink } from './contract.js';

export const PENDING_WAKE_LABEL = 'vibesync:pending-wake';
const ACTIVE_STATUSES = 'open,in_progress,blocked,deferred';
const HEARTBEAT_INTERVAL_MS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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
  readonly assignee?: string;
  readonly leaseExpiresAt?: number;
  readonly claimToken?: string;
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
  readonly now?: () => number;
  readonly logger?: { warn?(o: unknown, message: string): void };
}

export class BdPendingWakeStore implements PendingWakeStore {
  private readonly now: () => number;
  private readonly owner: string;
  private readonly logger: { warn?(o: unknown, message: string): void } | undefined;

  constructor(private readonly bd: CommandRunner, options: BdPendingWakeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.owner = `vibesync-pending-wake-${process.pid}-${randomUUID()}`;
    this.logger = options.logger;
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
    const record = await this.get(id);
    if (!record || record.status === 'closed') return { authorized: false, record };
    if (this.leaseIsLive(record)) return { authorized: false, record };
    if (record.status === 'in_progress' && !(await this.reclaimExpired(id))) return { authorized: false, record: await this.get(id) };
    const claimedFrom = await this.get(id);
    if (!claimedFrom || !isClaimable(claimedFrom)) return { authorized: false, record: claimedFrom };
    return this.takeClaim(claimedFrom);
  }

  /** Someone holds the wake and their lease has not run out. A missing expiry counts as live. */
  private leaseIsLive(record: PendingWakeRecord): boolean {
    return record.status === 'in_progress' && (record.leaseExpiresAt ?? Infinity) > this.now();
  }

  /**
   * Native reclaim checks the actual lease atomically and only on this replica.
   * Metadata timestamps must never authorize stealing a claim. False when bd refuses.
   */
  private async reclaimExpired(id: string): Promise<boolean> {
    try {
      await this.bd(['reclaim', '--older-than', '0s', '--id', id]);
      return true;
    } catch {
      return false;
    }
  }

  /** Claim the wake under a fresh token; authorized only when bd records exactly that token as the holder. */
  private async takeClaim(claimedFrom: PendingWakeRecord): Promise<PendingWakeClaim> {
    const id = claimedFrom.id;
    const claimToken = `${this.owner}-${randomUUID()}`;
    try {
      await this.bd([
        'update', id,
        '--claim', '--actor', claimToken,
        '--metadata', JSON.stringify({ ...metadataFromRow(claimedFrom), claimToken }),
      ]);
    } catch {
      return { authorized: false, record: await this.get(id) };
    }
    const claimed = await this.get(id);
    const held = claimed?.status === 'in_progress' && claimed.assignee === claimToken;
    return { authorized: held, record: claimed };
  }

  private async renewClaim(record: PendingWakeRecord): Promise<PendingWakeClaim> {
    try {
      await this.bd(['heartbeat', record.id, '--actor', record.assignee ?? '']);
      const renewed = await this.get(record.id);
      return { authorized: renewed?.assignee === record.assignee && renewed?.claimToken === record.claimToken, record: renewed };
    } catch {
      return { authorized: false, record: await this.get(record.id) };
    }
  }

  async sendClaimed(record: PendingWakeRecord, sink: PmWakeSink, at = this.now()): Promise<PendingWakeSendResult> {
    const owned = await this.get(record.id);
    if (!owned || !stillHeldBy(owned, record)) return { authorized: false, record: owned };
    if (alreadyDelivered(owned)) return this.closeAlreadyDelivered(owned, record);
    const heartbeat = startLeaseHeartbeat(this.bd, record.id, record.assignee ?? '', this.logger);
    try {
      const refreshed = await this.renewClaim(owned);
      if (!refreshed.authorized || !refreshed.record) return { authorized: false, record: refreshed.record };
      const renewed = await this.get(record.id);
      if (!renewed || renewed.claimToken !== record.claimToken) return { authorized: false, record: renewed };
      const outcome = await deliver(sink, owned.payload);
      const receipt = receiptFor(outcome, owned.payload.msgId, at);
      await this.recordAttempt(owned, record, receipt);
      return { authorized: true, record: await this.get(record.id), outcome, receipt };
    } finally {
      await heartbeat.stop();
    }
  }

  /**
   * The delivery receipt survived but closing the bead did not. Complete
   * bookkeeping under the current claim; never replay the external effect.
   */
  private async closeAlreadyDelivered(owned: PendingWakeRecord, record: PendingWakeRecord): Promise<PendingWakeSendResult> {
    const receipt = owned.receipt!;
    await this.closeHeld(record);
    return {
      authorized: true, record: await this.get(record.id), receipt,
      outcome: { ok: true, accepted: true, applicationDelivered: true, msgId: receipt.msgId, ...(receipt.reason ? { reason: receipt.reason } : {}) },
    };
  }

  /** Store the attempt's receipt and count it; close the wake when it was delivered. Both writes are guarded by the claim. */
  private async recordAttempt(owned: PendingWakeRecord, record: PendingWakeRecord, receipt: PendingWakeReceipt): Promise<void> {
    const delivered = receipt.accepted && receipt.applicationDelivered;
    const metadata = metadataFromRow(owned);
    await this.bd([
      'update', record.id,
      '--metadata', JSON.stringify({
        ...metadata,
        state: delivered ? 'delivered' : 'pending',
        attempts: Number(metadata['attempts'] ?? 0) + 1,
        receipt,
      }),
      ...heldGuard(record),
    ]);
    if (delivered) await this.closeHeld(record);
  }

  private async closeHeld(record: PendingWakeRecord): Promise<void> {
    await this.bd(['update', record.id, '--status', 'closed', ...heldGuard(record)]);
  }

  async claimAndSend(id: string, sink: PmWakeSink): Promise<PendingWakeSendResult> {
    const claim = await this.claim(id);
    if (!claim.authorized || !claim.record) return claim;
    return this.sendClaimed(claim.record, sink);
  }
}

/** Open or blocked: the states bd lets a new claim start from. */
function isClaimable(record: PendingWakeRecord): boolean {
  return record.status === 'open' || record.status === 'blocked';
}

/** bd write guards: the update applies only while this claim still holds the wake. */
function heldGuard(record: PendingWakeRecord): string[] {
  return ['--if-assignee', record.assignee ?? '', '--if-status', 'in_progress'];
}

/** The wake is still in progress under exactly this claim (assignee and claim token). */
function stillHeldBy(current: PendingWakeRecord, claim: PendingWakeRecord): boolean {
  return current.status === 'in_progress' && current.assignee === claim.assignee && current.claimToken === claim.claimToken;
}

/** A receipt for this wake's own message says it was accepted and delivered. */
function alreadyDelivered(record: PendingWakeRecord): boolean {
  const receipt = record.receipt;
  return Boolean(receipt?.accepted && receipt.applicationDelivered && receipt.msgId === record.payload.msgId);
}

/** Send the wake; a sink that throws is a failed attempt, never an exception. */
async function deliver(sink: PmWakeSink, payload: PendingWakePayload): Promise<PmWakeOutcome> {
  try {
    return await sink.wake({
      agentId: payload.agentId,
      projectIdentifier: payload.projectIdentifier,
      reason: payload.reason,
      detail: payload.detail,
      wakeId: payload.msgId,
      ...(payload.correlation ? { correlation: payload.correlation } : {}),
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function receiptFor(outcome: PmWakeOutcome, msgId: string, at: number): PendingWakeReceipt {
  const reason = outcome.reason ?? outcome.error;
  return {
    accepted: outcome.accepted ?? outcome.ok,
    applicationDelivered: outcome.applicationDelivered ?? false,
    ...(reason ? { reason } : {}),
    msgId,
    observedAt: new Date(at).toISOString(),
  };
}

function startLeaseHeartbeat(bd: CommandRunner, id: string, assignee: string, logger?: { warn?(o: unknown, message: string): void }) {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = bd(['heartbeat', id, '--actor', assignee]).then(() => undefined).catch((error: unknown) => {
      logger?.warn?.({ id, error: errorMessage(error) }, 'pm-wake: Beads lease heartbeat failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
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
  if (!id || !isObject(metadata)) return null;
  const payload = toPayload(metadata['payload']);
  if (!payload) return null;
  const receipt = metadata['receipt'];
  return {
    id,
    status: String(row['status'] ?? ''),
    ...leaseFields(row, metadata),
    rawMetadata: metadata,
    payload,
    ...(isReceipt(receipt) ? { receipt } : {}),
  };
}

/** Who holds the wake and until when: assignee, owner, lease expiry, and the claim token from metadata. */
function leaseFields(row: Record<string, unknown>, metadata: Record<string, unknown>): Pick<PendingWakeRecord, 'assignee' | 'owner' | 'leaseExpiresAt' | 'claimToken'> {
  const leaseExpiresAt = typeof row['lease_expires_at'] === 'string' ? Date.parse(row['lease_expires_at']) : NaN;
  return {
    assignee: stringOr(row['assignee'], ''),
    ...(typeof row['owner'] === 'string' ? { owner: row['owner'] } : {}),
    ...(Number.isFinite(leaseExpiresAt) ? { leaseExpiresAt } : {}),
    ...(typeof metadata['claimToken'] === 'string' ? { claimToken: metadata['claimToken'] } : {}),
  };
}

const REQUIRED_PAYLOAD_STRINGS = ['projectIdentifier', 'agentId', 'msgId', 'body', 'detail'] as const;

/** The stored payload, or null when a required field is missing or the correlation is not an object. */
function toPayload(value: unknown): PendingWakePayload | null {
  if (!isObject(value)) return null;
  if (!REQUIRED_PAYLOAD_STRINGS.every((key) => typeof value[key] === 'string')) return null;
  const correlation = value['correlation'];
  if (correlation !== undefined && !isObject(correlation)) return null;
  return {
    projectIdentifier: value['projectIdentifier'] as string,
    agentId: value['agentId'] as string,
    msgId: value['msgId'] as string,
    reason: isWakeReason(value['reason']) ? value['reason'] : 'backstop',
    detail: value['detail'] as string,
    body: value['body'] as string,
    ...(isStringMap(correlation) ? { correlation } : {}),
    createdAt: stringOr(value['createdAt'], ''),
  };
}

/** A plain object: not null, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function isWakeReason(value: unknown): value is PmWakeInput['reason'] {
  return value === 'event' || value === 'ready' || value === 'stall' || value === 'backstop';
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isReceipt(value: unknown): value is PendingWakeReceipt {
  if (!isObject(value)) return false;
  const typed = (key: string, type: 'boolean' | 'string') => typeof value[key] === type;
  const reasonOk = value['reason'] === undefined || typeof value['reason'] === 'string';
  return typed('accepted', 'boolean') && typed('applicationDelivered', 'boolean') && typed('msgId', 'string') && typed('observedAt', 'string') && reasonOk;
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
