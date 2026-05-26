/**
 * A2UIProvider — server side for letta-mobile / web client UI rendering.
 *
 * A2UI (https://a2ui.org/, https://github.com/google/A2UI) is Google's
 * open spec for agents to send declarative UI descriptions to clients
 * that render them natively. This provider is the server end: it
 * delegates prompt/response to an INNER RuntimeProvider (the actual
 * agent runtime) and adapts the SessionEvent stream into A2UI surface
 * updates that get delivered to the client via the configured
 * delivery function.
 *
 * Composition over inheritance: an A2UIProvider is constructed AROUND
 * another RuntimeProvider (typically LettaPMAgentProvider or
 * LettaCodeSubagentProvider). The inner provider answers the agent's
 * thinking; A2UIProvider negotiates the UI capability with the client
 * and maps stream events to A2UI surface updates.
 *
 * Provider-specific start-spec extra fields:
 *   - extra.a2uiCapability?: A2uiCapability — negotiated client
 *     capabilities (component catalog, surface ids client supports).
 *     If absent, prompts pass through unchanged (legacy clients).
 *   - extra.inner: SessionSpec — required; the inner provider's spec.
 *
 * Status: SKELETON. The capability negotiation and surface-update
 * emission are stubbed; full A2UI message-emission lands when the
 * mobile-side rendering work Codex is doing converges with a stable
 * client-side schema. The provider shape and inner-delegation seam
 * are pinned so future implementation slots in cleanly.
 *
 * See vibesync-0tw.
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
 * Client-side A2UI capability descriptor — what UI components the
 * client can render. Negotiated at session start, stored on the
 * handle, consulted by the provider when emitting surface updates.
 *
 * Schema mirrors A2UI v0.8's capability negotiation envelope; fields
 * stay open-ended pending the upstream spec's stabilization.
 */
export interface A2uiCapability {
  readonly protocolVersion: string;
  readonly catalogId?: string;
  readonly supportedComponents?: readonly string[];
}

interface A2uiHandle extends SessionHandle {
  readonly providerKind: 'a2ui';
  readonly innerHandle: SessionHandle;
  readonly capability: A2uiCapability | null;
}

export class A2UIProvider implements RuntimeProvider {
  readonly kind = 'a2ui';

  constructor(private readonly inner: RuntimeProvider) {}

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const innerSpec = (spec.extra?.['inner'] ?? null) as SessionSpec | null;
    if (!innerSpec) {
      throw new Error(`A2UIProvider.start: spec.extra.inner (SessionSpec) is required`);
    }
    const capabilityRaw = spec.extra?.['a2uiCapability'];
    const capability =
      capabilityRaw && typeof capabilityRaw === 'object' && 'protocolVersion' in capabilityRaw
        ? (capabilityRaw as A2uiCapability)
        : null;
    const innerHandle = await this.inner.start(innerSpec);
    const handle: A2uiHandle = {
      id: `a2ui:${innerHandle.id}`,
      providerKind: 'a2ui',
      innerHandle,
      capability,
    };
    return handle;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const h = expectHandle(handle);
    await this.inner.stop(h.innerHandle);
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    return this.inner.prompt(h.innerHandle, content);
  }

  async nudge(handle: SessionHandle): Promise<void> {
    const h = expectHandle(handle);
    await this.inner.nudge(h.innerHandle);
  }

  /**
   * Skeleton observe — relays inner events through. Full A2UI surface-
   * update emission (mapping message-delta → A2UI text component
   * updates, tool-call → A2UI action chip, etc.) lands when the mobile
   * renderer side stabilizes its schema. Until then, capability is
   * null on most sessions and pass-through is the correct behaviour.
   */
  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const h = expectHandle(handle);
    for await (const ev of this.inner.observe(h.innerHandle)) {
      yield ev;
      // TODO(vibesync-0tw follow-up): when capability !== null,
      // also emit A2UI surface updates derived from `ev`. The shape
      // depends on the negotiated catalog and is owned by a follow-up
      // bead once the upstream A2UI v0.9 schema lands.
    }
  }
}

function expectHandle(handle: SessionHandle): A2uiHandle {
  if (handle.providerKind !== 'a2ui') {
    throw new Error(
      `A2UIProvider: handle from wrong provider (got ${handle.providerKind}, want a2ui)`,
    );
  }
  return handle as A2uiHandle;
}
