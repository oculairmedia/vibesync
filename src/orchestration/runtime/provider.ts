/**
 * RuntimeProvider — the orchestration plane's session-management seam.
 *
 * Mirrors Gas City's `runtime.Provider` interface (internal/runtime/) so
 * higher layers (formulas, molecules, dispatch) don't need to know which
 * agent runtime backs a session. Today the primary implementation is:
 *
 *   - LettaCodeSubagentProvider — drives the letta-code local backend
 *     for spawned Gastown role sessions (mayor / coder / reviewer /
 *     refinery / tester).
 *
 * The persistent PM-agent path remains a separate Letta integration above
 * this seam; spawned role sessions route through the local backend.
 *
 * Future implementations will plug in alongside without changing this
 * interface:
 *
 *   - ACPProvider — JSON-RPC over stdio (vibesync-oq4)
 *   - A2UIProvider — server side for letta-mobile / web UI rendering (vibesync-0tw)
 *   - FakeProvider — in-memory, for tests
 *
 * Layering invariant #5 (zero hardcoded roles) discipline: this interface
 * MUST NOT widen to include role-specific concerns (memory blocks, Letta
 * conversation IDs, fork semantics, A2UI capability negotiation, etc.).
 * Those belong ABOVE the interface, in formulas + role config + per-
 * implementation start-spec extensions. Keep the surface at five methods.
 *
 * See docs/architecture/gastown-orchestration.md and vibesync-57p.
 */

/**
 * Opaque handle to a started session. Implementations stash whatever
 * backend state they need (Letta agent id + conversation target id, ACP
 * subprocess + JSON-RPC connection, etc.) behind this token.
 *
 * Discipline: callers MUST treat this as opaque and pass it back into the
 * same provider that issued it. Cross-provider handle exchange is a
 * defect.
 */
export interface SessionHandle {
  /** Provider-stable id; safe to log and persist on a bead. */
  readonly id: string;
  /** Provider that owns this handle. Used by the daemon for routing. */
  readonly providerKind: string;
}

/**
 * Provider metadata for a prompt accepted by the runtime.
 *
 * `taskId` is intentionally provider-opaque. Dispatchers may persist it
 * on molecule-step beads so a later process can re-attach through the
 * same RuntimeProvider; they must not interpret it directly.
 */
export interface PromptResult {
  readonly taskId?: string;
}

/**
 * Caller-supplied configuration for starting a session. Each provider
 * extends this with its own typed start-spec; the interface defines only
 * the irreducible fields every provider needs.
 *
 * The `extra` map is the escape hatch for provider-specific config. The
 * provider is responsible for documenting which keys it expects.
 */
export interface SessionSpec {
  /** Stable identity for the role this session embodies (e.g. "reviewer"). Role behavior lives in pack config, not here. */
  readonly role: string;
  /** Human-readable label for logs/telemetry. */
  readonly label?: string;
  /** Provider-specific config; documented per-provider. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated union of content pieces in a prompt. Mirrors Letta's
 * `MessageContentPart` shape (text + image), kept narrow here so adding
 * a new modality (audio, file refs) is a deliberate cross-provider
 * decision.
 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string };

/**
 * Provider-emitted observation events for a session. Discriminated by
 * `kind`. The orchestration daemon translates these into event-bus
 * entries (vibesync-ds4) and molecule-step state transitions.
 *
 * Provider implementations may emit additional `kind` values; consumers
 * should treat unknown kinds as opaque and pass-through.
 */
export type SessionEvent =
  | { readonly kind: 'started'; readonly ts: string }
  | { readonly kind: 'first-token'; readonly ts: string }
  | { readonly kind: 'message-delta'; readonly ts: string; readonly text: string }
  | { readonly kind: 'tool-call'; readonly ts: string; readonly tool: string; readonly args: unknown }
  | { readonly kind: 'tool-result'; readonly ts: string; readonly tool: string; readonly result: unknown; readonly ok: boolean }
  | { readonly kind: 'usage'; readonly ts: string; readonly prompt: number; readonly completion: number }
  | { readonly kind: 'turn-done'; readonly ts: string; readonly stopReason?: string }
  | { readonly kind: 'error'; readonly ts: string; readonly code: string; readonly message: string }
  | { readonly kind: 'stopped'; readonly ts: string };

/**
 * The five-method runtime contract every provider implements.
 *
 *   start    — bring a session into existence (spawn process, create agent, etc.)
 *   stop     — tear it down (kill, archive, decommission)
 *   prompt   — send the user's input as a content-block array
 *   nudge    — wake a session that may have gone idle (no-op for many providers)
 *   observe  — async-iterable of SessionEvent until turn ends or stopped
 *
 * Layering invariant: NO role-specific knowledge lives here. If you find
 * yourself wanting to add a method like `setMemoryBlock` or
 * `forkConversation`, that's a sign the abstraction is being violated.
 * Those operations belong in the provider's start-spec or in a separate
 * Letta-specific service that the provider's implementation calls.
 */
export interface RuntimeProvider {
  /** Provider identifier (e.g. "letta-code-subagent", "letta-pm-agent", "acp"). */
  readonly kind: string;

  /**
   * Bring a session into existence. Implementations may pool / reuse
   * sessions internally; from the caller's perspective each `start`
   * returns a usable handle.
   */
  start(spec: SessionSpec): Promise<SessionHandle>;

  /**
   * Tear down a session. Idempotent: calling on an already-stopped
   * handle is a no-op.
   */
  stop(handle: SessionHandle): Promise<void>;

  /**
   * Send the user's input as a content-block array. Returns when the
   * provider has accepted the prompt; the actual reply streams via
   * `observe`. Does NOT wait for turn completion.
   */
  prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult>;

  /**
   * Wake a session that may have gone idle. Many providers treat this as
   * a no-op; subprocess-based providers (ACP) use it to send a no-op
   * JSON-RPC ping.
   */
  nudge(handle: SessionHandle): Promise<void>;

  /**
   * Stream of SessionEvent emitted by this session. The iterable ends
   * naturally on `turn-done` or `stopped`; callers can also break out
   * of the for-await loop.
   *
   * Implementations should be ok with multiple concurrent observers
   * (the daemon may have its own subscriber + a TUI surface tailing).
   */
  observe(handle: SessionHandle): AsyncIterable<SessionEvent>;
}
