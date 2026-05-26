#!/usr/bin/env bun
/**
 * scripts/smoke/finalize-pm-agent-by-id.ts — one-shot direct invocation
 * of the four steps _finalizePmAgent runs in production (vibesync-rgx,
 * vibesync-3hj), targeted at an explicit Letta agent id. Skips
 * ensureAgent / ensureControlAgent reconciliation entirely — use this
 * for smoke tests where the agent already exists and you don't want to
 * depend on the control-agent + tag lookup paths being healthy.
 *
 * Usage:
 *   bun scripts/smoke/finalize-pm-agent-by-id.ts <agentId> [projectIdentifier] [projectName]
 *
 * projectIdentifier defaults to "vibesync"; projectName defaults to
 * projectIdentifier. The pair is fed into buildPersonaBlock for the
 * persona update step.
 *
 * Idempotent. Each step ends up in already-attached / already-set state
 * on re-run; failures are logged but the script continues to the next
 * step, matching the production _finalizePmAgent shape.
 */

import { createLettaService } from '../../src/LettaService.js';
import { buildPersonaBlock } from '../../src/letta/pm-agent-persona.js';
import type { LettaToolService } from '../../src/letta/LettaToolService.js';
import type { LettaMemoryService } from '../../src/letta/LettaMemoryService.js';

async function main(): Promise<void> {
  const [, , agentId, projectIdArg, projectNameArg] = process.argv;
  if (!agentId || !agentId.startsWith('agent-')) {
    console.error('usage: bun scripts/smoke/finalize-pm-agent-by-id.ts <agent-...> [projectIdentifier] [projectName]');
    process.exit(2);
  }
  if (!process.env['LETTA_BASE_URL'] || !process.env['LETTA_PASSWORD']) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing from env. Source .env first.');
    process.exit(2);
  }
  const projectIdentifier = projectIdArg ?? 'vibesync';
  const projectName = projectNameArg ?? projectIdentifier;

  // Build a LettaService just to get configured tool + memory services
  // — we bypass the ensureAgent + ensureControlAgent path entirely.
  const svc = createLettaService();
  const inner = svc as unknown as { _tools: LettaToolService; _memory: LettaMemoryService };

  console.log(`[finalize-by-id] target agent: ${agentId} (project=${projectIdentifier}, name=${projectName})`);

  console.log('[finalize-by-id] step 1/4: attach dispatch_molecule …');
  try {
    const ok = await inner._tools.attachDispatchMoleculeTool(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] step 2/4: attach list_formulas …');
  try {
    const ok = await inner._tools.attachListFormulasTool(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] step 3/4: sync tool_exec_environment_variables …');
  try {
    const ok = await inner._tools.syncPmAgentEnvVars(agentId);
    console.log(`  → ${ok ? 'OK' : 'FAIL'}`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] step 4/4: update persona block (with Formula Dispatch Protocol) …');
  try {
    const persona = buildPersonaBlock(projectIdentifier, projectName);
    await inner._memory._updatePersonaBlock(agentId, persona);
    console.log(`  → OK (${persona.length} chars pushed)`);
  } catch (err) { console.error('  ERROR:', (err as Error).message); }

  console.log('[finalize-by-id] done.');
}

main().catch((err: unknown) => {
  console.error('[finalize-by-id] crashed:', err);
  process.exit(1);
});
