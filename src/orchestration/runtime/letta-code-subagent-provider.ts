/**
 * LettaCodeSubagentProvider — SKELETON (vibesync-573).
 *
 * RuntimeProvider that spawns formula-step teammates as Letta Code
 * SUBAGENTS via the parent PM agent's Task tool, instead of separate
 * top-level Letta agents via letta-teams-sdk. Surfaced during the rig
 * smoke today: the letta-teams path leaks agents (vibesync-6zj) and
 * spawned teammates have no real tool execution. Subagents are the
 * native Letta Code primitive: defined via `.letta/agents/<role>.md`
 * files, launched through the Task tool, lifecycle owned by the
 * runtime — no parallel cleanup code needed.
 *
 * NOT YET IMPLEMENTED. This file documents the contract and pins the
 * RuntimeProvider interface so downstream wiring (vibesync-8hk) can
 * compile against it. Each method throws until the spawn mechanism is
 * decided and implemented.
 *
 * # Spawn mechanism
 *
 * Letta Code subagents launch via the parent agent's `Agent` tool
 * (a.k.a. Task in the docs). The tool is called BY the parent agent —
 * not from outside. Two paths to drive that from vibesync's
 * dispatcher:
 *
 *   (a) PUPPET (works today): post a system-marked message to
 *       `POST /v1/agents/{pmAgentId}/messages` instructing the PM to
 *       call Agent(subagent_type='reviewer', input='…') and return
 *       the subagent's final output. Collect the next assistant_message
 *       as the step result. Costs: one extra PM-turn per step;
 *       output goes through the PM's response (LLM may reformat).
 *
 *   (b) DIRECT (cleaner, needs a shim change): add an admin endpoint
 *       on the local-backend shim like
 *       `POST /v1/agents/{pmAgentId}/spawn-subagent` that invokes
 *       the Task pathway directly without going through PM
 *       inference. Output flows back as a TaskState that
 *       LettaCodeSubagentProvider polls via TaskOutput.
 *
 * Phase 1 picks (a); phase 2 swaps the impl to (b) once the shim
 * adds the endpoint. The provider's external contract doesn't change.
 *
 * # Subagent definitions
 *
 * Each role's behavior lives in `packs/gastown/.letta/agents/<role>.md`
 * (frontmatter: name, description, tools, model, memoryBlocks; body:
 * system prompt). These were created when the pivot was decided and
 * supersede the role.toml + prompts/<role>-system.md split for any
 * project using this provider.
 *
 * # SessionSpec.extra
 *
 *   parentAgentId  — required. The PM agent that will host the Task
 *                    tool call. Resolved by FormulaDispatcher from
 *                    the per-project agent state.
 *   subagentType   — optional. Defaults to spec.role. Names must match
 *                    a project- or globally-scoped `.letta/agents/<n>.md`
 *                    file.
 *   moleculeId     — optional; threaded into event bus payloads.
 *   stepName       — optional; same.
 *   timeoutMs      — optional; hard cap on TaskOutput polling.
 *
 * # Mapping the RuntimeProvider methods
 *
 *   start(spec)         → record the spec; lazily defer the actual
 *                          Task invocation until prompt() fires (so
 *                          the dispatcher can hand the rendered
 *                          template in as the subagent's input).
 *   prompt(handle, ...) → POST the puppet message to the PM (path a)
 *                          OR call the admin spawn endpoint (path b).
 *                          Capture the returned task_id.
 *   observe(handle)     → poll TaskOutput; yield session events as
 *                          the subagent makes progress; emit
 *                          turn-done on completion.
 *   stop(handle)        → TaskStop on the task_id. Subagent
 *                          lifecycle is owned by the runtime — no
 *                          manual agent deletion (the letta-teams
 *                          leak path doesn't apply here).
 *   nudge(handle)       → no-op (Task tool has its own scheduling).
 *
 * # Out of scope here
 *
 *   - The puppet-message instruction template (lives in the impl).
 *   - Provider selection logic (vibesync-8hk: per-project routing).
 *   - Migration of existing letta-teams PM agents (kept as legacy).
 *
 * Status: SKELETON. See vibesync-573 for the implementation issue.
 */

import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

export interface LettaCodeSubagentProviderOptions {
  /**
   * Base URL of the local-backend shim (e.g. http://localhost:8291).
   * Distinct from LETTA_BASE_URL — the legacy remote Letta lives at a
   * different host and uses the LettaTeamsProvider path.
   */
  readonly shimBaseUrl: string;
  /** Bearer token. Optional if the shim doesn't enforce auth. */
  readonly password?: string;
  /**
   * Hard timeout for TaskOutput polling. Default 5min — formula steps
   * can be long-running once subagents do real work.
   */
  readonly taskTimeoutMs?: number;
}

export class LettaCodeSubagentProvider implements RuntimeProvider {
  readonly kind = 'letta-code-subagent';
  // Fields kept private so the impl can attach them later without changing
  // the public surface.
  // @ts-expect-error — field reserved for the impl
  private readonly shimBaseUrl: string;
  // @ts-expect-error — field reserved for the impl
  private readonly password: string | undefined;
  // @ts-expect-error — field reserved for the impl
  private readonly taskTimeoutMs: number;

  constructor(opts: LettaCodeSubagentProviderOptions) {
    this.shimBaseUrl = opts.shimBaseUrl;
    this.password = opts.password;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 5 * 60 * 1000;
  }

  async start(_spec: SessionSpec): Promise<SessionHandle> {
    throw new Error('LettaCodeSubagentProvider.start: not implemented (vibesync-573)');
  }

  async stop(_handle: SessionHandle): Promise<void> {
    throw new Error('LettaCodeSubagentProvider.stop: not implemented (vibesync-573)');
  }

  async prompt(_handle: SessionHandle, _content: readonly ContentBlock[]): Promise<PromptResult> {
    throw new Error('LettaCodeSubagentProvider.prompt: not implemented (vibesync-573)');
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // Task tool has its own scheduling — no-op by design.
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *observe(_handle: SessionHandle): AsyncIterable<SessionEvent> {
    throw new Error('LettaCodeSubagentProvider.observe: not implemented (vibesync-573)');
  }
}
