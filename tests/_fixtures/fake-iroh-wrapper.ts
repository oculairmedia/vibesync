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
import { FrameDecoder, encodeFrameParts } from '../../src/orchestration/runtime/iroh/frame-codec.js';
import type { DuplexLike, IrohLink } from '../../src/orchestration/runtime/iroh/connection.js';

type F = Record<string, unknown>;

export interface TurnScript {
  /** Text of the deltas streamed live (deliberately NOT the final message). */
  deltas?: string[];
  stopReason?: string | null;
  error?: string;
  /** What message.list returns as the assistant message. */
  finalText?: string;
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

  dials = 0;
  readonly received: F[] = [];
  readonly violations: string[] = [];
  turnsExecuted = 0;

  private convCounter = 0;
  private readonly runtimes = new Set<string>();
  private readonly messages = new Map<string, F[]>();
  private readonly parked = new Map<string, F[]>();
  private readonly seenCmids = new Set<string>();
  private links: Array<{ stream: Queue; control: Queue; authed: boolean; dead: boolean }> = [];
  private eventSeq = 0;
  private lastCmidByConv = new Map<string, string>();

  constructor(opts: { scope?: string[]; authToken?: string | null } = {}) {
    this.scope = opts.scope ?? ['agent-parent'];
    this.authToken = opts.authToken ?? null;
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
      default:
        return this.reply(l, { type: 'error', request_id: rid, error: `unknown frame ${String(f['type'])}` });
    }
  }

  private onRpc(l: { control: Queue; dead: boolean }, f: F): void {
    const rid = f['request_id'];
    const method = f['method'];
    const params = (f['params'] ?? {}) as F;
    if (method === 'conversation.create') {
      const agent = String(params['agent_id']);
      if (!this.scope.includes(agent)) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: "forbidden: agent not in this device's scope" });
      this.convCounter += 1;
      const id = `conv-${this.convCounter}`;
      this.messages.set(id, []);
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: { id } });
    }
    if (method === 'message.list') {
      const conv = String(params['conversation_id']);
      const list = this.messages.get(conv);
      if (!list) return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: 'conversation not found' });
      return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: true, result: { messages: list } });
    }
    return this.reply(l, { type: 'admin_rpc_response', request_id: rid, success: false, error: `method not found: ${String(method)}` });
  }

  private onInput(l: { control: Queue; dead: boolean }, f: F): void {
    const rid = f['request_id'];
    const rt = (f['runtime'] ?? {}) as F;
    const agent = String(rt['agent_id']);
    const conv = String(rt['conversation_id']);
    const reject = (error: string): void =>
      this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: false, error });
    if (!this.scope.includes(agent)) return reject("forbidden: agent not in this device's scope");
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

    if (this.seenCmids.has(`${conv}/${cmid}`)) {
      // dedupe: ack as already-known; replay parked frames incl. the terminal.
      this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: true, disposition: 'started' });
      if (this.replay) {
        for (const p of this.parked.get(conv) ?? []) for (const lk of this.links) if (!lk.dead && lk.authed) for (const c of encodeFrameParts(JSON.stringify(p))) lk.stream.push(c);
      }
      return;
    }
    this.seenCmids.add(`${conv}/${cmid}`);
    this.lastCmidByConv.set(conv, cmid);
    this.parked.set(conv, []);
    const text = ((f['payload'] as F)['messages'] as F[])[0]!['content'];
    this.messages.get(conv)?.push({ message_type: 'user_message', role: 'user', content: text, otid: cmid });
    this.reply(l, { type: 'input_accepted', request_id: rid, runtime: rt, accepted: true, disposition: 'started' });
    this.turnsExecuted += 1;
    const mode = this.dropAfterAccept;
    this.dropAfterAccept = false;
    void this.runTurn(agent, conv, mode === 'drop' ? () => this.dropLinks() : mode === 'restart' ? () => this.restartAfterFinish() : null);
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
    if (s.finalText !== undefined) {
      this.messages.get(conv)?.push({ message_type: 'assistant_message', role: 'assistant', run_id: 'run-1', content: [{ type: 'text', text: s.finalText }] });
    }
    await tick();
    this.emitStream(
      conv,
      this.frame('turn_finished', agent, conv, {
        turn_id: `turn-${this.turnsExecuted}`,
        stop_reason: s.stopReason === undefined ? 'end_turn' : s.stopReason,
        run_id: 'run-1',
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
