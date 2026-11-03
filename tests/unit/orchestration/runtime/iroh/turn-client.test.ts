import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrohAuthError, IrohConnection, IrohRefusedError } from '../../../../../src/orchestration/runtime/iroh/connection.js';
import { runTurn, createConversation, lastAssistantText, chronological } from '../../../../../src/orchestration/runtime/iroh/turn-client.js';
import { FakeIrohWrapper } from '../../../../_fixtures/fake-iroh-wrapper.js';

const AGENT = 'agent-parent';

function mk(fake: FakeIrohWrapper, extra: Partial<ConstructorParameters<typeof IrohConnection>[0]> = {}): IrohConnection {
  return new IrohConnection({
    dial: fake.dial,
    peerName: 'vibesync-test',
    sleep: async () => undefined,
    backoff: { initialMs: 1, capMs: 4, maxAttempts: 4 },
    ...extra,
  });
}

let conn: IrohConnection | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await conn?.close();
  conn = null;
});

describe('turn-client against a wrapper that enforces the real preconditions', () => {
  it('end_turn -> completed; finalText comes from message.list, NOT from the deltas', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: ['DELTA-ONE ', 'DELTA-TWO'], stopReason: 'end_turn', finalText: 'FINAL-FROM-LIST' };
    conn = mk(fake);
    const seen: string[] = [];
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-1' }, { onProgress: (p) => p.text && seen.push(p.text) });
    expect(r.boundary).toBe('completed');
    expect(r.stopReason).toBe('end_turn');
    expect(r.finalText).toBe('FINAL-FROM-LIST');
    expect(seen.join('')).toBe('DELTA-ONE DELTA-TWO');
    expect(r.finalText).not.toContain('DELTA');
    expect(r.runId).toBe('run-1');
    expect(r.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1 });
    expect(fake.violations).toEqual([]);
    // the real sequence reached the wrapper, in order
    expect(fake.received.map((f) => f['type'] === 'admin_rpc' ? `rpc:${String(f['method'])}` : f['type'])).toEqual([
      'auth', 'rpc:conversation.create', 'runtime_start', 'input', 'rpc:message.list',
    ]);
    const rs = fake.received.find((f) => f['type'] === 'runtime_start')!;
    expect(rs['mode']).toBe('unrestricted');
    const auth = fake.received[0]!;
    expect(auth['capabilities']).toEqual(['frame_part']);
    expect(auth['peer_name']).toBe('vibesync-test');
  });

  it('matches create validation for tag shape and lane ownership scope', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-parent', 'agent-other'] });
    conn = mk(fake);
    await conn.connect();
    const rejected = async (agent: string, tags: unknown, error: string) => {
      await expect(conn!.rpc('conversation.create', { agent_id: agent, tags })).rejects.toThrow(error);
    };

    await rejected(AGENT, 'lane:work', 'invalid_tags: expected an array of strings');
    await rejected(AGENT, ['lane:work', 1], 'invalid_tags: expected an array of strings');
    await rejected(AGENT, [null], 'invalid_tags: expected an array of strings');
    await rejected(AGENT, [1], 'invalid_tags: expected an array of strings');
    await conn.rpc('conversation.create', { agent_id: AGENT, tags: null });
    await conn.rpc('conversation.create', { agent_id: AGENT, tags: ['lane:home', 'lane:home'] });
    await rejected(AGENT, ['lane:home'], 'lane_already_assigned');
    await conn.rpc('conversation.create', { agent_id: 'agent-other', tags: ['lane:home'] });
    await conn.rpc('conversation.create', { agent_id: AGENT, tags: ['lane:work'] });
    await conn.rpc('conversation.create', { agent_id: AGENT, tags: ['lane:work'] });
    await conn.rpc('conversation.create', { agent_id: AGENT, tags: ['lane:inbox'] });
    await rejected(AGENT, ['lane:inbox'], 'lane_already_assigned');

    expect(fake.conversationTags.size).toBe(6);
    expect(fake.violations).toEqual([
      'conversation.create attempted duplicate home/inbox lane tag for one agent',
      'conversation.create attempted duplicate home/inbox lane tag for one agent',
    ]);
  });

  it('prefers the assistant message stamped with the turn run_id', async () => {
    const fake = new FakeIrohWrapper();
    conn = mk(fake);
    const conv = await (async () => { await conn!.connect(); return createConversation(conn!, AGENT); })();
    // older run's assistant message planted before the turn
    (fake as unknown as { messages: Map<string, unknown[]> }).messages.get(conv)!.push({ message_type: 'assistant_message', run_id: 'run-OLD', content: 'old' });
    const r = await runTurn(conn, { agentId: AGENT, conversationId: conv, text: 'q', clientMessageId: 'cm-r' });
    expect(r.finalText).toBe('PONG');
  });

  it.each([['error'], ['llm_api_error'], ['invalid_tool_call']])('stop_reason %s -> failed (no message.list read for output)', async (reason) => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: reason, error: 'boom', finalText: 'should not be used' };
    conn = mk(fake);
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-e' });
    expect(r.boundary).toBe('failed');
    expect(r.failureReason).toBe('stop_reason');
    expect(r.error).toBe('boom');
    expect(r.finalText).toBe('');
  });

  it('cancelled -> cancelled', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'cancelled' };
    conn = mk(fake);
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-c' });
    expect(r.boundary).toBe('cancelled');
  });

  it('a turn_finished with requires_approval is a step failure, not a hang', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'requires_approval' };
    conn = mk(fake);
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-ra' });
    expect(r.boundary).toBe('failed');
    expect(r.failureReason).toBe('requires_approval');
  });

  it('pending_approvals then idle -> failure requires_approval without hanging (fake timers)', async () => {
    vi.useFakeTimers();
    const fake = new FakeIrohWrapper();
    fake.script = {
      deltas: [],
      stallWith: [
        { type: 'pending_approvals', approvals: [{ approval_id: 'a1', tool_call_id: 't1', tool_name: 'Bash' }] },
        { type: 'update_loop_status', loop_status: { status: 'WAITING_ON_APPROVAL', active_run_ids: [] } },
      ],
    };
    conn = mk(fake);
    const p = runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-pa' }, { approvalGraceMs: 500, turnTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.failureReason).toBe('requires_approval');
    expect(r.boundary).toBe('failed');
    expect(r.stopReason).toBe('requires_approval');
  });

  it('(CodeRabbit #55) idle THEN pending_approvals (reverse order) -> still requires_approval, not a turn timeout', async () => {
    vi.useFakeTimers();
    const fake = new FakeIrohWrapper();
    fake.script = {
      deltas: [],
      stallWith: [
        { type: 'update_loop_status', loop_status: { status: 'WAITING_ON_APPROVAL', active_run_ids: [] } },
        { type: 'pending_approvals', approvals: [{ approval_id: 'a1', tool_call_id: 't1', tool_name: 'Bash' }] },
      ],
    };
    conn = mk(fake);
    const p = runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-pa-rev' }, { approvalGraceMs: 500, turnTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2_000); // far below the 60 s turn timeout
    const r = await p;
    expect(r.failureReason).toBe('requires_approval');
    expect(r.boundary).toBe('failed');
  });

  it('an unknown mid-turn stop_reason is not terminal: keep reading, bounded by the turn timeout', async () => {
    vi.useFakeTimers();
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'tool_use', finalText: 'x' };
    conn = mk(fake);
    const p = runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-u' }, { turnTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await p;
    expect(r.failureReason).toBe('turn_timeout');
    expect(r.boundary).toBe('failed');
  });

  it('input_accepted accepted:false -> failure before running', async () => {
    const fake = new FakeIrohWrapper();
    fake.rejectInput = 'queue full';
    conn = mk(fake);
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-rej' });
    expect(r.boundary).toBe('failed');
    expect(r.failureReason).toBe('input_rejected');
    expect(r.error).toBe('queue full');
    expect(fake.turnsExecuted).toBe(0);
  });

  it('redial mid-turn: SAME client_message_id re-sent, terminal replayed, exactly one result and one execution', async () => {
    const fake = new FakeIrohWrapper();
    fake.dropAfterAccept = 'drop';
    fake.script = { deltas: ['partial'], stopReason: 'end_turn', finalText: 'DONE-AFTER-REDIAL' };
    conn = mk(fake);
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'work', clientMessageId: 'cm-redial' });
    expect(r.boundary).toBe('completed');
    expect(r.finalText).toBe('DONE-AFTER-REDIAL');
    expect(r.reconciled).toBe(false);
    expect(fake.dials).toBe(2);
    const inputs = fake.inputsFor('cm-redial');
    expect(inputs).toHaveLength(2);
    expect(fake.turnsExecuted).toBe(1);
    expect(fake.violations).toEqual([]);
  });

  it('wrapper restart (no replay): reconciled via message.list', async () => {
    vi.useFakeTimers();
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'end_turn', finalText: 'RECONCILED-ANSWER' };
    conn = mk(fake);
    await conn.connect();
    const conv = await createConversation(conn, AGENT);
    // Start the turn, drop the link after accept, and lose the parked frames (wrapper restart).
    fake.dropAfterAccept = 'restart';
    const p = runTurn(conn, { agentId: AGENT, conversationId: conv, text: 'work', clientMessageId: 'cm-restart' }, { replayWaitMs: 100, reconcileIntervalMs: 100, turnTimeoutMs: 60_000 });
    // after restart the wrapper still holds the conversation (host store) with the finished answer
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.boundary).toBe('completed');
    expect(r.reconciled).toBe(true);
    expect(r.finalText).toBe('RECONCILED-ANSWER');
  });

  it('forbidden agent -> refusal, NOT retried', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-other'] });
    conn = mk(fake);
    await expect(runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-f' })).rejects.toThrow(/forbidden: agent not in this device's scope/);
    expect(fake.dials).toBe(1);
    expect(fake.received.filter((f) => f['type'] === 'admin_rpc')).toHaveLength(1);
    await expect(runTurn(conn, { agentId: AGENT, conversationId: 'conv-x', text: 'hi', clientMessageId: 'cm-f2' })).rejects.toBeInstanceOf(IrohRefusedError);
    expect(fake.received.filter((f) => f['type'] === 'runtime_start')).toHaveLength(1);
  });

  it('refuses to run without a client_message_id', async () => {
    const fake = new FakeIrohWrapper();
    conn = mk(fake);
    await expect(runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: '' })).rejects.toThrow(/clientMessageId/);
  });

  it('auth failure is loud and not retried', async () => {
    const fake = new FakeIrohWrapper();
    fake.rejectAuth = true;
    conn = mk(fake);
    await expect(runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-a' })).rejects.toBeInstanceOf(IrohAuthError);
    expect(fake.dials).toBe(1);
  });

  it('transient dial failures are retried with bounded backoff, then succeed', async () => {
    const fake = new FakeIrohWrapper();
    fake.dialFailures = 2;
    const sleeps: number[] = [];
    conn = mk(fake, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 1 });
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-b' });
    expect(r.boundary).toBe('completed');
    expect(fake.dials).toBe(3);
    expect(sleeps).toEqual([1, 2]);
  });

  it('gives up with a connection error after maxAttempts dial failures (capped)', async () => {
    const fake = new FakeIrohWrapper();
    fake.dialFailures = 99;
    const sleeps: number[] = [];
    conn = mk(fake, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 1 });
    await expect(conn.connect()).rejects.toThrow(/after 4 attempts/);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(4);
  });

  it('counts the fake as honest: input before runtime_start and without client_message_id are rejected by the fake itself', async () => {
    const fake = new FakeIrohWrapper();
    conn = mk(fake);
    await conn.connect();
    const conv = await createConversation(conn, AGENT);
    const noRuntime = await conn.request({ type: 'input', runtime: { agent_id: AGENT, conversation_id: conv }, payload: { kind: 'create_message', messages: [{ role: 'user', content: 'x', client_message_id: 'z' }] } });
    expect(noRuntime['accepted']).toBe(false);
    await conn.request({ type: 'runtime_start', agent_id: AGENT, conversation_id: conv, mode: 'unrestricted' });
    const noCmid = await conn.request({ type: 'input', runtime: { agent_id: AGENT, conversation_id: conv }, payload: { kind: 'create_message', messages: [{ role: 'user', content: 'x' }] } });
    expect(noCmid['accepted']).toBe(false);
    expect(fake.violations).toEqual(['input before runtime_start', 'input without client_message_id']);
  });
});

// vibesync-jni4: selecting THE turn's final message
describe('lastAssistantText / chronological (vibesync-jni4)', () => {
  const a = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ id: `ui-msg-${id}`, date: new Date(Date.UTC(2026, 10, 2, 5, 0, id)).toISOString(), message_type: 'assistant_message', content: [{ type: 'text', text }], ...extra });
  const u = (id: number, cmid: string) => ({ id: `ui-msg-${id}`, date: new Date(Date.UTC(2026, 10, 2, 5, 0, id)).toISOString(), message_type: 'user_message', otid: cmid, turn_id: cmid, content: 'q' });

  it('orders newest-first and oldest-first lists the same way (by date, then id)', () => {
    const asc = [u(1, 'c1'), a(2, 'one'), u(3, 'c2'), a(4, 'two')];
    expect(chronological([...asc].reverse()).map((m) => m['id'])).toEqual(asc.map((m) => m['id']));
    expect(chronological(asc).map((m) => m['id'])).toEqual(asc.map((m) => m['id']));
    // no dates: fall back to the numeric id tail
    const noDate = asc.map(({ date: _d, ...rest }) => rest);
    expect(chronological([...noDate].reverse()).map((m) => m['id'])).toEqual(noDate.map((m) => m['id']));
  });

  it('on a newest-first host the LAST message of the second turn is returned, not the first message of the conversation (the live bug)', () => {
    const list = [a(4, 'SECOND'), u(3, 'c2'), a(2, 'FIRST'), u(1, 'c1')]; // newest-first, as the live wrapper returns
    expect(lastAssistantText(list, null, 'c2')).toBe('SECOND');
    expect(lastAssistantText(list, null, 'c1')).toBe('FIRST');
  });

  it('prefers run_id, ignores an earlier and a later message of other runs', () => {
    const list = [a(5, 'late notification', { run_id: 'run-3' }), a(4, 'THE ANSWER', { run_id: 'run-2' }), a(2, 'Waiting for the coder', { run_id: 'run-1' })];
    expect(lastAssistantText(list, 'run-2', 'c')).toBe('THE ANSWER');
  });

  it('without run_id stamps, a message of ANOTHER run after the input is not adopted; with nothing for this turn the result is empty', () => {
    const list = [a(3, "Waiting for the coder's output.", { run_id: 'run-OTHER' }), u(2, 'c9'), a(1, 'old', { run_id: 'run-old' })];
    expect(lastAssistantText(list, 'run-9', 'c9')).toBe('');
    // an unstamped, unmatched older message is also not adopted
    expect(lastAssistantText([a(1, 'stale placeholder')], 'run-9', 'c9')).toBe('');
  });
});
