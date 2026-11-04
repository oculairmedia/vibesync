import { afterEach, describe, expect, it } from 'vitest';

import { IrohConnection, IrohConnectionLostError } from '../../../../../src/engine/runtime/iroh/connection.js';
import { FakeIrohWrapper } from '../../../../_fixtures/fake-iroh-wrapper.js';

let conn: IrohConnection | null = null;
afterEach(async () => {
  await conn?.close();
  conn = null;
});
const mk = (fake: FakeIrohWrapper): IrohConnection =>
  (conn = new IrohConnection({ dial: fake.dial, peerName: 'p', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 3 } }));

describe('IrohConnection', () => {
  it('connect() is single-flight and idempotent', async () => {
    const fake = new FakeIrohWrapper();
    const c = mk(fake);
    await Promise.all([c.connect(), c.connect(), c.connect()]);
    await c.connect();
    expect(fake.dials).toBe(1);
    expect(c.generation).toBe(1);
  });

  it('a link drop rejects pending requests with IrohConnectionLostError and a redial restores service', async () => {
    const fake = new FakeIrohWrapper();
    const c = mk(fake);
    await c.connect();
    let dropped = 0;
    c.onDisconnect(() => (dropped += 1));
    fake.dropLinks();
    await new Promise((r) => setTimeout(r, 5));
    expect(dropped).toBe(1);
    expect(c.isConnected).toBe(false);
    await expect(c.request({ type: 'admin_rpc', method: 'message.list', params: {} })).rejects.toBeInstanceOf(IrohConnectionLostError);
    await c.connect();
    expect(c.generation).toBe(2);
    expect(fake.dials).toBe(2);
  });

  it('writes frames over the 1 MiB limit as frame_part and reads big replies back (capability negotiated)', async () => {
    const fake = new FakeIrohWrapper();
    const c = mk(fake);
    await c.connect();
    const conv = ((await c.rpc('conversation.create', { agent_id: 'agent-parent' })) as { id: string }).id;
    const big = 'é'.repeat(700_000); // 1.4 MB utf8 > 1 MiB
    await c.request({ type: 'runtime_start', agent_id: 'agent-parent', conversation_id: conv, mode: 'unrestricted' });
    const acc = await c.request({ type: 'input', runtime: { agent_id: 'agent-parent', conversation_id: conv }, payload: { kind: 'create_message', messages: [{ role: 'user', content: big, client_message_id: 'big-1' }] } });
    expect(acc['accepted']).toBe(true);
    const listed = (await c.rpc('message.list', { conversation_id: conv, limit: 5 })) as { messages: Array<{ content: unknown }> };
    expect(listed.messages[0]!.content).toBe(big);
    expect(fake.violations).toEqual([]);
  });

  it('close() makes later connect() fail loudly', async () => {
    const fake = new FakeIrohWrapper();
    const c = mk(fake);
    await c.connect();
    await c.close();
    await expect(c.connect()).rejects.toThrow(/closed/);
  });
});
