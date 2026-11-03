/**
 * IrohWrapperProvider — RuntimeProvider that runs formula steps through the
 * Letta Iroh wrapper as a paired peer (vibesync-x38j / vibesync-57mi).
 *
 * DIRECT ROLE DISPATCH (vibesync-jni4). Each step goes straight to the role
 * agent that owns the step's role: conversation.create on THAT agent,
 * runtime_start, ONE input carrying only the rendered step prompt (task +
 * prior outputs), wait for turn_finished, then read the role agent's own final
 * assistant message for that turn. There is no parent PM agent and no Agent
 * tool in the path. The previous design puppeted the parent into calling the
 * Agent tool; in letta-code 0.34.x that tool ALWAYS runs in the background and
 * returns "Task running in background ..." at once, so the parent ended its
 * turn with a "Waiting for ..." placeholder and the step closed green with the
 * placeholder as its output while no work had been done.
 *
 * Role agents carry their persona in their own system prompt, so none is
 * inlined. The role agent id comes from SessionSpec.extra.agentId, else the
 * injected AgentIdResolver (project_role_agents). If neither yields an id the
 * step FAILS with that reason; it never falls back to another agent.
 *
 * Per session: one fresh conversation on the role agent. One IrohConnection is
 * shared by every session of a provider instance.
 *
 * Event contract with the dispatcher (it concatenates EVERY message-delta into
 * the step output): live stream deltas are progress only and are surfaced as
 * first-token / tool-call events, never as message-delta. The step output is
 * the role agent's final assistant message of THIS turn (matched by the
 * turn_finished run_id, see turn-client.lastAssistantText), read back with
 * message.list after turn_finished and emitted as the single message-delta. A
 * turn that ends in anything but a completed boundary (including
 * requires_approval) is an `error` event, so a step can never close green
 * without having done its work.
 *
 * SessionSpec.extra: parentAgentId (required; only passed to the resolver as
 * context, never messaged), agentId, projectIdentifier, moleculeId, stepName,
 * attempt, turnTimeoutMs. Others (subagentType, personaContent,
 * conversationId) are ignored: the conversation is always fresh.
 */

import { randomUUID } from 'node:crypto';

import type { IrohConnection } from './iroh/connection.js';
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
  contentToText,
  readNumberExtra,
  readStringExtra,
  resolveDefaultTurnTimeout,
} from './subagent-dispatch.js';
import type { AgentIdResolver } from './subagent-dispatch.js';

export const IROH_PROVIDER_KIND = 'letta-code-iroh';

export interface IrohWrapperProviderOptions {
  /** Shared, lazily-dialed connection. The provider never dials at construction. */
  readonly connection: IrohConnection;
  /**
   * Resolves the role agent id for (role, project) when SessionSpec.extra.agentId
   * is absent. Production wires project_role_agents. No resolver and no
   * extra.agentId => start() fails (there is no fallback agent).
   */
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
  /** The role agent the step is dispatched to. */
  readonly agentId: string;
}

interface SessionState {
  readonly role: string;
  /** The role agent every call of this session targets. */
  readonly agentId: string;
  readonly stepTimeoutMs: number | null;
  readonly moleculeId: string | null;
  readonly motivatingBeadId: string | null;
  readonly stepName: string | null;
  /** Title for the step's conversation in the app list (see stepConversationTitle). */
  readonly title: string | null;
  readonly attempt: number | null;
  /** Infra failures this step already absorbed (vibesync-ynmp): they do not bump `attempt`, so they must still change the client message id. */
  readonly infraRetries: number;
  readonly abort: AbortController;
  readonly seenTurnIds: Set<string>;
  conversationId: string | null;
  promptCount: number;
  stopped: boolean;
  events: SessionEvent[];
  promptDone: Promise<void> | null;
  /** Every parked observer's wakeup (CodeRabbit #55: one slot let a second observer steal the first's). */
  waiters: Set<() => void>;
}

export class IrohWrapperProvider implements RuntimeProvider {
  readonly kind = IROH_PROVIDER_KIND;
  private readonly conn: IrohConnection;
  private readonly agentIdResolver: AgentIdResolver | null;
  private readonly turnTimeoutMs: number;
  private readonly runtimeMode: string;
  private readonly turnOptions: NonNullable<IrohWrapperProviderOptions['turnOptions']>;
  private readonly log: (m: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private handleCounter = 0;

  constructor(opts: IrohWrapperProviderOptions) {
    if (!opts.connection) throw new Error('IrohWrapperProvider: connection is required');
    this.conn = opts.connection;
    this.agentIdResolver = opts.agentIdResolver ?? null;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? resolveDefaultTurnTimeout();
    this.runtimeMode = opts.runtimeMode ?? 'unrestricted';
    this.turnOptions = opts.turnOptions ?? {};
    this.log = opts.log ?? (() => undefined);
  }

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const projectIdentifier = readStringExtra(spec, 'projectIdentifier') ?? null;
    // Only context for the resolver; the parent is never messaged by this provider.
    const parentAgentId = readStringExtra(spec, 'parentAgentId') ?? '';

    // Explicit agentId (dispatcher/bootstrapper) wins, then the resolver. There is
    // deliberately NO fallback agent: dispatching a role's work to anyone else
    // (the parent PM, an inline persona) is how steps closed green without work.
    let agentId = readStringExtra(spec, 'agentId') ?? null;
    if (agentId === null && this.agentIdResolver) {
      agentId = await this.agentIdResolver.resolveRoleAgent(spec.role, parentAgentId, projectIdentifier);
    }
    if (!agentId) {
      throw new Error(
        `IrohWrapperProvider.start: no role agent id for role "${spec.role}"` +
          `${projectIdentifier ? ` in project "${projectIdentifier}"` : ' (no projectIdentifier on the dispatch)'}: ` +
          'SessionSpec.extra.agentId is absent and the resolver (project_role_agents) returned none. ' +
          'Refusing to fall back to another agent.',
      );
    }

    this.handleCounter += 1;
    const handle: IrohSessionHandle = {
      id: `${IROH_PROVIDER_KIND}:${agentId}:${spec.role}:${this.handleCounter}`,
      providerKind: IROH_PROVIDER_KIND,
      role: spec.role,
      agentId,
    };
    const attempt = spec.extra?.['attempt'];
    this.sessions.set(handle.id, {
      role: spec.role,
      agentId,
      stepTimeoutMs: readNumberExtra(spec, 'turnTimeoutMs') ?? null,
      moleculeId: readStringExtra(spec, 'moleculeId') ?? null,
      motivatingBeadId: readStringExtra(spec, 'motivatingBeadId') ?? null,
      stepName: readStringExtra(spec, 'stepName') ?? null,
      title: stepConversationTitle(
        readStringExtra(spec, 'formulaName') ?? null,
        readStringExtra(spec, 'stepName') ?? null,
        readStringExtra(spec, 'motivatingBeadId') ?? null,
      ),
      attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : null,
      infraRetries: readNumberExtra(spec, 'infraRetries') ?? 0,
      abort: new AbortController(),
      seenTurnIds: new Set(),
      conversationId: null,
      promptCount: 0,
      stopped: false,
      events: [],
      promptDone: null,
      waiters: new Set(),
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
    wakeAll(state);
    this.sessions.delete(h.id);
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) throw new Error(`IrohWrapperProvider.prompt: unknown session ${h.id}`);
    if (state.stopped) throw new Error(`IrohWrapperProvider.prompt: session ${h.id} already stopped`);

    // ONE input: the rendered step prompt (task + prior outputs) and nothing else.
    // The role agent already carries its persona in its own system prompt.
    const text = contentToText(content);
    state.promptCount += 1;
    const clientMessageId = clientMessageIdFor(state, h.id);
    state.events = [];

    // Surface the conversation id to the dispatcher (step trace) as soon as the
    // fresh conversation exists. A creation failure still flows as an error event.
    let conversationKnown!: (id: string | null) => void;
    const known = new Promise<string | null>((resolve) => {
      conversationKnown = resolve;
    });
    state.promptDone = this.runPrompt(state, text, clientMessageId, conversationKnown)
      .catch((err: unknown) => {
        this.push(state, { kind: 'error', ts: nowIso(), code: errorCode(err), message: errorMessage(err) });
        this.push(state, { kind: 'turn-done', ts: nowIso(), stopReason: 'error' });
      })
      .finally(() => conversationKnown(null));
    const conversationId = await known;
    return conversationId ? { conversationId } : {};
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
      let wake!: () => void;
      const settled = await new Promise<'event' | 'done'>((resolve) => {
        wake = () => resolve('event');
        state.waiters.add(wake);
        void state.promptDone!.then(() => resolve('done'));
      });
      state.waiters.delete(wake);
      if (settled === 'done' && cursor >= state.events.length) {
        // prompt settled without a terminal event: never leave the dispatcher hanging.
        yield { kind: 'turn-done', ts: nowIso(), stopReason: 'closed' };
        return;
      }
    }
  }

  /**
   * The shared connection. Other clients of the same Iroh peer identity (the PM
   * wake sink, vibesync-2bgv) borrow it so there is one dial and one auth.
   * They must not close it: the owner does that through {@link close}.
   */
  get connection(): IrohConnection {
    return this.conn;
  }

  /** Close the shared connection (daemon shutdown). */
  async close(): Promise<void> {
    await this.conn.close();
  }

  // ───────────────────────── internals ─────────────────────────

  private async runPrompt(
    state: SessionState,
    text: string,
    clientMessageId: string,
    conversationKnown: (id: string | null) => void,
  ): Promise<void> {
    this.push(state, { kind: 'started', ts: nowIso() });
    await this.conn.connect();
    // Always a fresh conversation on the ROLE agent: a retried attempt must not
    // inherit a half-finished turn, and concurrent steps of one role must not
    // share context.
    state.conversationId ??= await createConversation(this.conn, state.agentId, state.title ?? undefined, {
      tags: workConversationTags(state.moleculeId, state.motivatingBeadId),
    });
    conversationKnown(state.conversationId);
    let firstToken = false;
    const result = await runTurn(
      this.conn,
      { agentId: state.agentId, conversationId: state.conversationId, text, clientMessageId },
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
    wakeAll(state);
  }
}

function wakeAll(state: SessionState): void {
  for (const w of [...state.waiters]) w();
}

/** Stable per logical prompt: the same step attempt re-sent after a redial dedupes on the wrapper. */
function clientMessageIdFor(state: SessionState, handleId: string): string {
  if (state.moleculeId && state.stepName) {
    const attempt = `${state.attempt ?? 1}${state.infraRetries > 0 ? `r${state.infraRetries}` : ''}`;
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

/**
 * "<formula> · <step> · <bead>" (bead omitted when the run has none). Shown as
 * the conversation title in the app, so a run's turns are findable by formula,
 * step and the bead that motivated it. Null when there is nothing to name.
 */
export function stepConversationTitle(formulaName: string | null, stepName: string | null, motivatingBeadId: string | null): string | null {
  const parts = [formulaName, stepName, motivatingBeadId].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function workConversationTags(moleculeId: string | null, motivatingBeadId: string | null): string[] {
  return [
    'lane:work',
    ...(motivatingBeadId ? [`bead:${motivatingBeadId}`] : []),
    ...(moleculeId ? [`run:${moleculeId}`] : []),
  ];
}
