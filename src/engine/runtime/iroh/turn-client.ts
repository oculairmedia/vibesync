/**
 * Turn client — run ONE turn on a Letta agent conversation over an
 * IrohConnection and report how it ended (vibesync-x38j / vibesync-57mi).
 *
 * Sequence (proven live from Bun):
 *   [conversation.create]  → runtime_start(mode) → input(client_message_id)
 *   → input_accepted (acceptance ONLY) → stream frames … → turn_finished
 *   → message.list → last assistant message = final output.
 *
 * Rules this module enforces:
 *   - TERMINAL = `turn_finished`. `boundaryOf(stop_reason)` classifies it;
 *     `requires_approval` and unknown reasons are NOT terminal-complete:
 *     requires_approval is a STEP FAILURE ('requires_approval'), never a hang.
 *     A `pending_approvals` snapshot still non-empty when the loop goes idle
 *     is the same failure.
 *   - The final text is NEVER assembled from deltas; deltas are progress only.
 *   - client_message_id is mandatory and stable. After a dropped link the SAME
 *     input is re-sent on the redialed connection; the wrapper dedupes and
 *     replays parked frames incl. the terminal. If no terminal is replayed
 *     within `replayWaitMs` (wrapper restarted: parking is in-memory) the turn
 *     is reconciled from message.list.
 *   - Refusals (forbidden / method-not-found / auth) are not retried.
 */

import {
  IrohConnectionError,
  IrohConnectionLostError,
  IrohRefusedError,
  IrohTimeoutError,
  refusalFrom,
} from './connection.js';
import type { Frame, IrohConnection } from './connection.js';
import { boundaryOf, REQUIRES_APPROVAL } from './stop-reason.js';

export interface TurnRequest {
  readonly agentId: string;
  /** Existing conversation, or null to create a fresh one on the agent. */
  readonly conversationId: string | null;
  readonly text: string;
  /** Stable per logical prompt (derive from moleculeId+stepId+attempt). */
  readonly clientMessageId: string;
}

export interface TurnProgress {
  readonly kind: 'accepted' | 'delta' | 'tool-call' | 'redial' | 'reconciled';
  readonly text?: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly disposition?: string;
}

export interface RunTurnOptions {
  readonly mode?: string;
  readonly cwd?: string;
  readonly turnTimeoutMs?: number;
  readonly approvalGraceMs?: number;
  readonly replayWaitMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly maxRedials?: number;
  readonly messageListLimit?: number;
  /** turn ids already consumed on this conversation (guards against replayed old terminals). */
  readonly ignoreTurnIds?: Set<string>;
  /** Abort the wait (session stopped). The turn itself keeps running on the host. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: TurnProgress) => void;
}

export type TurnFailureReason =
  | 'requires_approval'
  | 'input_rejected'
  | 'turn_timeout'
  | 'cancelled'
  | 'stop_reason'
  | null;

export interface TurnResult {
  readonly conversationId: string;
  readonly stopReason: string | null;
  /** completed | cancelled | failed (never awaiting_approval/continuing: those are mapped). */
  readonly boundary: 'completed' | 'cancelled' | 'failed';
  readonly failureReason: TurnFailureReason;
  readonly error: string | null;
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly finalText: string;
  readonly usage: Record<string, unknown> | null;
  /** True when the outcome came from message.list instead of a replayed turn_finished. */
  readonly reconciled: boolean;
}

const DEFAULTS = {
  mode: 'unrestricted',
  turnTimeoutMs: 10 * 60 * 1000,
  approvalGraceMs: 2_000,
  replayWaitMs: 10_000,
  reconcileIntervalMs: 5_000,
  maxRedials: 5,
  messageListLimit: 50,
};

type Outcome =
  | { readonly kind: 'terminal'; readonly frame: Frame }
  | { readonly kind: 'approval_stuck' }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'reconciled'; readonly text: string; readonly runId: string | null };

export interface ConversationCreateMetadata {
  readonly tags?: readonly string[];
}

/**
 * Create a conversation on `agentId`. `title` is stored as the conversation's
 * `summary`, which is what the app's conversation list shows (otherwise the
 * host shows "Conversation <n>" or auto-titles from the first reply).
 */
export async function createConversation(
  conn: IrohConnection,
  agentId: string,
  title?: string,
  metadata: ConversationCreateMetadata = {},
): Promise<string> {
  const params = { agent_id: agentId, ...optionalField('summary', title), ...optionalField('tags', metadata.tags && [...metadata.tags]) };
  const result = await withRedial(conn, () => conn.rpc('conversation.create', params), 3);
  const conv = conversationIdOf(result);
  if (!conv) throw new IrohRefusedError('conversation.create returned no conversation id');
  return conv;
}

/** conversation.create answers `{id}`, `{conversation: {id}}` or `{conversation_id}`. */
function conversationIdOf(result: unknown): string | null {
  const r = asRecord(result);
  return str(r?.['id']) ?? str(asRecord(r?.['conversation'])?.['id']) ?? str(r?.['conversation_id']);
}

export type InputSubmission =
  | { readonly accepted: true; readonly disposition: string | null }
  | { readonly accepted: false; readonly error: string };

/**
 * `runtime_start(mode)` then ONE `input` carrying `clientMessageId`, and the
 * wrapper's `input_accepted` answer: acceptance ONLY, no waiting for the turn
 * (vibesync-2bgv: a PM wake is "the PM got the message", not "the PM finished").
 * `disposition` is the host's word for what it did with an accepted input
 * ('started', or 'queued' behind an active turn). A refusal (forbidden, method
 * not found, runtime_start failure) throws {@link IrohRefusedError}; any other
 * rejection comes back as `{accepted:false, error}`. Link loss throws the
 * retryable connection errors; the same `clientMessageId` can then be re-sent
 * (the wrapper dedupes).
 */
export async function submitInput(
  conn: IrohConnection,
  req: { readonly agentId: string; readonly conversationId: string; readonly text: string; readonly clientMessageId: string },
  mode: string = DEFAULTS.mode,
  cwd?: string,
): Promise<InputSubmission> {
  if (!req.clientMessageId) throw new Error('submitInput: clientMessageId is required (stable per prompt)');
  await startRuntime(conn, req, mode, cwd);
  return sendInput(conn, req);
}

async function startRuntime(conn: IrohConnection, req: { readonly agentId: string; readonly conversationId: string }, mode: string, cwd?: string): Promise<void> {
  const rs = await conn.request({ type: 'runtime_start', agent_id: req.agentId, conversation_id: req.conversationId, mode, ...optionalField('cwd', cwd) });
  if (rs['success'] !== true) throw refusalFrom('runtime_start', rs['error'] ?? 'runtime_start failed');
}

/** A refusal the caller cannot fix by retrying (forbidden, missing, unsupported) throws; anything else is a rejected input. */
async function sendInput(
  conn: IrohConnection,
  req: { readonly agentId: string; readonly conversationId: string; readonly text: string; readonly clientMessageId: string },
): Promise<InputSubmission> {
  const accepted = await conn.request({
    type: 'input',
    runtime: { agent_id: req.agentId, conversation_id: req.conversationId },
    payload: {
      kind: 'create_message',
      messages: [{ role: 'user', content: req.text, client_message_id: req.clientMessageId }],
    },
  });
  if (accepted['accepted'] === true) return { accepted: true, disposition: str(accepted['disposition']) };
  const err = str(accepted['error']) ?? 'input not accepted';
  if (/forbidden|not found|unknown method|unsupported/i.test(err)) throw refusalFrom('input', err);
  return { accepted: false, error: err };
}

export async function runTurn(conn: IrohConnection, req: TurnRequest, opts: RunTurnOptions = {}): Promise<TurnResult> {
  if (!req.clientMessageId) throw new Error('runTurn: clientMessageId is required (stable per prompt)');
  const o = { ...DEFAULTS, ...stripUndefined(opts) };
  const deadline = Date.now() + o.turnTimeoutMs;
  await conn.connect();
  const conversationId = req.conversationId ?? (await createConversation(conn, req.agentId));
  const ctx: TurnContext = { conn, req, conversationId, o, deadline };

  return runWithRedials(ctx);
}

/** Run attempts until one ends the turn; a dropped link redials, at most maxRedials times. */
async function runWithRedials(ctx: TurnContext): Promise<TurnResult> {
  const { conn, o } = ctx;
  for (let redials = 0; ; redials += 1) {
    const outcome = await attemptOrDisconnect(ctx, redials > 0);
    if (outcome.kind !== 'disconnect') return finish(ctx, outcome);
    if (redials + 1 > o.maxRedials) throw new IrohConnectionError(`turn abandoned after ${o.maxRedials} redials`);
    o.onProgress?.({ kind: 'redial' });
    await conn.connect(); // bounded exponential backoff inside; auth/config errors surface here
  }
}

/** One attempt; a retryable transport error counts as a disconnect, anything else is thrown. */
async function attemptOrDisconnect(ctx: TurnContext, redialed: boolean): Promise<Outcome> {
  try {
    return await attempt(ctx, redialed);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    return { kind: 'disconnect' };
  }
}

type ResolvedOptions = Required<Omit<RunTurnOptions, 'ignoreTurnIds' | 'onProgress' | 'signal' | 'cwd'>> & RunTurnOptions;

/** Everything one turn needs, bundled so the helpers below take one argument. */
interface TurnContext {
  readonly conn: IrohConnection;
  readonly req: TurnRequest;
  readonly conversationId: string;
  readonly o: ResolvedOptions;
  readonly deadline: number;
}

/**
 * Turn state the frame listener writes and the wait loop reads. A mutable
 * holder: the listener runs in a closure, so plain `let`s would be narrowed to
 * their initial value by the control-flow analysis of the loop.
 */
interface TurnState {
  terminal: Frame | null;
  pendingApprovals: number;
  idleWithApproval: boolean;
  /** Loop is idle (waiting, no active runs). Tracked on its own so frame order does not matter. */
  loopIdle: boolean;
  sawActivity: boolean;
  disconnected: boolean;
  wake: (() => void) | null;
}

type Reconciliation = { text: string; runId: string | null };

async function attempt(ctx: TurnContext, redialed: boolean): Promise<Outcome> {
  const { conn, req, conversationId, o } = ctx;
  const st: TurnState = {
    terminal: null,
    pendingApprovals: 0,
    idleWithApproval: false,
    loopIdle: false,
    sawActivity: false,
    disconnected: false,
    wake: null,
  };
  const ping = (): void => st.wake?.();

  const unFrame = conn.onFrame((f) => {
    if (frameConversation(f) !== conversationId) return;
    applyFrame(st, f, o);
    ping();
  });
  const onAbort = (): void => ping();
  o.signal?.addEventListener('abort', onAbort);
  const unDisc = conn.onDisconnect(() => {
    st.disconnected = true;
    ping();
  });

  try {
    await conn.connect();
    const submitted = await submitInput(conn, { agentId: req.agentId, conversationId, text: req.text, clientMessageId: req.clientMessageId }, o.mode, o.cwd);
    if ('error' in submitted) {
      return {
        kind: 'terminal',
        frame: { type: 'turn_finished', stop_reason: 'error', error: submitted.error, __input_rejected: true },
      };
    }
    o.onProgress?.({ kind: 'accepted', ...(submitted.disposition ? { disposition: submitted.disposition } : {}) });
    return await waitForTurnEnd(ctx, st, redialed);
  } finally {
    unFrame();
    unDisc();
    o.signal?.removeEventListener('abort', onAbort);
  }
}

/** Fold one frame for this conversation into the turn state. */
function applyFrame(st: TurnState, f: Frame, o: ResolvedOptions): void {
  switch (f['type']) {
    case 'stream_delta':
      onStreamDelta(st, f, o);
      break;
    case 'pending_approvals':
      onPendingApprovals(st, f);
      break;
    case 'update_loop_status':
      onLoopStatus(st, f);
      break;
    case 'turn_finished':
      onTurnFinished(st, f, o);
      break;
    default:
      break;
  }
}

function onStreamDelta(st: TurnState, f: Frame, o: ResolvedOptions): void {
  st.sawActivity = true;
  const progress = deltaProgress(asRecord(f['delta']));
  if (progress) o.onProgress?.(progress);
}

/** The progress event a stream delta reports: text for assistant or reasoning output, the tool for a tool call, else nothing. */
function deltaProgress(d: Record<string, unknown> | null): TurnProgress | null {
  const kind = str(d?.['message_type']);
  if (kind === 'assistant_message' || kind === 'reasoning_message') {
    const text = contentText(d?.['content']);
    return text ? { kind: 'delta', text } : null;
  }
  if (kind === 'tool_call_message') return toolCallProgress(d);
  return null;
}

function toolCallProgress(d: Record<string, unknown> | null): TurnProgress {
  const tc = asRecord(d?.['tool_call']);
  return { kind: 'tool-call', tool: str(tc?.['name']) ?? str(d?.['tool_name']) ?? 'unknown', args: tc?.['arguments'] ?? null };
}

function onPendingApprovals(st: TurnState, f: Frame): void {
  const list = f['approvals'];
  st.pendingApprovals = Array.isArray(list) ? list.length : 0;
  // Either frame may arrive first (CodeRabbit #55): idle + pending = stalled on approval.
  st.idleWithApproval = st.loopIdle && st.pendingApprovals > 0;
}

function onLoopStatus(st: TurnState, f: Frame): void {
  const ls = asRecord(f['loop_status']);
  const status = str(ls?.['status']);
  const active = Array.isArray(ls?.['active_run_ids']) ? (ls?.['active_run_ids'] as unknown[]).length : 0;
  if (status !== 'WAITING_ON_INPUT' && status !== 'WAITING_ON_APPROVAL') {
    st.sawActivity = true;
    st.loopIdle = false;
  } else {
    st.loopIdle = active === 0;
  }
  st.idleWithApproval = st.loopIdle && st.pendingApprovals > 0;
}

function onTurnFinished(st: TurnState, f: Frame, o: ResolvedOptions): void {
  const tid = str(f['turn_id']);
  if (tid && o.ignoreTurnIds?.has(tid)) return;
  // Unknown reasons are not terminal (provider reasons such as tool_use can
  // arrive mid-turn): keep reading, bounded by the turn timeout.
  if (boundaryOf(str(f['stop_reason'])) === 'continuing') return;
  st.terminal = f;
}

/** Wait for the authoritative end of the turn. */
async function waitForTurnEnd(ctx: TurnContext, st: TurnState, redialed: boolean): Promise<Outcome> {
  const { o, deadline } = ctx;
  const wait: WaitState = {
    nextReconcile: redialed ? Date.now() + o.replayWaitMs : Number.POSITIVE_INFINITY,
    approvalSince: null,
    prevRec: null,
  };
  for (;;) {
    const ended = endedOutcome(st, o.signal);
    if (ended) return ended;
    const now = Date.now();
    if (now >= deadline) return { kind: 'timeout' };
    if (approvalStuck(st, wait, now, o.approvalGraceMs)) return { kind: 'approval_stuck' };
    // Await only when a poll is due (CodeRabbit on #162): an await here when no
    // poll is due lets an abort land after the check above and before the sleep
    // registers its wake, and the loop would then sleep to the turn timeout.
    if (reconcileDue(st, wait, now, o.reconcileIntervalMs)) {
      const reconciled = await reconcileStep(ctx, wait);
      if (reconciled) return reconciled;
      continue;
    }
    await sleepUntilWoken(st, sleepBudgetMs(now, deadline, [approvalWakeAt(wait, o.approvalGraceMs), wait.nextReconcile]));
  }
}

/** The wait loop's own clocks, kept apart from the frame-driven TurnState. */
interface WaitState {
  nextReconcile: number;
  approvalSince: number | null;
  prevRec: Reconciliation | null;
}

/** Idle with a pending approval for longer than the grace period. Starts or clears the approval clock. */
function approvalStuck(st: TurnState, wait: WaitState, now: number, graceMs: number): boolean {
  wait.approvalSince = st.idleWithApproval ? (wait.approvalSince ?? now) : null;
  return wait.approvalSince !== null && now - wait.approvalSince >= graceMs;
}

function approvalWakeAt(wait: WaitState, graceMs: number): number {
  return wait.approvalSince === null ? Number.POSITIVE_INFINITY : wait.approvalSince + graceMs;
}

/**
 * A history poll is due. Reconcile only when the turn shows no sign of life
 * after the redial: a live turn replays/continues its frames, a dead one
 * (wrapper restarted, parking lost) stays silent, so a sign of life pushes the
 * next poll back. Synchronous on purpose (see waitForTurnEnd).
 */
function reconcileDue(st: TurnState, wait: WaitState, now: number, intervalMs: number): boolean {
  if (now >= wait.nextReconcile && st.sawActivity) wait.nextReconcile = now + intervalMs;
  return now >= wait.nextReconcile;
}

/**
 * Poll the conversation history. Two identical polls one interval apart end the
 * turn as reconciled: a mid-turn assistant message (e.g. text before a tool
 * call) changes or is followed by more frames.
 */
async function reconcileStep(ctx: TurnContext, wait: WaitState): Promise<Outcome | null> {
  const rec = await tryReconcile(ctx.conn, ctx.req, ctx.conversationId, ctx.o);
  if (sameReconciliation(rec, wait.prevRec)) return { kind: 'reconciled', ...rec };
  wait.prevRec = rec;
  wait.nextReconcile = Date.now() + ctx.o.reconcileIntervalMs;
  return null;
}

/** The turn ended by itself: a terminal frame, an abort, or a dropped link. */
function endedOutcome(st: TurnState, signal: AbortSignal | undefined): Outcome | null {
  if (st.terminal) return { kind: 'terminal', frame: st.terminal };
  if (signal?.aborted) return { kind: 'aborted' };
  if (st.disconnected) return { kind: 'disconnect' };
  return null;
}

function sameReconciliation(rec: Reconciliation | null, prev: Reconciliation | null): rec is Reconciliation {
  return rec !== null && prev !== null && rec.text === prev.text && rec.runId === prev.runId;
}

/** Sleep until the deadline or the earliest wake-up point (each at least 1 ms away). */
function sleepBudgetMs(now: number, deadline: number, wakeAts: readonly number[]): number {
  return wakeAts.filter(Number.isFinite).reduce((ms, at) => Math.min(ms, Math.max(1, at - now)), deadline - now);
}

/** Sleep for `ms`, or less if a frame, an abort or a disconnect wakes the loop. */
function sleepUntilWoken(st: TurnState, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      st.wake = null;
      resolve();
    }
    st.wake = done;
  });
}

type ResultBase = { conversationId: string; usage: Record<string, unknown> | null; reconciled: boolean };

async function finish(ctx: TurnContext, outcome: Exclude<Outcome, { kind: 'disconnect' }>): Promise<TurnResult> {
  const base: ResultBase = { conversationId: ctx.conversationId, usage: null, reconciled: false };
  if (outcome.kind === 'terminal') return finishFromFrame(ctx, base, outcome.frame);
  return finishWithoutFrame(base, outcome, ctx.o.turnTimeoutMs);
}

/** Outcomes the client decided without a terminal frame from the runtime. */
function finishWithoutFrame(
  base: ResultBase,
  outcome: Exclude<Outcome, { kind: 'disconnect' } | { kind: 'terminal' }>,
  turnTimeoutMs: number,
): TurnResult {
  switch (outcome.kind) {
    case 'timeout':
      return { ...base, stopReason: null, boundary: 'failed', failureReason: 'turn_timeout', error: `turn did not finish within ${turnTimeoutMs}ms`, turnId: null, runId: null, finalText: '' };
    case 'aborted':
      return { ...base, stopReason: null, boundary: 'cancelled', failureReason: 'cancelled', error: 'session stopped before the turn finished', turnId: null, runId: null, finalText: '' };
    case 'approval_stuck':
      return { ...base, stopReason: REQUIRES_APPROVAL, boundary: 'failed', failureReason: 'requires_approval', error: 'runtime idle with a pending approval; no approver for unattended steps', turnId: null, runId: null, finalText: '' };
    case 'reconciled':
      return { ...base, stopReason: 'end_turn', boundary: 'completed', failureReason: null, error: null, turnId: null, runId: outcome.runId, finalText: outcome.text, reconciled: true };
  }
}

/** The runtime's own terminal frame decides the result. */
async function finishFromFrame(ctx: TurnContext, base: ResultBase, f: Frame): Promise<TurnResult> {
  if (f['__input_rejected'] === true) {
    return { ...base, stopReason: 'error', boundary: 'failed', failureReason: 'input_rejected', error: str(f['error']), turnId: null, runId: null, finalText: '' };
  }
  const stopReason = str(f['stop_reason']);
  const turnId = str(f['turn_id']);
  if (turnId) ctx.o.ignoreTurnIds?.add(turnId);
  const runId = str(f['run_id']);
  const usage = asRecord(f['usage']);
  const error = str(f['error']);
  const b = boundaryOf(stopReason);
  if (b === 'awaiting_approval') {
    return { ...base, usage, stopReason, boundary: 'failed', failureReason: 'requires_approval', error: error ?? 'turn stopped on requires_approval; no approver for unattended steps', turnId, runId, finalText: '' };
  }
  if (b === 'failed') {
    return { ...base, usage, stopReason, boundary: 'failed', failureReason: 'stop_reason', error: error ?? `stop_reason ${stopReason ?? ''}`, turnId, runId, finalText: '' };
  }
  if (b === 'cancelled') {
    return { ...base, usage, stopReason, boundary: 'cancelled', failureReason: 'cancelled', error, turnId, runId, finalText: '' };
  }
  const messages = await listMessages(ctx.conn, ctx.conversationId, ctx.o.messageListLimit);
  const finalText = lastAssistantText(messages, runId, ctx.req.clientMessageId);
  return { ...base, usage, stopReason, boundary: 'completed', failureReason: null, error: null, turnId, runId, finalText };
}

// ───────────────────────── message.list helpers ─────────────────────────

async function listMessages(conn: IrohConnection, conversationId: string, limit: number): Promise<Record<string, unknown>[]> {
  const result = await withRedial(conn, () => conn.rpc('message.list', { conversation_id: conversationId, limit }), 3);
  const r = asRecord(result);
  const arr = Array.isArray(result) ? result : Array.isArray(r?.['messages']) ? r['messages'] : Array.isArray(r?.['items']) ? r['items'] : [];
  return arr.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object');
}

function isAssistant(m: Record<string, unknown>): boolean {
  return m['message_type'] === 'assistant_message' || m['role'] === 'assistant';
}
function isUser(m: Record<string, unknown>): boolean {
  return m['message_type'] === 'user_message' || m['role'] === 'user';
}

/**
 * Oldest → newest. The live wrapper's message.list returns NEWEST-FIRST (proven
 * live, vibesync-jni4: with `.at(-1)` on that order a multi-message turn yielded
 * its FIRST message, e.g. "FIRST" for the second turn of a conversation). Other
 * hosts / the older fake return oldest-first. Decide from the message dates, then
 * the numeric tail of the ids; when neither is conclusive keep the given order.
 */
export function chronological(messages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  if (messages.length < 2) return [...messages];
  const first = messages[0]!;
  const last = messages.at(-1)!;
  const t0 = Date.parse(String(first['date'] ?? ''));
  const t1 = Date.parse(String(last['date'] ?? ''));
  if (Number.isFinite(t0) && Number.isFinite(t1) && t0 !== t1) return t0 > t1 ? [...messages].reverse() : [...messages];
  const n0 = idTail(first['id']);
  const n1 = idTail(last['id']);
  if (n0 !== null && n1 !== null && n0 !== n1) return n0 > n1 ? [...messages].reverse() : [...messages];
  return [...messages];
}
function idTail(id: unknown): number | null {
  const m = typeof id === 'string' ? /(\d+)(?!.*\d)/.exec(id.split(':')[0]!) : null;
  return m ? Number(m[1]) : null;
}

/**
 * The role agent's FINAL assistant message of THIS turn.
 *
 * A message belongs to the turn when (in order of preference):
 *   1. it carries `run_id === runId` (turn_finished.run_id; the live host does not
 *      stamp run_id on messages today, so 2/3 are the working path there), or
 *   2. its `turn_id` is the input's client_message_id (what the live wrapper stamps), or
 *   3. it comes after the user message that carries the input's client_message_id.
 * A message stamped with a different run_id is never used. Of the candidates the chronologically LAST wins (text before a tool call is not the
 * answer). If nothing can be tied to this turn the result is '' (the provider
 * turns that into an `empty_output` error): an unrelated older assistant message
 * (a "Waiting for ..." placeholder, a previous turn) must never become the output.
 */
export function lastAssistantText(
  messages: readonly Record<string, unknown>[],
  runId: string | null,
  clientMessageId: string | null = null,
): string {
  const ordered = chronological(messages);
  const assistants = ordered.filter(isAssistant);
  if (assistants.length === 0) return '';
  const byRun = runId ? assistants.filter((m) => m['run_id'] === runId) : [];
  if (byRun.length > 0) return contentText(byRun.at(-1)!['content'] ?? byRun.at(-1)!['text']);
  if (clientMessageId) {
    // A message stamped with a DIFFERENT run_id is another run's output, whatever its position.
    const notOtherRun = (m: Record<string, unknown>): boolean => !(runId && typeof m['run_id'] === 'string' && m['run_id'] !== runId);
    const byTurn = assistants.filter((m) => m['turn_id'] === clientMessageId && notOtherRun(m));
    if (byTurn.length > 0) return contentText(byTurn.at(-1)!['content'] ?? byTurn.at(-1)!['text']);
    let userIdx = -1;
    ordered.forEach((m, i) => {
      if (isUser(m) && (m['client_message_id'] === clientMessageId || m['otid'] === clientMessageId)) userIdx = i;
    });
    if (userIdx >= 0) {
      // Bounded by the NEXT user message: a later turn's answer is not this turn's.
      const rest = ordered.slice(userIdx + 1);
      const nextUser = rest.findIndex(isUser);
      const after = (nextUser < 0 ? rest : rest.slice(0, nextUser)).filter((m) => isAssistant(m) && notOtherRun(m));
      if (after.length > 0) return contentText(after.at(-1)!['content'] ?? after.at(-1)!['text']);
    }
    return '';
  }
  // No client_message_id to tie to (legacy callers): old behaviour, last assistant message.
  const pick = assistants.at(-1)!;
  return contentText(pick['content'] ?? pick['text']);
}

async function tryReconcile(
  conn: IrohConnection,
  req: TurnRequest,
  conversationId: string,
  o: { messageListLimit: number },
): Promise<{ text: string; runId: string | null } | null> {
  let messages: Record<string, unknown>[];
  try {
    messages = chronological(await conn.connect().then(() => listMessages(conn, conversationId, o.messageListLimit)));
  } catch (err) {
    if (isRetryable(err)) return null;
    throw err;
  }
  const userIdx = inputIndex(messages, req);
  if (userIdx < 0) return null;
  const last = messages.slice(userIdx + 1).filter(isAssistant).at(-1);
  return last ? { text: contentText(last['content'] ?? last['text']), runId: str(last['run_id']) } : null;
}

/** The last user message that is this turn's input: matched by client_message_id or otid, or by its text. */
function inputIndex(messages: readonly Record<string, unknown>[], req: TurnRequest): number {
  let userIdx = -1;
  messages.forEach((m, i) => {
    if (isUser(m) && isTurnInput(m, req)) userIdx = i;
  });
  return userIdx;
}

function isTurnInput(m: Record<string, unknown>, req: TurnRequest): boolean {
  const idMatch = m['client_message_id'] === req.clientMessageId || m['otid'] === req.clientMessageId;
  return idMatch || contentText(m['content'] ?? m['text']).trim() === req.text.trim();
}

// ───────────────────────── small utilities ─────────────────────────

async function withRedial<T>(conn: IrohConnection, fn: () => Promise<T>, tries: number): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      await conn.connect();
      return await fn();
    } catch (err) {
      if (i >= tries || !isRetryable(err)) throw err;
    }
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof IrohConnectionLostError || err instanceof IrohTimeoutError;
}

function frameConversation(f: Frame): string | null {
  return str(asRecord(f['runtime'])?.['conversation_id']) ?? str(f['conversation_id']);
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof asRecord(p)?.['text'] === 'string' ? (asRecord(p)!['text'] as string) : ''))
      .join('');
  }
  return '';
}

/** `{ [key]: value }` when the value is set (not undefined, null or empty), else `{}`: for optional request fields. */
function optionalField<K extends string, V>(key: K, value: V | undefined | null | ''): Partial<Record<K, V>> {
  return value === undefined || value === null || value === '' ? {} : ({ [key]: value } as Record<K, V>);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
