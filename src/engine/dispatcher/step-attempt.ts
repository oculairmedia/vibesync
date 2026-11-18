import { ATTEMPT_STOP_TIMEOUT_MS } from './util.js';
import type { MoleculeWalker } from '../molecule/index.js';
import type { RuntimeProvider, SessionEvent, SessionHandle } from '../runtime/index.js';
import { AttemptFailure, type RuntimeSessionEventContext, type StepAttemptArgs, type StepAttemptOutput } from './types.js';

export interface StepAttemptDeps {
  readonly walker: MoleculeWalker;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly emitRuntimeSessionEvent: (event: SessionEvent, context: RuntimeSessionEventContext) => void;
  /** Overrides ATTEMPT_STOP_TIMEOUT_MS (tests). */
  readonly stopTimeoutMs?: number;
}

/** The attempt never produced a reply: nothing to judge, nothing to write. */
const NOT_STARTED: StepAttemptOutput = { text: '', eventCount: 0, notStarted: true };

export class StepAttemptRunner {
  constructor(private readonly deps: StepAttemptDeps) {}

  async runStepAttempt(args: StepAttemptArgs): Promise<StepAttemptOutput> {
    this.emitStepAttemptStarted(args);
    let handle: SessionHandle | null = null;
    try {
      handle = await this.startStepAttempt(args);
      // Not started: the step was closed under it, or the run was cancelled meanwhile. NOT_STARTED, not an empty reply:
      // the turn writes nothing for it, whether or not THIS run was cancelled.
      if (handle === null) return NOT_STARTED;
      // The session id is recorded only after the prompt, so cancel() may not be able to name this session: once the
      // run is cancelled the attempt ends itself, and the finally below stops the session it holds (second outside
      // review of PR #188).
      if (args.cancelled?.()) return NOT_STARTED;
      const promptResult = await args.provider.prompt(handle, [{ type: 'text', text: args.rendered }]);
      if (args.cancelled?.()) return NOT_STARTED;
      const traceConversationId = promptResult.conversationId;
      await this.recordStepAttemptTask(args, handle, promptResult.taskId, traceConversationId);
      // That write took a while: a cancel claimed during it may have read the steps before the session id landed, so it
      // could not stop this session. Ask before observing: the observe loop only checks between events, and a silent
      // agent sends none (third outside review of PR #188).
      if (args.cancelled?.()) return NOT_STARTED;
      const observed = await this.observeStepAttempt(args, handle, promptResult.taskId, traceConversationId);
      return { text: observed.text, eventCount: observed.eventCount };
    } finally {
      if (handle) await this.stopBounded(args, handle);
    }
  }

  /**
   * Stop the session, but never wait longer than ATTEMPT_STOP_TIMEOUT_MS: the turn must be able to return (outside
   * review of PR #188). A stop that does not answer in time is reported, not waited on; one that fails is rethrown,
   * as before.
   */
  private async stopBounded(args: StepAttemptArgs, handle: SessionHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.deps.stopTimeoutMs ?? ATTEMPT_STOP_TIMEOUT_MS); });
    try {
      const outcome = await Promise.race([args.provider.stop(handle).then(() => 'stopped' as const), timedOut]);
      if (outcome === 'timeout') {
        this.deps.emit('dispatcher/step.stop_timeout', args.moleculeId, args.stepId, {
          stepName: args.stepName,
          stepId: args.stepId,
          sessionId: handle.id,
          waitedMs: this.deps.stopTimeoutMs ?? ATTEMPT_STOP_TIMEOUT_MS,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private emitStepAttemptStarted(args: StepAttemptArgs): void {
    this.deps.emit('dispatcher/step.started', args.moleculeId, args.stepId, {
      stepName: args.stepName,
      role: args.role,
      stepId: args.stepId,
      attempt: args.attempt,
    });
  }

  /** Null when the step was no longer open (the root close got there first): then no session is started. */
  private async startStepAttempt(args: StepAttemptArgs): Promise<SessionHandle | null> {
    // Not started when bd refused (the step is no longer open) or this run was cancelled during the write. Both halves
    // are needed: a cancel of this run sets `cancelled`, but another dispatcher on the same tracker (the restart path)
    // can close the step while this run is never marked cancelled, and then only bd's refusal stops the start.
    if (!(await this.deps.walker.startStep(args.stepId)) || args.cancelled?.()) return null;
    return args.provider.start(this.stepAttemptSessionSpec(args));
  }

  private stepAttemptSessionSpec(args: StepAttemptArgs): Parameters<RuntimeProvider['start']>[0] {
    return {
      role: args.role,
      label: `${args.formulaName}/${args.stepName}`,
      extra: this.stepAttemptExtra(args),
    };
  }

  private stepAttemptExtra(args: StepAttemptArgs): NonNullable<Parameters<RuntimeProvider['start']>[0]['extra']> {
    return {
      moleculeId: args.moleculeId,
      stepName: args.stepName,
      formulaName: args.formulaName,
      ...(args.motivatingBeadId ? { motivatingBeadId: args.motivatingBeadId } : {}),
      attempt: args.attempt,
      infraRetries: args.infraRetries,
      ...(args.reviewRound > 1 ? { reviewRound: args.reviewRound } : {}),
      stepId: args.stepId,
      memfsEnabled: false,
      memoryBlocks: args.roleConfig.memoryBlocks ?? [],
      ...(args.roleConfig.memoryBlocksPolicy?.mode === 'replace' ? { memoryBlockSeedMode: 'replace' } : {}),
      ...(args.roleConfig.tools && args.roleConfig.tools.length > 0 ? { tools: [...args.roleConfig.tools] } : {}),
      ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
      ...(args.turnTimeoutMs !== undefined ? { turnTimeoutMs: args.turnTimeoutMs } : {}),
      ...(args.workdir !== undefined ? { workdir: args.workdir } : {}),
    };
  }

  private async recordStepAttemptTask(
    args: StepAttemptArgs,
    handle: SessionHandle,
    taskId: string | undefined,
    conversationId: string | undefined,
  ): Promise<void> {
    if (!taskId && !conversationId) return;
    // A prompt can resolve after cancel() has recorded the step and closed the root: write nothing on it then.
    if (args.cancelled?.()) return;
    await this.deps.walker.recordStepTask(args.stepId, {
      ...(taskId ? { taskId } : {}),
      providerKind: handle.providerKind,
      sessionId: handle.id,
      ...(conversationId ? { conversationId } : {}),
    });
    this.deps.emit('dispatcher/step.task_recorded', args.moleculeId, taskId, {
      stepName: args.stepName,
      role: args.role,
      stepId: args.stepId,
      sessionId: handle.id,
      attempt: args.attempt,
      ...(conversationId ? { conversationId } : {}),
    });
  }

  private async observeStepAttempt(
    args: StepAttemptArgs,
    handle: SessionHandle,
    taskId: string | undefined,
    conversationId: string | undefined,
  ): Promise<StepAttemptOutput> {
    let text = '';
    let eventCount = 0;
    let agentActed = false;
    const it = args.provider.observe(handle)[Symbol.asyncIterator]();
    const signal = args.cancelSignal;
    try {
      while (true) {
        if (signal?.aborted || args.cancelled?.()) break;
        let removeListener: (() => void) | undefined;
        const cancelled = new Promise<null>((resolve) => {
          if (signal?.aborted) { resolve(null); return; }
          const onAbort = () => resolve(null);
          signal?.addEventListener('abort', onAbort, { once: true });
          removeListener = () => signal?.removeEventListener('abort', onAbort);
        });
        const next = it.next();
        let result: IteratorResult<SessionEvent> | null;
        try {
          result = await Promise.race([next, cancelled]);
        } finally {
          removeListener?.();
        }
        if (result === null) {
          void next.catch(() => undefined);
          break;
        }
        if (result.done) break;
        const event = result.value;
        eventCount++;
        this.deps.emitRuntimeSessionEvent(event, buildStepAttemptEventPayload(args, handle, taskId, conversationId));
        if (event.kind === 'message-delta') {
          text += event.text;
        }
        agentActed = didAgentAct(event, agentActed);
        this.handleStepAttemptEvent(event, agentActed);
        if (args.cancelled?.()) break;
        if (event.kind === 'turn-done') {
          void it.return?.().catch(() => undefined);
          break;
        }
      }
    } finally {
      // Stream exited or cancelled
    }
    return { text, eventCount };
  }

  private handleStepAttemptEvent(event: SessionEvent, agentActed: boolean): void {
    if (event.kind === 'error') {
      throw new AttemptFailure(event.message, { origin: 'event', code: event.code, producedOutput: agentActed }, event.code);
    }
    if (event.kind === 'stopped') {
      throw new AttemptFailure('runtime stopped before turn completion', { origin: 'stopped' });
    }
    if (event.kind === 'turn-done' && event.stopReason === 'requires_approval') {
      throw new AttemptFailure(
        'runtime halted on requires_approval — no approver attached for headless dispatch; ' +
          'the Agent/tool call never executed (set SHIM_PERMISSION_MODE=bypassPermissions on the shim)',
        { origin: 'event', code: 'requires_approval', producedOutput: agentActed },
      );
    }
  }
}

function didAgentAct(event: SessionEvent, agentActed: boolean): boolean {
  return agentActed || (event.kind === 'message-delta' && event.text.length > 0) ||
    event.kind === 'tool-call' || event.kind === 'tool-result';
}

function buildStepAttemptEventPayload(
  args: StepAttemptArgs,
  handle: SessionHandle,
  taskId: string | undefined,
  conversationId: string | undefined,
): RuntimeSessionEventContext {
  return {
    moleculeId: args.moleculeId,
    stepId: args.stepId,
    stepName: args.stepName,
    role: args.role,
    attempt: args.attempt,
    providerKind: handle.providerKind,
    sessionId: handle.id,
    ...(taskId ? { taskId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
  };
}
