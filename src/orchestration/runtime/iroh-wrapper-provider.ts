/**
 * IrohWrapperProvider — RuntimeProvider that runs formula steps through the
 * Letta Iroh wrapper as a paired peer (vibesync-x38j / vibesync-57mi).
 *
 * Replaces the retired admin-shim HTTP transport of LettaCodeSubagentProvider.
 * ONLY the transport differs: the puppet message (the parent PM agent is told
 * to call Agent(subagent_type=…, agent_id=<role agent>, …) and return its
 * output) and the persona/agent-id resolution come from the shared
 * `subagent-dispatch.ts`, which both providers import.
 *
 * Per session: one fresh conversation on the parent agent (conversation.create)
 * unless SessionSpec.extra.conversationId names one that exists on the host.
 * One IrohConnection is shared by every session of a provider instance.
 *
 * Event contract with the dispatcher (it concatenates EVERY message-delta into
 * the step output): live stream deltas are progress only and are surfaced as
 * first-token / tool-call events, never as message-delta. The step output is
 * the final assistant message read back with message.list after turn_finished,
 * emitted as the single message-delta. A turn that ends in anything but a
 * completed boundary (including requires_approval) is an `error` event, so a
 * step can never close green without having done its work.
 *
 * SessionSpec.extra: parentAgentId (required), subagentType, agentId,
 * personaContent, conversationId, projectIdentifier, moleculeId, stepName,
 * attempt, turnTimeoutMs — same keys as LettaCodeSubagentProvider.
 */

import { randomUUID } from 'node:crypto';

import type { IrohConnection } from './iroh/connection.js';
import { IrohRefusedError } from './iroh/connection.js';
import { REQUIRES_APPROVAL } from './iroh/stop-reason.js';
import { createConversation, runTurn } from './iroh/turn-client.js';
import type { RunTurnOptions, TurnResult } from './iroh/turn-client.js';
import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';
import {
  buildPuppetMessage,
  contentToText,
  readNumberExtra,
  readStringExtra,
  resolveDefaultTurnTimeout,
} from './subagent-dispatch.js';
import type { AgentIdResolver, PersonaLoader } from './subagent-dispatch.js';

export const IROH_PROVIDER_KIND = 'letta-code-iroh';

export interface IrohWrapperProviderOptions {
  /** Shared, lazily-dialed connection. The provider never dials at construction. */
  readonly connection: IrohConnection;
  /** Fallback when no persistent role agent id resolves (same contract as LettaCodeSubagentProvider). */
  readonly personaLoader: PersonaLoader;
  readonly agentIdResolver?: AgentIdResolver;
  readonly turnTimeoutMs?: number;
  /** Runtime start mode. Unattended steps need 'unrestricted' (Meridian decision). */
  readonly runtimeMode?: string;
  /** Extra runTurn tuning (grace windows, redial limits). Tests inject small values. */
  readonly turnOptions?: Omit<RunTurnOptions, 'mode' | 'turnTimeoutMs' | 'signal' | 'onProgress' | 'ignoreTurnIds'>;
  readonly log?: (message: string) => void;
}

interface IrohSessionHandle extends SessionHandle {
  readonly providerKind: typeof IROH_PROVIDER_KIND;
  readonly role: string;
  readonly parentAgentId: string;
}

interface SessionState {
  readonly role: string;
  readonly parentAgentId: string;
  readonly subagentType: string;
  readonly personaContent: string;
  readonly agentId: string | null;
  readonly stepTimeoutMs: number | null;
  readonly moleculeId: string | null;
  readonly stepName: string | null;
  readonly attempt: number | null;
  readonly abort: AbortController;
  readonly seenTurnIds: Set<string>;
  conversationId: string | null;
  promptCount: number;
  stopped: boolean;
  events: SessionEvent[];
  promptDone: Promise<void> | null;
  notify: (() => void) | null;
}

export class IrohWrapperProvider implements RuntimeProvider {
  readonly kind = IROH_PROVIDER_KIND;
  private readonly conn: IrohConnection;
  private readonly personaLoader: PersonaLoader;
  private readonly agentIdResolver: AgentIdResolver | null;
  private readonly turnTimeoutMs: number;
  private readonly runtimeMode: string;
  private readonly turnOptions: NonNullable<IrohWrapperProviderOptions['turnOptions']>;
  private readonly log: (m: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private handleCounter = 0;

  constructor(opts: IrohWrapperProviderOptions) {
    if (!opts.connection) throw new Error('IrohWrapperProvider: connection is required');
    if (!opts.personaLoader) throw new Error('IrohWrapperProvider: personaLoader is required');
    this.conn = opts.connection;
    this.personaLoader = opts.personaLoader;
    this.agentIdResolver = opts.agentIdResolver ?? null;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? resolveDefaultTurnTimeout();
    this.runtimeMode = opts.runtimeMode ?? 'unrestricted';
    this.turnOptions = opts.turnOptions ?? {};
    this.log = opts.log ?? (() => undefined);
  }

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const parentAgentId = readStringExtra(spec, 'parentAgentId');
    if (!parentAgentId) {
      throw new Error('IrohWrapperProvider.start: SessionSpec.extra.parentAgentId is required');
    }
    const subagentType = readStringExtra(spec, 'subagentType') ?? 'general-purpose';
    const projectIdentifier = readStringExtra(spec, 'projectIdentifier') ?? null;

    // Same precedence as LettaCodeSubagentProvider: explicit agentId, resolver, inline persona.
    let resolvedAgentId = readStringExtra(spec, 'agentId') ?? null;
    if (resolvedAgentId === null && this.agentIdResolver) {
      resolvedAgentId = await this.agentIdResolver.resolveRoleAgent(spec.role, parentAgentId, projectIdentifier);
    }
    const personaContent =
      resolvedAgentId !== null
        ? ''
        : readStringExtra(spec, 'personaContent') ?? (await this.personaLoader.load(spec.role));

    this.handleCounter += 1;
    const handle: IrohSessionHandle = {
      id: `${IROH_PROVIDER_KIND}:${parentAgentId}:${spec.role}:${this.handleCounter}`,
      providerKind: IROH_PROVIDER_KIND,
      role: spec.role,
      parentAgentId,
    };
    const attempt = spec.extra?.['attempt'];
    this.sessions.set(handle.id, {
      role: spec.role,
      parentAgentId,
      subagentType,
      personaContent,
      agentId: resolvedAgentId,
      stepTimeoutMs: readNumberExtra(spec, 'turnTimeoutMs') ?? null,
      moleculeId: readStringExtra(spec, 'moleculeId') ?? null,
      stepName: readStringExtra(spec, 'stepName') ?? null,
      attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : null,
      abort: new AbortController(),
      seenTurnIds: new Set(),
      conversationId: readStringExtra(spec, 'conversationId') ?? null,
      promptCount: 0,
      stopped: false,
      events: [],
      promptDone: null,
      notify: null,
    });
    return handle;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) return;
    state.stopped = true;
    // The turn itself keeps running on the host (parked there); we only stop waiting.
    state.abort.abort();
    state.notify?.();
    this.sessions.delete(h.id);
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) throw new Error(`IrohWrapperProvider.prompt: unknown session ${h.id}`);
    if (state.stopped) throw new Error(`IrohWrapperProvider.prompt: session ${h.id} already stopped`);

    const puppet = buildPuppetMessage({
      subagentType: state.subagentType,
      personaContent: state.personaContent,
      role: state.role,
      input: contentToText(content),
      agentId: state.agentId,
    });
    state.promptCount += 1;
    const clientMessageId = clientMessageIdFor(state, h.id);
    state.events = [];

    state.promptDone = this.runPrompt(state, puppet, clientMessageId).catch((err: unknown) => {
      this.push(state, { kind: 'error', ts: nowIso(), code: errorCode(err), message: errorMessage(err) });
      this.push(state, { kind: 'turn-done', ts: nowIso(), stopReason: 'error' });
    });
    return {};
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // No nudge verb on the wrapper protocol.
  }

  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) {
      yield { kind: 'error', ts: nowIso(), code: 'unknown_session', message: `IrohWrapperProvider.observe: no session for ${h.id}` };
      return;
    }
    while (!state.promptDone && !state.stopped) await sleep(10);
    let cursor = 0;
    for (;;) {
      if (cursor < state.events.length) {
        const ev = state.events[cursor]!;
        cursor += 1;
        yield ev;
        if (ev.kind === 'turn-done' || ev.kind === 'stopped') return;
        continue;
      }
      if (state.stopped) {
        yield { kind: 'stopped', ts: nowIso() };
        return;
      }
      const settled = await new Promise<'event' | 'done'>((resolve) => {
        state.notify = () => resolve('event');
        void state.promptDone!.then(() => resolve('done'));
      });
      state.notify = null;
      if (settled === 'done' && cursor >= state.events.length) {
        // prompt settled without a terminal event: never leave the dispatcher hanging.
        yield { kind: 'turn-done', ts: nowIso(), stopReason: 'closed' };
        return;
      }
    }
  }

  /** Close the shared connection (daemon shutdown). */
  async close(): Promise<void> {
    await this.conn.close();
  }

  // ───────────────────────── internals ─────────────────────────

  private async runPrompt(state: SessionState, puppet: string, clientMessageId: string): Promise<void> {
    this.push(state, { kind: 'started', ts: nowIso() });
    await this.conn.connect();
    if (state.conversationId) {
      state.conversationId = await this.confirmConversation(state.parentAgentId, state.conversationId);
    }
    if (!state.conversationId) {
      state.conversationId = await createConversation(this.conn, state.parentAgentId);
    }
    let firstToken = false;
    const result = await runTurn(
      this.conn,
      { agentId: state.parentAgentId, conversationId: state.conversationId, text: puppet, clientMessageId },
      {
        ...this.turnOptions,
        mode: this.runtimeMode,
        turnTimeoutMs: state.stepTimeoutMs ?? this.turnTimeoutMs,
        signal: state.abort.signal,
        ignoreTurnIds: state.seenTurnIds,
        onProgress: (p) => {
          if (p.kind === 'delta' && !firstToken) {
            firstToken = true;
            this.push(state, { kind: 'first-token', ts: nowIso() });
          } else if (p.kind === 'tool-call') {
            if (!firstToken && (p.tool === 'Agent' || p.tool === 'Task')) {
              firstToken = true;
              this.push(state, { kind: 'first-token', ts: nowIso() });
            }
            this.push(state, { kind: 'tool-call', ts: nowIso(), tool: p.tool ?? 'unknown', args: p.args ?? null });
          } else if (p.kind === 'redial') {
            this.log(`iroh turn redialing (conv=${state.conversationId})`);
          }
        },
      },
    );
    if (state.stopped) return; // observe() reports 'stopped'
    this.finishTurn(state, result);
  }

  /** An id minted by the dispatcher may not exist on the host; fall back to a fresh conversation then. */
  private async confirmConversation(agentId: string, conversationId: string): Promise<string | null> {
    try {
      await this.conn.rpc('message.list', { conversation_id: conversationId, limit: 1 });
      return conversationId;
    } catch (err) {
      if (err instanceof IrohRefusedError && err.code !== 'forbidden') {
        this.log(`iroh: conversation ${conversationId} not found on host for ${agentId}; creating a fresh one`);
        return null;
      }
      throw err;
    }
  }

  private finishTurn(state: SessionState, r: TurnResult): void {
    if (r.usage) {
      const prompt = numberOf(r.usage['prompt_tokens']);
      const completion = numberOf(r.usage['completion_tokens']);
      if (prompt !== null || completion !== null) {
        this.push(state, { kind: 'usage', ts: nowIso(), prompt: prompt ?? 0, completion: completion ?? 0 });
      }
    }
    if (r.boundary === 'completed') {
      if (r.finalText.length === 0) {
        this.push(state, { kind: 'error', ts: nowIso(), code: 'empty_output', message: `turn completed (${r.stopReason ?? 'no stop_reason'}) but the conversation holds no assistant output` });
        this.push(state, { kind: 'turn-done', ts: nowIso(), stopReason: 'error' });
        return;
      }
      this.push(state, { kind: 'message-delta', ts: nowIso(), text: r.finalText });
      this.push(state, { kind: 'turn-done', ts: nowIso(), ...(r.stopReason ? { stopReason: r.stopReason } : {}) });
      return;
    }
    const code = r.failureReason ?? 'turn_failed';
    const message =
      code === 'requires_approval'
        ? `runtime halted on ${REQUIRES_APPROVAL} — no approver for unattended steps (runtime mode '${this.runtimeMode}')`
        : r.error ?? `turn ended ${r.boundary} (stop_reason=${r.stopReason ?? 'none'})`;
    this.push(state, { kind: 'error', ts: nowIso(), code, message });
    this.push(state, { kind: 'turn-done', ts: nowIso(), stopReason: r.stopReason ?? 'error' });
  }

  private push(state: SessionState, ev: SessionEvent): void {
    state.events.push(ev);
    state.notify?.();
  }
}

/** Stable per logical prompt: the same step attempt re-sent after a redial dedupes on the wrapper. */
function clientMessageIdFor(state: SessionState, handleId: string): string {
  if (state.moleculeId && state.stepName) {
    const attempt = state.attempt ?? 1;
    const seq = state.promptCount > 1 ? `:p${state.promptCount}` : '';
    return `vibesync:${state.moleculeId}:${state.stepName}:a${attempt}${seq}`;
  }
  return `vibesync:${handleId}:${state.promptCount}:${randomUUID()}`;
}

function expectHandle(handle: SessionHandle): IrohSessionHandle {
  if (handle.providerKind !== IROH_PROVIDER_KIND) {
    throw new Error(`IrohWrapperProvider: handle from wrong provider (got ${handle.providerKind}, want ${IROH_PROVIDER_KIND})`);
  }
  return handle as IrohSessionHandle;
}

function errorCode(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'iroh_error';
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function numberOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function nowIso(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
