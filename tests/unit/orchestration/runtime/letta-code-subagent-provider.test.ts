import { describe, expect, it } from 'vitest';

import {
  LettaCodeSubagentProvider,
  buildPuppetMessage,
  parseSseFrame,
  translateShimEvent,
} from '../../../../src/orchestration/runtime/index.js';
import type { PersonaLoader } from '../../../../src/orchestration/runtime/index.js';
import type { SessionEvent } from '../../../../src/orchestration/runtime/provider.js';

/**
 * Unit tests for LettaCodeSubagentProvider (vibesync-573 / vibesync-f5g).
 *
 * The shim is faked via an injected fetchImpl that returns a synthetic
 * SSE stream. We pin:
 *   - puppet message shape
 *   - SSE frame parsing (multiple data: lines, comments, [DONE])
 *   - shim event → SessionEvent translation
 *   - provider start/prompt/observe/stop end-to-end against the fake
 *   - the s28 workaround: subagent_type defaults to 'general-purpose'
 *     and persona content is inlined into the puppet message
 *   - tolerance of requires_approval halts
 */

function fakePersonaLoader(personas: Record<string, string> = {}): PersonaLoader {
  return {
    async load(role: string): Promise<string> {
      if (role in personas) return personas[role]!;
      return `# ${role} persona\nYou are the ${role}.`;
    },
  };
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(enc.encode(frame));
      }
      controller.close();
    },
  });
}

function frame(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFakeFetch(opts: {
  readonly conversationId?: string;
  readonly sseFrames?: string[];
  readonly conversationStatus?: number;
  readonly messagesStatus?: number;
  readonly conversationBody?: unknown;
}): { fetchImpl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url.endsWith('/v1/conversations')) {
      const status = opts.conversationStatus ?? 200;
      const body = opts.conversationBody ?? { id: opts.conversationId ?? 'conv-fake-1' };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/messages')) {
      const status = opts.messagesStatus ?? 200;
      if (status >= 400) {
        return new Response('boom', { status });
      }
      return new Response(sseStream(opts.sseFrames ?? [frame({ type: 'stop', stop_reason: 'end_turn' })]), {
        status,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function drain(provider: LettaCodeSubagentProvider, handle: Awaited<ReturnType<typeof provider.start>>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of provider.observe(handle)) {
    out.push(ev);
  }
  return out;
}

describe('LettaCodeSubagentProvider', () => {
  describe('construction', () => {
    it('requires shimBaseUrl', () => {
      expect(() =>
        new LettaCodeSubagentProvider({
          shimBaseUrl: '',
          personaLoader: fakePersonaLoader(),
        }),
      ).toThrow(/shimBaseUrl is required/);
    });

    it('requires personaLoader', () => {
      expect(() =>
        new LettaCodeSubagentProvider({
          shimBaseUrl: 'http://localhost:8291',
          personaLoader: undefined,
        }),
      ).toThrow(/personaLoader is required/);
    });

    it('strips trailing slashes from shimBaseUrl', async () => {
      const { fetchImpl, calls } = makeFakeFetch({});
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291///',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'hi' }]);
      await drain(provider, handle);
      expect(calls[0]!.url).toBe('http://localhost:8291/v1/conversations');
    });
  });

  describe('start', () => {
    it('rejects when extra.parentAgentId is missing', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      await expect(
        provider.start({ role: 'reviewer' }),
      ).rejects.toThrow(/parentAgentId is required/);
    });

    it('returns a handle tagged with the provider kind and role', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      expect(handle.providerKind).toBe('letta-code-subagent');
      expect(handle.id).toContain('agent-pm');
      expect(handle.id).toContain('reviewer');
    });

    it('does not create a conversation until prompt() fires', async () => {
      const { fetchImpl, calls } = makeFakeFetch({});
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      expect(calls.length).toBe(0);
      // stop() before prompt() must be a true no-op — no orphan conversation
      await provider.stop(handle);
      expect(calls.length).toBe(0);
    });
  });

  describe('prompt + observe (happy path)', () => {
    it('creates a conversation, posts a puppet message, and yields events ending in turn-done', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-abc',
        sseFrames: [
          frame({ type: 'start', id: 'msg-1' }),
          frame({ type: 'tool_call', tool_name: 'Agent', args: { subagent_type: 'general-purpose' } }),
          frame({ type: 'tool_return', tool_name: 'Agent', result: { output: 'review verdict: LGTM' } }),
          frame({ type: 'stop', stop_reason: 'end_turn' }),
        ],
      });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'review commit abc' }]);
      const events = await drain(provider, handle);

      // First HTTP call: POST /v1/conversations
      expect(calls[0]!.url).toBe('http://localhost:8291/v1/conversations');
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ agent_id: 'agent-pm' });

      // Second HTTP call: POST .../messages with the puppet body
      expect(calls[1]!.url).toBe('http://localhost:8291/v1/conversations/conv-abc/messages');
      const messageBody = JSON.parse(calls[1]!.init!.body as string) as { input: string };
      expect(messageBody.input).toContain('[ORCHESTRATION_SUBAGENT_DISPATCH]');
      expect(messageBody.input).toContain('"general-purpose"');
      expect(messageBody.input).toContain('You MUST call the Agent tool exactly once');
      expect(messageBody.input).toContain('<<<TASK_PROMPT_BEGIN>>>');
      expect(messageBody.input).toContain('<<<TASK_PROMPT_END>>>');
      expect(messageBody.input).toContain('# Role: reviewer');
      expect(messageBody.input).toContain('# Task');
      expect(messageBody.input).toContain('review commit abc');

      // Events: started → first-token + tool-call → message-delta → turn-done
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('started');
      expect(kinds).toContain('first-token');
      expect(kinds).toContain('tool-call');
      expect(kinds).toContain('message-delta');
      expect(kinds[kinds.length - 1]).toBe('turn-done');

      // Subagent output (from Agent's tool_return) is the message-delta payload.
      const delta = events.find((e): e is Extract<SessionEvent, { kind: 'message-delta' }> => e.kind === 'message-delta');
      expect(delta?.text).toBe('review verdict: LGTM');
    });

    it('reuses a conversation across multiple prompts on the same handle', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-reuse',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'first' }]);
      await drain(provider, handle);
      await provider.prompt(handle, [{ type: 'text', text: 'second' }]);
      await drain(provider, handle);

      const conversationCreates = calls.filter((c) => c.url.endsWith('/v1/conversations'));
      const messagePosts = calls.filter((c) => c.url.includes('/messages'));
      expect(conversationCreates).toHaveLength(1);
      expect(messagePosts).toHaveLength(2);
    });

    it('uses extra.conversationId when supplied (resume path) and skips creation', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm', conversationId: 'conv-resume' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'pick up where we left off' }]);
      await drain(provider, handle);

      // vibesync-ctla: a caller-supplied conversationId is created WITH that
      // id on the shim before the first message, otherwise the message POST
      // 404s (the shim store has no such conversation yet). The shim honors
      // a client-supplied `id`, so we POST /v1/conversations { agent_id, id }
      // and then send to /v1/conversations/<id>/messages.
      const createCall = calls.find((c) => c.url.endsWith('/v1/conversations'));
      expect(createCall).toBeDefined();
      expect(JSON.parse(createCall!.init!.body as string)).toMatchObject({
        agent_id: 'agent-pm',
        id: 'conv-resume',
      });
      expect(calls[calls.length - 1]!.url).toBe(
        'http://localhost:8291/v1/conversations/conv-resume/messages',
      );
    });
  });

  describe('approval halt tolerance', () => {
    it('treats requires_approval as non-terminal; turn ends on the real terminal stop (vibesync-ltrf)', async () => {
      // Under the shim's bypassPermissions mode the PM's Agent/tool call
      // emits stop_reason=requires_approval, the shim auto-approves, and the
      // turn continues to a real terminal stop (end_turn). The provider must
      // NOT surface the intermediate requires_approval as turn-done, or the
      // dispatcher ends the step on an intermediate event and the uuas guard
      // fails it spuriously (the tester-step flake).
      const { fetchImpl } = makeFakeFetch({
        conversationId: 'conv-approval',
        sseFrames: [
          frame({ type: 'tool_call', tool_name: 'Agent' }),
          frame({ type: 'stop', stop_reason: 'requires_approval' }),
          frame({ type: 'stop', stop_reason: 'end_turn' }),
        ],
      });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'pls review' }]);
      const events = await drain(provider, handle);

      // Exactly one turn-done, and it is the terminal end_turn — not the
      // intermediate requires_approval.
      const turnDones = events.filter(
        (e) => e.kind === 'turn-done',
      ) as Array<Extract<SessionEvent, { kind: 'turn-done' }>>;
      expect(turnDones).toHaveLength(1);
      expect(turnDones[0]!.stopReason).toBe('end_turn');
      expect(events.find((e) => e.kind === 'error')).toBeUndefined();
      // No turn-done should carry requires_approval.
      expect(
        events.some(
          (e) =>
            e.kind === 'turn-done' &&
            (e as Extract<SessionEvent, { kind: 'turn-done' }>).stopReason === 'requires_approval',
        ),
      ).toBe(false);
    });
  });

  describe('error paths', () => {
    it('emits an error event when POST /v1/conversations fails', async () => {
      const { fetchImpl } = makeFakeFetch({ conversationStatus: 500 });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'hi' }]);
      const events = await drain(provider, handle);

      const err = events.find((e) => e.kind === 'error') as Extract<SessionEvent, { kind: 'error' }> | undefined;
      expect(err).toBeDefined();
      expect(err!.code).toBe('stream_error');
      expect(events[events.length - 1]!.kind).toBe('turn-done');
    });

    it('emits an error event when POST .../messages fails', async () => {
      const { fetchImpl } = makeFakeFetch({ messagesStatus: 502 });
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'hi' }]);
      const events = await drain(provider, handle);

      const err = events.find((e) => e.kind === 'error') as Extract<SessionEvent, { kind: 'error' }> | undefined;
      expect(err).toBeDefined();
      expect(events[events.length - 1]!.kind).toBe('turn-done');
    });

    it('observe() on a stopped handle yields a stopped event', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.stop(handle);
      const events = await drain(provider, handle);
      // No session in the map after stop — observe yields an unknown_session error.
      expect(events[0]!.kind).toBe('error');
    });

    it('rejects handles from other providers', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      await expect(
        provider.prompt(
          { id: 'foreign:1', providerKind: 'foreign-provider' },
          [{ type: 'text', text: 'hi' }],
        ),
      ).rejects.toThrow(/wrong provider/);
    });
  });

  describe('idempotency & lifecycle', () => {
    it('stop() is idempotent', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.stop(handle);
      await expect(provider.stop(handle)).resolves.toBeUndefined();
    });

    it('nudge() is a no-op', async () => {
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await expect(provider.nudge(handle)).resolves.toBeUndefined();
    });
  });

  describe('AgentIdResolver (vibesync-mcz Phase C)', () => {
    /**
     * Builds a resolver that records every call and returns the
     * provided fixed result. Lets us assert (a) it was consulted with
     * the right args and (b) the provider honored the return value.
     */
    function recordingResolver(result: string | null) {
      const calls: Array<{ role: string; parentAgentId: string; projectIdentifier: string | null }> = [];
      return {
        calls,
        resolver: {
          async resolveRoleAgent(
            role: string,
            parentAgentId: string,
            projectIdentifier: string | null,
          ): Promise<string | null> {
            calls.push({ role, parentAgentId, projectIdentifier });
            return result;
          },
        },
      };
    }

    it('falls back to inline-persona path when no resolver is wired (backwards compat)', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-fallback',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const persona = '# Reviewer\nYou are the reviewer. Be skeptical.';
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader({ reviewer: persona }),
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm', projectIdentifier: 'vibesync' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'review abc' }]);
      await drain(provider, handle);

      const messagePost = calls.find((c) => c.url.includes('/messages'))!;
      const body = JSON.parse(messagePost.init!.body as string) as { input: string };
      // Today's contract: persona is inlined under '# Role: reviewer'.
      expect(body.input).toContain('# Role: reviewer');
      expect(body.input).toContain('You are the reviewer. Be skeptical.');
      // And the puppet must NOT smuggle an agent_id arg.
      expect(body.input).not.toContain('agent_id');
    });

    it('falls back to inline-persona path when resolver returns null', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-null',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const { calls: resolverCalls, resolver } = recordingResolver(null);
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader({ reviewer: '# Reviewer\nbe skeptical' }),
        agentIdResolver: resolver,
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm', projectIdentifier: 'vibesync' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'review abc' }]);
      await drain(provider, handle);

      expect(resolverCalls).toHaveLength(1);
      expect(resolverCalls[0]).toEqual({
        role: 'reviewer',
        parentAgentId: 'agent-pm',
        projectIdentifier: 'vibesync',
      });

      const messagePost = calls.find((c) => c.url.includes('/messages'))!;
      const body = JSON.parse(messagePost.init!.body as string) as { input: string };
      expect(body.input).toContain('# Role: reviewer');
      expect(body.input).toContain('be skeptical');
      expect(body.input).not.toContain('agent_id');
    });

    it('dispatches via agent_id and skips persona when resolver returns an id', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-persistent',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      // Persona loader is wired but MUST NOT be consulted on the
      // agent_id path. Make load() throw so any call fails loudly.
      const personaLoader = {
        async load(role: string): Promise<string> {
          throw new Error(`persona loader called unexpectedly for role=${role}`);
        },
      };
      const { resolver } = recordingResolver('agent-reviewer-vibesync-1');
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader,
        agentIdResolver: resolver,
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm', projectIdentifier: 'vibesync' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'review abc' }]);
      await drain(provider, handle);

      const messagePost = calls.find((c) => c.url.includes('/messages'))!;
      const body = JSON.parse(messagePost.init!.body as string) as { input: string };
      // agent_id tool arg present, persona block absent.
      expect(body.input).toContain('agent_id: "agent-reviewer-vibesync-1"');
      expect(body.input).not.toContain('# Role: reviewer');
      // Sentinel block still wraps the task only.
      expect(body.input).toContain('<<<TASK_PROMPT_BEGIN>>>');
      expect(body.input).toContain('# Task');
      expect(body.input).toContain('review abc');
      expect(body.input).toContain('<<<TASK_PROMPT_END>>>');
      // Explicit anti-inlining instruction is present so the PM
      // doesn't helpfully add persona text on its own.
      expect(body.input).toContain('do');
      expect(body.input).toContain('NOT inline persona');
    });

    it('extra.agentId overrides the resolver (caller-supplied id wins)', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        conversationId: 'conv-explicit',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const { calls: resolverCalls, resolver } = recordingResolver('agent-from-resolver');
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        agentIdResolver: resolver,
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: {
          parentAgentId: 'agent-pm',
          projectIdentifier: 'vibesync',
          agentId: 'agent-explicit-override',
        },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'go' }]);
      await drain(provider, handle);

      // Resolver must NOT be consulted when extra.agentId is supplied.
      expect(resolverCalls).toHaveLength(0);

      const messagePost = calls.find((c) => c.url.includes('/messages'))!;
      const body = JSON.parse(messagePost.init!.body as string) as { input: string };
      expect(body.input).toContain('agent_id: "agent-explicit-override"');
      expect(body.input).not.toContain('agent-from-resolver');
    });

    it('honors extra.conversationId on the agent_id path (per-dispatch isolation)', async () => {
      const { fetchImpl, calls } = makeFakeFetch({
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const { resolver } = recordingResolver('agent-reviewer-vibesync-1');
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        agentIdResolver: resolver,
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: {
          parentAgentId: 'agent-pm',
          projectIdentifier: 'vibesync',
          conversationId: 'conv-iso-7',
        },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'go' }]);
      await drain(provider, handle);

      // vibesync-ctla: the supplied per-dispatch conversation id is created
      // on the shim WITH that id before sending, then the message POSTs
      // against it. (Previously creation was skipped, which 404'd because
      // the dispatcher-minted conversation did not exist in the shim store.)
      const createCall = calls.find((c) => c.url.endsWith('/v1/conversations'));
      expect(createCall).toBeDefined();
      expect(JSON.parse(createCall!.init!.body as string)).toMatchObject({
        id: 'conv-iso-7',
      });
      expect(calls[calls.length - 1]!.url).toBe(
        'http://localhost:8291/v1/conversations/conv-iso-7/messages',
      );
    });

    it('resolver receives null projectIdentifier when extra.projectIdentifier is omitted', async () => {
      const { fetchImpl } = makeFakeFetch({
        conversationId: 'conv-no-pid',
        sseFrames: [frame({ type: 'stop', stop_reason: 'end_turn' })],
      });
      const { calls: resolverCalls, resolver } = recordingResolver(null);
      const provider = new LettaCodeSubagentProvider({
        shimBaseUrl: 'http://localhost:8291',
        personaLoader: fakePersonaLoader(),
        agentIdResolver: resolver,
        fetchImpl,
      });
      const handle = await provider.start({
        role: 'reviewer',
        extra: { parentAgentId: 'agent-pm' },
      });
      await provider.prompt(handle, [{ type: 'text', text: 'go' }]);
      await drain(provider, handle);

      expect(resolverCalls).toHaveLength(1);
      expect(resolverCalls[0]?.projectIdentifier).toBeNull();
    });
  });
});

describe('buildPuppetMessage', () => {
  it('embeds the persona content and the task input within explicit sentinels', () => {
    const out = buildPuppetMessage({
      subagentType: 'general-purpose',
      personaContent: 'You are the reviewer.',
      role: 'reviewer',
      input: 'Review commit abc.',
    });
    expect(out).toContain('subagent_type: "general-purpose"');
    expect(out).toContain('[ORCHESTRATION_SUBAGENT_DISPATCH]');
    expect(out).toContain('You MUST call the Agent tool exactly once');
    expect(out).toContain('Copy the complete text between <<<TASK_PROMPT_BEGIN>>>');
    expect(out).toContain('<<<TASK_PROMPT_BEGIN>>>');
    expect(out).toContain('<<<TASK_PROMPT_END>>>');
    expect(out).toContain('# Role: reviewer');
    expect(out).toContain('You are the reviewer.');
    expect(out).toContain('Review commit abc.');
    expect(out).toMatch(/Return ONLY the subagent's final output/);
  });

  it('treats agentId=null as the inline-persona path (backwards compat)', () => {
    const out = buildPuppetMessage({
      subagentType: 'general-purpose',
      personaContent: 'You are the reviewer.',
      role: 'reviewer',
      input: 'Review commit abc.',
      agentId: null,
    });
    expect(out).toContain('# Role: reviewer');
    expect(out).toContain('You are the reviewer.');
    expect(out).not.toContain('agent_id');
  });

  it('switches to the agent_id path when agentId is provided, dropping persona inlining', () => {
    const out = buildPuppetMessage({
      subagentType: 'general-purpose',
      // persona content should be ignored on the agent_id path
      personaContent: 'SHOULD NOT APPEAR',
      role: 'reviewer',
      input: 'Review commit abc.',
      agentId: 'agent-reviewer-vibesync-1',
    });
    expect(out).toContain('agent_id: "agent-reviewer-vibesync-1"');
    expect(out).toContain('<<<TASK_PROMPT_BEGIN>>>');
    expect(out).toContain('<<<TASK_PROMPT_END>>>');
    expect(out).toContain('# Task');
    expect(out).toContain('Review commit abc.');
    expect(out).not.toContain('SHOULD NOT APPEAR');
    expect(out).not.toContain('# Role: reviewer');
    expect(out).toMatch(/NOT inline persona/);
  });
});

describe('parseSseFrame', () => {
  it('joins multiple data: lines and parses JSON', () => {
    const frame = 'data: {"type":"stop",\ndata:  "stop_reason":"end_turn"}\n';
    const events = parseSseFrame(frame);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('stop');
  });

  it('ignores SSE comments and empty lines', () => {
    const frame = ': keep-alive\n\ndata: {"type":"start"}\n';
    const events = parseSseFrame(frame);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('start');
  });

  it('returns the [DONE] sentinel as type=done', () => {
    const events = parseSseFrame('data: [DONE]\n');
    expect(events).toEqual([{ type: 'done', data: null }]);
  });

  it('drops malformed JSON silently', () => {
    expect(parseSseFrame('data: not-json\n')).toEqual([]);
  });
});

describe('translateShimEvent', () => {
  it('translates Agent tool_return as a message-delta carrying the subagent output', () => {
    const out = translateShimEvent({
      type: 'tool_return',
      data: { tool_name: 'Agent', result: { output: 'subagent says hi' } },
    });
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.kind).toBe('message-delta');
    if (ev.kind === 'message-delta') {
      expect(ev.text).toBe('subagent says hi');
    }
  });

  it('translates vanilla Agent tool_return_message frames as message-delta output', () => {
    const out = translateShimEvent({
      type: 'message',
      data: {
        message_type: 'tool_return_message',
        name: 'Agent',
        status: 'success',
        tool_return: 'subagent says hi',
      },
    });
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.kind).toBe('message-delta');
    if (ev.kind === 'message-delta') {
      expect(ev.text).toBe('subagent says hi');
    }
  });

  it('emits first-token + tool-call for Agent tool_call', () => {
    const out = translateShimEvent({
      type: 'tool_call',
      data: { tool_name: 'Agent', args: { subagent_type: 'general-purpose' } },
    });
    expect(out.events.map((e) => e.kind)).toEqual(['first-token', 'tool-call']);
  });

  it('emits first-token + tool-call for vanilla Agent tool_call_message frames', () => {
    const out = translateShimEvent({
      type: 'message',
      data: {
        message_type: 'tool_call_message',
        tool_call: { name: 'Agent', arguments: '{"subagent_type":"general-purpose"}' },
      },
    });
    expect(out.events.map((e) => e.kind)).toEqual(['first-token', 'tool-call']);
  });

  it('emits tool-result (not message-delta) for non-Agent tool returns', () => {
    const out = translateShimEvent({
      type: 'tool_return',
      data: { tool_name: 'Bash', result: 'ok', ok: true },
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.kind).toBe('tool-result');
  });

  it('uses vanilla assistant_message content as fallback step output', () => {
    const out = translateShimEvent({
      type: 'message',
      data: { message_type: 'assistant_message', content: 'final role output' },
    });
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.kind).toBe('message-delta');
    if (ev.kind === 'message-delta') {
      expect(ev.text).toBe('final role output');
    }
  });

  it('passes a terminal stop_reason through to turn-done', () => {
    const out = translateShimEvent({ type: 'stop', data: { stop_reason: 'end_turn' } });
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.kind).toBe('turn-done');
    if (ev.kind === 'turn-done') {
      expect(ev.stopReason).toBe('end_turn');
    }
  });

  it('does NOT emit turn-done for requires_approval (non-terminal under bypassPermissions; vibesync-ltrf)', () => {
    const out = translateShimEvent({ type: 'stop', data: { stop_reason: 'requires_approval' } });
    expect(out.events).toHaveLength(0);
  });

  it('passes vanilla stop_reason frames through to turn-done', () => {
    const out = translateShimEvent({ type: 'message', data: { message_type: 'stop_reason', stop_reason: 'end_turn' } });
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.kind).toBe('turn-done');
    if (ev.kind === 'turn-done') {
      expect(ev.stopReason).toBe('end_turn');
    }
  });

  it('translates error frames', () => {
    const out = translateShimEvent({ type: 'error', data: { code: 'rate_limit', message: 'slow down' } });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.kind).toBe('error');
  });

  it('returns an empty event list for unknown frame types', () => {
    const out = translateShimEvent({ type: 'mystery', data: { whatever: 1 } });
    expect(out.events).toEqual([]);
  });
});
