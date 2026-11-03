/**
 * IrohPmWakeSink — the REAL {@link PmWakeSink} (vibesync-2bgv).
 *
 * One wake = ONE `input` to the PM agent over the Iroh connection the
 * orchestration plane already dials for formula steps (vibesync-x38j/jni4): one
 * client, one auth, no new transport. The connection arrives through an injected
 * getter, so this module never dials and a second connection can never exist.
 *
 * WHICH CONVERSATION. The wake lands where a human reads the PM:
 *   1. `conversationId` (VIBESYNC_PM_WAKE_CONVERSATION_ID) when configured;
 *   2. else the PM's most recently active INTERACTIVE conversation, from
 *      `admin_rpc conversation.list {agent_id}` (chat.read, inside the vibesync
 *      grant; `conversation.list_agent` is refused for this grant, proven live).
 *      Interactive = not archived, not `hidden`, `conversation_class` not
 *      'autonomous' (letta-mobile's IrohAgentMessageRouter.pickMostRecentInteractive
 *      rule: heartbeat/goal/dispatch conversations are never a target). Recency =
 *      last_message_at ?? updated_at ?? created_at;
 *   3. else (the PM has none) a fresh conversation created on the PM.
 * If listing fails (method not found, forbidden, link down) the wake FAILS
 * (ok:false). It never falls back to a fresh conversation: that would report
 * success for a message no human will ever read.
 * A wakeId is pinned to the conversation it first chose, so a retry (PmWaker
 * reuses the wakeId) hits the same conversation and the wrapper dedupes on
 * client_message_id even if "most recent" moved in between.
 *
 * WHAT "ok" MEANS. The wrapper's `input_accepted{accepted:true}`: the PM
 * received the message (it is running it or has it queued behind an active
 * turn). It does NOT wait for turn_finished: a PM turn can run for many
 * minutes, and the waker's question is "did the PM get the reason", not "did
 * the PM finish". An accepted:false answer, a refusal (forbidden, method not
 * found) or a dead transport is ok:false with the reason; the sink never throws.
 *
 * PERMISSION MODE. `runtime_start` requires a mode. The conversation's CURRENT
 * mode (`permission_mode.get`) is passed back unchanged so a wake never loosens
 * what the human chose; unknown/unsupported -> 'unrestricted' (what the step
 * runner uses).
 *
 * Secrets: only error messages and ids are logged; the key and any token live
 * inside IrohConnection and never reach this module.
 *
 * Layering: scheduler -> runtime is downward (allowed, invariant 1). The
 * connection getter is the only runtime coupling to boot.
 */

import { IrohConnectionLostError, IrohTimeoutError } from '../runtime/iroh/connection.js';
import type { IrohConnection } from '../runtime/iroh/connection.js';
import { createConversation, submitInput } from '../runtime/iroh/turn-client.js';
import type { PmWakeOutcome } from './pm-waker.js';
import { formatWakeMessage } from './pm-waker.js';
import type { PmWakeInput, PmWakeSink } from './pm-waker.js';

export interface IrohPmWakeSinkOptions {
  /** The plane's shared connection. May throw (e.g. no key configured): that becomes ok:false. */
  readonly getConnection: () => IrohConnection;
  /** Explicit legacy direct-input target (VIBESYNC_PM_WAKE_CONVERSATION_ID). */
  readonly conversationId?: string;
  readonly logger?: {
    info?(o: unknown, m: string): void;
    warn?(o: unknown, m: string): void;
  };
}

/** How many wakeId -> conversation pins to remember (retries are minutes apart; a handful is plenty). */
const MAX_PINS = 64;
const LIST_LIMIT = 200;
const DEFAULT_MODE = 'unrestricted';
const KNOWN_MODES: ReadonlySet<string> = new Set(['standard', 'acceptEdits', 'strict', 'unrestricted']);

export class IrohPmWakeSink implements PmWakeSink {
  private readonly pins = new Map<string, string>();

  constructor(private readonly opts: IrohPmWakeSinkOptions) {}

  async wake(input: PmWakeInput): Promise<PmWakeOutcome> {
    try {
      const response = await this.deliver(input);
      // Legacy direct input measures acceptance, not A2A application delivery.
      // Leave applicationDelivered unset to preserve its existing scheduling policy.
      return { ...response, accepted: response.ok, msgId: input.wakeId };
    } catch (err) {
      const error = errMsg(err);
      this.opts.logger?.warn?.({ agentId: input.agentId, reason: input.reason, wakeId: input.wakeId, error }, 'pm-wake: iroh delivery failed');
      return { ok: false, accepted: false, applicationDelivered: false, msgId: input.wakeId, error };
    }
  }

  private async deliver(input: PmWakeInput): Promise<{ ok: boolean; error?: string }> {
    const conn = this.opts.getConnection();
    // One redial-and-resend on a dropped link; the same wakeId makes the resend idempotent.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await conn.connect();
        const conversationId = await this.resolveConversation(conn, input);
        const mode = await currentMode(conn, input.agentId, conversationId);
        const res = await submitInput(
          conn,
          { agentId: input.agentId, conversationId, text: formatWakeMessage(input), clientMessageId: input.wakeId },
          mode,
        );
        if (!res.accepted) {
          this.opts.logger?.warn?.({ agentId: input.agentId, conversationId, reason: input.reason, wakeId: input.wakeId, error: res.error }, 'pm-wake: PM input rejected');
          return { ok: false, error: `input rejected: ${res.error}` };
        }
        this.opts.logger?.info?.(
          { agentId: input.agentId, conversationId, reason: input.reason, wakeId: input.wakeId, disposition: res.disposition ?? 'unspecified' },
          'pm-wake: input accepted; application delivery unconfirmed',
        );
        return { ok: true };
      } catch (err) {
        if (attempt < 2 && (err instanceof IrohConnectionLostError || err instanceof IrohTimeoutError)) continue;
        throw err;
      }
    }
  }

  private async resolveConversation(conn: IrohConnection, input: PmWakeInput): Promise<string> {
    const pinned = this.pins.get(input.wakeId);
    if (pinned) return pinned;
    const chosen = this.opts.conversationId?.trim() || (await pickInteractiveConversation(conn, input.agentId)) || (await createConversation(conn, input.agentId));
    this.pin(input.wakeId, chosen);
    return chosen;
  }

  private pin(wakeId: string, conversationId: string): void {
    this.pins.delete(wakeId);
    this.pins.set(wakeId, conversationId);
    while (this.pins.size > MAX_PINS) this.pins.delete(this.pins.keys().next().value as string);
  }
}

/** The PM's most recently active interactive conversation, or null when it has none. Throws when the list cannot be read. */
async function pickInteractiveConversation(conn: IrohConnection, agentId: string): Promise<string | null> {
  const result = await conn.rpc('conversation.list', { agent_id: agentId, limit: LIST_LIMIT });
  const rows = Array.isArray(result) ? result : Array.isArray(asRecord(result)?.['conversations']) ? (asRecord(result)!['conversations'] as unknown[]) : [];
  let best: { id: string; at: number } | null = null;
  for (const row of rows) {
    const c = asRecord(row);
    const id = str(c?.['id']);
    if (!c || !id) continue;
    if (str(c['agent_id']) !== null && str(c['agent_id']) !== agentId) continue; // never another agent's conversation
    if (c['archived'] === true || c['hidden'] === true || str(c['conversation_class']) === 'autonomous') continue;
    const at = Date.parse(str(c['last_message_at']) ?? str(c['updated_at']) ?? str(c['created_at']) ?? '');
    const key = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (!best || key > best.at) best = { id, at: key };
  }
  return best?.id ?? null;
}

async function currentMode(conn: IrohConnection, agentId: string, conversationId: string): Promise<string> {
  try {
    const r = asRecord(await conn.rpc('permission_mode.get', { agent_id: agentId, conversation_id: conversationId }));
    const mode = str(r?.['mode']);
    return mode && KNOWN_MODES.has(mode) ? mode : DEFAULT_MODE;
  } catch (err) {
    // A dropped link must surface (the caller redials); a host without the method just gets the default.
    if (err instanceof IrohConnectionLostError || err instanceof IrohTimeoutError) throw err;
    return DEFAULT_MODE;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
