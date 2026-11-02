/**
 * IrohConnection — one dialed + authenticated App Server connection to the
 * Letta wrapper (ALPN /letta/appserver/0), shared by every session of a
 * provider instance.
 *
 * Wire shape (proven live from Bun, vibesync-x38j):
 *   - two bi-streams opened IN ORDER: control first, then stream. The stream
 *     channel is receive-only, so its send half is finished immediately.
 *   - frames are IrohFrameCodec frames (4-byte BE length + UTF-8 JSON, with
 *     `frame_part` when the peer advertised the capability).
 *   - first control frame is `auth`; replies are matched by `request_id`
 *     (auth_response, admin_rpc_response, runtime_start_response,
 *     input_accepted). Everything else (stream_delta, turn_finished, ...) is
 *     dispatched to frame listeners.
 *
 * Reconnect: lazy. `connect()` is single-flight and idempotent; a dropped link
 * rejects every pending request with IrohConnectionLostError, notifies
 * disconnect listeners, and the next `connect()` redials with bounded
 * exponential backoff. Auth failures, config errors and server refusals are
 * NEVER retried. The token and key never appear in logs or errors.
 */

import { FRAME_PART_CAPABILITY, FrameDecoder, encodeFrame, encodeFrameParts } from './frame-codec.js';

/** One half-duplex-pair stream as the connection sees it. */
export interface DuplexLike {
  write(bytes: Uint8Array): Promise<void>;
  /** Next chunk, or null/empty at end of stream. */
  read(limit: number): Promise<Uint8Array | null>;
  finish(): Promise<void>;
}

/** A dialed transport: control + stream bi-streams, opened in that order. */
export interface IrohLink {
  readonly control: DuplexLike;
  readonly stream: DuplexLike;
  close(): Promise<void>;
}

export type IrohDialer = () => Promise<IrohLink>;

export type Frame = Record<string, unknown>;

export class IrohAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrohAuthError';
  }
}
/** Misconfiguration (missing key, bad address): retrying cannot help. */
export class IrohConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrohConfigError';
  }
}
export class IrohConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IrohConnectionError';
  }
}
/** The link dropped under a request. Retryable by redialing. */
export class IrohConnectionLostError extends Error {
  constructor(message = 'iroh connection lost') {
    super(message);
    this.name = 'IrohConnectionLostError';
  }
}
/** The wrapper answered and refused (forbidden, method-not-found, ...). Never retried. */
export class IrohRefusedError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = 'IrohRefusedError';
  }
}
export class IrohTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrohTimeoutError';
  }
}

export interface IrohConnectionOptions {
  readonly dial: IrohDialer;
  readonly peerName: string;
  /** Pairing token. Empty for an already-paired key. Never logged. */
  readonly token?: string;
  readonly capabilities?: readonly string[];
  readonly authTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly backoff?: {
    readonly initialMs?: number;
    readonly factor?: number;
    readonly capMs?: number;
    readonly maxAttempts?: number;
  };
  readonly readChunkBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly newRequestId?: () => string;
  readonly log?: (message: string) => void;
}

interface Pending {
  readonly resolve: (frame: Frame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Session {
  readonly link: IrohLink;
  readonly generation: number;
  readonly pending: Map<string, Pending>;
  readonly controlDecoder: FrameDecoder;
  readonly streamDecoder: FrameDecoder;
  sendQueue: Promise<void>;
  allowFrameParts: boolean;
  dead: boolean;
}

const DEFAULTS = {
  authTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  initialMs: 500,
  factor: 2,
  capMs: 15_000,
  maxAttempts: 8,
  readChunkBytes: 65_536,
};

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `vs-${Date.now().toString(36)}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export class IrohConnection {
  private session: Session | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private generationCounter = 0;
  private readonly frameListeners = new Set<(frame: Frame) => void>();
  private readonly disconnectListeners = new Set<(generation: number) => void>();
  private readonly o: Required<Omit<IrohConnectionOptions, 'backoff' | 'token' | 'capabilities'>> & {
    readonly token: string;
    readonly capabilities: readonly string[];
    readonly backoff: Required<NonNullable<IrohConnectionOptions['backoff']>>;
  };

  constructor(opts: IrohConnectionOptions) {
    this.o = {
      dial: opts.dial,
      peerName: opts.peerName,
      token: opts.token ?? '',
      capabilities: opts.capabilities ?? [FRAME_PART_CAPABILITY],
      authTimeoutMs: opts.authTimeoutMs ?? DEFAULTS.authTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      readChunkBytes: opts.readChunkBytes ?? DEFAULTS.readChunkBytes,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      newRequestId: opts.newRequestId ?? defaultRequestId,
      log: opts.log ?? (() => undefined),
      backoff: {
        initialMs: opts.backoff?.initialMs ?? DEFAULTS.initialMs,
        factor: opts.backoff?.factor ?? DEFAULTS.factor,
        capMs: opts.backoff?.capMs ?? DEFAULTS.capMs,
        maxAttempts: opts.backoff?.maxAttempts ?? DEFAULTS.maxAttempts,
      },
    };
  }

  /** Increments on every successful (re)connect; 0 before the first. */
  get generation(): number {
    return this.session && !this.session.dead ? this.session.generation : this.generationCounter;
  }

  get isConnected(): boolean {
    return this.session !== null && !this.session.dead;
  }

  newRequestId(prefix: string): string {
    return `${prefix}-${this.o.newRequestId()}`;
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onDisconnect(listener: (generation: number) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Dial + auth if not connected. Single-flight; retries transient dial failures with bounded backoff. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new IrohConnectionError('iroh connection is closed'));
    if (this.isConnected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connectWithBackoff().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /**
   * Send a control frame and await the frame carrying the same `request_id`.
   * Throws IrohConnectionLostError if the link drops first.
   */
  request(frame: Frame, opts: { timeoutMs?: number } = {}): Promise<Frame> {
    const session = this.session;
    if (!session || session.dead) return Promise.reject(new IrohConnectionLostError('iroh not connected'));
    const requestId = typeof frame['request_id'] === 'string' ? (frame['request_id'] as string) : this.newRequestId('req');
    const full: Frame = { ...frame, request_id: requestId };
    return this.requestOn(session, full, requestId, opts.timeoutMs ?? this.o.requestTimeoutMs);
  }

  /** admin_rpc round trip. Throws IrohRefusedError when the wrapper answers with an error. */
  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request({ type: 'admin_rpc', method, params });
    const error = reply['error'];
    if (reply['success'] === false || (error !== undefined && error !== null)) {
      throw refusalFrom(`admin_rpc ${method}`, error);
    }
    return reply['result'];
  }

  async close(): Promise<void> {
    this.closed = true;
    const s = this.session;
    if (s) {
      this.killSession(s, new IrohConnectionLostError('iroh connection closed'));
      await s.link.close().catch(() => undefined);
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private async connectWithBackoff(): Promise<void> {
    const b = this.o.backoff;
    let delay = b.initialMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.dialAndAuth();
        return;
      } catch (err) {
        if (this.closed || err instanceof IrohAuthError || err instanceof IrohConfigError) throw err;
        if (attempt >= b.maxAttempts) {
          throw new IrohConnectionError(
            `iroh connect failed after ${attempt} attempts: ${errorMessage(err)}`,
            { cause: err },
          );
        }
        this.o.log(`iroh connect attempt ${attempt} failed: ${errorMessage(err)}; retrying in ~${delay}ms`);
        await this.o.sleep(Math.round(delay * (0.5 + this.o.random() * 0.5)));
        delay = Math.min(delay * b.factor, b.capMs);
      }
    }
  }

  private async dialAndAuth(): Promise<void> {
    const link = await this.o.dial();
    this.generationCounter += 1;
    const session: Session = {
      link,
      generation: this.generationCounter,
      pending: new Map(),
      controlDecoder: new FrameDecoder(),
      streamDecoder: new FrameDecoder(),
      sendQueue: Promise.resolve(),
      // We advertise frame_part in auth, so the host may send parts to us and
      // we may send parts to it (the capability gate is the advertisement; the
      // auth frame itself is far below the 1 MiB part threshold).
      allowFrameParts: this.o.capabilities.includes(FRAME_PART_CAPABILITY),
      dead: false,
    };
    this.session = session;
    this.startReader(session, link.control, session.controlDecoder, 'control');
    this.startReader(session, link.stream, session.streamDecoder, 'stream');
    // The stream channel is receive-only: finish our send half right away.
    await link.stream.finish().catch(() => undefined);
    try {
      const authId = this.newRequestId('auth');
      const reply = await this.requestOn(
        session,
        {
          type: 'auth',
          request_id: authId,
          token: this.o.token,
          peer_name: this.o.peerName,
          capabilities: [...this.o.capabilities],
        },
        authId,
        this.o.authTimeoutMs,
      );
      if (reply['success'] !== true) {
        // Deliberately not echoing the frame wholesale: only the server's reason.
        const reason = firstString(reply['error'], reply['reason']) ?? 'rejected';
        throw new IrohAuthError(`iroh auth failed: ${reason}`);
      }
    } catch (err) {
      this.killSession(session, err instanceof Error ? err : new Error(String(err)), false);
      await link.close().catch(() => undefined);
      throw err;
    }
  }

  private requestOn(session: Session, frame: Frame, requestId: string, timeoutMs: number): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(new IrohTimeoutError(`iroh request ${String(frame['type'])} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      session.pending.set(requestId, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      this.send(session, frame).catch((err: unknown) => {
        const p = session.pending.get(requestId);
        session.pending.delete(requestId);
        if (p) p.reject(new IrohConnectionLostError(`iroh write failed: ${errorMessage(err)}`));
        this.handleLoss(session);
      });
    });
  }

  private send(session: Session, frame: Frame): Promise<void> {
    const json = JSON.stringify(frame);
    const chunks = session.allowFrameParts ? encodeFrameParts(json) : [encodeFrame(json)];
    // Per-stream mutex: parts of one logical frame must be contiguous.
    const run = session.sendQueue.then(async () => {
      for (const c of chunks) await session.link.control.write(c);
    });
    session.sendQueue = run.catch(() => undefined);
    return run;
  }

  private startReader(session: Session, duplex: DuplexLike, decoder: FrameDecoder, channel: 'control' | 'stream'): void {
    void (async () => {
      try {
        for (;;) {
          const chunk = await duplex.read(this.o.readChunkBytes);
          if (chunk == null || chunk.length === 0) break;
          for (const text of decoder.feed(chunk)) this.route(session, text, channel);
        }
        decoder.finish();
      } catch (err) {
        this.o.log(`iroh ${channel} reader ended: ${errorMessage(err)}`);
      }
      this.handleLoss(session);
    })();
  }

  private route(session: Session, text: string, channel: 'control' | 'stream'): void {
    let frame: Frame;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Frame;
    } catch {
      this.o.log(`iroh ${channel}: dropped non-JSON frame`);
      return;
    }
    if (session.dead) return;
    const rid = frame['request_id'];
    if (channel === 'control' && typeof rid === 'string') {
      const p = session.pending.get(rid);
      if (p) {
        session.pending.delete(rid);
        p.resolve(frame);
        return;
      }
    }
    for (const l of [...this.frameListeners]) {
      try {
        l(frame);
      } catch (err) {
        this.o.log(`iroh frame listener threw: ${errorMessage(err)}`);
      }
    }
  }

  private handleLoss(session: Session): void {
    if (session.dead) return;
    this.killSession(session, new IrohConnectionLostError());
    void session.link.close().catch(() => undefined);
  }

  private killSession(session: Session, reason: Error, notify = true): void {
    if (session.dead) return;
    session.dead = true;
    if (this.session === session) this.session = null;
    for (const [, p] of session.pending) p.reject(reason);
    session.pending.clear();
    if (!notify) return;
    for (const l of [...this.disconnectListeners]) {
      try {
        l(session.generation);
      } catch (err) {
        this.o.log(`iroh disconnect listener threw: ${errorMessage(err)}`);
      }
    }
  }
}

export function refusalFrom(what: string, error: unknown): IrohRefusedError {
  const text =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? (firstString((error as Frame)['message'], (error as Frame)['error']) ?? JSON.stringify(error))
        : 'refused';
  const code = /forbidden/i.test(text) ? 'forbidden' : /not.?found|unknown method|unsupported/i.test(text) ? 'not_found' : null;
  return new IrohRefusedError(`${what} refused: ${text}`, code);
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
