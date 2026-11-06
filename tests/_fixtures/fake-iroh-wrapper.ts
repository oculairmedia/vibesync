/**
 * In-memory fake of the Letta Iroh wrapper that ENFORCES the real
 * preconditions proven live (vibesync-x38j), unlike a permissive fake that
 * accepts anything (the false-pass that hid the retired-shim bug):
 *
 *   - frames go through the REAL frame codec in both directions;
 *   - first control frame must be `auth`; a paired key authenticates with ""
 *   - bi-streams must be opened control-then-stream, stream send half finished
 *   - `input` before `runtime_start` for that conversation  -> rejected
 *   - `input` without messages[].client_message_id           -> rejected
 *   - `runtime_start` without `mode`                         -> rejected
 *   - agent ids outside `scope` -> "forbidden: agent not in this device's scope"
 *   - input_accepted on control, then stream frames, then turn_finished
 *   - dedupe on (conversation, client_message_id); parked frames are replayed
 *     to a redialed link (unless `replay` is off, modelling a wrapper restart)
 */
import { FrameDecoder, encodeFrameParts } from '../../src/engine/runtime/iroh/frame-codec.js';
import type { DuplexLike, IrohLink } from '../../src/engine/runtime/iroh/connection.js';

type F = Record<string, unknown>;

export interface TurnScript {
  /** Text of the deltas streamed live (deliberately NOT the final message). */
  deltas?: string[];
  stopReason?: string | null;
  error?: string;
  /** What message.list returns as the assistant message. */
  finalText?: string;
  /**
   * run_id stamped on turn_finished AND on the final assistant message (default 'run-1').
   * Use a per-script value to prove the provider matches on it.
   */
  runId?: string;
  /**
   * Assistant messages persisted BEFORE the matching one, with the given run_ids
   * (e.g. the parent's "Waiting for ..." placeholder, a previous turn's answer).
   * They must never become the step output.
   */
  earlierAssistant?: Array<{ text: string; runId: string | null }>;
  /** Assistant messages persisted AFTER the matching one under a different run_id (a late task-notification turn). */
  laterAssistant?: Array<{ text: string; runId: string | null }>;
  /** Delay before turn_finished, so a live test/false-pass guard can see a plausible latency. */
  turnDelayMs?: number;
  /** After streaming, emit these frames instead of turn_finished (approval case). */
  stallWith?: F[];
  /** Extra frames before the terminal (e.g. unknown mid-turn stop reason). */
  preTerminal?: F[];
}

class Queue {
  private chunks: Uint8Array[] = [];
  private waiters: Array<(c: Uint8Array | null) => void> = [];
  private ended = false;
  push(c: Uint8Array): void {
    const w = this.waiters.shift();
    if (w) w(c);
    else this.chunks.push(c);
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  next(): Promise<Uint8Array | null> {
    const c = this.chunks.shift();
    if (c) return Promise.resolve(c);
    if (this.ended) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
}

export class FakeIrohWrapper {
  readonly scope: string[];
  readonly authToken: string | null; // null = accept anything
  script: TurnScript = { deltas: ['working…'], stopReason: 'end_turn', finalText: 'PONG' };
  /** Replay parked frames to a redialed link (false = wrapper restarted). */
  replay = true;
  rejectAuth = false;
  dialFailures = 0;
  /** Drop the link right after the first input_accepted (or restart the wrapper there). */
  dropAfterAccept: false | 'drop' | 'restart' = false;
  /** Reply input_accepted:false with this error. */
  rejectInput: string | null = null;
  /** admin_rpc methods answered with `method not found` (a host that predates them). */
  readonly unsupportedMethods = new Set<string>();
  /**
   * Order of message.list. The LIVE wrapper returns NEWEST-FIRST (proven
   * against the real host, vibesync-jni4); 'oldest-first' is kept so older
   * tests keep exercising the other shape.
   */
  listOrder: 'oldest-first' | 'newest-first' = 'oldest-first';

  dials = 0;
  readonly received: F[] = [];
  readonly violations: string[] = [];
  turnsExecuted = 0;
  /** Conversations a turn was aborted on (real host: abort_message ends the running turn). */
  readonly aborted: string[] = [];
  /** Answer abort_message with success:false and this error (e.g. a host that refuses). */
  rejectAbort: string | null = null;

  private convCounter = 0;
  private readonly runtimes = new Set<string>();
  /** conversation id -> the agent it was created on (a conversation belongs to exactly one agent). */
  readonly conversationAgent = new Map<string, string>();
  /** conversation id -> title (`summary`) passed to conversation.create. */
  readonly conversationTitles = new Map<string, string>();
  /** conversation id -> tags passed to conversation.create. */
  readonly conversationTags = new Map<string, string[]>();
  /** conversation id -> the record fields `conversation.list` serves (the real host lists these; see seedConversation). */
  private readonly conversationMeta = new Map<string, { created_at: string; last_message_at: string; archived: boolean; extra: F }>();
  /** permission mode `permission_mode.get` reports per `agent/conversation` (absent = runtime never started: `{}`). */
  readonly permissionModes = new Map<string, string>();
  /** `conversation.list` order. The LIVE host serves NEWEST-FIRST by last_message_at (proven live, vibesync-2bgv). */
  conversationListOrder: 'newest-first' | 'oldest-first' = 'newest-first';
  private readonly messages = new Map<string, F[]>();
  private readonly parked = new Map<string, F[]>();
  private readonly seenCmids = new Set<string>();
  private readonly seenCmidConvs = new Set<string>();
  /** Inputs the host dropped as already-handled ids in another conversation (no turn ran). */
  readonly duplicatesIgnored: { conversationId: string; clientMessageId: string }[] = [];
  private links: Array<{ stream: Queue; control: Queue; authed: boolean; dead: boolean }> = [];
  private eventSeq = 0;
  private lastCmidByConv = new Map<string, string>();

  constructor(opts: { scope?: string[]; authToken?: string | null } = {}) {
    this.scope = opts.scope ?? ['agent-parent'];
    this.authToken = opts.authToken ?? null;
  }

  /**
   * Pre-existing conversation on `agent` (what a human thread looks like to a
   * wake sink). `extra` rides on the listed record verbatim (e.g.
   * `conversation_class: 'autonomous'`, `hidden: true`).
   */
  seedConversation(agent: string, c: { id: string; lastMessageAt: string; archived?: boolean; extra?: F }): void {
    this.messages.set(c.id, []);
    this.conversationAgent.set(c.id, agent);
    this.conversationMeta.set(c.id, { created_at: c.lastMessageAt, last_message_at: c.lastMessageAt, archived: c.archived ?? false, extra: c.extra ?? {} });
    const tags = c.extra?.['tags'];
    if (Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')) this.conversationTags.set(c.id, [...tags]);
  }

  /** Every user message text persisted on `conv` (what the PM would see). */
  userTexts(conv: string): string[] {
    return (this.messages.get(conv) ?? []).filter((m) => m['message_type'] === 'user_message').map((m) => String(m['content']));
  }

  inputsFor(cmid: string): F[] {
    return this.received.filter((f) => f['type'] === 'input' && this.cmidOf(f) === cmid);
  }

  dial = async (): Promise<IrohLink> => {
    this.dials += 1;
    if (this.dialFailures > 0) {
      this.dialFailures -= 1;
      throw new Error('fake: connection refused');
    }
    return this.accept();
  };

  /** Simulate the host dropping every live link. */
  dropLinks(): void {
    for (const l of this.links) this.kill(l);
  }

  /**
   * Wrapper restart: parked frames (in-memory) are lost; the host's
   * conversation store (messages, keyed by client_message_id/otid) persists,
   * so a re-sent input is still deduped but nothing is replayed.
   */
  restart(): void {
    this.parked.clear();
    this.runtimes.clear();
    this.replay = false;
    this.dropLinks();
  }

  // ───────────────────────── link plumbing ─────────────────────────

  private accept(): IrohLink {
    const s2c = new Queue();
    const streamS2c = new Queue();
    const state = { stream: streamS2c, control: s2c, authed: false, dead: false };
    this.links.push(state);
    const decoder = new FrameDecoder();
    let streamFinished = false;

    const control: DuplexLike = {
      write: async (bytes) => {
        if (state.dead) throw new Error('fake: link closed');
        for (const text of decoder.feed(bytes)) this.onControlFrame(state, JSON.parse(text) as F);
      },
      read: () => s2c.next(),
      finish: async () => undefined,
    };
    const stream: DuplexLike = {
      write: async () => {
        this.violations.push('client wrote on the receive-only stream channel');
      },
      read: () => streamS2c.next(),
      finish: async () => {
        streamFinished = true;
      },
    };
    const link: IrohLink = {
      control,
      stream,
      close: async () => {
        this.kill(state);
        if (!streamFinished) this.violations.push('stream send half was not finished');
      },
    };
    return link;
  }

  private kill(l: { stream: Queue; control: Queue; dead: boolean }): void {
    if (l.dead) return;
    l.dead = true;
    l.control.end();
    l.stream.end();
  }

  private reply(l: { control: Queue; dead: boolean }, f: F): void {
    if (l.dead) return;
    for (const c of encodeFrameParts(JSON.stringify(f))) l.control.push(c);
  }

  private emitStream(conv: string, f: F): void {
    this.parked.set(conv, [...(this.parked.get(conv) ?? []), f]);
    for (const l of this.links) if (!l.dead && l.authed) for (const c of encodeFrameParts(JSON.stringify(f))) l.stream.push(c);
  }

  private frame(type: string, agent: string, conv: string, extra: F): F {
    this.eventSeq += 1;
    return {
      v: 1,
      type,
      runtime: { agent_id: agent, conversation_id: conv },
      event_seq: this.eventSeq,
      emitted_at: 'x',
      idempotency_key: `k-${this.eventSeq}`,
      ...extra,
    };
  }

  // ───────────────────────── protocol ─────────────────────────

  private cmidOf(f: F): string | null {
    const payload = f['payload'] as F | undefined;
    const msgs = payload?.['messages'] as F[] | undefined;
    const id = msgs?.[0]?.['client_message_id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private onControlFrame(l: { control: Queue; stream: Queue; authed: boolean; dead: boolean }, f: F): void {
    this.received.push(f);
    const rid = f['request_id'];
    if (f['type'] === 'auth') {
      const ok = !this.rejectAuth && (this.authToken === null || f['token'] === this.authToken || f['token'] === '');
      if (ok && !Array.isArray(f['capabilities'])) this.violations.push('auth without capabilities array');
      l.authed = ok;
      this.reply(l, ok ? { type: 'auth_response', request_id: rid, success: true, capabilities: ['frame_part'] } : { type: 'auth_response', request_id: rid, success: false, error: 'invalid token' });
      return;
    }
    if (!l.authed) {
      this.violations.push(`frame ${String(f['type'])} before auth`);
      this.reply(l, { type: 'error', request_id: rid, error: 'unauthenticated' });
      return;
    }
    switch (f['type']) {
      case 'admin_rpc':
        return this.onRpc(l, f);
      case 'runtime_start': {
        const agent = String(f['agent_id']);
        if (!this.scope.includes(agent)) return this.reply(l, { type: 'runtime_start_response', request_id: rid, success: false, error: "forbidden: agent not in this device's scope" });
        if (typeof f['mode'] !== 'string') return this.reply(l, { type: 'runtime_start_response', request_id: rid, success: false, error: 'mode required' });
        this.runtimes.add(`${agent}/${String(f['conversation_id'])}`);
        return this.reply(l, { type: 'runtime_start_response', request_id: rid, success: true });
      }
      case 'input':
        return this.onInput(l, f);
      case 'abort_message':
        return this.onAbort(l, f);
      default:
        return this.reply(l, { type: 'error', request_id: rid, error: `unknown frame ${String(f['type'])}` });
    }
  }

  private onRpc(l: { control: Queue; dead: boolean }, f: F): void {
    const rid = f['request_id'];
    const method = f['method'];
    const params = (f['params'] ?? {}) as F;
    if (typeof method === 'string' && this.unsupportedMethods.has(method)) {
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: `method not found: ${method}` });
    }
    if (method === 'conversation.create') {
      const agent = typeof params['agent_id'] === 'string' ? params['agent_id'] : null;
      if (!agent) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'agent_id required' });
      if (!this.scope.includes(agent)) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: "forbidden: agent not in this device's scope" });
      const rawTags = params['tags'];
      if (rawTags !== undefined && rawTags !== null && (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string'))) {
        return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'invalid_tags: expected an array of strings' });
      }
      this.convCounter += 1;
      const id = `conv-${this.convCounter}`;
      const tags = rawTags == null ? [] : (rawTags as string[]);
      const laneTags = [...new Set(tags)].filter((tag) => tag === 'lane:home' || tag === 'lane:inbox');
      const duplicateLane = laneTags.some((tag) =>
        [...this.conversationTags.entries()].some(([conversationId, existing]) =>
          this.conversationAgent.get(conversationId) === agent && existing.includes(tag),
        ),
      );
      if (duplicateLane) {
        this.violations.push('conversation.create attempted duplicate home/inbox lane tag for one agent');
        return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'lane_already_assigned' });
      }
      this.messages.set(id, []);
      this.conversationAgent.set(id, agent);
      const at = this.nextDate();
      this.conversationMeta.set(id, { created_at: at, last_message_at: at, archived: false, extra: { tags } });
      this.conversationTags.set(id, [...tags]);
      // Real host stores `summary` as the conversation title shown in the app list.
      if (typeof params['summary'] === 'string') this.conversationTitles.set(id, params['summary']);
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: { id } });
    }
    if (method === 'conversation.list') {
      const agent = String(params['agent_id']);
      if (!this.scope.includes(agent)) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: "forbidden: agent not in this device's scope" });
      const rows = [...this.conversationMeta.entries()]
        .filter(([id]) => this.conversationAgent.get(id) === agent)
        .map(([id, m]) => ({ id, agent_id: agent, archived: m.archived, created_at: m.created_at, updated_at: m.last_message_at, last_message_at: m.last_message_at, summary: null, ...m.extra }))
        .sort((a, b) => (a.last_message_at < b.last_message_at ? -1 : a.last_message_at > b.last_message_at ? 1 : 0));
      const ordered = this.conversationListOrder === 'newest-first' ? rows.reverse() : rows;
      const limit = typeof params['limit'] === 'number' ? (params['limit'] as number) : ordered.length;
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: ordered.slice(0, limit) });
    }
    if (method === 'conversation.list_agent') {
      // The paired vibesync grant is refused here on the LIVE host (proven live, vibesync-2bgv).
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'forbidden' });
    }
    if (method === 'permission_mode.get') {
      const agent = String(params['agent_id']);
      if (!this.scope.includes(agent)) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: "forbidden: agent not in this device's scope" });
      const mode = this.permissionModes.get(`${agent}/${String(params['conversation_id'])}`);
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: mode ? { mode } : {} });
    }
    if (method === 'message.list') {
      const conv = String(params['conversation_id']);
      const list = this.messages.get(conv);
      if (!list) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'conversation not found' });
      const limit = typeof params['limit'] === 'number' ? (params['limit'] as number) : list.length;
      // Real host semantics: `limit` keeps the NEWEST messages.
      const newest = list.slice(Math.max(0, list.length - limit));
      const out = this.listOrder === 'newest-first' ? [...newest].reverse() : newest;
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: { messages: out } });
    }
    return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: `method not found: ${String(method)}` });
  }

  /**
   * Real host contract (letta-mobile IrohNodeConnection.handleAbort): request_id
   * is required; the answer is abort_message_response { request_id, runtime,
   * aborted, success, error? }. An aborted turn ends with turn_finished
   * stop_reason "cancelled".
   */
  private onAbort(l: { control: Queue; dead: boolean }, f: F): void {
    const rid = f['request_id'];
    const rt = (f['runtime'] ?? {}) as F;
    if (typeof rid !== 'string') {
      return this.reply(l, { type: 'abort_message_response', success: false, error: 'request_id is required' });
    }
    if (this.rejectAbort) {
      return this.reply(l, { type: 'abort_message_response', request_id: rid, runtime: rt, aborted: false, success: false, error: this.rejectAbort });
    }
    const conv = String(rt['conversation_id']);
    this.aborted.push(conv);
    this.reply(l, { type: 'abort_message_response', request_id: rid, runtime: rt, aborted: true, success: true });
    const terminal = { type: 'turn_finished', runtime: rt, conversation_id: conv, stop_reason: 'cancelled', turn_id: `turn-abort-${conv}` };
    for (const lk of this.links) if (!lk.dead && lk.authed) for (const c of encodeFrameParts(JSON.stringify(terminal))) lk.stream.push(c);
  }

  private onInput(l: { control: Queue; dead: boolean }, f: F): void {
    const rid = f['request_id'];
    const rt = (f['runtime'] ?? {}) as F;
    const agent = String(rt['agent_id']);
    const conv = String(rt['conversation_id']);
    const reject = (error: string): void =>
      this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: false, error });
    if (!this.scope.includes(agent)) return reject("forbidden: agent not in this device's scope");
    const owner = this.conversationAgent.get(conv);
    if (owner !== undefined && owner !== agent) {
      this.violations.push(`input for agent ${agent} on a conversation that belongs to ${owner}`);
      return reject('conversation does not belong to this agent');
    }
    if (!this.runtimes.has(`${agent}/${conv}`)) {
      this.violations.push('input before runtime_start');
      return reject('runtime not started');
    }
    const cmid = this.cmidOf(f);
    if (!cmid) {
      this.violations.push('input without client_message_id');
      return reject('client_message_id required');
    }
    if (this.rejectInput) return reject(this.rejectInput);

    // Real host: clientMessageDedupe.markHandled(clientMsgId) keys on the id ALONE,
    // across conversations (letta-mobile IrohNodeConnection). A repeated id in a
    // NEW conversation is ignored too, and no turn runs (vibesync-9lzk.41).
    if (this.seenCmids.has(cmid) && !this.seenCmidConvs.has(`${conv}/${cmid}`)) {
      this.duplicatesIgnored.push({ conversationId: conv, clientMessageId: cmid });
      this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: true, disposition: 'started' });
      return;
    }
    if (this.seenCmidConvs.has(`${conv}/${cmid}`)) {
      // dedupe: ack as already-known; replay parked frames incl. the terminal.
      this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: true, disposition: 'started' });
      if (this.replay) {
        for (const p of this.parked.get(conv) ?? []) for (const lk of this.links) if (!lk.dead && lk.authed) for (const c of encodeFrameParts(JSON.stringify(p))) lk.stream.push(c);
      }
      return;
    }
    this.seenCmids.add(cmid);
    this.seenCmidConvs.add(`${conv}/${cmid}`);
    this.lastCmidByConv.set(conv, cmid);
    this.parked.set(conv, []);
    const text = ((f['payload'] as F)['messages'] as F[])[0]!['content'];
    const userId = this.nextMsgId(); // id first: nextDate() derives from the sequence it bumps
    const userDate = this.nextDate();
    this.messages.get(conv)?.push({ id: userId, date: userDate, message_type: 'user_message', role: 'user', content: text, otid: cmid, turn_id: cmid });
    const meta = this.conversationMeta.get(conv);
    if (meta) meta.last_message_at = userDate;
    this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: true, disposition: 'started' });
    this.turnsExecuted += 1;
    const mode = this.dropAfterAccept;
    this.dropAfterAccept = false;
    void this.runTurn(agent, conv, mode === 'drop' ? () => this.dropLinks() : mode === 'restart' ? () => this.restartAfterFinish() : null);
  }

  private msgSeq = 0;
  private nextMsgId(): string {
    this.msgSeq += 1;
    return `ui-msg-${1000 + this.msgSeq}`;
  }
  private nextDate(): string {
    return new Date(Date.UTC(2026, 10, 2, 5, 0, 0) + this.msgSeq * 1000).toISOString();
  }

  private restartAfterFinish(): void {
    // The link dies mid-turn; the turn still finishes on the host; THEN the
    // wrapper process dies, so the parked terminal is lost.
    this.pendingRestart = true;
    this.dropLinks();
  }
  private pendingRestart = false;

  private async runTurn(agent: string, conv: string, afterAccept: (() => void) | null): Promise<void> {
    const s = this.script;
    await Promise.resolve();
    afterAccept?.();
    const tick = async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
    };
    this.emitStream(conv, this.frame('update_loop_status', agent, conv, { loop_status: { status: 'PROCESSING_API_RESPONSE', active_run_ids: ['run-1'] } }));
    for (const d of s.deltas ?? []) {
      await tick();
      this.emitStream(conv, this.frame('stream_delta', agent, conv, { delta: { message_type: 'assistant_message', content: d } }));
    }
    for (const f of s.preTerminal ?? []) {
      await tick();
      this.emitStream(conv, { ...f });
    }
    if (s.stallWith) {
      for (const f of s.stallWith) {
        await tick();
        this.emitStream(conv, this.frame(String(f['type']), agent, conv, f));
      }
      return;
    }
    const runId = s.runId ?? 'run-1';
    const assistant = (text: string, rid: string | null): F => ({
      id: this.nextMsgId(),
      date: this.nextDate(),
      message_type: 'assistant_message',
      role: 'assistant',
      ...(rid ? { run_id: rid } : {}),
      content: [{ type: 'text', text }],
    });
    for (const e of s.earlierAssistant ?? []) this.messages.get(conv)?.push(assistant(e.text, e.runId));
    if (s.finalText !== undefined) this.messages.get(conv)?.push(assistant(s.finalText, runId));
    for (const e of s.laterAssistant ?? []) this.messages.get(conv)?.push(assistant(e.text, e.runId));
    if (s.turnDelayMs) await new Promise((r) => setTimeout(r, s.turnDelayMs));
    await tick();
    this.emitStream(
      conv,
      this.frame('turn_finished', agent, conv, {
        turn_id: `turn-${this.turnsExecuted}`,
        stop_reason: s.stopReason === undefined ? 'end_turn' : s.stopReason,
        run_id: runId,
        ...(s.error ? { error: s.error } : {}),
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
    if (this.pendingRestart) {
      this.pendingRestart = false;
      this.restart();
    }
  }
}
