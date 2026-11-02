/**
 * LIVE (vibesync-jni4): one DIRECT turn on a real role agent, through the real
 * IrohWrapperProvider and the real Letta Iroh wrapper as the paired peer.
 * Skipped unless VIBESYNC_IROH_LIVE=1. Read-only use of the paired key
 * (VIBESYNC_IROH_SECRET_KEY_PATH, default /root/.letta/vibesync/iroh-secret.key); never printed.
 *
 * The role agent id is data, supplied by the environment (invariant 5), default
 * = the vibesync reviewer from project_role_agents on this host.
 */
import { appendFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { createNativeIrohConnection, resolveNativeIrohConfig } from '../../src/orchestration/runtime/iroh/native-dialer.js';
import { IrohWrapperProvider } from '../../src/orchestration/runtime/iroh-wrapper-provider.js';
import type { SessionEvent } from '../../src/orchestration/runtime/provider.js';
import { MIN_MODEL_RESPONSE_MS, assertNotFalsePass } from '../_fixtures/false-pass-guard.js';

const LIVE = process.env['VIBESYNC_IROH_LIVE'] === '1';
const ROLE_AGENT = process.env['VIBESYNC_JNI4_LIVE_ROLE_AGENT_ID'] ?? 'agent-0248f563-0fd2-4ff4-8a9e-f77288e731a0';
const PARENT = process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] ?? 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1';

describe.skipIf(!LIVE)('direct role dispatch over Iroh (live)', () => {
  const conn = LIVE ? createNativeIrohConnection(resolveNativeIrohConfig(), { log: (m) => console.log(`[iroh] ${m}`) }) : null;
  afterAll(async () => {
    await conn?.close();
  });

  it('one direct turn: output contains LGTM, is not a "Waiting for" placeholder, took a real model time', async () => {
    const provider = new IrohWrapperProvider({ connection: conn!, turnTimeoutMs: 240_000 });
    const handle = await provider.start({ role: 'live-role', extra: { parentAgentId: PARENT, agentId: ROLE_AGENT, moleculeId: 'jni4-live', stepName: `live-${Date.now()}`, attempt: 1 } });
    const t0 = Date.now();
    const prompt = await provider.prompt(handle, [{ type: 'text', text: 'Reply with exactly: LGTM. Do not call tools.' }]);
    const events: SessionEvent[] = [];
    for await (const e of provider.observe(handle)) events.push(e);
    const durationMs = Date.now() - t0;
    await provider.stop(handle);

    const errors = events.filter((e) => e.kind === 'error');
    const deltas = events.filter((e): e is Extract<SessionEvent, { kind: 'message-delta' }> => e.kind === 'message-delta');
    const output = deltas.map((d) => d.text).join('');
    // vitest swallows console output in this repo's config; optionally keep a transcript file.
    const transcript = process.env['VIBESYNC_JNI4_LIVE_TRANSCRIPT'];
    const line = (m: string): void => {
      console.log(m);
      if (transcript) appendFileSync(transcript, `${m}\n`);
    };
    line(`[live] agent=${ROLE_AGENT} conversation=${prompt.conversationId} durationMs=${durationMs} (min ${MIN_MODEL_RESPONSE_MS}) events=${events.map((e) => e.kind).join(',')}`);
    line(`[live] output=${JSON.stringify(output.slice(0, 200))} errors=${JSON.stringify(errors)}`);

    expect(errors).toEqual([]);
    expect(prompt.conversationId).toMatch(/\S/);
    expect(deltas).toHaveLength(1);
    expect(output).toContain('LGTM');
    expect(output).not.toContain('Waiting for');
    // run_id/turn match is enforced inside the provider (turn-client); a message of another turn yields empty_output (an error above).
    assertNotFalsePass({ output, durationMs });
  }, 270_000);
});
