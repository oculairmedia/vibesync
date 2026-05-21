/**
 * LettaTeamsProvider — wraps `letta-teams-sdk` behind the
 * RuntimeProvider seam.
 *
 * Brings the SDK's TeamsRuntime (daemon + teammates + tasks) into
 * VibeSync's orchestration plane as one provider implementation
 * alongside LettaPMAgentProvider.
 *
 * Provider-specific start-spec extra fields:
 *   - extra.moleculeId?: string — molecule the session belongs to.
 *     Used to scope the teammate name (see Naming below) and tagged
 *     onto every event emitted to the orchestration EventBus.
 *   - extra.target?: string — explicit target name; overrides both
 *     `role` and the moleculeId-derived default. Use this only when a
 *     caller needs to attach to a pre-existing teammate by name.
 *   - extra.model?: string — LLM model handle.
 *   - extra.contextWindowLimit?: number — context window override.
 *   - extra.spawnPrompt?: string — rich init prompt.
 *   - extra.memfsEnabled?: boolean — memfs lifecycle (default false).
 *   - extra.memfsStartup?: 'blocking' | 'background' | 'skip' — memfs
 *     startup mode. Default teams' built-in (currently 'background').
 *     Pass 'blocking' for tests / roles that must have the memfs ready
 *     before the first prompt; 'skip' to disable the startup sync.
 *   - extra.runTeamsInit?: boolean — opt back in to letta-teams' built-
 *     in init.js memory-block bootstrap. Default false. See "Memory
 *     blocks" below.
 *   - extra.resumeTaskId?: string — restore observation for a previously
 *     dispatched teams task after the VibeSync process restarts.
 *
 * memfs lifecycle (vibesync-6wn.6):
 *   letta-teams owns the memfs lifecycle inside the teammate's
 *   process — memfsEnabled and memfsStartup are honored at
 *   `runtime.teammates.spawn`, and `runtime.teammates.remove` (called
 *   from this provider's stop()) tears the memfs down with the
 *   teammate. From the orchestration plane's perspective there is no
 *   separate "create memfs" / "destroy memfs" step; this provider
 *   forwards the two knobs and lets teams do the rest. Memfs state
 *   (memfsMemoryDir, memfsLastSyncedAt, etc.) is visible on
 *   TeammateState for callers that need to inspect it.
 *
 * Memory blocks (vibesync-6wn.3):
 *   letta-teams-sdk ships init.js, which writes opinionated memory-
 *   block prompts ("you are running inside letta-teams …") onto a new
 *   teammate. For Gastown, role packs (`packs/<name>/roles/*.toml`)
 *   are the source of truth for memory block content per role. We do
 *   not want teams' init to plant prompts we would then have to dig
 *   out, so this provider passes `skipInit: true` on spawn by default.
 *   Callers who specifically want teams' init can opt back in via
 *   `extra.runTeamsInit = true`. Seeding memory blocks from role TOML
 *   onto the spawned teammate's Letta agent is a follow-up
 *   (vibesync-6wn.3a).
 *
 * Naming (vibesync-6wn.4):
 *   letta-teams' teammate namespace is flat and global per daemon.
 *   To keep concurrent molecules from colliding on the same role
 *   teammate, the provider derives the target as:
 *
 *     extra.target ?? (extra.moleculeId ? `${moleculeId}-${role}` : role)
 *
 *   Two molecules running a "reviewer" role get distinct teammates
 *   (`mol-1-reviewer` vs `mol-2-reviewer`); stop() on one does not
 *   affect the other. Calls without a moleculeId fall back to the
 *   bare role name — backwards-compatible with the early skeleton
 *   tests and with any caller that has not yet adopted molecules.
 *
 * Discipline:
 *   - This file is in src/orchestration/runtime/; allowed to import the
 *     third-party SDK. Other layers MUST NOT import letta-teams-sdk
 *     directly; they go through this provider.
 *   - Daemon lifecycle: call ensureDaemonRunning() before first use.
 *     Idempotent; safe to call from multiple sites.
 *
 * Status: IN PROGRESS. start/stop/prompt wired against the SDK;
 * observe() now polls runtime.tasks.get to translate TaskState
 * transitions and tool-call frames into SessionEvent. Event-bus
 * publish is the next hop (vibesync-6wn.7).
 *
 * See vibesync-y0z, vibesync-6wn (epic), vibesync-6wn.2 (this journey).
 */

import type { EventBus, EventInput } from '../events/bus.js';
import type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

// Type-only imports — keep the SDK out of the runtime require graph
// until first construction.
type TeamsRuntime = import('letta-teams-sdk').TeamsRuntime;
type SpawnTeammateInput = import('letta-teams-sdk').SpawnTeammateInput;
type TeammateState = import('letta-teams-sdk').TeammateState;
type MemfsStartup = import('letta-teams-sdk').MemfsStartup;
type TaskState = import('letta-teams-sdk').TaskState;
type TaskStatus = import('letta-teams-sdk').TaskStatus;
type ToolCallEvent = NonNullable<TaskState['toolCalls']>[number];

const MEMFS_STARTUP_VALUES = new Set<MemfsStartup>(['blocking', 'background', 'skip']);

/** Shape of one memory block carried through SessionSpec.extra. */
export interface MemoryBlockInput {
  readonly label: string;
  readonly value: string;
  readonly limit?: number;
}

export type MemoryBlockSeedMode = 'augment' | 'replace';

export interface MemoryBlockSeedOptions {
  readonly mode?: MemoryBlockSeedMode;
}

/**
 * Adapter the provider calls to write a role pack's memory blocks
 * onto the Letta agent backing a spawned teammate. Implementations
 * live next to the SDK they wrap (e.g. src/letta/) so the
 * orchestration plane never imports @letta-ai/letta-client directly.
 *
 * Contract: idempotent upsert. Calling with the same blocks twice
 * must be a no-op on the second call (the seeder is responsible for
 * diffing). Throwing surfaces as a session start failure.
 */
export interface MemoryBlockSeeder {
  seed(agentId: string, blocks: readonly MemoryBlockInput[], opts?: MemoryBlockSeedOptions): Promise<void>;
}

/**
 * Adapter the provider calls during stop() to actually delete the
 * spawned Letta agent (vibesync-6zj). letta-teams-sdk's
 * `teammates.remove(name)` only deletes a local JSON file in the
 * daemon's project dir — it does NOT touch the underlying Letta agent.
 * Without this hook the underlying agents accumulate forever.
 *
 * Implementations live in src/letta/ so the orchestration plane never
 * imports @letta-ai/letta-client directly. Contract: idempotent;
 * tolerate "already gone" (HTTP 404 / not-found) silently; surface
 * other failures so the provider can log them.
 */
export interface TeammateDeleter {
  delete(agentId: string): Promise<void>;
}

/**
 * Outcome of a single per-tool attach attempt. Status values:
 *
 *   attached         — the tool was just attached to the agent
 *   already_attached — the agent already had the tool (idempotent no-op)
 *   unknown          — the attacher does not know how to handle that tool
 *                       name (typically a built-in or pre-attached tool that
 *                       the provider does not need to wire — surfaces as a
 *                       warning event but is not an error)
 *   error            — attach failed; details in `error`
 *
 * Implementations never throw — failures are reported via status='error'
 * so the start() path stays resilient across a partially-wired tool registry.
 */
export interface ToolAttachResult {
  readonly status: 'attached' | 'already_attached' | 'unknown' | 'error';
  readonly error?: string;
}

/**
 * Adapter the provider calls once per name in `extra.tools` after a
 * teammate spawns. Implementations live next to the SDKs they wrap
 * (e.g. src/letta/) so the orchestration plane never imports the
 * Letta client directly. See vibesync-cs2.
 *
 * Contract: idempotent; unknown tool names return status='unknown'
 * instead of throwing.
 */
export interface ToolAttacher {
  attach(agentId: string, toolName: string): Promise<ToolAttachResult>;
}

interface LettaTeamsSessionHandle extends SessionHandle {
  readonly providerKind: 'letta-teams';
  /** Teammate name in letta-teams-sdk (also the dispatch target). */
  readonly target: string;
}

/** Per-session bookkeeping needed to stream events for the latest turn. */
interface SessionState {
  /** ID of the most recent task dispatched via prompt(). */
  activeTaskId: string | null;
  /** Tripped by stop(); observe() exits with a `stopped` event. */
  stopped: boolean;
  /** Optional molecule id sourced from SessionSpec.extra at start time. */
  moleculeId?: string;
  /**
   * Letta agent id behind the spawned teammate. Captured at spawn time
   * because the daemon's `removeTeammate` only unlinks the local
   * teammate file — we need to call DELETE /v1/agents/<agentId>
   * directly during stop() to actually free the agent (vibesync-6zj).
   */
  agentId?: string;
}

export interface LettaTeamsProviderOptions {
  /** Poll cadence for runtime.tasks.get inside observe(). Default 250ms. */
  readonly pollIntervalMs?: number;
  /**
   * Max time observe() will wait for the first dispatched task on a
   * fresh handle before yielding a `stopped` event. Default 30s.
   * Set lower in tests via the constructor.
   */
  readonly initialTaskTimeoutMs?: number;
  /** Injectable sleep — tests pass a fake to avoid real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Optional orchestration EventBus. When provided, every SessionEvent
   * yielded from observe() also publishes onto the bus as a
   * `runtime/session.<kind>` event tagged with the teammate target and
   * the active task id. Omitted in unit tests; supplied at production
   * wiring time so other layers (HealthPatrol, dispatcher, TUI) can
   * subscribe instead of polling.
   */
  readonly eventBus?: EventBus;
  /**
   * Optional adapter that writes a role pack's memory blocks onto the
   * spawned teammate's Letta agent after spawn. Required when callers
   * pass SessionSpec.extra.memoryBlocks; ignored when they don't.
   * Implementations live in src/letta/ so the orchestration plane
   * never imports @letta-ai/letta-client directly.
   */
  readonly memoryBlockSeeder?: MemoryBlockSeeder;
  /**
   * Optional adapter that resolves each name in `extra.tools` to an
   * attach call against the spawned teammate's Letta agent. When the
   * caller passes tools but no attacher is wired, the provider emits a
   * single `runtime/teammate.tool_attach.skipped` event with reason
   * 'no_attacher' and continues — declared tools are advisory, not a
   * hard precondition for start(). See vibesync-cs2.
   */
  readonly toolAttacher?: ToolAttacher;
  /**
   * Optional adapter that actually deletes the Letta agent during
   * stop() (vibesync-6zj). letta-teams-sdk's teammates.remove only
   * unlinks a local JSON file — without this hook every formula run
   * leaks one Letta agent per role. Missing deleter is logged once but
   * does not throw; old agents continue to accumulate until the deleter
   * is wired.
   */
  readonly teammateDeleter?: TeammateDeleter;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_INITIAL_TASK_TIMEOUT_MS = 30_000;

export class LettaTeamsProvider implements RuntimeProvider {
  readonly kind = 'letta-teams';
  private runtime: TeamsRuntime | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pollIntervalMs: number;
  private readonly initialTaskTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly eventBus: EventBus | null;
  private readonly memoryBlockSeeder: MemoryBlockSeeder | null;
  private readonly toolAttacher: ToolAttacher | null;
  private readonly teammateDeleter: TeammateDeleter | null;
  private warnedAboutMissingDeleter = false;

  constructor(opts: LettaTeamsProviderOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.initialTaskTimeoutMs = opts.initialTaskTimeoutMs ?? DEFAULT_INITIAL_TASK_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.eventBus = opts.eventBus ?? null;
    this.memoryBlockSeeder = opts.memoryBlockSeeder ?? null;
    this.toolAttacher = opts.toolAttacher ?? null;
    this.teammateDeleter = opts.teammateDeleter ?? null;
  }

  /**
   * Lazily create the TeamsRuntime singleton. The SDK exposes a
   * shared `getTeamsRuntime()` accessor as well, but we own ours so
   * tests can inject.
   */
  private async getRuntime(): Promise<TeamsRuntime> {
    if (this.runtime) return this.runtime;
    const sdk = await import('letta-teams-sdk');
    this.runtime = sdk.createTeamsRuntime();
    return this.runtime;
  }

  /**
   * Ensure the SDK daemon is running. Call once on application startup
   * (or lazily on first session start; this method is idempotent).
   */
  async ensureDaemonRunning(): Promise<void> {
    const runtime = await this.getRuntime();
    await runtime.daemon.ensureRunning();
  }

  /**
   * Build a HealthPatrol-shaped supervisor for the teams daemon. Returns
   * a small adapter that delegates to runtime.daemon.{isRunning,
   * ensureRunning, stop}; the patrol does the restart-on-stall, backoff,
   * and circuit-break work. Wire on application startup:
   *
   *     patrol.trackDaemon(provider.daemonSupervisor());
   */
  daemonSupervisor(): {
    readonly id: string;
    readonly providerKind: string;
    isRunning(): Promise<boolean>;
    ensureRunning(): Promise<void>;
    stop(): Promise<unknown>;
  } {
    return {
      id: 'letta-teams-daemon',
      providerKind: this.kind,
      isRunning: async () => {
        const runtime = await this.getRuntime();
        return runtime.daemon.isRunning();
      },
      ensureRunning: async () => {
        const runtime = await this.getRuntime();
        await runtime.daemon.ensureRunning();
      },
      stop: async () => {
        const runtime = await this.getRuntime();
        return runtime.daemon.stop();
      },
    };
  }

  async start(spec: SessionSpec): Promise<SessionHandle> {
    const runtime = await this.getRuntime();
    await runtime.daemon.ensureRunning();
    const target = resolveTeammateTarget(spec);
    const exists = await runtime.teammates.exists(target);
    let teammate: TeammateState | null = null;
    if (!exists) {
      const runTeamsInit = readBoolExtra(spec, 'runTeamsInit') === true;
      const input: SpawnTeammateInput = {
        name: target,
        role: spec.role,
        // Layering invariant: role packs own memory block content.
        // Skip teams' built-in init.js unless the caller has explicitly
        // opted in. See "Memory blocks" in the header comment.
        skipInit: !runTeamsInit,
        ...(readStringExtra(spec, 'model') !== undefined ? { model: readStringExtra(spec, 'model')! } : {}),
        ...(readNumberExtra(spec, 'contextWindowLimit') !== undefined
          ? { contextWindowLimit: readNumberExtra(spec, 'contextWindowLimit')! }
          : {}),
        ...(readStringExtra(spec, 'spawnPrompt') !== undefined
          ? { spawnPrompt: readStringExtra(spec, 'spawnPrompt')! }
          : {}),
        ...(readBoolExtra(spec, 'memfsEnabled') !== undefined
          ? { memfsEnabled: readBoolExtra(spec, 'memfsEnabled')! }
          : {}),
        ...(readMemfsStartup(spec) !== undefined
          ? { memfsStartup: readMemfsStartup(spec)! }
          : {}),
      };
      teammate = await runtime.teammates.spawn(input);
    } else {
      teammate = await runtime.teammates.get(target);
    }

    // Seed role-pack memory blocks onto the teammate's Letta agent.
    // Idempotent upsert — calling start() twice with the same blocks
    // is a no-op on the second pass (the seeder diffs internally).
    const memoryBlocks = readMemoryBlocks(spec);
    const memoryBlockMode = readMemoryBlockSeedMode(spec);
    if (memoryBlocks.length > 0 || memoryBlockMode === 'replace') {
      if (!this.memoryBlockSeeder) {
        throw new Error(
          'LettaTeamsProvider: SessionSpec.extra.memoryBlocks supplied but no memoryBlockSeeder was injected. Wire one at construction time.',
        );
      }
      if (!teammate?.agentId) {
        throw new Error(
          `LettaTeamsProvider: cannot seed memory blocks — teammate ${target} has no agentId (teams returned ${teammate ? 'a teammate without an agentId' : 'null'})`,
        );
      }
      if (memoryBlockMode === 'replace') {
        await this.memoryBlockSeeder.seed(teammate.agentId, memoryBlocks, { mode: 'replace' });
      } else {
        await this.memoryBlockSeeder.seed(teammate.agentId, memoryBlocks);
      }
    }

    const moleculeId = readStringExtra(spec, 'moleculeId');

    // Attach role-declared tools onto the teammate's Letta agent
    // (vibesync-cs2). Failures are advisory — we emit per-tool events
    // and continue rather than failing the whole session start, since
    // an unknown tool typically means the provider does not need to wire
    // it (it is already attached or supplied by the daemon).
    const toolNames = readToolNames(spec);
    if (toolNames.length > 0) {
      await this.attachRoleTools({
        target,
        agentId: teammate?.agentId,
        ...(moleculeId !== undefined ? { moleculeId } : {}),
        toolNames,
      });
    }

    const handle: LettaTeamsSessionHandle = {
      id: `letta-teams:${target}`,
      providerKind: 'letta-teams',
      target,
    };
    const resumeTaskId = readStringExtra(spec, 'resumeTaskId');
    const session: SessionState = { activeTaskId: resumeTaskId ?? null, stopped: false };
    if (teammate?.agentId) session.agentId = teammate.agentId;
    if (moleculeId !== undefined) session.moleculeId = moleculeId;
    this.sessions.set(handle.id, session);
    return handle;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const h = expectHandle(handle);
    const runtime = await this.getRuntime();
    const session = this.sessions.get(h.id);
    if (session) session.stopped = true;

    // letta-teams-sdk's removeTeammate(name) only unlinks the daemon's
    // local teammate JSON file — it does NOT touch the underlying Letta
    // agent (verified at node_modules/letta-teams-sdk/dist/store/teammate.js).
    // Without an explicit DELETE on the agent id, every spawn leaks one
    // agent per role (vibesync-6zj). Call the SDK first (so the
    // daemon's local view stays consistent), then delete the Letta
    // agent via the injected deleter.
    await runtime.teammates.remove(h.target);

    if (session?.agentId) {
      if (!this.teammateDeleter) {
        if (!this.warnedAboutMissingDeleter) {
          // eslint-disable-next-line no-console
          console.warn(
            'LettaTeamsProvider: teammateDeleter not wired — spawned Letta agents will leak (one per role per molecule). See vibesync-6zj.',
          );
          this.warnedAboutMissingDeleter = true;
        }
      } else {
        try {
          await this.teammateDeleter.delete(session.agentId);
        } catch (err) {
          // Deleter contract: tolerate "already gone" silently. Anything
          // that reaches here is a real failure we want visibility on,
          // but it's not fatal to the dispatcher's finally-block.
          // eslint-disable-next-line no-console
          console.warn(
            `LettaTeamsProvider: teammateDeleter.delete(${session.agentId}) failed: ${(err as Error).message}`,
          );
        }
      }
    }
    this.sessions.delete(h.id);
  }

  async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
    const h = expectHandle(handle);
    const runtime = await this.getRuntime();
    const message = contentToText(content);
    const { taskId } = await runtime.tasks.dispatch({ target: h.target, message });
    const session = this.sessions.get(h.id) ?? { activeTaskId: null, stopped: false };
    session.activeTaskId = taskId;
    this.sessions.set(h.id, session);
    return { taskId };
  }

  async nudge(_handle: SessionHandle): Promise<void> {
    // letta-teams-sdk has no nudge verb; the daemon polls on its own.
  }

  /**
   * Stream SessionEvents derived from the most recently dispatched task
   * on this handle. Poll-based because letta-teams-sdk exposes no
   * progress callback — `runtime.tasks.get(id)` is the source of truth.
   *
   * Mapping:
   *   pending  → `started` (once, on first observation)
   *   running  → `first-token` (once, on the transition into running)
   *   toolCalls grown → emit `tool-call` then `tool-result` per new entry
   *   done     → `turn-done` (stopReason = 'done'), iterator ends
   *   error    → `error`, iterator ends
   *   stop()   → `stopped`, iterator ends
   *
   * The iterator ends naturally on a terminal task status or when stop()
   * trips the session flag. Callers can also break out of the for-await.
   */
  async *observe(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const h = expectHandle(handle);
    const runtime = await this.getRuntime();
    const session = this.sessions.get(h.id);
    if (!session) {
      // Handle never went through start() on this provider instance.
      const ev: SessionEvent = { kind: 'error', ts: nowIso(), code: 'unknown_session', message: `No session for ${h.id}` };
      this.publish(h, session, ev);
      yield ev;
      return;
    }

    // Wait for an active task. prompt() may not have been called yet on
    // a freshly started handle; bail with `stopped` if we time out or
    // stop() trips first.
    const taskWaitStart = Date.now();
    while (!session.activeTaskId && !session.stopped) {
      if (Date.now() - taskWaitStart > this.initialTaskTimeoutMs) {
        const ev: SessionEvent = { kind: 'stopped', ts: nowIso() };
        this.publish(h, session, ev);
        yield ev;
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
    if (session.stopped) {
      const ev: SessionEvent = { kind: 'stopped', ts: nowIso() };
      this.publish(h, session, ev);
      yield ev;
      return;
    }
    const taskId = session.activeTaskId!;

    let lastStatus: TaskStatus | undefined;
    let lastToolCount = 0;
    let startedEmitted = false;
    let resultEmitted = false;

    while (true) {
      if (session.stopped) {
        const ev: SessionEvent = { kind: 'stopped', ts: nowIso() };
        this.publish(h, session, ev);
        yield ev;
        return;
      }

      const state = await runtime.tasks.get(taskId);
      if (!state) {
        const ev: SessionEvent = {
          kind: 'error',
          ts: nowIso(),
          code: 'task_vanished',
          message: `Task ${taskId} no longer present in runtime`,
        };
        this.publish(h, session, ev);
        yield ev;
        return;
      }

      if (!startedEmitted) {
        const ev: SessionEvent = { kind: 'started', ts: state.createdAt };
        this.publish(h, session, ev);
        yield ev;
        startedEmitted = true;
      }

      if (lastStatus !== 'running' && state.status === 'running') {
        const ev: SessionEvent = { kind: 'first-token', ts: state.startedAt ?? nowIso() };
        this.publish(h, session, ev);
        yield ev;
      }

      const toolCalls = state.toolCalls ?? [];
      for (let i = lastToolCount; i < toolCalls.length; i += 1) {
        for (const ev of toolCallEvents(toolCalls[i]!)) {
          this.publish(h, session, ev);
          yield ev;
        }
      }
      lastToolCount = toolCalls.length;

      if (state.status === 'done') {
        if (!resultEmitted && typeof state.result === 'string' && state.result.length > 0) {
          const resultEvent: SessionEvent = {
            kind: 'message-delta',
            ts: state.completedAt ?? nowIso(),
            text: state.result,
          };
          this.publish(h, session, resultEvent);
          yield resultEvent;
          resultEmitted = true;
        }
        const ev: SessionEvent = {
          kind: 'turn-done',
          ts: state.completedAt ?? nowIso(),
          stopReason: 'done',
        };
        this.publish(h, session, ev);
        yield ev;
        // Clear the active task so the next observe() waits for the
        // following prompt() rather than re-streaming this turn.
        session.activeTaskId = null;
        return;
      }
      if (state.status === 'error') {
        const ev: SessionEvent = {
          kind: 'error',
          ts: state.completedAt ?? nowIso(),
          code: 'task_error',
          message: state.error ?? 'task error',
        };
        this.publish(h, session, ev);
        yield ev;
        session.activeTaskId = null;
        return;
      }

      lastStatus = state.status;
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Resolve each name in `extra.tools` against the injected ToolAttacher
   * and emit one `runtime/teammate.tool_attach.<status>` event per name.
   * Never throws — attach failures and unknown names surface as bus
   * events so the session start path stays resilient (vibesync-cs2).
   *
   * Edge cases:
   *   - No attacher wired   → one `.skipped` event with reason='no_attacher'
   *                            tagged with the full tool list.
   *   - Teammate lacks agentId → one `.skipped` event with reason='no_agent_id'
   *                            tagged with the full tool list (cannot
   *                            address a Letta agent without an id).
   *   - Attacher throws     → reported as `.error` for that tool only;
   *                            the loop continues with the next name.
   */
  private async attachRoleTools(args: {
    readonly target: string;
    readonly agentId: string | undefined;
    readonly moleculeId?: string;
    readonly toolNames: readonly string[];
  }): Promise<void> {
    if (!this.toolAttacher) {
      this.emitToolAttachEvent({
        target: args.target,
        ...(args.moleculeId !== undefined ? { moleculeId: args.moleculeId } : {}),
        kind: 'runtime/teammate.tool_attach.skipped',
        payload: { reason: 'no_attacher', tools: [...args.toolNames] },
      });
      return;
    }
    if (!args.agentId) {
      this.emitToolAttachEvent({
        target: args.target,
        ...(args.moleculeId !== undefined ? { moleculeId: args.moleculeId } : {}),
        kind: 'runtime/teammate.tool_attach.skipped',
        payload: { reason: 'no_agent_id', tools: [...args.toolNames] },
      });
      return;
    }
    const agentId = args.agentId;
    for (const toolName of args.toolNames) {
      let result: ToolAttachResult;
      try {
        result = await this.toolAttacher.attach(agentId, toolName);
      } catch (err) {
        result = { status: 'error', error: (err as Error).message ?? String(err) };
      }
      this.emitToolAttachEvent({
        target: args.target,
        ...(args.moleculeId !== undefined ? { moleculeId: args.moleculeId } : {}),
        kind: `runtime/teammate.tool_attach.${result.status}`,
        payload: {
          tool: toolName,
          agent_id: agentId,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });
    }
  }

  private emitToolAttachEvent(args: {
    readonly target: string;
    readonly moleculeId?: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }): void {
    if (!this.eventBus) return;
    const input: EventInput = {
      layer: 'runtime',
      kind: args.kind,
      teammate: args.target,
      ...(args.moleculeId ? { molecule_id: args.moleculeId } : {}),
      payload: args.payload,
    };
    this.eventBus.emit(input);
  }

  /**
   * Forward one SessionEvent to the orchestration EventBus, if one was
   * supplied at construction time. Tagged as `runtime/session.<kind>`
   * with the teammate target and the active task id; molecule_id is
   * carried over from SessionSpec.extra when present.
   *
   * No-op when no bus is wired (unit tests rely on this).
   */
  private publish(
    handle: LettaTeamsSessionHandle,
    session: SessionState | undefined,
    event: SessionEvent,
  ): void {
    if (!this.eventBus) return;
    const input: EventInput = {
      layer: 'runtime',
      kind: `runtime/session.${event.kind}`,
      teammate: handle.target,
      ...(session?.activeTaskId ? { task_id: session.activeTaskId } : {}),
      ...(session?.moleculeId ? { molecule_id: session.moleculeId } : {}),
      payload: sessionEventPayload(event),
    };
    this.eventBus.emit(input);
  }
}

/**
 * Strip the discriminant + ts from a SessionEvent so the remaining
 * fields ride as payload on the bus envelope. The envelope already
 * carries kind (via `runtime/session.<kind>`) and ts (auto-added by
 * EventBus.emit), so duplicating them in payload would be redundant.
 */
function sessionEventPayload(event: SessionEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'message-delta':
      return { text: event.text };
    case 'tool-call':
      return { tool: event.tool, args: event.args };
    case 'tool-result':
      return { tool: event.tool, result: event.result, ok: event.ok };
    case 'usage':
      return { prompt: event.prompt, completion: event.completion };
    case 'turn-done':
      return event.stopReason !== undefined ? { stopReason: event.stopReason } : {};
    case 'error':
      return { code: event.code, message: event.message };
    case 'started':
    case 'first-token':
    case 'stopped':
      return {};
    default:
      return {};
  }
}

function* toolCallEvents(tc: ToolCallEvent): Iterable<SessionEvent> {
  const ts = nowIso();
  yield { kind: 'tool-call', ts, tool: tc.name, args: tc.input ?? null };
  yield {
    kind: 'tool-result',
    ts,
    tool: tc.name,
    result: tc.success ? null : (tc.error ?? null),
    ok: tc.success,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick the teams teammate target name for a SessionSpec.
 *
 * Order:
 *   1. extra.target — explicit override; caller knows the exact target.
 *   2. `${moleculeId}-${role}` — default when running inside a molecule.
 *   3. role — bare fallback for sessions that do not belong to a molecule.
 *
 * Exported for unit-test introspection; production code goes through
 * LettaTeamsProvider.start.
 */
export function resolveTeammateTarget(spec: SessionSpec): string {
  const explicit = readStringExtra(spec, 'target');
  if (explicit) return explicit;
  const moleculeId = readStringExtra(spec, 'moleculeId');
  return moleculeId ? `${moleculeId}-${spec.role}` : spec.role;
}

function expectHandle(handle: SessionHandle): LettaTeamsSessionHandle {
  if (handle.providerKind !== 'letta-teams') {
    throw new Error(
      `LettaTeamsProvider: handle from wrong provider (got ${handle.providerKind}, want letta-teams)`,
    );
  }
  const existingTarget = 'target' in handle && typeof handle.target === 'string' ? handle.target : undefined;
  const parsedTarget = handle.id.startsWith('letta-teams:') ? handle.id.slice('letta-teams:'.length) : undefined;
  const target = existingTarget ?? parsedTarget;
  if (!target) {
    throw new Error(`LettaTeamsProvider: handle ${handle.id} is missing a teammate target`);
  }
  return { ...handle, providerKind: 'letta-teams', target };
}

function readStringExtra(spec: SessionSpec, key: string): string | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'string' ? v : undefined;
}
function readNumberExtra(spec: SessionSpec, key: string): number | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'number' ? v : undefined;
}
function readBoolExtra(spec: SessionSpec, key: string): boolean | undefined {
  const v = spec.extra?.[key];
  return typeof v === 'boolean' ? v : undefined;
}
function readMemfsStartup(spec: SessionSpec): MemfsStartup | undefined {
  const v = spec.extra?.['memfsStartup'];
  if (typeof v !== 'string') return undefined;
  return MEMFS_STARTUP_VALUES.has(v as MemfsStartup) ? (v as MemfsStartup) : undefined;
}

function readMemoryBlocks(spec: SessionSpec): MemoryBlockInput[] {
  const raw = spec.extra?.['memoryBlocks'];
  if (!Array.isArray(raw)) return [];
  const out: MemoryBlockInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r['label'] !== 'string' || (r['label'] as string).length === 0) continue;
    if (typeof r['value'] !== 'string') continue;
    const block: MemoryBlockInput = { label: r['label'] as string, value: r['value'] as string };
    if (typeof r['limit'] === 'number' && Number.isFinite(r['limit'] as number) && (r['limit'] as number) > 0) {
      out.push({ ...block, limit: r['limit'] as number });
    } else {
      out.push(block);
    }
  }
  return out;
}

function readMemoryBlockSeedMode(spec: SessionSpec): MemoryBlockSeedMode {
  return spec.extra?.['memoryBlockSeedMode'] === 'replace' ? 'replace' : 'augment';
}

/**
 * Pull the list of role tool names from SessionSpec.extra.tools. Returns
 * a deduplicated array of non-empty strings; ignores any non-string or
 * empty entry rather than throwing so a malformed role pack does not
 * kill session start.
 */
function readToolNames(spec: SessionSpec): string[] {
  const raw = spec.extra?.['tools'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * letta-teams-sdk's DispatchTaskInput.message is a string. Image
 * content blocks are not supported on this provider yet — they get
 * surfaced as a `[image: <media-type>]` placeholder in the text body
 * so the caller can spot the missing modality without crashing.
 */
function contentToText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType}]`);
  }
  return parts.join('\n');
}
