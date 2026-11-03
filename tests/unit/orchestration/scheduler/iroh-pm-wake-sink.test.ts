/**
 * vibesync-2bgv — the real PmWakeSink: one wake = one turn's INPUT to the PM
 * agent over the shared Iroh connection.
 *
 * Runs against tests/_fixtures/fake-iroh-wrapper.ts, which enforces the
 * preconditions proven live (scope, runtime_start before input, mandatory
 * client_message_id, agent-owned conversations, dedupe on client_message_id).
 *
 * False passes guarded against:
 *   - ok:true although the PM never received the message (every test asserts on
 *     what the FAKE persisted for the PM's conversation, not on the sink's return);
 *   - a wake into a conversation nobody reads (a fresh one, an archived one, a
 *     heartbeat/hidden one, another agent's);
 *   - a retry that lands a second copy (in a different conversation, because
 *     "most recent" moved between attempts).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { IrohConnection, type Frame } from '../../../../src/orchestration/runtime/iroh/connection.js';
import { IrohPmWakeSink } from '../../../../src/orchestration/scheduler/iroh-pm-wake-sink.js';
import { formatWakeMessage, type PmWakeInput } from '../../../../src/orchestration/scheduler/pm-waker.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';

const PM = 'agent-pm-1';
const OTHER = 'agent-other';

const conns: IrohConnection[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
});

function mkConn(fake: FakeIrohWrapper, token = ''): IrohConnection {
  const c = new IrohConnection({
    dial: fake.dial,
    peerName: 'wake-test',
    token,
    sleep: async () => undefined,
    backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 },
  });
  conns.push(c);
  return c;
}

function mkSink(fake: FakeIrohWrapper, over: { conversationId?: string; logs?: Array<[string, unknown, string]>; conn?: IrohConnection } = {}) {
  const conn = over.conn ?? mkConn(fake);
  const logs = over.logs ?? [];
  const sink = new IrohPmWakeSink({
    getConnection: () => conn,
    ...(over.conversationId ? { conversationId: over.conversationId } : {}),
    logger: {
      info: (o, m) => logs.push(['info', o, m]),
      warn: (o, m) => logs.push(['warn', o, m]),
    },
  });
  return { sink, conn, logs };
}

const wakeInput = (over: Partial<PmWakeInput> = {}): PmWakeInput => ({
  agentId: PM,
  projectIdentifier: 'proj-x',
  reason: 'backstop',
  detail: 'no wake for 480 min',
  wakeId: 'proj-x-backstop-1000',
  correlation: undefined,
  ...over,
});

describe('IrohPmWakeSink (vibesync-2bgv)', () => {
  it('1. delivers ONE input to the PM agent: text == formatWakeMessage, client_message_id == wakeId, ok:true', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.seedConversation(PM, { id: 'conv-human', lastMessageAt: '2026-11-02T03:00:00.000Z' });
    const { sink } = mkSink(fake);
    const input = wakeInput();

    const res = await sink.wake(input);

    expect(res).toMatchObject({ ok: true, accepted: true, applicationDelivered: false, msgId: input.wakeId });
    const inputs = fake.received.filter((f) => f['type'] === 'input');
    expect(inputs).toHaveLength(1);
    const frame = inputs[0] as { runtime: Record<string, string>; payload: { messages: Array<Record<string, string>> } };
    expect(frame.runtime).toEqual({ agent_id: PM, conversation_id: 'conv-human' });
    expect(frame.payload.messages).toHaveLength(1);
    expect(frame.payload.messages[0]!['content']).toBe(formatWakeMessage(input));
    expect(frame.payload.messages[0]!['client_message_id']).toBe(input.wakeId);
    // What the PM actually has (not what the sink said):
    expect(fake.userTexts('conv-human')).toEqual([formatWakeMessage(input)]);
    expect(fake.turnsExecuted).toBe(1);
    expect(fake.violations).toEqual([]);
  });

  it('1b. returns on input_accepted: it does not wait for turn_finished (a PM turn can run for minutes)', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.script = { deltas: ['working…'], stopReason: 'end_turn', finalText: 'done', turnDelayMs: 2_500 };
    fake.seedConversation(PM, { id: 'conv-human', lastMessageAt: '2026-11-02T03:00:00.000Z' });
    const { sink, conn } = mkSink(fake);
    const frames: string[] = [];
    conn.onFrame((f: Frame) => frames.push(String(f['type'])));

    const t0 = Date.now();
    const res = await sink.wake(wakeInput());

    expect(res.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(frames).not.toContain('turn_finished'); // the turn was still running when ok came back
    expect(fake.userTexts('conv-human')).toHaveLength(1); // input accepted and persisted; inbox rendering is a separate integration gate
  });

  it('2. the same wakeId twice: the wrapper dedupes on client_message_id -> exactly one turn, one message, both ok:true', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.seedConversation(PM, { id: 'conv-human', lastMessageAt: '2026-11-02T03:00:00.000Z' });
    const { sink } = mkSink(fake);
    const input = wakeInput();

    expect((await sink.wake(input)).ok).toBe(true);
    // Between attempts another conversation becomes the PM's most recent one: the retry must NOT follow it.
    fake.seedConversation(PM, { id: 'conv-newer', lastMessageAt: '2026-11-02T09:00:00.000Z' });
    expect((await sink.wake(input)).ok).toBe(true);

    expect(fake.inputsFor(input.wakeId)).toHaveLength(2); // the duplicate really reached the wrapper...
    expect(fake.turnsExecuted).toBe(1); // ...which deduped it
    expect(fake.userTexts('conv-human')).toHaveLength(1);
    expect(fake.userTexts('conv-newer')).toEqual([]);
    expect(new Set(fake.inputsFor(input.wakeId).map((f) => JSON.stringify(f['runtime']))).size).toBe(1);
  });

  it('3. input_accepted:false -> ok:false with the wrapper error, no throw', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.seedConversation(PM, { id: 'conv-human', lastMessageAt: '2026-11-02T03:00:00.000Z' });
    fake.rejectInput = 'queue is full';
    const { sink } = mkSink(fake);

    const res = await sink.wake(wakeInput());

    expect(res.ok).toBe(false);
    expect(res.error).toContain('queue is full');
    expect(fake.userTexts('conv-human')).toEqual([]);
    expect(fake.turnsExecuted).toBe(0);
  });

  it('3b. forbidden (PM agent outside the grant scope) -> ok:false naming forbidden, no throw', async () => {
    const fake = new FakeIrohWrapper({ scope: [OTHER] });
    const { sink } = mkSink(fake);
    const res = await sink.wake(wakeInput());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forbidden/i);
    expect(fake.turnsExecuted).toBe(0);
  });

  it('3c. forbidden on the input itself (a conversation-id override on an agent outside scope) -> ok:false', async () => {
    const fake = new FakeIrohWrapper({ scope: [OTHER] });
    const { sink } = mkSink(fake, { conversationId: 'conv-x' });
    const res = await sink.wake(wakeInput());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forbidden/i);
  });

  it('3d. method-not-found on conversation.list -> ok:false (NOT a silent fresh conversation nobody reads)', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.unsupportedMethods.add('conversation.list');
    const { sink } = mkSink(fake);
    const res = await sink.wake(wakeInput());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
    expect(fake.conversationAgent.size).toBe(0); // nothing was created
    expect(fake.turnsExecuted).toBe(0);
  });

  it('3e. transport down / auth rejected -> ok:false, never throws', async () => {
    const down = new FakeIrohWrapper({ scope: [PM] });
    down.dialFailures = 99;
    const r1 = await mkSink(down).sink.wake(wakeInput());
    expect(r1.ok).toBe(false);
    expect(r1.error).toBeTruthy();

    const denied = new FakeIrohWrapper({ scope: [PM] });
    denied.rejectAuth = true;
    const r2 = await mkSink(denied).sink.wake(wakeInput());
    expect(r2.ok).toBe(false);
    expect(r2.error).toBeTruthy();
  });

  it('3f. a getConnection that throws (e.g. no address/key configured) -> ok:false, never throws', async () => {
    const sink = new IrohPmWakeSink({ getConnection: () => { throw new Error('iroh secret key file not found: /x'); } });
    const res = await sink.wake(wakeInput());
    expect(res).toMatchObject({ ok: false, accepted: false, applicationDelivered: false, msgId: wakeInput().wakeId, error: expect.stringContaining('secret key file not found') });
  });

  it('3g. the pairing token never appears in an error or a log line', async () => {
    const SECRET = 'PAIR-TOKEN-do-not-leak-0xC0FFEE';
    const fake = new FakeIrohWrapper({ scope: [OTHER], authToken: SECRET });
    const logs: Array<[string, unknown, string]> = [];
    const bad = mkSink(fake, { logs, conn: mkConn(fake, 'wrong-token') });
    const res = await bad.sink.wake(wakeInput());
    expect(res.ok).toBe(false);
    const good = mkSink(fake, { logs, conn: mkConn(fake, SECRET) });
    const res2 = await good.sink.wake(wakeInput()); // forbidden: OTHER-only scope
    expect(res2.ok).toBe(false);
    const blob = JSON.stringify([res, res2, logs]);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain('wrong-token');
  });

  describe('4. which conversation (STAGE 0 rule)', () => {
    function seeded(order: 'newest-first' | 'oldest-first') {
      const fake = new FakeIrohWrapper({ scope: [PM, OTHER] });
      fake.conversationListOrder = order;
      fake.seedConversation(PM, { id: 'conv-old', lastMessageAt: '2026-11-02T01:00:00.000Z' });
      fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2026-11-02T02:00:00.000Z' }); // the one a human reads
      fake.seedConversation(PM, { id: 'conv-archived', lastMessageAt: '2026-11-02T03:00:00.000Z', archived: true });
      fake.seedConversation(PM, { id: 'conv-heartbeat', lastMessageAt: '2026-11-02T04:00:00.000Z', extra: { conversation_class: 'autonomous' } });
      fake.seedConversation(PM, { id: 'conv-hidden', lastMessageAt: '2026-11-02T05:00:00.000Z', extra: { hidden: true } });
      fake.seedConversation(OTHER, { id: 'conv-other-agent', lastMessageAt: '2026-11-02T06:00:00.000Z' });
      return fake;
    }

    for (const order of ['newest-first', 'oldest-first'] as const) {
      it(`picks the PM's most recently active INTERACTIVE conversation (skips archived / autonomous / hidden / other agents), list order ${order}`, async () => {
        const fake = seeded(order);
        const { sink } = mkSink(fake);
        expect((await sink.wake(wakeInput())).ok).toBe(true);
        expect(fake.userTexts('conv-live')).toHaveLength(1);
        for (const c of ['conv-old', 'conv-archived', 'conv-heartbeat', 'conv-hidden', 'conv-other-agent']) expect(fake.userTexts(c), c).toEqual([]);
        expect(fake.conversationAgent.get('conv-live')).toBe(PM);
      });
    }

    it('recency is last_message_at, not list position: a conversation that just received a message wins', async () => {
      const fake = seeded('newest-first');
      const { sink } = mkSink(fake);
      // A human posts in the OLD conversation later than anything else.
      fake.seedConversation(PM, { id: 'conv-old', lastMessageAt: '2026-11-02T07:00:00.000Z' });
      expect((await sink.wake(wakeInput())).ok).toBe(true);
      expect(fake.userTexts('conv-old')).toHaveLength(1);
      expect(fake.userTexts('conv-live')).toEqual([]);
    });

    it('the explicit override (VIBESYNC_PM_WAKE_CONVERSATION_ID) wins over the most-recent pick, and conversation.list is not even asked', async () => {
      const fake = seeded('newest-first');
      const { sink } = mkSink(fake, { conversationId: 'conv-old' });
      expect((await sink.wake(wakeInput())).ok).toBe(true);
      expect(fake.userTexts('conv-old')).toHaveLength(1);
      expect(fake.userTexts('conv-live')).toEqual([]);
      expect(fake.received.some((f) => f['type'] === 'admin_rpc' && f['method'] === 'conversation.list')).toBe(false);
    });

    it('an override that belongs to another agent is refused by the wrapper -> ok:false (never delivered)', async () => {
      const fake = seeded('newest-first');
      const { sink } = mkSink(fake, { conversationId: 'conv-other-agent' });
      const res = await sink.wake(wakeInput());
      expect(res.ok).toBe(false);
      expect(fake.userTexts('conv-other-agent')).toEqual([]);
    });

    it('the PM has no conversation at all: a fresh one is created ON THE PM and receives the wake', async () => {
      const fake = new FakeIrohWrapper({ scope: [PM] });
      const { sink } = mkSink(fake);
      expect((await sink.wake(wakeInput())).ok).toBe(true);
      expect([...fake.conversationAgent.entries()]).toEqual([['conv-1', PM]]);
      expect(fake.userTexts('conv-1')).toHaveLength(1);
    });

    it('never loosens a permission mode a human chose: runtime_start carries the conversation\'s current mode; unknown -> unrestricted', async () => {
      const fake = seeded('newest-first');
      fake.permissionModes.set(`${PM}/conv-live`, 'standard');
      const { sink } = mkSink(fake);
      expect((await sink.wake(wakeInput())).ok).toBe(true);
      const starts = fake.received.filter((f) => f['type'] === 'runtime_start');
      expect(starts).toHaveLength(1);
      expect(starts[0]!['mode']).toBe('standard');

      const fresh = new FakeIrohWrapper({ scope: [PM] });
      fresh.seedConversation(PM, { id: 'c', lastMessageAt: '2026-11-02T03:00:00.000Z' });
      expect((await mkSink(fresh).sink.wake(wakeInput())).ok).toBe(true);
      expect(fresh.received.find((f) => f['type'] === 'runtime_start')!['mode']).toBe('unrestricted');
    });

    it('permission_mode.get unsupported by the host -> still delivers (mode falls back to unrestricted)', async () => {
      const fake = seeded('newest-first');
      fake.unsupportedMethods.add('permission_mode.get');
      expect((await mkSink(fake).sink.wake(wakeInput())).ok).toBe(true);
      expect(fake.userTexts('conv-live')).toHaveLength(1);
    });
  });
});
