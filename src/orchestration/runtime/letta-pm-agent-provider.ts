/**
 * LettaPMAgentProvider — wraps VibeSync's existing src/letta/ services
 * behind the RuntimeProvider seam.
 *
 * This is the FIRST implementation, validating the interface against
 * code that's already in production. Adding it does not change any
 * existing PM-agent behaviour — existing call sites continue calling
 * the underlying services directly. The provider is the NEW way to
 * reach those services from the orchestration layer.
 *
 * Discipline:
 *   - This file is in src/orchestration/runtime/, which is allowed to
 *     import from src/letta/ (lower-layer infrastructure).
 *   - src/letta/ MUST NOT import from src/orchestration/. (Layering
 *     invariant #1.)
 *
 * Provider-specific start-spec extra fields:
 *   - extra.projectId: string — required; identifies which project this
 *     session is scoped to (PM agent is per-project).
 *   - extra.controlAgentName?: string — override LettaConfig.controlAgentName
 *     for this session only.
 *
 * Status:
 *   - This is a SKELETON wired against the existing service shape. The
 *     hot-path prompt/observe flow is stubbed to delegate to the
 *     existing Letta SDK client; full event normalization (mapping Letta
 *     stream frames → SessionEvent) is deferred until the daemon
 *     (vibesync-uxx) needs it.
 *
 * See vibesync-57p.
 */

import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

/**
 * Subset of the existing src/letta/ services this provider needs. We
 * accept these as constructor args so the provider stays testable —
 * the daemon wires real services, tests wire fakes.
 */
export interface LettaPMAgentServices {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly lifecycle: {
    ensureAgent(projectId: string, controlAgentName?: string): Promise<{ id: string; name: string }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client: { agents: { messages: { create: (...args: any[]) => Promise<unknown> } } };
}

interface LettaSessionHandle extends SessionHandle {
  readonly providerKind: 'letta-pm-agent';
  readonly agentId: string;
  readonly projectId: string;
}

export class LettaPMAgentProvider implements RuntimeProvider {
  readonly kind = 'letta-pm-agent';
  private readonly services: LettaPMAgentServices;

  constructor(services: LettaPMAgentServices) {
    this.services = services;
  }

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const projectId = readStringExtra(spec, 'projectId');
    if (!projectId) {
      throw new Error(`LettaPMAgentProvider.start: spec.extra.projectId is required for role=${spec.role}`);
    }
    const controlName = readOptionalStringExtra(spec, 'controlAgentName');
    const agent = await this.services.lifecycle.ensureAgent(projectId, controlName);
    const handle: LettaSessionHandle = {
      id: `letta-pm:${projectId}:${agent.id}`,
      providerKind: 'letta-pm-agent',
      agentId: agent.id,
      projectId,
    };
    return handle;
  }

  async stop(_handle: SessionHandle): Promise<void> {
    // PM agents are persistent per-project entities; "stopping" a session
    // doesn't tear down the agent. The daemon archives the SessionHandle
    // record; the underlying Letta agent stays alive for the next start.
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectLettaHandle(handle);
    const messageContent = toLettaMessageContent(content);
    await this.services.client.agents.messages.create(h.agentId, {
      messages: [{ role: 'user', content: messageContent }],
    });
    return {};
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // Letta REST has no "nudge" verb; agents wake on the next message.
    // No-op preserves the interface without inventing a fake operation.
  }

  /**
   * Observes the Letta SSE stream for the session's agent. SKELETON: the
   * existing Letta integration emits raw stream frames; the daemon
   * (vibesync-uxx) is the right place to normalize them into
   * SessionEvent because it owns the molecule-step state machine and
   * already has to translate. For now we yield a synthetic started/
   * turn-done bracket so callers can integration-test the lifecycle.
   */
  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    expectLettaHandle(handle);
    const ts = new Date().toISOString();
    yield { kind: 'started', ts };
    yield { kind: 'turn-done', ts };
    // TODO(vibesync-uxx): wire to the real SSE stream when the
    // daemon integrates this provider end-to-end. Track via a follow-up
    // bead if normalization grows complex.
  }
}

function expectLettaHandle(handle: SessionHandle): LettaSessionHandle {
  if (handle.providerKind !== 'letta-pm-agent') {
    throw new Error(
      `LettaPMAgentProvider: handle from wrong provider (got ${handle.providerKind}, want letta-pm-agent)`,
    );
  }
  return handle as LettaSessionHandle;
}

function readStringExtra(spec: SessionSpec, key: string): string | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'string' ? v : undefined;
}

function readOptionalStringExtra(spec: SessionSpec, key: string): string | undefined {
  return readStringExtra(spec, key);
}

/**
 * Map orchestration ContentBlock array to Letta SDK message content. Text
 * passes through; image blocks become Letta's image content-part shape.
 *
 * Kept narrow: a new modality on ContentBlock needs an explicit mapping
 * line here, by design.
 */
function toLettaMessageContent(content: readonly ContentBlock[]): unknown {
  const parts = content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mimeType, data: block.data },
    };
  });
  // Single text block can be sent as a plain string for legacy
  // compatibility with older Letta server builds.
  const onlyPart = parts[0];
  if (parts.length === 1 && onlyPart && onlyPart.type === 'text') {
    return onlyPart.text;
  }
  return parts;
}
