/**
 * Characterisation tests for the Iroh turn client's message helpers
 * (vibesync-9lzk.59), written BEFORE refactoring turn-client.ts (CodeScene 7.70;
 * its unit tests take 192 of 250 branch arms). These pin the pure functions that
 * pick a turn's final text out of a conversation's history: chronological,
 * lastAssistantText and contentText. The turn loop itself is covered by
 * turn-client.test.ts against the fake wrapper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IrohConnection, IrohRefusedError } from '../../../../../src/engine/runtime/iroh/connection.js';
import { chronological, contentText, createConversation, lastAssistantText, runTurn, submitInput } from '../../../../../src/engine/runtime/iroh/turn-client.js';
import { FakeIrohWrapper } from '../../../../_fixtures/fake-iroh-wrapper.js';

type Msg = Record<string, unknown>;
const user = (n: number, cm: string, extra: Msg = {}): Msg => ({ id: `msg-${n}`, date: new Date(n * 1000).toISOString(), message_type: 'user_message', client_message_id: cm, content: `u${n}`, ...extra });
const asst = (n: number, text: string, extra: Msg = {}): Msg => ({ id: `msg-${n}`, date: new Date(n * 1000).toISOString(), message_type: 'assistant_message', content: [{ type: 'text', text }], ...extra });

describe('contentText', () => {
  it('returns a plain string as is', () => {
    expect(contentText('hello')).toBe('hello');
  });

  it('joins string parts and text parts of an array, skipping parts with no text', () => {
    expect(contentText(['a', { type: 'text', text: 'b' }, { type: 'image' }, 7, null, { text: 'c' }])).toBe('abc');
  });

  it('returns empty for anything else', () => {
    expect(contentText(undefined)).toBe('');
    expect(contentText(42)).toBe('');
    expect(contentText({ text: 'not an array' })).toBe('');
  });
});

describe('chronological', () => {
  it('leaves a list of zero or one message as it is', () => {
    expect(chronological([])).toEqual([]);
    const one = [asst(1, 'x')];
    expect(chronological(one)).toEqual(one);
  });

  it('falls back to the id tail when the first and last dates are equal', () => {
    const sameDate = '2026-01-01T00:00:00Z';
    const list = [{ id: 'msg-9', date: sameDate }, { id: 'msg-2', date: sameDate }];
    expect(chronological(list).map((m) => m['id'])).toEqual(['msg-2', 'msg-9']);
  });

  it('keeps the given order when neither dates nor id tails decide', () => {
    const list = [{ id: 'abc', date: 'not a date' }, { id: 'xyz', date: 'also not' }];
    expect(chronological(list).map((m) => m['id'])).toEqual(['abc', 'xyz']);
  });

  it('reads the id tail before any ":" suffix', () => {
    const list = [{ id: 'msg-5:part-1' }, { id: 'msg-3:part-9' }];
    expect(chronological(list).map((m) => m['id'])).toEqual(['msg-3:part-9', 'msg-5:part-1']);
  });

  it('does not reorder its input in place', () => {
    const list = [asst(2, 'b'), asst(1, 'a')];
    chronological(list);
    expect(list.map((m) => m['id'])).toEqual(['msg-2', 'msg-1']);
  });
});

describe('lastAssistantText', () => {
  it('returns empty when there is no assistant message at all', () => {
    expect(lastAssistantText([user(1, 'c1')], 'run-1', 'c1')).toBe('');
  });

  it('recognises messages by role as well as by message_type', () => {
    const list = [{ id: 'msg-1', role: 'user', client_message_id: 'c1' }, { id: 'msg-2', role: 'assistant', text: 'BY ROLE' }];
    expect(lastAssistantText(list, null, 'c1')).toBe('BY ROLE');
  });

  it('takes the last message stamped with the turn\'s turn_id, ignoring one stamped with another run', () => {
    const list = [
      user(1, 'c1'),
      asst(2, 'first part', { turn_id: 'c1' }),
      asst(3, 'FINAL', { turn_id: 'c1' }),
      asst(4, 'other run, same turn id', { turn_id: 'c1', run_id: 'run-OTHER' }),
    ];
    expect(lastAssistantText(list, 'run-1', 'c1')).toBe('FINAL');
  });

  it('matches the input by its otid as well as its client_message_id', () => {
    const list = [{ ...user(1, 'unused'), client_message_id: undefined, otid: 'c1' }, asst(2, 'BY OTID')];
    expect(lastAssistantText(list, null, 'c1')).toBe('BY OTID');
  });

  it('stops at the next user message: a later turn\'s answer is not this turn\'s', () => {
    const list = [user(1, 'c1'), asst(2, 'ANSWER ONE'), user(3, 'c2'), asst(4, 'answer two')];
    expect(lastAssistantText(list, null, 'c1')).toBe('ANSWER ONE');
  });

  it('returns empty when the input message is not in the history', () => {
    expect(lastAssistantText([user(1, 'someone-else'), asst(2, 'x')], null, 'c1')).toBe('');
  });

  it('without a client_message_id, falls back to the last assistant message (legacy callers)', () => {
    expect(lastAssistantText([asst(1, 'old'), user(2, 'c'), asst(3, 'LAST')], null, null)).toBe('LAST');
  });

  it('reads text from a plain text field when there is no content', () => {
    const list = [user(1, 'c1'), { id: 'msg-2', date: new Date(2000).toISOString(), message_type: 'assistant_message', text: 'FROM TEXT' }];
    expect(lastAssistantText(list, null, 'c1')).toBe('FROM TEXT');
  });
});

describe('turn loop: stream frames and conversation creation (through the fake wrapper)', () => {
  const AGENT = 'agent-parent';
  let conn: IrohConnection | null = null;
  afterEach(async () => {
    await conn?.close();
    conn = null;
  });
  const mk = (fake: FakeIrohWrapper) => new IrohConnection({ dial: fake.dial, peerName: 'vibesync-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 4, maxAttempts: 4 } });
  const delta = (conversationId: string, delta: Record<string, unknown>) => ({ v: 1, type: 'stream_delta', runtime: { agent_id: AGENT, conversation_id: conversationId }, delta });

  it('reports reasoning deltas and tool calls as progress, names a tool from either field, and skips an empty delta', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = {
      deltas: [],
      stopReason: 'end_turn',
      finalText: 'DONE',
      preTerminal: [
        delta('conv-1', { message_type: 'reasoning_message', content: 'thinking ' }),
        delta('conv-1', { message_type: 'assistant_message', content: '' }),
        delta('conv-1', { message_type: 'tool_call_message', tool_call: { name: 'Bash', arguments: { cmd: 'ls' } } }),
        delta('conv-1', { message_type: 'tool_call_message', tool_name: 'Read' }),
        delta('conv-1', { message_type: 'tool_call_message' }),
        delta('conv-1', { message_type: 'something_else', content: 'ignored' }),
      ],
    };
    conn = mk(fake);
    const seen: unknown[] = [];
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-progress' }, { onProgress: (p) => seen.push(p) });
    expect(r.boundary).toBe('completed');
    expect(seen.filter((p) => (p as { kind: string }).kind !== 'accepted')).toEqual([
      { kind: 'delta', text: 'thinking ' },
      { kind: 'tool-call', tool: 'Bash', args: { cmd: 'ls' } },
      { kind: 'tool-call', tool: 'Read', args: null },
      { kind: 'tool-call', tool: 'unknown', args: null },
    ]);
  });

  it('ignores a stream frame for another conversation', async () => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'end_turn', finalText: 'DONE', preTerminal: [delta('conv-SOMEONE-ELSE', { message_type: 'assistant_message', content: 'NOT MINE' })] };
    conn = mk(fake);
    const texts: string[] = [];
    await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-other' }, { onProgress: (p) => p.text && texts.push(p.text) });
    expect(texts).toEqual([]);
  });

  it('createConversation is refused for an agent outside the wrapper\'s scope, and not retried', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-parent'] });
    conn = mk(fake);
    await expect(createConversation(conn, 'agent-forbidden')).rejects.toThrow(/forbidden/);
    expect(fake.received.filter((f) => f['type'] === 'admin_rpc' && f['method'] === 'conversation.create')).toHaveLength(1);
  });

  it('createConversation sends the title as summary and the tags it is given', async () => {
    const fake = new FakeIrohWrapper();
    conn = mk(fake);
    const id = await createConversation(conn, AGENT, 'Step: coder', { tags: ['lane:work', 'bead:x-1'] });
    expect(id).toBe('conv-1');
    const sent = fake.received.find((f) => f['type'] === 'admin_rpc' && f['method'] === 'conversation.create')!;
    expect(sent['params']).toEqual({ agent_id: AGENT, summary: 'Step: coder', tags: ['lane:work', 'bead:x-1'] });
  });
});

describe('turn loop: refusals, redials, approval grace and reconcile timing (through the fake wrapper)', () => {
  const AGENT = 'agent-parent';
  let conn: IrohConnection | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    await conn?.close();
    conn = null;
  });
  const mk = (fake: FakeIrohWrapper) => new IrohConnection({ dial: fake.dial, peerName: 'vibesync-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 4, maxAttempts: 4 } });

  it('a refused runtime_start throws a refusal naming runtime_start, and no input is sent', async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-other'] });
    conn = mk(fake);
    await conn.connect();
    await expect(submitInput(conn, { agentId: AGENT, conversationId: 'conv-x', text: 'hi', clientMessageId: 'cm-rs' })).rejects.toThrow(/runtime_start/);
    expect(fake.received.filter((f) => f['type'] === 'input')).toHaveLength(0);
  });

  it('an input refused as forbidden throws; any other refusal is a rejected input', async () => {
    const fake = new FakeIrohWrapper();
    conn = mk(fake);
    await conn.connect();
    const conv = await createConversation(conn, AGENT);
    fake.rejectInput = 'forbidden: not allowed';
    await expect(submitInput(conn, { agentId: AGENT, conversationId: conv, text: 'hi', clientMessageId: 'cm-forbid' })).rejects.toBeInstanceOf(IrohRefusedError);
    fake.rejectInput = 'queue full';
    expect(await submitInput(conn, { agentId: AGENT, conversationId: conv, text: 'hi', clientMessageId: 'cm-full' })).toEqual({ accepted: false, error: 'queue full' });
  });

  it('a dropped link redials, reporting a redial; with maxRedials 0 the turn is abandoned instead', async () => {
    const fake = new FakeIrohWrapper();
    fake.dropAfterAccept = 'drop';
    fake.script = { deltas: [], stopReason: 'end_turn', finalText: 'DONE' };
    conn = mk(fake);
    const kinds: string[] = [];
    await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'w', clientMessageId: 'cm-rd1' }, { onProgress: (p) => kinds.push(p.kind) });
    expect(kinds).toContain('redial');

    const strict = new FakeIrohWrapper();
    strict.dropAfterAccept = 'drop';
    strict.script = { deltas: [], stopReason: 'end_turn', finalText: 'DONE' };
    await conn.close();
    conn = mk(strict);
    await expect(runTurn(conn, { agentId: AGENT, conversationId: null, text: 'w', clientMessageId: 'cm-rd2' }, { maxRedials: 0 })).rejects.toThrow(/turn abandoned after 0 redials/);
  });

  it('a pending approval does not fail the turn before the grace period runs out', async () => {
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
    let settled = false;
    const p = runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: 'cm-grace' }, { approvalGraceMs: 5_000, turnTimeoutMs: 60_000 })
      .then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).failureReason).toBe('requires_approval');
  });

  it('after a redial, a turn that is still producing frames is not reconciled from history', async () => {
    vi.useFakeTimers();
    const fake = new FakeIrohWrapper();
    fake.dropAfterAccept = 'drop';
    fake.script = { deltas: ['still ', 'working'], stopReason: 'end_turn', finalText: 'THE REAL END', turnDelayMs: 3_000 };
    conn = mk(fake);
    const p = runTurn(conn, { agentId: AGENT, conversationId: null, text: 'w', clientMessageId: 'cm-live' }, { replayWaitMs: 100, reconcileIntervalMs: 100, turnTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.reconciled).toBe(false);
    expect(r.finalText).toBe('THE REAL END');
  });
});

/**
 * A hand-built connection for the paths the fake wrapper cannot reach: history
 * that changes between polls, an input matched only by its text, and the shapes
 * conversation.create can answer with.
 */
function stubConnection(opts: { rpc: (method: string, params: Record<string, unknown>) => unknown; dropFirstInput?: boolean }) {
  const frameListeners = new Set<(f: Record<string, unknown>) => void>();
  const disconnectListeners = new Set<() => void>();
  const rpcCalls: { method: string; params: Record<string, unknown> }[] = [];
  let inputs = 0;
  const conn = {
    connect: async () => undefined,
    close: async () => undefined,
    onFrame: (fn: (f: Record<string, unknown>) => void) => { frameListeners.add(fn); return () => frameListeners.delete(fn); },
    onDisconnect: (fn: () => void) => { disconnectListeners.add(fn); return () => disconnectListeners.delete(fn); },
    rpc: async (method: string, params: Record<string, unknown>) => { rpcCalls.push({ method, params }); return opts.rpc(method, params); },
    request: async (frame: Record<string, unknown>) => {
      if (frame['type'] === 'runtime_start') return { success: true };
      inputs += 1;
      // The first input is accepted and then the link drops: the turn redials and, with no frames, reconciles.
      if (opts.dropFirstInput && inputs === 1) queueMicrotask(() => { for (const fn of disconnectListeners) fn(); });
      return { accepted: true, disposition: 'started' };
    },
  };
  return { conn: conn as never, rpcCalls };
}

describe('reconcile and conversation creation (through a stub connection)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reconciles only on two identical polls, and finds an input matched by its text alone', async () => {
    vi.useFakeTimers();
    // No client_message_id or otid on the stored input: only its text ties it to the turn.
    const user = { id: 'm-1', date: new Date(1000).toISOString(), message_type: 'user_message', content: 'do the work' };
    const answer = (n: number, text: string) => ({ id: `m-${n}`, date: new Date(n * 1000).toISOString(), message_type: 'assistant_message', content: text });
    const polls = [[user, answer(2, 'partial')], [user, answer(2, 'partial'), answer(3, 'FINAL')], [user, answer(2, 'partial'), answer(3, 'FINAL')]];
    let poll = 0;
    const { conn } = stubConnection({
      dropFirstInput: true,
      rpc: (method) => {
        if (method === 'conversation.create') return { id: 'conv-s' };
        if (method === 'message.list') return polls[Math.min(poll++, polls.length - 1)];
        return {};
      },
    });
    const p = runTurn(conn, { agentId: 'agent-parent', conversationId: null, text: 'do the work', clientMessageId: 'cm-text' }, { replayWaitMs: 100, reconcileIntervalMs: 100, turnTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await p;
    expect(r.reconciled).toBe(true);
    expect(r.finalText).toBe('FINAL');
  });

  it.each([
    ['{id}', { id: 'c-1' }, 'c-1'],
    ['{conversation: {id}}', { conversation: { id: 'c-2' } }, 'c-2'],
    ['{conversation_id}', { conversation_id: 'c-3' }, 'c-3'],
  ])('createConversation reads the id from %s', async (_shape, answer, expected) => {
    const { conn } = stubConnection({ rpc: () => answer });
    expect(await createConversation(conn, 'agent-parent')).toBe(expected);
  });

  it('createConversation refuses an answer with no conversation id', async () => {
    const { conn } = stubConnection({ rpc: () => ({ ok: true }) });
    await expect(createConversation(conn, 'agent-parent')).rejects.toThrow(/returned no conversation id/);
  });

  it('createConversation leaves out an empty title and absent tags', async () => {
    const { conn, rpcCalls } = stubConnection({ rpc: () => ({ id: 'c-4' }) });
    await createConversation(conn, 'agent-parent', '');
    expect(rpcCalls[0]!.params).toEqual({ agent_id: 'agent-parent' });
  });
});

describe('an abort while the wait loop is between its checks (CodeRabbit on #162)', () => {
  const AGENT = 'agent-parent';
  let conn: IrohConnection | null = null;
  afterEach(async () => {
    await conn?.close();
    conn = null;
  });
  const mk = (fake: FakeIrohWrapper) => new IrohConnection({ dial: fake.dial, peerName: 'vibesync-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 4, maxAttempts: 4 } });
  /** Run `fn` after `depth` nested microtasks. */
  const afterMicrotasks = (depth: number, fn: () => void): void => {
    if (depth <= 0) { fn(); return; }
    queueMicrotask(() => afterMicrotasks(depth - 1, fn));
  };

  it.each([1, 2, 3, 4])('an abort %i microtask(s) after the input is accepted ends the turn as cancelled, not at the turn timeout', async (depth) => {
    const fake = new FakeIrohWrapper();
    fake.script = { deltas: [], stopReason: 'end_turn', finalText: 'late', turnDelayMs: 60_000 };
    conn = mk(fake);
    const ac = new AbortController();
    const started = Date.now();
    const r = await runTurn(conn, { agentId: AGENT, conversationId: null, text: 'hi', clientMessageId: `cm-abort-${depth}` }, {
      signal: ac.signal,
      turnTimeoutMs: 4_000,
      onProgress: (p) => { if (p.kind === 'accepted') afterMicrotasks(depth, () => ac.abort()); },
    });
    expect(r.boundary).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
