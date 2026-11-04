/**
 * LIVE: one real turn through the real Letta Iroh wrapper as the paired
 * vibesync peer (vibesync-x38j). Skipped unless VIBESYNC_IROH_LIVE=1.
 * Uses the paired key at VIBESYNC_IROH_SECRET_KEY_PATH (default
 * /root/.letta/vibesync/iroh-secret.key) read-only; never prints it.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createNativeIrohConnection, resolveNativeIrohConfig } from '../../src/engine/runtime/iroh/native-dialer.js';
import { runTurn } from '../../src/engine/runtime/iroh/turn-client.js';

const LIVE = process.env['VIBESYNC_IROH_LIVE'] === '1';
const PARENT = process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] ?? 'agent-a9db7a7a-0ca7-4a3a-b124-11e8ab7fd7e1';

describe.skipIf(!LIVE)('iroh wrapper (live)', () => {
  const conn = LIVE ? createNativeIrohConnection(resolveNativeIrohConfig(), { log: (m) => console.log(`[iroh] ${m}`) }) : null;
  afterAll(async () => {
    await conn?.close();
  });

  it('runs one turn on the parent agent: completed, finalText contains PONG', async () => {
    const progress: string[] = [];
    const t0 = Date.now();
    const r = await runTurn(
      conn!,
      { agentId: PARENT, conversationId: null, text: 'vibesync x38j live test. Reply with exactly the word: PONG. Do not call any tools.', clientMessageId: `vibesync-live-${Date.now()}` },
      { turnTimeoutMs: 120_000, onProgress: (p) => progress.push(p.kind) },
    );
    console.log(`[live] boundary=${r.boundary} stop_reason=${r.stopReason} run_id=${r.runId} conv=${r.conversationId} reconciled=${r.reconciled} ms=${Date.now() - t0} progress=${[...new Set(progress)].join(',')}`);
    console.log(`[live] finalText=${JSON.stringify(r.finalText.slice(0, 120))}`);
    expect(r.boundary).toBe('completed');
    expect(r.finalText).toContain('PONG');
  }, 150_000);
});
