import { afterEach, describe, expect, it } from 'vitest';

import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';
import { IrohWrapperProvider } from '../../../../src/engine/runtime/iroh-wrapper-provider.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/provider.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';

const PARENT = 'agent-parent';
const ROLE_AGENT = 'agent-role-1';
// Data only (invariant 5: never hardcoded in src). The live project_role_agents ids on this host.
const CODER = 'agent-395ae3a2-6b32-46d1-87ca-e94bb9620fae';
const REVIEWER = 'agent-0248f563-0fd2-4ff4-8a9e-f77288e731a0';
const PERSONA_MARKER = 'PERSONA-TEXT-THAT-MUST-NOT-BE-SENT';
/**
 * The pre-jni4 constructor REQUIRED a personaLoader. Callers that still pass one
 * (and the pre-fix code, in the fail-on-revert run) must behave: the new provider
 * ignores it and never sends persona text.
 */
const legacyPersonaOption = { personaLoader: { load: async (role: string) => `${PERSONA_MARKER} (${role})` } } as object;

let provider: IrohWrapperProvider | null = null;
afterEach(async () => {
  await provider?.close();
  provider = null;
});

/** Scope that includes the parent AND every role agent used below, so a mis-route is caught by assertions, not by 'forbidden'. */
const SCOPE = [PARENT, ROLE_AGENT, CODER, REVIEWER];

function mk(fake: FakeIrohWrapper, extra: Partial<ConstructorParameters<typeof IrohWrapperProvider>[0]> = {}): IrohWrapperProvider {
  const connection = new IrohConnection({ dial: fake.dial, peerName: 'vibesync-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 3 } });
  provider = new IrohWrapperProvider({ connection, turnTimeoutMs: 5_000, ...legacyPersonaOption, ...extra } as ConstructorParameters<typeof IrohWrapperProvider>[0]);
  return provider;
}

async function runStep(p: IrohWrapperProvider, spec: SessionSpec, text: string): Promise<SessionEvent[]> {
  const handle = await p.start(spec);
  try {
    await p.prompt(handle, [{ type: 'text', text }]);
    const out: SessionEvent[] = [];
    for await (const ev of p.observe(handle)) out.push(ev);
    return out;
  } finally {
    await p.stop(handle);
  }
}

const baseSpec = (extra: Record<string, unknown> = {}): SessionSpec => ({
  role: 'some-role',
  extra: { parentAgentId: PARENT, agentId: ROLE_AGENT, moleculeId: 'mol-1', stepName: 'step-a', attempt: 1, ...extra },
});

describe('IrohWrapperProvider', () => {
  it('maps the final assistant message (message.list) to the single step-output message-delta', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.script = { deltas: ['LIVE-DELTA-NOT-OUTPUT'], stopReason: 'end_turn', finalText: 'STEP-OUTPUT' };
    const ev = await runStep(mk(fake), baseSpec(), 'do the thing');
    const deltas = ev.filter((e) => e.kind === 'message-delta');
    expect(deltas).toEqual([expect.objectContaining({ text: 'STEP-OUTPUT' })]);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn-done', stopReason: 'end_turn' });
    expect(ev.some((e) => e.kind === 'error')).toBe(false);
    expect(ev[0]!.kind).toBe('started');
    expect(fake.violations).toEqual([]);
  });

  it('(CodeRabbit #55) two concurrent observers both wake on a live event (one notify slot loses a wakeup)', async () => {
    const p = mk(new FakeIrohWrapper({ scope: SCOPE }));
    const handle = await p.start(baseSpec());
    // Drive the session state directly: a prompt that never settles, events pushed one at a time while
    // BOTH observers are parked waiting. With a single notify slot the second observer overwrites the
    // first's wakeup, so the first never sees the live event until promptDone settles (it never does).
    const st = (p as unknown as { sessions: Map<string, { promptDone: Promise<void> | null }> }).sessions.get((handle as { id: string }).id)!;
    st.promptDone = new Promise<void>(() => {});
    const push = (ev: SessionEvent) => (p as unknown as { push(s: unknown, e: SessionEvent): void }).push(st, ev);
    const got: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const run = async (k: 'a' | 'b') => { for await (const ev of p.observe(handle)) got[k].push(ev.kind); };
    const a = run('a');
    await new Promise((r) => setTimeout(r, 20)); // a parks first
    const b = run('b');
    await new Promise((r) => setTimeout(r, 20)); // b parks and (buggy) steals a's slot
    push({ kind: 'started', ts: 't' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got.a).toEqual(['started']);
    expect(got.b).toEqual(['started']);
    push({ kind: 'turn-done', ts: 't' });
    await Promise.race([Promise.all([a, b]), new Promise((r) => setTimeout(r, 1_000))]);
    expect(got.a).toEqual(['started', 'turn-done']);
    expect(got.b).toEqual(['started', 'turn-done']);
    await p.stop(handle);
  });

  it('keeps work conversation titles and generic metadata unchanged', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    const p = mk(fake);
    await runStep(p, baseSpec({ formulaName: 'code-review', motivatingBeadId: 'vibesync-byil' }), 'a');
    await runStep(p, baseSpec({ formulaName: 'code-review', stepName: 'step-b' }), 'b');

    expect([...fake.conversationTitles.values()]).toEqual(['code-review · step-a · vibesync-byil', 'code-review · step-b']);
    expect([...fake.conversationTags.entries()]).toEqual([
      ['conv-1', ['lane:work', 'bead:vibesync-byil', 'run:mol-1']],
      ['conv-2', ['lane:work', 'run:mol-1']],
    ]);
    expect(fake.received.filter((frame) => frame['type'] === 'runtime_start' || frame['type'] === 'input').map((frame) => frame['type']))
      .toEqual(['runtime_start', 'input', 'runtime_start', 'input']);
    const createIndexes = fake.received.map((frame) => frame['method']).reduce<number[]>((indexes, method, index) => method === 'conversation.create' ? [...indexes, index] : indexes, []);
    for (const index of createIndexes) {
      expect(fake.received[index + 1]?.['type']).toBe('runtime_start');
      expect(fake.received[index + 2]?.['type']).toBe('input');
    }
  });

  it('leaves generic conversation creation without metadata unchanged', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    const connection = new IrohConnection({ dial: fake.dial, peerName: 'generic', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 3 } });
    await connection.connect();
    const { createConversation } = await import('../../../../src/engine/runtime/iroh/turn-client.js');
    await createConversation(connection, ROLE_AGENT, 'wake title');
    await connection.close();

    const create = fake.received.find((frame) => frame['method'] === 'conversation.create');
    expect(create?.['params']).toEqual({ agent_id: ROLE_AGENT, summary: 'wake title' });
    expect(fake.conversationTags.get('conv-1')).toEqual([]);
    expect(fake.conversationTitles.get('conv-1')).toBe('wake title');
  });

  it('creates one fresh conversation per session and uses a stable client_message_id from molecule+step+attempt', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    const p = mk(fake);
    await runStep(p, baseSpec(), 'a');
    await runStep(p, baseSpec({ stepName: 'step-b' }), 'b');
    expect(fake.received.filter((f) => f['method'] === 'conversation.create')).toHaveLength(2);
    expect(fake.dials).toBe(1); // one shared connection per provider instance
    const cmids = fake.received.filter((f) => f['type'] === 'input').map((f) => ((f['payload'] as { messages: Array<{ client_message_id: string }> }).messages[0]!.client_message_id));
    expect(cmids).toEqual(['vibesync:mol-1:step-a:a1', 'vibesync:mol-1:step-b:a1']);
  });

  it('a requires_approval turn surfaces an error event (step failure), never a green close', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.script = { deltas: [], stopReason: 'requires_approval' };
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'requires_approval' });
    expect(ev.some((e) => e.kind === 'message-delta')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn-done' });
  });

  it('error stop_reason -> error event with the wrapper message', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.script = { deltas: [], stopReason: 'llm_api_error', error: 'upstream 500' };
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'stop_reason', message: 'upstream 500' });
  });

  it('forbidden role agent -> error event naming the refusal (not retried)', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-elsewhere'] });
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringContaining('forbidden: agent not in this device') });
    expect(fake.dials).toBe(1);
  });

  it('a dead host surfaces as an error event after bounded retries, never a hang', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.dialFailures = 99;
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/after 3 attempts/) });
    expect(fake.dials).toBe(3);
  });

  it('an empty final output on a completed turn is an error, not a silent green step', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.script = { deltas: ['chatter'], stopReason: 'end_turn' }; // no assistant message persisted
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'empty_output' });
  });

  it('rejects foreign handles', async () => {
    const p = mk(new FakeIrohWrapper({ scope: SCOPE }));
    await expect(p.prompt({ id: 'x', providerKind: 'acp' }, [])).rejects.toThrow(/wrong provider/);
  });

  it('stop() during a running turn ends observe with stopped and does not hang', async () => {
    const fake = new FakeIrohWrapper({ scope: SCOPE });
    fake.script = { deltas: [], stallWith: [{ type: 'update_loop_status', loop_status: { status: 'PROCESSING_API_RESPONSE', active_run_ids: ['r'] } }] };
    const p = mk(fake);
    const h = await p.start(baseSpec());
    await p.prompt(h, [{ type: 'text', text: 'x' }]);
    const seen: SessionEvent[] = [];
    const obs = (async () => { for await (const e of p.observe(h)) seen.push(e); })();
    await new Promise((r) => setTimeout(r, 30));
    await p.stop(h);
    await obs;
    expect(seen.at(-1)?.kind).toBe('stopped');
  });

  // ───────────────────────── vibesync-jni4: direct role dispatch ─────────────────────────

  describe('direct dispatch to the role agent (vibesync-jni4)', () => {
    const inputsOf = (fake: FakeIrohWrapper): string[] =>
      fake.received
        .filter((f) => f['type'] === 'input')
        .map((f) => (f['payload'] as { messages: Array<{ content: string }> }).messages[0]!.content);

    it('1. conversation.create, runtime_start and input all target the ROLE agent, never the parent; no puppet/Agent-tool text', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      await runStep(mk(fake), baseSpec({ agentId: CODER }), 'do the thing');
      const creates = fake.received.filter((f) => f['method'] === 'conversation.create');
      expect(creates.map((f) => (f['params'] as { agent_id: string }).agent_id)).toEqual([CODER]);
      expect(fake.received.filter((f) => f['type'] === 'runtime_start').map((f) => f['agent_id'])).toEqual([CODER]);
      expect(fake.received.filter((f) => f['type'] === 'input').map((f) => (f['runtime'] as { agent_id: string }).agent_id)).toEqual([CODER]);
      expect(JSON.stringify(fake.received)).not.toContain(PARENT);
      for (const text of inputsOf(fake)) {
        expect(text).not.toContain('ORCHESTRATION_SUBAGENT_DISPATCH');
        expect(text).not.toContain('Agent tool');
        expect(text).not.toContain('subagent_type');
      }
      expect(fake.violations).toEqual([]);
    });

    it('2. the one input carries exactly the step task + inputs; the persona is NOT inlined', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const task = 'Review PR 12.\n\nPrior reviewer output: LGTM-ish';
      // Even if a caller still passes personaContent (old contract), it must not reach the wire.
      await runStep(mk(fake), baseSpec({ agentId: REVIEWER, personaContent: PERSONA_MARKER }), task);
      expect(inputsOf(fake)).toEqual([task]);
      expect(JSON.stringify(fake.received)).not.toContain(PERSONA_MARKER);
    });

    it('3. output is the role agent message whose run_id matches turn_finished, not an earlier "Waiting for" placeholder (newest-first host)', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      fake.listOrder = 'newest-first'; // what the live wrapper does
      fake.script = {
        deltas: ['live delta'],
        runId: 'run-42',
        finalText: 'REAL REPORT: 2 findings',
        earlierAssistant: [{ text: "Waiting for the coder's output.", runId: 'run-parent-1' }],
        laterAssistant: [{ text: 'Waiting on task_37 to finish.', runId: 'run-notification-9' }],
      };
      const ev = await runStep(mk(fake), baseSpec(), 'x');
      const deltas = ev.filter((e) => e.kind === 'message-delta');
      expect(deltas).toHaveLength(1);
      const out = (deltas[0] as { text: string }).text;
      expect(out).toBe('REAL REPORT: 2 findings');
      expect(out).not.toContain('Waiting for');
      expect(out).not.toContain('Waiting on');
    });

    it('3b. same on an oldest-first host', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      fake.script = { runId: 'run-7', finalText: 'REAL', earlierAssistant: [{ text: 'Waiting for x', runId: 'run-6' }], laterAssistant: [{ text: 'late', runId: 'run-8' }] };
      const ev = await runStep(mk(fake), baseSpec(), 'x');
      expect(ev.find((e) => e.kind === 'message-delta')).toMatchObject({ text: 'REAL' });
    });

    it('3c. a multi-message turn yields its LAST message (host lists newest-first)', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      fake.listOrder = 'newest-first';
      fake.script = { runId: 'run-5', earlierAssistant: [{ text: 'text before a tool call', runId: 'run-5' }], finalText: 'FINAL ANSWER' };
      const ev = await runStep(mk(fake), baseSpec(), 'x');
      expect(ev.find((e) => e.kind === 'message-delta')).toMatchObject({ text: 'FINAL ANSWER' });
    });

    it('3d. no message for this turn (only an unrelated older one) -> empty_output error, never the stale text', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      fake.script = { runId: 'run-9', earlierAssistant: [{ text: "Waiting for the coder's output.", runId: 'run-other' }] };
      const ev = await runStep(mk(fake), baseSpec(), 'x');
      expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'empty_output' });
      expect(ev.some((e) => e.kind === 'message-delta')).toBe(false);
    });

    it('4a. no extra.agentId and no resolver -> start fails with a clear reason, parent never called', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const p = mk(fake);
      await expect(p.start({ role: 'reviewer', extra: { parentAgentId: PARENT, projectIdentifier: 'proj' } })).rejects.toThrow(
        /no role agent id for role "reviewer" in project "proj".*Refusing to fall back/s,
      );
      expect(fake.dials).toBe(0);
      expect(fake.received).toEqual([]);
    });

    it('4b. resolver returns null -> start fails (no fallback to the parent), nothing sent', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const calls: unknown[][] = [];
      const p = mk(fake, { agentIdResolver: { resolveRoleAgent: async (...a) => { calls.push(a); return null; } } });
      await expect(p.start({ role: 'coder', extra: { parentAgentId: PARENT, projectIdentifier: 'proj' } })).rejects.toThrow(/no role agent id for role "coder"/);
      expect(calls).toEqual([['coder', PARENT, 'proj']]);
      expect(fake.received).toEqual([]);
    });

    it('4c. resolver id is used when extra.agentId is absent; extra.agentId wins over the resolver', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const resolver = { resolveRoleAgent: async () => REVIEWER };
      const p = mk(fake, { agentIdResolver: resolver });
      await runStep(p, { role: 'reviewer', extra: { parentAgentId: PARENT, projectIdentifier: 'proj', moleculeId: 'm', stepName: 's' } }, 'a');
      await runStep(p, baseSpec({ agentId: CODER, stepName: 's2' }), 'b');
      expect(fake.received.filter((f) => f['method'] === 'conversation.create').map((f) => (f['params'] as { agent_id: string }).agent_id)).toEqual([REVIEWER, CODER]);
    });

    it('4d. a missing parentAgentId is no longer fatal (the parent is not part of the path)', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const ev = await runStep(mk(fake), { role: 'r', extra: { agentId: ROLE_AGENT, moleculeId: 'm', stepName: 's' } }, 'x');
      expect(ev.find((e) => e.kind === 'message-delta')).toMatchObject({ text: 'PONG' });
    });

    it('5. prompt() reports the host-side conversation id so the dispatcher can record it on the step trace', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const p = mk(fake);
      const h = await p.start(baseSpec());
      const r = await p.prompt(h, [{ type: 'text', text: 'x' }]);
      expect(r.conversationId).toBe('conv-1');
      expect(fake.conversationAgent.get('conv-1')).toBe(ROLE_AGENT);
      for await (const _ of p.observe(h)) { /* drain */ }
      await p.stop(h);
    });

    it('5b. a failure before the conversation exists still resolves prompt() and surfaces as an error event', async () => {
      const fake = new FakeIrohWrapper({ scope: ['agent-elsewhere'] });
      const p = mk(fake);
      const h = await p.start(baseSpec());
      const r = await p.prompt(h, [{ type: 'text', text: 'x' }]);
      expect(r.conversationId).toBeUndefined();
      const ev: SessionEvent[] = [];
      for await (const e of p.observe(h)) ev.push(e);
      expect(ev.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringContaining('forbidden') });
      await p.stop(h);
    });

    it('each step gets its OWN fresh conversation on its OWN role agent (even a caller-supplied conversationId is not reused)', async () => {
      const fake = new FakeIrohWrapper({ scope: SCOPE });
      const p = mk(fake);
      await runStep(p, baseSpec({ agentId: REVIEWER, conversationId: 'conv-dispatcher-minted' }), 'a');
      await runStep(p, baseSpec({ agentId: CODER, stepName: 'step-b', conversationId: 'conv-dispatcher-minted-2' }), 'b');
      expect([...fake.conversationAgent.entries()]).toEqual([['conv-1', REVIEWER], ['conv-2', CODER]]);
      expect(fake.violations).toEqual([]);
    });
  });
});
