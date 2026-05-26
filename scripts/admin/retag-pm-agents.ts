#!/usr/bin/env bun
/**
 * scripts/admin/retag-pm-agents.ts — one-time migration that replaces
 * the legacy org tag 'huly-vibe-sync' with the current org tag
 * 'vibesync' on every Letta agent that carries it. Preserves all other
 * tags verbatim (most importantly the per-project tag and any feature
 * flags like 'git-memory-enabled').
 *
 * Why: today (2026-05-21) LettaAgentLifecycleService.ensureAgent looks
 * for agents tagged ('vibesync', 'project:<id>'). Most existing agents
 * still carry the legacy 'huly-vibe-sync' org tag — so ensureAgent
 * fails to find them and creates a duplicate stub instead. This
 * migration unsticks every project at once.
 *
 * Modes:
 *   --dry-run (default)   Read-only; print which agents would change.
 *   --apply               Actually PATCH each agent.
 *   --backup-dir <path>   Where to write the pre-state snapshot
 *                         (default: /tmp/vibesync-deploy-snapshot).
 *
 * Restore: each agent's pre-state JSON is written to
 *   <backup-dir>/retag-pre/<agent-id>.json
 * Re-run with original tags via curl PATCH if anything regresses.
 *
 * Env required: LETTA_BASE_URL, LETTA_PASSWORD.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OLD_TAG = 'huly-vibe-sync';
const NEW_TAG = 'vibesync';

interface Agent {
  readonly id: string;
  readonly name?: string;
  readonly tags?: readonly string[];
}

function arg(name: string, defaultValue?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return defaultValue;
  return process.argv[idx + 1] ?? defaultValue;
}

async function listAgents(baseUrl: string, password: string): Promise<Agent[]> {
  const url = `${baseUrl}/v1/agents?limit=500&include=agent.tags`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${password}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} listing agents: ${await r.text()}`);
  return (await r.json()) as Agent[];
}

async function patchTags(baseUrl: string, password: string, agentId: string, tags: readonly string[]): Promise<void> {
  const url = `${baseUrl}/v1/agents/${agentId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} patching ${agentId}: ${await r.text()}`);
}

async function main(): Promise<void> {
  const base = (process.env['LETTA_BASE_URL'] ?? '').replace(/\/+$/, '');
  const password = process.env['LETTA_PASSWORD'] ?? '';
  if (!base || !password) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing. Source .env first.');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const backupDir = arg('--backup-dir', '/tmp/vibesync-deploy-snapshot')!;

  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`Letta: ${base}`);

  const all = await listAgents(base, password);
  const candidates = all.filter((a) => (a.tags ?? []).includes(OLD_TAG));
  console.log(`Found ${candidates.length} agents tagged "${OLD_TAG}" (out of ${all.length} total).`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (apply) {
    const preDir = join(backupDir, 'retag-pre');
    if (!existsSync(preDir)) mkdirSync(preDir, { recursive: true });
    console.log(`Pre-state backup → ${preDir}`);
  }

  let ok = 0;
  let fail = 0;
  for (const a of candidates) {
    const oldTags = a.tags ?? [];
    const newTagsRaw = oldTags.map((t) => (t === OLD_TAG ? NEW_TAG : t));
    // De-duplicate just in case an agent already had both old + new
    const newTags = Array.from(new Set(newTagsRaw));

    if (!apply) {
      console.log(`  [dry] ${a.id}  ${a.name ?? '(unnamed)'}: ${JSON.stringify(oldTags)} → ${JSON.stringify(newTags)}`);
      continue;
    }

    try {
      writeFileSync(join(backupDir, 'retag-pre', `${a.id}.json`), JSON.stringify({ id: a.id, name: a.name, tags: oldTags }, null, 2));
      await patchTags(base, password, a.id, newTags);
      ok++;
      console.log(`  ✓ ${a.id}  ${a.name ?? '(unnamed)'}`);
    } catch (err) {
      fail++;
      console.error(`  ✗ ${a.id}  ${a.name ?? '(unnamed)'}: ${(err as Error).message}`);
    }
  }

  if (apply) {
    console.log();
    console.log(`Done. ${ok} retagged, ${fail} failed.`);
  } else {
    console.log();
    console.log('Dry-run complete. Re-run with --apply to actually patch.');
  }
}

main().catch((err: unknown) => {
  console.error('crashed:', err);
  process.exit(1);
});
