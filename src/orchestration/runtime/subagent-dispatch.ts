/**
 * Shared dispatch logic for providers that PUPPET a parent PM agent into
 * calling Letta Code's Agent tool (vibesync-573 / vibesync-f5g / vibesync-x38j).
 *
 * Extracted verbatim from LettaCodeSubagentProvider so the HTTP/SSE provider
 * and the Iroh provider build byte-identical puppet messages and parse the
 * role output the same way. Only the transport differs. Behaviour here MUST
 * NOT change per provider; a golden test pins both providers to this module.
 *
 * Pure: no I/O, no upward imports.
 */

import type { ContentBlock, SessionSpec } from './provider.js';

/**
 * Reader for role-persona content. Production wires this to the
 * filesystem; tests can inject a fake. The pack/role tuple is the
 * key — we don't take an absolute path because pack discovery is
 * resolved one layer up (formula → pack).
 */
export interface PersonaLoader {
  /**
   * Return the .md body (frontmatter included is fine — the PM will
   * skim past it) for the given role name. Throws when the role is
   * not found, since a missing persona is a configuration error, not
   * a runtime degradation.
   */
  load(role: string): Promise<string>;
}

/**
 * Resolver for persistent per-(project, role) subagent ids
 * (vibesync-mcz Phase C). Wired in production to the
 * RoleAgentBootstrapper backed by project_role_agents.
 *
 * Contract:
 *   - Return a real Letta Code agent id ('agent-<uuid>') and the
 *     provider will dispatch via Agent(subagent_type='general-purpose',
 *     agent_id=<id>, prompt=<task>) — persona is NOT inlined; the
 *     persistent agent owns its own system prompt.
 *   - Return null and the provider falls back to today's inline
 *     persona path (backwards compat for projects that haven't been
 *     bootstrapped yet, or callers that don't want persistence).
 *   - Throwing is treated as a hard failure (start() rejects). Use
 *     null for "no row", not for transient errors.
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
 * Resolve the global default turn timeout. Checks VIBESYNC_TURN_TIMEOUT_MS
 * env var first (vibesync-lcp-98y8), falls back to 10min if not set or invalid.
 */
export function resolveDefaultTurnTimeout(): number {
  const envVar = process.env['VIBESYNC_TURN_TIMEOUT_MS'];
  if (envVar !== undefined) {
    const parsed = Number.parseInt(envVar, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}


/**
 * Build the puppet message body the dispatcher posts to the PM. The
 * PM is instructed to call Agent(subagent_type=..., prompt=...) with
 * the persona inlined and the rendered template as the task.
 *
 * Kept ASCII-friendly and explicit so the PM's instruction-following
 * has the smallest possible space to misinterpret.
 *
 * vibesync-mcz Phase C: when `agentId` is provided, the puppet
 * instructs the PM to dispatch via Agent(subagent_type=..., agent_id=...,
 * prompt=<task only>) — persona is NOT inlined because the persistent
 * agent at `agentId` owns its system prompt. When `agentId` is null
 * (default), the inline-persona path is used unchanged — backwards
 * compat for projects that haven't been bootstrapped yet.
 */
export function buildPuppetMessage(args: {
  readonly subagentType: string;
  readonly personaContent: string;
  readonly role: string;
  readonly input: string;
  readonly agentId?: string | null;
}): string {
  if (args.agentId) {
    return [
      `[ORCHESTRATION_SUBAGENT_DISPATCH]`,
      ``,
      `You MUST call the Agent tool exactly once with these arguments.`,
      `Copy the complete text between <<<TASK_PROMPT_BEGIN>>> and`,
      `<<<TASK_PROMPT_END>>> into the Agent prompt argument verbatim.`,
      `  subagent_type: ${JSON.stringify(args.subagentType)}`,
      `  agent_id: ${JSON.stringify(args.agentId)}`,
      `  description: ${JSON.stringify(`${args.role} role`)}`,
      `  prompt: |-`,
      `<<<TASK_PROMPT_BEGIN>>>`,
      `# Task`,
      ``,
      `${args.input.trim()}`,
      `<<<TASK_PROMPT_END>>>`,
      ``,
      `The subagent at agent_id ${JSON.stringify(args.agentId)} already`,
      `knows its role identity from its persistent system prompt — do`,
      `NOT inline persona or role instructions in the prompt.`,
      ``,
      `Return ONLY the subagent's final output verbatim. Do not summarize,`,
      `reformat, prefix, or comment on it. The dispatcher consumes your`,
      `next assistant message as the step output.`,
    ].join('\n');
  }
  return [
    `[ORCHESTRATION_SUBAGENT_DISPATCH]`,
    ``,
    `You MUST call the Agent tool exactly once with these arguments.`,
    `Copy the complete text between <<<TASK_PROMPT_BEGIN>>> and`,
    `<<<TASK_PROMPT_END>>> into the Agent prompt argument verbatim.`,
    `  subagent_type: ${JSON.stringify(args.subagentType)}`,
    `  description: ${JSON.stringify(`${args.role} role`)}`,
    `  prompt: |-`,
    `<<<TASK_PROMPT_BEGIN>>>`,
    `# Role: ${args.role}`,
    ``,
    `${args.personaContent.trim()}`,
    ``,
    `# Task`,
    ``,
    `${args.input.trim()}`,
    `<<<TASK_PROMPT_END>>>`,
    ``,
    `Return ONLY the subagent's final output verbatim. Do not summarize,`,
    `reformat, prefix, or comment on it. The dispatcher consumes your`,
    `next assistant message as the step output.`,
  ].join('\n');
}


export function extractSubagentText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r['output'] === 'string') return r['output'];
    if (typeof r['text'] === 'string') return r['text'];
    if (typeof r['content'] === 'string') return r['content'];
    if (Array.isArray(r['content'])) {
      const parts: string[] = [];
      for (const part of r['content']) {
        if (typeof part === 'string') {
          parts.push(part);
          continue;
        }
        if (part && typeof part === 'object') {
          const txt = (part as Record<string, unknown>)['text'];
          if (typeof txt === 'string') parts.push(txt);
        }
      }
      return parts.join('');
    }
  }
  return '';
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
