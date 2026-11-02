/**
 * LIVE: one real PM wake through the real Letta Iroh wrapper as the paired
 * vibesync peer (vibesync-2bgv). Skipped unless VIBESYNC_IROH_LIVE=1.
 *
 * It puts ONE message in the PM's live conversation (that is the feature). The
 * sink's own log reports which conversation it chose; the test then reads that
 * conversation back with message.list and requires the wake text to be there:
 * ok:true alone is not evidence the PM received anything.
 * Uses the paired key read-only (VIBESYNC_IROH_SECRET_KEY_PATH); never prints it.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createNativeIrohConnection, resolveNativeIrohConfig } from '../../src/orchestration/runtime/iroh/native-dialer.js';
import { IrohPmWakeSink } from '../../src/orchestration/scheduler/iroh-pm-wake-sink.js';
import { formatWakeMessage } from '../../src/orchestration/scheduler/pm-waker.js';

const LIVE = process.env['VIBESYNC_IROH_LIVE'] === '1';
const PM = process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] ?? 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1';

describe.skipIf(!LIVE)('IrohPmWakeSink (live)', () => {
  const conn = LIVE ? createNativeIrohConnection(resolveNativeIrohConfig(), { log: (m) => console.log(`[iroh] ${m}`) }) : null;
  afterAll(async () => {
    await conn?.close();
  });

  it('delivers one backstop wake to the PM; message.list on the chosen conversation contains it', async () => {
    const delivered: Array<Record<string, unknown>> = [];
    const sink = new IrohPmWakeSink({
      getConnection: () => conn!,
      ...(process.env['VIBESYNC_PM_WAKE_CONVERSATION_ID'] ? { conversationId: process.env['VIBESYNC_PM_WAKE_CONVERSATION_ID'] } : {}),
      logger: {
        info: (o, m) => {
          console.log(`[live] ${m} ${JSON.stringify(o)}`);
          if (m === 'pm-wake: delivered to PM') delivered.push(o as Record<string, unknown>);
        },
        warn: (o, m) => console.log(`[live] WARN ${m} ${JSON.stringify(o)}`),
      },
    });
    const wake = {
      agentId: PM,
      projectIdentifier: 'vibesync',
      reason: 'backstop' as const,
      detail: 'vibesync-2bgv live sink test (ignore)',
      wakeId: `vibesync-2bgv-live-${Date.now()}`,
    };
    const t0 = Date.now();
    const res = await sink.wake(wake);
    console.log(`[live] result=${JSON.stringify(res)} ms=${Date.now() - t0}`);
    expect(res).toEqual({ ok: true });

    expect(delivered).toHaveLength(1);
    const conversationId = String(delivered[0]!['conversationId']);
    const text = formatWakeMessage(wake);
    // input_accepted only means the PM HAS the message. When the PM is mid-turn the host QUEUES it
    // (disposition 'queued', proven live: it persisted ~14 s after acceptance), so poll, bounded.
    const find = async (): Promise<Record<string, unknown> | undefined> => {
      const raw = (await conn!.rpc('message.list', { conversation_id: conversationId, limit: 100 })) as unknown;
      const rec = raw as { messages?: unknown[] };
      const list = (Array.isArray(raw) ? raw : (rec.messages ?? [])) as Array<Record<string, unknown>>;
      return list.find((m) => m['message_type'] === 'user_message' && JSON.stringify(m['content'] ?? m['text'] ?? '').includes(wake.wakeId));
    };
    const deadline = Date.now() + 90_000;
    let hit = await find();
    let polls = 1;
    while (!hit && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      hit = await find();
      polls += 1;
    }
    console.log(`[live] conversation=${conversationId} disposition=${String(delivered[0]!['disposition'])} polls=${polls} found=${hit ? `${String(hit['message_type'])} ${String(hit['id'])} at ${String(hit['date'])}` : 'NO'} ms=${Date.now() - t0}`);
    expect(hit, `wake ${wake.wakeId} not found in message.list of ${conversationId}`).toBeDefined();
    const persisted = (Array.isArray(hit!['content']) ? (hit!['content'] as Array<Record<string, unknown>>).map((p) => String(p['text'] ?? '')).join('') : String(hit!['content']));
    expect(persisted).toBe(text);
    expect(hit!['otid']).toBe(wake.wakeId);
  }, 150_000);
});
