#!/usr/bin/env bun
/**
 * scripts/smoke/finalize-pm-agent-by-id.ts — one-shot direct invocation
 * of the three steps _finalizePmAgent runs in production (vibesync-rgx),
 * targeted at an explicit Letta agent id. Skips ensureAgent /
 * ensureControlAgent reconciliation entirely — use this for smoke tests
 * where the agent already exists and you don't want to depend on the
 * control-agent + tag lookup paths being healthy.
 *
 * Usage:
 *   bun scripts/smoke/finalize-pm-agent-by-id.ts <agentId>
 *
 * Idempotent. Each step ends up in already-attached / already-set state
 * on re-run; failures are logged but the script continues to the next
 * step, matching the production _finalizePmAgent shape.
 */

import { createLettaService } from '../../src/LettaService.js';
import type { LettaToolService } from '../../src/letta/LettaToolService.js';

async function main(): Promise<void> {
  const [, , agentId] = process.argv;
  if (!agentId || !agentId.startsWith('agent-')) {
    console.error('usage: bun scripts/smoke/finalize-pm-agent-by-id.ts <agent-...>');
    process.exit(2);
  }
  if (!process.env['LETTA_BASE_URL'] || !process.env['LETTA_PASSWORD']) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing from env. Source .env first.');
    process.exit(2);
  }

  // Build a LettaService just to get a configured LettaToolService — we
  // bypass the ensureAgent + ensureControlAgent path entirely.
  const svc = createLettaService();
  const tools = (svc as unknown as { _tools: LettaToolService })._tools;

  console.log(`[finalize-by-id] target agent: ${agentId}`);

  console.log('[finalize-by-id] step 1/3: attach dispatch_molecule …');
  try {
    const ok = await tools.attachDispatchMoleculeTool(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] step 2/3: attach list_formulas …');
  try {
    const ok = await tools.attachListFormulasTool(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] step 3/3: sync tool_exec_environment_variables …');
  try {
    const ok = await tools.syncPmAgentEnvVars(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] done.');
}

main().catch((err: unknown) => {
  console.error('[finalize-by-id] crashed:', err);
  process.exit(1);
});
