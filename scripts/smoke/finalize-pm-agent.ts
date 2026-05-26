#!/usr/bin/env bun
/**
 * scripts/smoke/finalize-pm-agent.ts — one-shot script that loads
 * LettaService and re-runs ensureAgent for a single project, which
 * triggers _finalizePmAgent on the new code path:
 *   - attaches dispatch_molecule
 *   - attaches list_formulas
 *   - syncs tool_exec_environment_variables (LETTA_AGENT_ID +
 *     VIBESYNC_API_BASE_URL + optional VIBESYNC_ORCHESTRATION_TOKEN)
 *
 * Idempotent: every step ends up in already-attached / already-set
 * state on re-run. Contained: touches exactly one PM agent per run.
 *
 * Usage:
 *   bun scripts/smoke/finalize-pm-agent.ts <projectIdentifier> [projectName]
 *
 * Examples:
 *   bun scripts/smoke/finalize-pm-agent.ts vibesync
 *   bun scripts/smoke/finalize-pm-agent.ts vibesync "Vibesync"
 *
 * Defaults projectName to projectIdentifier when omitted. The Letta
 * env (LETTA_BASE_URL, LETTA_PASSWORD) is inherited from the shell;
 * source .env first if running outside the server process env.
 *
 * Exits non-zero on hard failure. Soft failures inside _finalizePmAgent
 * (single tool attach or env sync) are logged but do not throw — same
 * shape as the production path. See vibesync-rgx.
 */

import { createLettaService } from '../../src/LettaService.js';

async function main(): Promise<void> {
  const [, , rawId, rawName] = process.argv;
  if (!rawId) {
    console.error('usage: bun scripts/smoke/finalize-pm-agent.ts <projectIdentifier> [projectName]');
    process.exit(2);
  }
  const projectIdentifier = rawId;
  const projectName = rawName ?? rawId;

  if (!process.env['LETTA_BASE_URL'] || !process.env['LETTA_PASSWORD']) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing from env. Source .env first.');
    process.exit(2);
  }

  console.log(`[finalize] target: project=${projectIdentifier} name=${projectName}`);
  const letta = createLettaService();

  const agent = await letta.ensureAgent(projectIdentifier, projectName);
  if (!agent || typeof agent !== 'object' || typeof (agent as { id?: unknown }).id !== 'string') {
    console.error('[finalize] ensureAgent returned no agent id');
    process.exit(1);
  }
  const agentId = (agent as { id: string }).id;
  console.log(`[finalize] ensureAgent → ${agentId}`);
  console.log('[finalize] done (idempotent — re-run is safe)');
}

main().catch((err: unknown) => {
  console.error('[finalize] failed:', err);
  process.exit(1);
});
