/**
 * WaitStore on the `bd` CLI (vibesync-9g24). Argv arrays only, through the
 * injected CommandRunner (no shell strings, no direct Dolt access).
 *
 * bd behaviours relied on (verified on bd 1.3.2, {@link MIN_BD_VERSION_FOR_WAITS}):
 *   - `bd create --type gate --metadata <json> -l <label> --silent` stores JSON
 *     metadata and prints only the id;
 *   - `bd update <id> --metadata <json>` is a SHALLOW MERGE, and works on closed beads;
 *   - `bd list --id a,b --all --include-gates --include-ephemeral --json` omits
 *     ids that do not exist (so absence is observable) and returns gates;
 *   - a gate carrying our label is NOT touched by `bd gate check` (it has no
 *     await_id/type), so bd's own gate sweeper cannot close a wait behind our back;
 *   - `bd dep add <waiter> <wait>` keeps the waiter out of `bd ready` until the
 *     wait bead closes;
 *   - `bd close` on an already-closed bead exits 0.
 */

import { parseJsonOutput, type CommandRunner } from '../beads/cli.js';
import {
  WAIT_LABEL,
  type NewWait,
  type WaitMode,
  type WaitRecord,
  type WaitState,
  type WaitStore,
  type WaitWaiter,
} from './types.js';

type Row = Record<string, unknown>;

/** Conservative bead-id shape; rejects anything that could be parsed as a flag or split into several ids. */
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function assertBeadId(id: string, what: string): void {
  if (!BEAD_ID.test(id)) throw new Error(`${what}: ${JSON.stringify(id)} is not a valid bead id`);
}

const OPEN_STATUSES = 'open,in_progress,blocked,deferred';
const WAIT_STATES: ReadonlySet<string> = new Set(['pending', 'ready', 'closed', 'canceled', 'expired', 'failed']);

export class BdWaitStore implements WaitStore {
  constructor(private readonly bd: CommandRunner) {}

  async create(
    wait: NewWait,
    meta: { readonly createdAt: string; readonly expiresAt: string | undefined },
  ): Promise<string> {
    const mode: WaitMode = wait.mode ?? 'all';
    const metadata: Record<string, unknown> = {
      v: 1,
      state: 'pending' satisfies WaitState,
      mode,
      on: [...wait.on],
      waiter: { kind: wait.waiter.kind, id: wait.waiter.id },
      createdAt: meta.createdAt,
      wakeAttempts: 0,
      ...(wait.note !== undefined ? { note: wait.note } : {}),
      ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
    };
    const out = await this.bd([
      'create',
      '--type', 'gate',
      `--title=wait (${mode}) on ${wait.on.join(', ')}`,
      `--description=${wait.note ?? `Durable wait (${mode}) on ${wait.on.join(', ')}`}`,
      '-l', WAIT_LABEL,
      '--metadata', JSON.stringify(metadata),
      '--silent',
    ]);
    const id = out.trim();
    if (!BEAD_ID.test(id)) {
      throw new Error(`bd create returned an unexpected wait id: ${JSON.stringify(out.slice(0, 120))}`);
    }
    return id;
  }

  async listActive(): Promise<WaitRecord[]> {
    const out = await this.bd([
      'list', '--label', WAIT_LABEL, '--status', OPEN_STATUSES,
      '--include-gates', '--include-ephemeral', '--limit', '0', '--json',
    ]);
    return rows(out, 'bd list (waits)').flatMap((r) => {
      const rec = toRecord(r);
      return rec ? [rec] : [];
    });
  }

  async get(id: string): Promise<WaitRecord | null> {
    assertBeadId(id, 'get wait');
    const out = await this.bd([
      'list', '--id', id, '--all', '--include-gates', '--include-ephemeral', '--limit', '0', '--json',
    ]);
    const row = rows(out, `bd list (wait ${id})`)[0];
    return row ? toRecord(row) : null;
  }

  async beadStatuses(ids: readonly string[]): Promise<Map<string, string>> {
    for (const id of ids) assertBeadId(id, 'wait target');
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const out = await this.bd([
      'list', '--id', ids.join(','), '--all', '--include-gates', '--include-ephemeral', '--limit', '0', '--json',
    ]);
    for (const r of rows(out, 'bd list (wait targets)')) {
      const id = String(r['id'] ?? '');
      if (id) result.set(id, String(r['status'] ?? ''));
    }
    return result;
  }

  async patch(id: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
    assertBeadId(id, 'patch wait');
    await this.bd(['update', id, '--metadata', JSON.stringify(patch)]);
  }

  async close(id: string, reason: string): Promise<void> {
    assertBeadId(id, 'close wait');
    await this.bd(['close', id, `--reason=${reason}`]);
  }

  async blockWaiter(waiterBeadId: string, waitId: string): Promise<void> {
    assertBeadId(waiterBeadId, 'waiter bead');
    assertBeadId(waitId, 'wait');
    await this.bd(['dep', 'add', waiterBeadId, waitId]);
  }
}

function rows(raw: string, context: string): Row[] {
  const parsed = parseJsonOutput(raw, context);
  if (!Array.isArray(parsed)) throw new Error(`${context}: expected a JSON array`);
  return parsed.filter((r): r is Row => typeof r === 'object' && r !== null);
}

/** Null when the row is not a well-formed wait (a foreign bead with our label must not crash the sweep). */
function toRecord(r: Row): WaitRecord | null {
  const id = String(r['id'] ?? '');
  const md = r['metadata'];
  if (!id || typeof md !== 'object' || md === null) return null;
  const m = md as Row;
  const on = m['on'];
  const mode = m['mode'];
  const state = m['state'];
  const waiter = m['waiter'] as Row | undefined;
  if (!Array.isArray(on) || on.length === 0 || !on.every((x) => typeof x === 'string')) return null;
  if (mode !== 'any' && mode !== 'all') return null;
  if (typeof state !== 'string' || !WAIT_STATES.has(state)) return null;
  if (!waiter || typeof waiter['id'] !== 'string' || typeof waiter['kind'] !== 'string') return null;
  const attempts = Number(m['wakeAttempts']);
  return {
    id,
    mode,
    on: on as string[],
    note: typeof m['note'] === 'string' ? m['note'] : undefined,
    waiter: { kind: waiter['kind'] as WaitWaiter['kind'], id: waiter['id'] },
    state: state as WaitState,
    createdAt: typeof m['createdAt'] === 'string' ? m['createdAt'] : undefined,
    expiresAt: typeof m['expiresAt'] === 'string' ? m['expiresAt'] : undefined,
    wakeAttempts: Number.isFinite(attempts) ? attempts : 0,
    reason: typeof m['reason'] === 'string' ? m['reason'] : undefined,
    beadStatus: String(r['status'] ?? ''),
  };
}
