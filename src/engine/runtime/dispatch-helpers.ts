/**
 * Small helpers the Iroh runtime provider uses to read a SessionSpec and to
 * resolve the role agent a step runs on.
 *
 * Pure: no I/O, no upward imports.
 */

import type { ContentBlock, SessionSpec } from './provider.js';

/**
 * Resolves the persistent role agent for a step from project_role_agents.
 * Return null when there is no row: the step then fails with a clear reason.
 * Throwing is a hard failure (start() rejects); use null for "no row", not for
 * transient errors.
 */
export interface AgentIdResolver {
  resolveRoleAgent(
    role: string,
    parentAgentId: string,
    projectIdentifier: string | null,
  ): Promise<string | null>;
}

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The global default turn timeout: VIBESYNC_TURN_TIMEOUT_MS when it is a
 * positive integer, else 10 minutes.
 */
export function resolveDefaultTurnTimeout(): number {
  const envVar = process.env['VIBESYNC_TURN_TIMEOUT_MS'];
  if (envVar !== undefined) {
    const parsed = Number.parseInt(envVar, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

export function readStringExtra(spec: SessionSpec, key: string): string | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function readNumberExtra(spec: SessionSpec, key: string): number | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function contentToText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType}]`);
  }
  return parts.join('\n');
}
