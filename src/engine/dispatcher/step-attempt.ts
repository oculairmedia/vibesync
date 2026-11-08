import type { MoleculeWalker } from '../molecule/index.js';
import type { RuntimeProvider, SessionEvent, SessionHandle } from '../runtime/index.js';
import { AttemptFailure, type RuntimeSessionEventContext, type StepAttemptArgs, type StepAttemptOutput } from './types.js';

export interface StepAttemptDeps {
  readonly walker: MoleculeWalker;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly emitRuntimeSessionEvent: (event: SessionEvent, context: RuntimeSessionEventContext) => void;
}

export class StepAttemptRunner {
  constructor(private readonly deps: StepAttemptDeps) {}

  async runStepAttempt(args: StepAttemptArgs): Promise<StepAttemptOutput> {
    this.emitStepAttemptStarted(args);
    let handle: SessionHandle | null = null;
    try {
      handle = await this.startStepAttempt(args);
      const promptResult = await args.provider.prompt(handle, [{ type: 'text', text: args.rendered }]);
      const traceConversationId = promptResult.conversationId;
      await this.recordStepAttemptTask(args, handle, promptResult.taskId, traceConversationId);
      const observed = await this.observeStepAttempt(args, handle, promptResult.taskId, traceConversationId);
      return { text: observed.text, eventCount: observed.eventCount };
    } finally {
      if (handle) await args.provider.stop(handle);
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

  private async startStepAttempt(args: StepAttemptArgs): Promise<SessionHandle> {
    await this.deps.walker.startStep(args.stepId);
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
    for await (const event of args.provider.observe(handle)) {
      eventCount++;
      this.deps.emitRuntimeSessionEvent(event, buildStepAttemptEventPayload(args, handle, taskId, conversationId));
      if (event.kind === 'message-delta') {
        text += event.text;
      }
      agentActed = didAgentAct(event, agentActed);
      this.handleStepAttemptEvent(event, agentActed);
      if (event.kind === 'turn-done') break;
    }
    return { text, eventCount };
  }

  private handleStepAttemptEvent(event: SessionEvent, agentActed: boolean): void {
    if (event.kind === 'error') {
      throw new AttemptFailure(event.message, { origin: 'event', code: event.code, producedOutput: agentActed });
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
