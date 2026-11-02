import { afterEach, describe, expect, it } from 'vitest';

import { IrohConnection } from '../../../../src/orchestration/runtime/iroh/connection.js';
import { IrohWrapperProvider } from '../../../../src/orchestration/runtime/iroh-wrapper-provider.js';
import { LettaCodeSubagentProvider } from '../../../../src/orchestration/runtime/letta-code-subagent-provider.js';
import type { PersonaLoader } from '../../../../src/orchestration/runtime/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/orchestration/runtime/provider.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';

const PARENT = 'agent-parent';
const persona: PersonaLoader = { load: async (role) => `# ${role} persona\nYou are the ${role}.` };

let provider: IrohWrapperProvider | null = null;
afterEach(async () => {
  await provider?.close();
  provider = null;
});

function mk(fake: FakeIrohWrapper, extra: Partial<ConstructorParameters<typeof IrohWrapperProvider>[0]> = {}): IrohWrapperProvider {
  const connection = new IrohConnection({ dial: fake.dial, peerName: 'vibesync-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 3 } });
  provider = new IrohWrapperProvider({ connection, personaLoader: persona, turnTimeoutMs: 5_000, ...extra });
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
  extra: { parentAgentId: PARENT, moleculeId: 'mol-1', stepName: 'step-a', attempt: 1, ...extra },
});

describe('IrohWrapperProvider', () => {
  it('maps the final assistant message (message.list) to the single step-output message-delta', async () => {
    const fake = new FakeIrohWrapper();
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
    const p = mk(new FakeIrohWrapper());
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

  it('creates one fresh conversation per session and uses a stable client_message_id from molecule+step+attempt', async () => {
    const fake = new FakeIrohWrapper();
    const p = mk(fake);
    await runStep(p, baseSpec(), 'a');
    await runStep(p, baseSpec({ stepName: 'step-b' }), 'b');
    expect(fake.received.filter((f) => f['method'] === 'conversation.create')).toHaveLength(2);
    expect(fake.dials).toBe(1); // one shared connection per provider instance
    const cmids = fake.received.filter((f) => f['type'] === 'input').map((f) => ((f['payload'] as { messages: Array<{ client_message_id: string }> }).messages[0]!.client_message_id));
    expect(cmids).toEqual(['vibesync:mol-1:step-a:a1', 'vibesync:mol-1:step-b:a1']);
  });

  it('a requires_approval turn surfaces an error event (step failure), never a green close', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'requires_approval' };
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'requires_approval' });
    expect(ev.some((e) => e.kind === 'message-delta')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn-done' });
  });

  it('error stop_reason -> error event with the wrapper message', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'llm_api_error', error: 'upstream 500' };
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'stop_reason', message: 'upstream 500' });
  });

  it('forbidden parent agent -> error event naming the refusal (not retried)', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-elsewhere'] });
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringContaining('forbidden: agent not in this device') });
    expect(fake.dials).toBe(1);
  });

  it('a dead host surfaces as an error event after bounded retries, never a hang', async () => {
    const fake = new FakeIrohWrapper();
    fake.dialFailures = 99;
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/after 3 attempts/) });
    expect(fake.dials).toBe(3);
  });

  it('an empty final output on a completed turn is an error, not a silent green step', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: ['chatter'], stopReason: 'end_turn' }; // no assistant message persisted
    const ev = await runStep(mk(fake), baseSpec(), 'x');
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: 'empty_output' });
  });

  it('requires parentAgentId and rejects foreign handles', async () => {
    const fake = new FakeIrohWrapper();
    const p = mk(fake);
    await expect(p.start({ role: 'r' })).rejects.toThrow(/parentAgentId/);
    await expect(p.prompt({ id: 'x', providerKind: 'acp' }, [])).rejects.toThrow(/wrong provider/);
  });

  it('stop() during a running turn ends observe with stopped and does not hang', async () => {
    const fake = new FakeIrohWrapper();
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

  it('honours extra.conversationId when it exists on the host, otherwise falls back to a fresh conversation', async () => {
    const fake = new FakeIrohWrapper();
    const p = mk(fake);
    await runStep(p, baseSpec(), 'seed'); // creates conv-1 on the host
    const created = fake.received.filter((f) => f['method'] === 'conversation.create').length;
    await runStep(p, baseSpec({ stepName: 'again', conversationId: 'conv-1' }), 'reuse');
    expect(fake.received.filter((f) => f['method'] === 'conversation.create')).toHaveLength(created); // reused
    const inputs = fake.received.filter((f) => f['type'] === 'input');
    expect((inputs.at(-1)!['runtime'] as { conversation_id: string }).conversation_id).toBe('conv-1');
    await runStep(p, baseSpec({ stepName: 'mint', conversationId: 'conv-dispatcher-minted' }), 'fresh');
    expect(fake.received.filter((f) => f['method'] === 'conversation.create')).toHaveLength(created + 1);
  });

  describe('golden: same puppet message as LettaCodeSubagentProvider for the same spec', () => {
    async function oldProviderPuppet(spec: SessionSpec, text: string): Promise<string> {
      let sent = '';
      const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).match(/\/v1\/agents\/[^/]+$/)) return new Response(JSON.stringify({ id: PARENT, model: 'lmstudio/gpt-5.6-sol' }), { status: 200 });
        if (String(url).endsWith('/v1/conversations')) return new Response(JSON.stringify({ id: 'c1' }), { status: 200 });
        if (String(url).includes('/messages')) {
          sent = (JSON.parse(init!.body as string) as { input: string }).input;
          return new Response('data: {"type":"stop","stop_reason":"end_turn"}\n\n', { status: 200 });
        }
        return new Response('nf', { status: 404 });
      }) as unknown as typeof fetch;
      const old = new LettaCodeSubagentProvider({ shimBaseUrl: 'http://shim', personaLoader: persona, fetchImpl, parentAgentModel: 'lmstudio/gpt-5.6-sol' });
      const h = await old.start(spec);
      await old.prompt(h, [{ type: 'text', text }]);
      for await (const _ of old.observe(h)) { /* drain */ }
      await old.stop(h);
      return sent;
    }

    function irohPuppet(fake: FakeIrohWrapper): string {
      const input = fake.received.find((f) => f['type'] === 'input')!;
      return (input['payload'] as { messages: Array<{ content: string }> }).messages[0]!.content;
    }

    it('inline-persona path', async () => {
      const fake = new FakeIrohWrapper();
      await runStep(mk(fake), baseSpec(), 'render this');
      expect(irohPuppet(fake)).toBe(await oldProviderPuppet(baseSpec(), 'render this'));
      expect(irohPuppet(fake)).toContain('# Role: some-role');
    });

    it('persistent-agent path (extra.agentId): persona NOT inlined, agent_id dispatched', async () => {
      const fake = new FakeIrohWrapper();
      const spec = baseSpec({ agentId: 'agent-role-1' });
      await runStep(mk(fake), spec, 'render this');
      const got = irohPuppet(fake);
      expect(got).toBe(await oldProviderPuppet(spec, 'render this'));
      expect(got).toContain('agent_id: "agent-role-1"');
      expect(got).not.toContain('You are the some-role');
    });

    it('agentIdResolver path', async () => {
      const fake = new FakeIrohWrapper();
      const resolver = { resolveRoleAgent: async () => 'agent-resolved' };
      await runStep(mk(fake, { agentIdResolver: resolver }), baseSpec(), 'task');
      expect(irohPuppet(fake)).toContain('agent_id: "agent-resolved"');
    });
  });
});
