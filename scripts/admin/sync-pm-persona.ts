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
 *   By default targets PM agents tagged both "vibesync" and "project:<id>".
 *   Role agents (tagged "role:<name>") are excluded.
 *   Pass --include-control to also update the configured control agent.
 *
 * Env required: LETTA_BASE_URL, LETTA_PASSWORD.
 */

import { pathToFileURL } from 'node:url';

import { createLettaService } from '../../src/LettaService.js';
import { buildPersonaBlock } from '../../src/letta/pm-agent-persona.js';

const AGENT_PAGE_LIMIT = 200;
const LEGACY_LIMIT_WARNING_THRESHOLD = 500;

export interface AgentSummary {
  readonly id: string;
  readonly name?: string;
  readonly tags?: readonly string[];
}

export interface AgentDetails extends AgentSummary {
  readonly memory?: { readonly blocks?: readonly { readonly label?: string; readonly value?: unknown }[] };
}

export interface TargetAgent extends AgentSummary {
  readonly projectIdentifier: string;
  readonly projectName: string;
  readonly isControl: boolean;
}

export interface SyncLettaService {
  readonly controlAgentName: string;
  listAgents(filters: Record<string, unknown>): Promise<unknown>;
  _updatePersonaBlock(agentId: string, personaContent: string): Promise<void>;
  getAgent(agentId: string): Promise<unknown>;
}

export interface SyncPmPersonaOptions {
  readonly apply: boolean;
  readonly includeControl: boolean;
  readonly letta: SyncLettaService;
  readonly log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface SyncPmPersonaResult {
  readonly targets: readonly TargetAgent[];
  readonly updated: number;
  readonly failed: number;
}

export function parseProjectIdentifier(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((value) => value.startsWith('project:'));
  return tag ? tag.slice('project:'.length) : null;
}

export function projectNameFromAgentName(agentName: string | undefined, projectIdentifier: string): string {
  const prefix = 'PM - ';
  if (agentName?.startsWith(prefix)) return agentName.slice(prefix.length).trim() || projectIdentifier;
  return agentName?.trim() || projectIdentifier;
}

function isRoleAgent(tags: readonly string[]): boolean {
  return tags.some((value) => value.startsWith('role:'));
}

function extractAgentPage(response: unknown): { agents: AgentSummary[]; nextCursor: string | null } {
  if (Array.isArray(response)) return { agents: response as AgentSummary[], nextCursor: null };
  const obj = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const agents = (obj['agents'] ?? obj['data'] ?? obj['items'] ?? []) as AgentSummary[];
  const nextCursor = obj['nextCursor'] ?? obj['next_cursor'] ?? obj['after'] ?? null;
  return { agents: Array.isArray(agents) ? agents : [], nextCursor: typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null };
}

export async function listAllAgents(letta: Pick<SyncLettaService, 'listAgents'>, log: Pick<Console, 'warn'> = console): Promise<AgentSummary[]> {
  const all: AgentSummary[] = [];
  let after: string | null = null;
  let sawFullLegacyWindow = false;

  do {
    const filters: Record<string, unknown> = { limit: AGENT_PAGE_LIMIT, include: 'agent.tags' };
    if (after) filters['after'] = after;
    const { agents, nextCursor } = extractAgentPage(await letta.listAgents(filters));
    all.push(...agents);
    if (agents.length === AGENT_PAGE_LIMIT && !nextCursor) sawFullLegacyWindow = true;
    after = nextCursor;
  } while (after);

  if (sawFullLegacyWindow || all.length === LEGACY_LIMIT_WARNING_THRESHOLD) {
    log.warn(`Warning: fetched ${all.length} agents and may have reached a Letta API page/limit boundary; verify no PM agents were omitted.`);
  }

  return all;
}

export function selectTargets(agents: readonly AgentSummary[], controlAgentName: string, includeControl: boolean): TargetAgent[] {
  const targets: TargetAgent[] = [];

  for (const agent of agents) {
    const tags = agent.tags ?? [];
    const projectIdentifier = parseProjectIdentifier(tags);
    const isProjectPm = tags.includes('vibesync') && projectIdentifier !== null && !isRoleAgent(tags);
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

  return targets;
}

function personaBlockValue(agent: unknown): string | null {
  const details = agent as AgentDetails;
  const block = details.memory?.blocks?.find((value) => value.label === 'persona');
  return typeof block?.value === 'string' ? block.value : null;
}

async function verifyPersonaUpdated(letta: Pick<SyncLettaService, 'getAgent'>, agentId: string, persona: string): Promise<void> {
  const agent = await letta.getAgent(agentId);
  if (personaBlockValue(agent) !== persona) throw new Error('persona block verification failed after update');
}

export async function runSyncPmPersona(options: SyncPmPersonaOptions): Promise<SyncPmPersonaResult> {
  const log = options.log ?? console;
  const controlAgentName = options.letta.controlAgentName;
  const agents = await listAllAgents(options.letta, log);
  const targets = selectTargets(agents, controlAgentName, options.includeControl);

  log.log(`mode: ${options.apply ? 'APPLY' : 'dry-run'}`);
  log.log(`control agent: ${controlAgentName}${options.includeControl ? ' (included)' : ' (excluded)'}`);
  log.log(`targets: ${targets.length}`);

  let updated = 0;
  let failed = 0;
  for (const target of targets) {
    const persona = buildPersonaBlock(target.projectIdentifier, target.projectName);
    const label = `${target.id} ${target.name ?? '(unnamed)'} project=${target.projectIdentifier}`;
    if (!options.apply) {
      log.log(`  [dry] ${label} personaChars=${persona.length}${target.isControl ? ' control=true' : ''}`);
      continue;
    }

    try {
      await options.letta._updatePersonaBlock(target.id, persona);
      await verifyPersonaUpdated(options.letta, target.id, persona);
      updated++;
      log.log(`  ✓ ${label} personaChars=${persona.length}${target.isControl ? ' control=true' : ''}`);
    } catch (err) {
      failed++;
      log.error(`  ✗ ${label}: ${(err as Error).message}`);
    }
  }

  if (!options.apply) {
    log.log('Dry-run complete. Re-run with --apply to update persona blocks.');
  } else {
    log.log(`Done. ${updated} updated, ${failed} failed.`);
  }

  return { targets, updated, failed };
}

async function main(): Promise<void> {
  if (!process.env['LETTA_BASE_URL'] || !process.env['LETTA_PASSWORD']) {
    console.error('LETTA_BASE_URL or LETTA_PASSWORD missing. Source .env first.');
    process.exit(2);
  }

  const result = await runSyncPmPersona({
    apply: process.argv.includes('--apply'),
    includeControl: process.argv.includes('--include-control'),
    letta: createLettaService() as SyncLettaService,
  });

  if (process.argv.includes('--apply') && result.failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('crashed:', err);
    process.exit(1);
  });
}
