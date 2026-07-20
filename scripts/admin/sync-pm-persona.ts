#!/usr/bin/env bun
/**
 * Sync the central VibeSync PM persona template to existing PM agents.
 *
 * This complements the normal ensureAgent/finalize path, which updates a PM
 * persona when a single project is touched. Use this script when the central
 * PM operating charter changes and existing PMs should all receive it now.
 *
 * Modes:
 *   --dry-run (default)   Read-only; print target agents and persona sizes.
 *   --apply               Update each target agent's persona block.
 *
 * Selection:
 *   By default targets agents tagged both "vibesync" and "project:<id>".
 *   Pass --include-control to also update the configured control agent.
 *
 * Env required: LETTA_BASE_URL, LETTA_PASSWORD.
 */

import { createLettaService } from '../../src/LettaService.js';
import { buildPersonaBlock } from '../../src/letta/pm-agent-persona.js';

interface AgentSummary {
  readonly id: string;
  readonly name?: string;
  readonly tags?: readonly string[];
}

interface TargetAgent extends AgentSummary {
  readonly projectIdentifier: string;
  readonly projectName: string;
  readonly isControl: boolean;
}

function parseProjectIdentifier(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((value) => value.startsWith('project:'));
  return tag ? tag.slice('project:'.length) : null;
}

function projectNameFromAgentName(agentName: string | undefined, projectIdentifier: string): string {
  const prefix = 'PM - ';
  if (agentName?.startsWith(prefix)) return agentName.slice(prefix.length).trim() || projectIdentifier;
  return agentName?.trim() || projectIdentifier;
}

async function main(): Promise<void> {
  if (!process.env['LETTA_BASE_URL'] || !process.env['LETTA_PASSWORD']) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing. Source .env first.');
    process.exit(2);
  }

  const apply = process.argv.includes('--apply');
  const includeControl = process.argv.includes('--include-control');
  const letta = createLettaService();
  const controlAgentName = letta.controlAgentName;

  const agents = await letta.listAgents({ limit: 500, include: 'agent.tags' }) as AgentSummary[];
  const targets: TargetAgent[] = [];

  for (const agent of agents) {
    const tags = agent.tags ?? [];
    const projectIdentifier = parseProjectIdentifier(tags);
    const isProjectPm = tags.includes('vibesync') && projectIdentifier !== null;
    const isControl = agent.name === controlAgentName;
    if (!isProjectPm && !(includeControl && isControl)) continue;

    const effectiveProjectIdentifier = isControl ? 'CONTROL' : projectIdentifier!;
    const effectiveProjectName = isControl
      ? 'PM Control Template'
      : projectNameFromAgentName(agent.name, effectiveProjectIdentifier);

    targets.push({
      ...agent,
      projectIdentifier: effectiveProjectIdentifier,
      projectName: effectiveProjectName,
      isControl,
    });
  }

  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`control agent: ${controlAgentName}${includeControl ? ' (included)' : ' (excluded)'}`);
  console.log(`targets: ${targets.length}`);

  let updated = 0;
  let failed = 0;
  for (const target of targets) {
    const persona = buildPersonaBlock(target.projectIdentifier, target.projectName);
    const label = `${target.id} ${target.name ?? '(unnamed)'} project=${target.projectIdentifier}`;
    if (!apply) {
      console.log(`  [dry] ${label} personaChars=${persona.length}${target.isControl ? ' control=true' : ''}`);
      continue;
    }

    try {
      await letta._updatePersonaBlock(target.id, persona);
      updated++;
      console.log(`  ✓ ${label} personaChars=${persona.length}${target.isControl ? ' control=true' : ''}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${label}: ${(err as Error).message}`);
    }
  }

  if (!apply) {
    console.log('Dry-run complete. Re-run with --apply to update persona blocks.');
    return;
  }

  console.log(`Done. ${updated} updated, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('crashed:', err);
  process.exit(1);
});
