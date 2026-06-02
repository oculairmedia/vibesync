/**
 * LettaCodeSubagentProvider — RuntimeProvider for the letta-code local
 * backend (vibesync-573 / vibesync-f5g).
 *
 * Drives Letta Code's `Agent` (a.k.a. Task) tool by puppeting the parent
 * PM agent through the local-backend shim's conversations API:
 *
 *   POST /v1/conversations                  → create a conversation tied to {agent_id}
 *   POST /v1/conversations/{conv}/messages  → send a user-marked message; the
 *                                              shim replies as Server-Sent Events
 *                                              (data: {json}\n\n)
 *
 * Each formula-step session lazily creates one conversation on the
 * first prompt() (so resume + multi-prompt sessions stay grouped). The
 * puppet message instructs the PM to call Agent(subagent_type=
 * 'general-purpose', prompt=<inlined persona> + <rendered template>)
 * and return the subagent's final output.
 *
 * # Why subagent_type='general-purpose' + inline persona
 *
 * vibesync-s28 documents that Letta Code 0.25.11 does NOT discover
 * custom .letta/agents/<role>.md subagent types via the Agent tool's
 * subagent_type parameter. The workaround — verified during the rig
 * smoke on 2026-05-21 — is to pass subagent_type='general-purpose'
 * (which the runtime always knows about) and INLINE the role's persona
 * content from packs/gastown/.letta/agents/<role>.md as the leading
 * block of the prompt. That gives us identity, tools-doc, and
 * output-format constraints without depending on subagent discovery.
 *
 * # SSE parsing
 *
 * The shim returns chunked Server-Sent Events. Frames are separated by
 * blank lines and contain one or more `data:` lines whose payload is
 * JSON. We parse line-by-line, accumulating partial frames across
 * chunk boundaries, and translate recognized event shapes into the
 * RuntimeProvider SessionEvent stream.
 *
 * # Subagent output extraction
 *
 * The dispatcher concatenates `message-delta.text` events to build the
 * step output (see FormulaDispatcher.runStepAttempt). Prefer Agent
 * tool-return payloads when the shim sends them, because they are the
 * cleanest representation of the subagent's final response. Newer SDK
 * shim streams can omit `tool_return_message` and carry the role output
 * as an `assistant_message` instead, so assistant content is accepted as
 * a fallback rather than being dropped as scaffolding.
 *
 * # Approval halts
 *
 * If the PM hits stop_reason='requires_approval' (vibesync-573 smoke
 * blocker 2), the provider surfaces it as a `turn-done` event with
 * stopReason='requires_approval' rather than throwing. Higher layers
 * can decide to re-prompt with an approval ack or surface to the
 * user. This is the contract documented in vibesync-f5g.
 *
 * # Lifecycle
 *
 * Subagent processes are owned by Letta Code's Task runtime — we do
 * NOT call DELETE on any agent during stop(). The leak surface from the
 * removed Teams-backed provider (vibesync-6zj) does not apply here
 * because we don't spawn separate Letta agents.
 *
 * # SessionSpec.extra
 *
 *   parentAgentId  — REQUIRED. The PM agent that hosts the Agent tool
 *                    call. Resolved by FormulaDispatcher / boot from
 *                    the per-project routing row.
 *   subagentType   — optional; passed through but defaults to
 *                    'general-purpose' (s28 workaround). The role's
 *                    actual identity comes from the inlined persona.
 *   moleculeId     — optional; threaded into log lines.
 *   stepName       — optional; same.
 *   personaContent — optional; if supplied, used as the inline persona
 *                    block instead of reading from packs. Useful for
 *                    tests and for callers that already have the
 *                    persona in hand.
 *   conversationId — optional; resume an existing conversation
 *                    (otherwise a new one is created on first prompt).
 *
 * See vibesync-573, vibesync-f5g.
 */

import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

/**
 * Reader for role-persona content. Production wires this to the
 * filesystem; tests can inject a fake. The pack/role tuple is the
 * key — we don't take an absolute path because pack discovery is
 * resolved one layer up (formula → pack).
 */
export interface PersonaLoader {
  /**
   * Return the .md body (frontmatter included is fine — the PM will
   * skim past it) for the given role name. Throws when the role is
   * not found, since a missing persona is a configuration error, not
   * a runtime degradation.
   */
  load(role: string): Promise<string>;
}

/**
 * Resolver for persistent per-(project, role) subagent ids
 * (vibesync-mcz Phase C). Wired in production to the
 * RoleAgentBootstrapper backed by project_role_agents.
 *
 * Contract:
 *   - Return a real Letta Code agent id ('agent-<uuid>') and the
 *     provider will dispatch via Agent(subagent_type='general-purpose',
 *     agent_id=<id>, prompt=<task>) — persona is NOT inlined; the
 *     persistent agent owns its own system prompt.
 *   - Return null and the provider falls back to today's inline
 *     persona path (backwards compat for projects that haven't been
 *     bootstrapped yet, or callers that don't want persistence).
 *   - Throwing is treated as a hard failure (start() rejects). Use
 *     null for "no row", not for transient errors.
 */
export interface AgentIdResolver {
  resolveRoleAgent(
    role: string,
    parentAgentId: string,
    projectIdentifier: string | null,
  ): Promise<string | null>;
}

export interface LettaCodeSubagentProviderOptions {
  /**
   * Base URL of the local-backend shim (e.g. http://localhost:8291).
   * Distinct from LETTA_BASE_URL, which points at the PM-agent Letta API.
   */
  readonly shimBaseUrl: string;
  /** Bearer token. Optional if the shim doesn't enforce auth. */
  readonly password?: string;
  /**
   * Default hard timeout for the SSE read loop. Default 10min — formula
   * steps with real subagents (file reads, lint, etc.) can be slow.
   * Overridden per-step via SessionSpec.extra.turnTimeoutMs (vibesync-lcp-98y8).
   * Can also be set globally via VIBESYNC_TURN_TIMEOUT_MS env var.
   */
  readonly turnTimeoutMs?: number;
  /**
   * Loader for persona content (`packs/<pack>/.letta/agents/<role>.md`).
   * Required at construction time; the default
   * `createDefaultPersonaLoader` reads from packs/gastown/.letta/agents/.
   *
   * Still required even when an AgentIdResolver is wired — it's the
   * fallback when the resolver returns null (no persistent agent has
   * been bootstrapped yet for this (project, role) pair).
   */
  readonly personaLoader: PersonaLoader;
  /**
   * Optional resolver for persistent per-(project, role) subagent ids
   * (vibesync-mcz Phase C). When provided AND the resolver returns a
   * non-null id, the puppet message dispatches via agent_id and the
   * persona is NOT inlined. When omitted, or the resolver returns
   * null, the provider uses the inline-persona path unchanged.
   */
  readonly agentIdResolver?: AgentIdResolver;
  /**
   * Injectable fetch. Defaults to the global. Tests inject a fake
   * that returns a fixed SSE body.
   */
  readonly fetchImpl?: typeof fetch;
}

interface LettaCodeSubagentSessionHandle extends SessionHandle {
  readonly providerKind: 'letta-code-subagent';
  readonly role: string;
  readonly parentAgentId: string;
}

interface SessionState {
  readonly role: string;
  readonly parentAgentId: string;
  readonly subagentType: string;
  /**
   * Persona body inlined into the puppet message when we DON'T have
   * a persistent agent id. Ignored when `agentId` is non-null (the
   * persistent agent owns its system prompt).
   */
  readonly personaContent: string;
  /**
   * Persistent role-agent id (vibesync-mcz Phase C). When non-null,
   * the puppet message dispatches with agent_id and omits persona;
   * the persistent agent's stored system prompt is the source of
   * truth for identity. When null, fall back to the inline path.
   */
  readonly agentId: string | null;
  /**
   * Per-step turn timeout (vibesync-lcp-98y8). When non-null,
   * overrides the provider's default for this session. Extracted
   * from SessionSpec.extra.turnTimeoutMs at start() time.
   */
  readonly stepTimeoutMs: number | null;
  conversationId: string | null;
  /**
   * vibesync-ctla: tracks whether the conversation has been created on
   * the shim store yet. A dispatcher-minted conversationId is present
   * but not yet created; we must POST /v1/conversations (with that id)
   * before sending the first message, or the message POST 404s.
   */
  conversationCreated: boolean;
  stopped: boolean;
  activeTaskId: string | null;
  /**
   * Captured event queue produced by prompt(). observe() drains this
   * in order. The queue is reset on each prompt() so a session can
   * be re-prompted within the same handle (resume / multi-turn).
   */
  events: SessionEvent[];
  /** Resolves to non-null once prompt() has drained the SSE stream. */
  promptDone: Promise<void> | null;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the global default turn timeout. Checks VIBESYNC_TURN_TIMEOUT_MS
 * env var first (vibesync-lcp-98y8), falls back to 10min if not set or invalid.
 */
function resolveDefaultTurnTimeout(): number {
  const envVar = process.env['VIBESYNC_TURN_TIMEOUT_MS'];
  if (envVar !== undefined) {
    const parsed = Number.parseInt(envVar, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

export class LettaCodeSubagentProvider implements RuntimeProvider {
  readonly kind = 'letta-code-subagent';
  private readonly opts: Required<
    Omit<LettaCodeSubagentProviderOptions, 'password' | 'fetchImpl' | 'agentIdResolver'>
  > & {
    readonly password: string;
    readonly fetchImpl: typeof fetch;
    readonly agentIdResolver: AgentIdResolver | null;
  };
  private readonly sessions = new Map<string, SessionState>();
  private handleCounter = 0;

  constructor(opts: LettaCodeSubagentProviderOptions) {
    if (!opts.shimBaseUrl) {
      throw new Error('LettaCodeSubagentProvider: shimBaseUrl is required');
    }
    if (!opts.personaLoader) {
      throw new Error('LettaCodeSubagentProvider: personaLoader is required');
    }
    this.opts = {
      shimBaseUrl: opts.shimBaseUrl.replace(/\/+$/, ''),
      password: opts.password ?? '',
      turnTimeoutMs: opts.turnTimeoutMs ?? resolveDefaultTurnTimeout(),
      personaLoader: opts.personaLoader,
      agentIdResolver: opts.agentIdResolver ?? null,
      fetchImpl: opts.fetchImpl ?? fetch.bind(globalThis),
    };
  }

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const parentAgentId = readStringExtra(spec, 'parentAgentId');
    if (!parentAgentId) {
      throw new Error(
        'LettaCodeSubagentProvider.start: SessionSpec.extra.parentAgentId is required',
      );
    }
    const subagentType = readStringExtra(spec, 'subagentType') ?? 'general-purpose';
    const conversationId = readStringExtra(spec, 'conversationId') ?? null;
    const projectIdentifier = readStringExtra(spec, 'projectIdentifier') ?? null;

    // vibesync-mcz Phase C: precedence for agent_id is
    //   1. explicit extra.agentId (caller already knows the id)
    //   2. resolver lookup (production: project_role_agents row)
    //   3. null → inline-persona fallback path (today's behavior)
    // Persona is only loaded on path 3 — when we have a persistent
    // agent_id, the agent's stored system prompt is the source of
    // truth and we MUST NOT re-inline persona text.
    const explicitAgentId = readStringExtra(spec, 'agentId') ?? null;
    let resolvedAgentId = explicitAgentId;
    if (resolvedAgentId === null && this.opts.agentIdResolver) {
      resolvedAgentId = await this.opts.agentIdResolver.resolveRoleAgent(
        spec.role,
        parentAgentId,
        projectIdentifier,
      );
    }

    const personaContent =
      resolvedAgentId !== null
        ? ''
        : readStringExtra(spec, 'personaContent') ?? (await this.opts.personaLoader.load(spec.role));

    // vibesync-lcp-98y8: extract per-step turnTimeoutMs from extra if present
    const stepTimeoutMs = readNumberExtra(spec, 'turnTimeoutMs') ?? null;
    this.handleCounter += 1;
    const handle: LettaCodeSubagentSessionHandle = {
      id: `letta-code-subagent:${parentAgentId}:${spec.role}:${this.handleCounter}`,
      providerKind: 'letta-code-subagent',
      role: spec.role,
      parentAgentId,
    };
    const state: SessionState = {
      role: spec.role,
      parentAgentId,
      subagentType,
      personaContent,
      agentId: resolvedAgentId,
      stepTimeoutMs,
      conversationId,
      conversationCreated: false,
      stopped: false,
      activeTaskId: null,
      events: [],
      promptDone: null,
    };
    this.sessions.set(handle.id, state);
    return handle;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) return;
    state.stopped = true;
    this.sessions.delete(h.id);
    // Subagent lifecycle is owned by the Letta Code runtime — no
    // DELETE on the parent agent. Conversations persist server-side
    // intentionally so a later session can re-attach.
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) {
      throw new Error(`LettaCodeSubagentProvider.prompt: unknown session ${h.id}`);
    }
    if (state.stopped) {
      throw new Error(`LettaCodeSubagentProvider.prompt: session ${h.id} already stopped`);
    }
    const rendered = contentToText(content);
    const puppet = buildPuppetMessage({
      subagentType: state.subagentType,
      personaContent: state.personaContent,
      role: state.role,
      input: rendered,
      agentId: state.agentId,
    });
    // Reset the event queue so observe() only sees the current turn.
    state.events = [];
    state.activeTaskId = null;
    // Both conversation creation and SSE streaming run inside the
    // background promise so failures in either surface as `error`
    // events on the observe() stream (the contract documented in
    // vibesync-f5g), not as synchronous throws from prompt().
    state.promptDone = (async () => {
      // vibesync-ctla: always ensure the conversation exists on the shim
      // before sending. If the dispatcher minted a per-step conversationId,
      // create it WITH that id (the shim honors a client-supplied id);
      // otherwise create a fresh server-assigned one. Previously this only
      // created a conversation when state.conversationId was empty, so a
      // caller-supplied (never-created) id 404'd on the first message.
      if (!state.conversationCreated) {
        const desiredId = state.conversationId;
        const createdId = await this.createConversation(state.parentAgentId, desiredId);
        // When we asked for a specific id (dispatcher-minted per-step conv),
        // keep it authoritative — the shim honors the supplied id even if a
        // given backend doesn't echo it back. Otherwise adopt the
        // server-assigned id.
        state.conversationId = desiredId ?? createdId;
        state.conversationCreated = true;
      }
      // vibesync-lcp-98y8: use per-step timeout if set, else provider default
      await this.runPromptStream(state, puppet, state.stepTimeoutMs ?? undefined);
    })().catch((err: unknown) => {
      // Surface the failure as a synthetic error event so observe()
      // can yield it before completing. Don't rethrow — promptDone is
      // observed via observe(), not awaited by the caller.
      state.events.push({
        kind: 'error',
        ts: nowIso(),
        code: 'stream_error',
        message: errorMessage(err),
      });
      state.events.push({ kind: 'turn-done', ts: nowIso(), stopReason: 'error' });
    });
    // Best-effort: pull the activeTaskId off the message envelope once
    // it's available. The shim returns the message id in the first
    // SSE frame; we can't know it synchronously, so the dispatcher
    // gets undefined here and learns the id via the started event.
    return state.activeTaskId !== null ? { taskId: state.activeTaskId } : {};
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // Letta Code's Task tool has its own scheduling — no nudge verb.
  }

  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const h = expectHandle(handle);
    const state = this.sessions.get(h.id);
    if (!state) {
      yield {
        kind: 'error',
        ts: nowIso(),
        code: 'unknown_session',
        message: `LettaCodeSubagentProvider.observe: no session for ${h.id}`,
      };
      return;
    }
    // Wait for prompt() to have been called at least once.
    while (!state.promptDone && !state.stopped) {
      await sleep(10);
    }
    if (state.stopped) {
      yield { kind: 'stopped', ts: nowIso() };
      return;
    }
    let cursor = 0;
    // Drain events as the SSE handler appends to the queue. We yield
    // each event once, then either await more events or exit when the
    // queue carries a terminal event (turn-done / stopped / error).
    while (true) {
      if (state.stopped) {
        yield { kind: 'stopped', ts: nowIso() };
        return;
      }
      if (cursor < state.events.length) {
        const ev = state.events[cursor]!;
        cursor += 1;
        yield ev;
        if (ev.kind === 'turn-done' || ev.kind === 'stopped') return;
        continue;
      }
      // Queue drained — wait briefly for more, or exit if prompt
      // settled and nothing new came in.
      const settled = await Promise.race([
        state.promptDone!.then(() => 'done' as const),
        sleep(25).then(() => 'tick' as const),
      ]);
      if (settled === 'done' && cursor >= state.events.length) {
        // Stream ended without an explicit terminal event — synthesize
        // one so the dispatcher's for-await loop terminates.
        yield { kind: 'turn-done', ts: nowIso(), stopReason: 'closed' };
        return;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  private async createConversation(parentAgentId: string, desiredId?: string | null): Promise<string> {
    const url = `${this.opts.shimBaseUrl}/v1/conversations`;
    // vibesync-ctla: when the dispatcher mints a per-step conversation_id
    // (Phase D isolation), the shim store has no such conversation yet, so
    // POSTing the turn to /v1/conversations/<id>/messages 404s. The shim's
    // POST /v1/conversations accepts a client-supplied `id`, so create the
    // conversation with the desired id up front. Without a desiredId, the
    // shim assigns one.
    const body: Record<string, unknown> = { agent_id: parentAgentId };
    if (desiredId) body['id'] = desiredId;
    const res = await this.opts.fetchImpl(url, {
      method: 'POST',
      headers: this.headers({ json: true }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(
        `LettaCodeSubagentProvider: POST /v1/conversations failed (${res.status}): ${body}`,
      );
    }
    const json = (await res.json()) as { id?: string; conversation_id?: string };
    const id = json.id ?? json.conversation_id;
    if (!id) {
      throw new Error(
        `LettaCodeSubagentProvider: POST /v1/conversations returned no id (body=${JSON.stringify(json)})`,
      );
    }
    return id;
  }

  private async runPromptStream(state: SessionState, puppet: string, stepTimeoutMs?: number): Promise<void> {
    const url = `${this.opts.shimBaseUrl}/v1/conversations/${encodeURIComponent(state.conversationId!)}/messages`;
    const ac = new AbortController();
    const effectiveTimeout = stepTimeoutMs ?? this.opts.turnTimeoutMs;
    const timeoutHandle = setTimeout(() => ac.abort(), effectiveTimeout);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.opts.fetchImpl(url, {
        method: 'POST',
        headers: this.headers({ json: true, sse: true }),
        // admin-shim's /v1/conversations/:id/messages handler accepts
        // `input`, `text`, or Letta-style `messages[]`, but NOT a bare
        // top-level { role, content } envelope. Sending `input` keeps the
        // provider aligned with the shim's accepted contract and avoids
        // 400 {"detail":"missing user text"} failures on dispatch.
        body: JSON.stringify({ input: puppet }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      throw err;
    }
    if (!res.ok) {
      clearTimeout(timeoutHandle);
      const body = await safeReadText(res);
      throw new Error(
        `LettaCodeSubagentProvider: POST .../messages failed (${res.status}): ${body}`,
      );
    }
    state.events.push({ kind: 'started', ts: nowIso() });
    try {
      await this.consumeSseBody(state, res);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Read the SSE body line-by-line, translating recognized frames into
   * SessionEvents. Tolerant of unknown frame kinds — they pass through
   * as no-ops so the shim can add new event types without breaking us.
   */
  private async consumeSseBody(state: SessionState, res: Response): Promise<void> {
    const body = res.body;
    if (!body) {
      state.events.push({
        kind: 'error',
        ts: nowIso(),
        code: 'empty_body',
        message: 'LettaCodeSubagentProvider: SSE response has no body',
      });
      state.events.push({ kind: 'turn-done', ts: nowIso(), stopReason: 'error' });
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let firstTokenEmitted = false;
    let turnDoneEmitted = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines (\n\n).
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const frameEvents = parseSseFrame(frame);
          for (const frameEvent of frameEvents) {
            const translated = translateShimEvent(frameEvent);
            for (const ev of translated.events) {
              if (ev.kind === 'first-token') {
                if (firstTokenEmitted) continue;
                firstTokenEmitted = true;
              }
              if (ev.kind === 'turn-done') turnDoneEmitted = true;
              state.events.push(ev);
            }
            if (translated.taskId && !state.activeTaskId) {
              state.activeTaskId = translated.taskId;
            }
          }
          split = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
      // Flush a trailing frame without the blank-line terminator.
      if (buffer.trim().length > 0) {
        const frameEvents = parseSseFrame(buffer);
        for (const frameEvent of frameEvents) {
          const translated = translateShimEvent(frameEvent);
          for (const ev of translated.events) {
            if (ev.kind === 'turn-done') turnDoneEmitted = true;
            state.events.push(ev);
          }
        }
      }
    } catch (err) {
      state.events.push({
        kind: 'error',
        ts: nowIso(),
        code: 'sse_read_error',
        message: errorMessage(err),
      });
    } finally {
      if (!turnDoneEmitted) {
        state.events.push({ kind: 'turn-done', ts: nowIso(), stopReason: 'closed' });
      }
    }
  }

  private headers(opts: { json?: boolean; sse?: boolean }): Record<string, string> {
    const h: Record<string, string> = {};
    if (opts.json) h['Content-Type'] = 'application/json';
    if (opts.sse) h['Accept'] = 'text/event-stream';
    else h['Accept'] = 'application/json';
    if (this.opts.password) h['Authorization'] = `Bearer ${this.opts.password}`;
    return h;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the puppet message body the dispatcher posts to the PM. The
 * PM is instructed to call Agent(subagent_type=..., prompt=...) with
 * the persona inlined and the rendered template as the task.
 *
 * Kept ASCII-friendly and explicit so the PM's instruction-following
 * has the smallest possible space to misinterpret.
 *
 * vibesync-mcz Phase C: when `agentId` is provided, the puppet
 * instructs the PM to dispatch via Agent(subagent_type=..., agent_id=...,
 * prompt=<task only>) — persona is NOT inlined because the persistent
 * agent at `agentId` owns its system prompt. When `agentId` is null
 * (default), the inline-persona path is used unchanged — backwards
 * compat for projects that haven't been bootstrapped yet.
 */
export function buildPuppetMessage(args: {
  readonly subagentType: string;
  readonly personaContent: string;
  readonly role: string;
  readonly input: string;
  readonly agentId?: string | null;
}): string {
  if (args.agentId) {
    return [
      `[ORCHESTRATION_SUBAGENT_DISPATCH]`,
      ``,
      `You MUST call the Agent tool exactly once with these arguments.`,
      `Copy the complete text between <<<TASK_PROMPT_BEGIN>>> and`,
      `<<<TASK_PROMPT_END>>> into the Agent prompt argument verbatim.`,
      `  subagent_type: ${JSON.stringify(args.subagentType)}`,
      `  agent_id: ${JSON.stringify(args.agentId)}`,
      `  description: ${JSON.stringify(`${args.role} role`)}`,
      `  prompt: |-`,
      `<<<TASK_PROMPT_BEGIN>>>`,
      `# Task`,
      ``,
      `${args.input.trim()}`,
      `<<<TASK_PROMPT_END>>>`,
      ``,
      `The subagent at agent_id ${JSON.stringify(args.agentId)} already`,
      `knows its role identity from its persistent system prompt — do`,
      `NOT inline persona or role instructions in the prompt.`,
      ``,
      `Return ONLY the subagent's final output verbatim. Do not summarize,`,
      `reformat, prefix, or comment on it. The dispatcher consumes your`,
      `next assistant message as the step output.`,
    ].join('\n');
  }
  return [
    `[ORCHESTRATION_SUBAGENT_DISPATCH]`,
    ``,
    `You MUST call the Agent tool exactly once with these arguments.`,
    `Copy the complete text between <<<TASK_PROMPT_BEGIN>>> and`,
    `<<<TASK_PROMPT_END>>> into the Agent prompt argument verbatim.`,
    `  subagent_type: ${JSON.stringify(args.subagentType)}`,
    `  description: ${JSON.stringify(`${args.role} role`)}`,
    `  prompt: |-`,
    `<<<TASK_PROMPT_BEGIN>>>`,
    `# Role: ${args.role}`,
    ``,
    `${args.personaContent.trim()}`,
    ``,
    `# Task`,
    ``,
    `${args.input.trim()}`,
    `<<<TASK_PROMPT_END>>>`,
    ``,
    `Return ONLY the subagent's final output verbatim. Do not summarize,`,
    `reformat, prefix, or comment on it. The dispatcher consumes your`,
    `next assistant message as the step output.`,
  ].join('\n');
}

interface ShimFrameEvent {
  readonly type: string;
  readonly data: unknown;
}

/**
 * Parse one SSE frame (the text between two blank lines) into the
 * `data:` JSON payloads it carries. Frames may have multiple `data:`
 * lines; per SSE spec, they're joined with `\n` and parsed as a
 * single JSON document. Unknown or non-JSON payloads are dropped
 * silently so the consumer doesn't error on `: keep-alive` comments.
 */
export function parseSseFrame(frame: string): ShimFrameEvent[] {
  const lines = frame.split('\n');
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
      continue;
    }
  }
  if (dataLines.length === 0) return [];
  const joined = dataLines.join('\n');
  // Allow the literal sentinel ` [DONE]` the way OpenAI-style streams
  // signal end-of-stream — translate into a typed marker rather than
  // failing the JSON.parse.
  if (joined === '[DONE]') {
    return [{ type: 'done', data: null }];
  }
  try {
    const data = JSON.parse(joined) as unknown;
    if (data && typeof data === 'object') {
      const typed = (data as Record<string, unknown>)['type'];
      if (typeof typed === 'string') {
        return [{ type: typed, data }];
      }
    }
    return [{ type: eventType, data }];
  } catch {
    return [];
  }
}

interface TranslatedFrame {
  readonly events: SessionEvent[];
  readonly taskId?: string;
}

/**
 * Translate one shim SSE frame into 0..N SessionEvents.
 *
 * Frame kinds recognized today (matches what the rig smoke saw on
 * 2026-05-21 against agent-a9db7a7a):
 *
 *   - `message_start` / `start` → started
 *   - `tool_call` / `tool_call_message` → tool-call (also surfaces
 *     Agent calls as first-token)
 *   - `tool_return` / `tool_return_message` (Agent) → message-delta with the subagent's output
 *     (this is THE output the dispatcher concatenates)
 *   - `tool_return` (non-Agent) → tool-result
 *   - `assistant_message` / `assistant_message_delta` → fallback
 *     message-delta for SDK shim streams that omit tool-return payloads
 *   - `stop` / `message_stop` / `stop_reason` with stop_reason → turn-done
 *   - `done` (the [DONE] sentinel) → turn-done if not already emitted
 *   - `error` → error event
 *
 * Anything else passes through silently. Unknown frame kinds are not
 * an error.
 */
export function translateShimEvent(frame: ShimFrameEvent): TranslatedFrame {
  const ts = nowIso();
  const data = (frame.data ?? {}) as Record<string, unknown>;
  const frameType = readString(data['message_type']) ?? frame.type;
  switch (frameType) {
    case 'start':
    case 'message_start': {
      const taskId = readString(data['id']) ?? readString(data['message_id']);
      return taskId ? { events: [], taskId } : { events: [] };
    }
    case 'tool_call': {
      const tool = readString(data['tool_name']) ?? readString(data['name']) ?? 'unknown';
      const args = data['args'] ?? data['input'] ?? null;
      const events: SessionEvent[] = [{ kind: 'tool-call', ts, tool, args }];
      if (tool === 'Agent' || tool === 'Task') {
        events.unshift({ kind: 'first-token', ts });
      }
      return { events };
    }
    case 'tool_call_message': {
      const toolCall = isRecord(data['tool_call']) ? data['tool_call'] : null;
      const tool = readString(data['tool_name']) ?? readString(data['name']) ?? readString(toolCall?.['name']) ?? 'unknown';
      const args = data['args'] ?? data['input'] ?? toolCall?.['arguments'] ?? null;
      const events: SessionEvent[] = [{ kind: 'tool-call', ts, tool, args }];
      if (tool === 'Agent' || tool === 'Task') {
        events.unshift({ kind: 'first-token', ts });
      }
      return { events };
    }
    case 'tool_return':
    case 'tool_result': {
      const tool = readString(data['tool_name']) ?? readString(data['name']) ?? 'unknown';
      const ok = data['ok'] !== false && data['success'] !== false && !data['error'];
      const result = data['result'] ?? data['output'] ?? data['content'] ?? null;
      const events: SessionEvent[] = [];
      if (tool === 'Agent' || tool === 'Task') {
        const text = extractSubagentText(result);
        if (text.length > 0) events.push({ kind: 'message-delta', ts, text });
      } else {
        events.push({ kind: 'tool-result', ts, tool, result, ok });
      }
      return { events };
    }
    case 'tool_return_message': {
      const toolReturns = Array.isArray(data['tool_returns']) ? data['tool_returns'] : [];
      const firstReturn = isRecord(toolReturns[0]) ? toolReturns[0] : null;
      const tool = readString(data['tool_name']) ?? readString(data['name']) ?? readString(firstReturn?.['name']) ?? 'unknown';
      const status = readString(data['status']) ?? readString(firstReturn?.['status']);
      const ok = status !== 'error' && data['is_err'] !== true;
      const result = data['tool_return'] ?? firstReturn?.['func_response'] ?? data['result'] ?? data['output'] ?? data['content'] ?? null;
      const events: SessionEvent[] = [];
      if (tool === 'Agent' || tool === 'Task') {
        const text = extractSubagentText(result);
        if (text.length > 0) events.push({ kind: 'message-delta', ts, text });
      } else {
        events.push({ kind: 'tool-result', ts, tool, result, ok });
      }
      return { events };
    }
    case 'assistant_message':
    case 'assistant_message_delta': {
      const text = extractSubagentText(data['content'] ?? data['delta'] ?? data['text'] ?? '');
      return text.length > 0 ? { events: [{ kind: 'message-delta', ts, text }] } : { events: [] };
    }
    case 'stop':
    case 'message_stop':
    case 'stop_reason': {
      const reason = readString(data['stop_reason']) ?? readString(data['reason']) ?? undefined;
      // vibesync-ltrf: `requires_approval` is NOT a terminal stop under the
      // shim's bypassPermissions mode — the PM's Agent/tool call emits it,
      // then the shim immediately follows with an `auto_approval` frame and
      // the turn continues to a real terminal stop (`end_turn`). Emitting a
      // turn-done here makes the dispatcher's observe loop end the step on
      // an intermediate event (a race against the real end_turn), and the
      // uuas guard then fails the step even though work continued. Treat it
      // as a non-terminal intermediate: emit nothing and wait for the real
      // terminal stop_reason. A genuinely un-approved halt (no auto_approval,
      // e.g. permissionMode=default with no approver) still terminates via
      // the SSE stream close -> the consumeSseBody turn-done fallback.
      if (reason === 'requires_approval') {
        return { events: [] };
      }
      return { events: [reason ? { kind: 'turn-done', ts, stopReason: reason } : { kind: 'turn-done', ts }] };
    }
    case 'done':
      return { events: [{ kind: 'turn-done', ts, stopReason: 'closed' }] };
    case 'error': {
      const code = readString(data['code']) ?? 'shim_error';
      const message = readString(data['message']) ?? 'unknown shim error';
      return { events: [{ kind: 'error', ts, code, message }] };
    }
    default:
      return { events: [] };
  }
}

function extractSubagentText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r['output'] === 'string') return r['output'];
    if (typeof r['text'] === 'string') return r['text'];
    if (typeof r['content'] === 'string') return r['content'];
    if (Array.isArray(r['content'])) {
      const parts: string[] = [];
      for (const part of r['content']) {
        if (typeof part === 'string') {
          parts.push(part);
          continue;
        }
        if (part && typeof part === 'object') {
          const txt = (part as Record<string, unknown>)['text'];
          if (typeof txt === 'string') parts.push(txt);
        }
      }
      return parts.join('');
    }
  }
  return '';
}

/**
 * Default filesystem-backed persona loader. Looks under
 * packs/gastown/.letta/agents/<role>.md relative to a pack root.
 * Constructed lazily so the orchestration plane doesn't read the
 * filesystem during static import.
 */
export function createDefaultPersonaLoader(packRoot: string): PersonaLoader {
  return {
    async load(role: string): Promise<string> {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const path = join(packRoot, '.letta', 'agents', `${role}.md`);
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(
          `LettaCodeSubagentProvider: persona for role "${role}" not found at ${path}: ${errorMessage(err)}`,
        );
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tiny utilities (kept local so the file stays self-contained)
// ──────────────────────────────────────────────────────────────────────

function expectHandle(handle: SessionHandle): LettaCodeSubagentSessionHandle {
  if (handle.providerKind !== 'letta-code-subagent') {
    throw new Error(
      `LettaCodeSubagentProvider: handle from wrong provider (got ${handle.providerKind}, want letta-code-subagent)`,
    );
  }
  return handle as LettaCodeSubagentSessionHandle;
}

function readStringExtra(spec: SessionSpec, key: string): string | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readNumberExtra(spec: SessionSpec, key: string): number | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function contentToText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType}]`);
  }
  return parts.join('\n');
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
