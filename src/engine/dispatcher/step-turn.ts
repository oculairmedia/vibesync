import type { MoleculeWalker, StepSpec } from '../molecule/index.js';
import { STEP_OUTCOME_INSTRUCTIONS } from './step-outcome.js';
import { PROJECT_MEMORY_READ_FAILED_EVENT, renderProjectMemory, type ProjectMemorySource } from './project-memory.js';
import { renderContext, renderTemplate } from './render.js';
import {
  classifyFailure,
  decideRetry,
  readFailureClass,
  readRetryState,
  readReviewRound,
  resolveRetryPolicy,
  type RetryDecision,
  type ResolvedRetryPolicy,
  type RetryState,
} from '../retry/index.js';
import {
  AttemptFailure,
  FormulaDispatchError,
  FormulaEscalationError,
  StepBlockedError,
  type StepAttemptOutput,
  type StepFailureContext,
  type StepRunArgs,
  type StepRunContext,
  type StepRunFailure,
} from './types.js';
import { StepAttemptRunner } from './step-attempt.js';
import { StepVerdictReader } from './step-verdict.js';
import { readStepName, sleep, softFailMarker, stringifyError } from './util.js';

export interface StepTurnDeps {
  readonly walker: MoleculeWalker;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly stepAttempt: StepAttemptRunner;
  readonly stepVerdict: StepVerdictReader;
  readonly projectMemory: ProjectMemorySource | null;
}

export class StepTurnRunner {
  constructor(private readonly deps: StepTurnDeps) {}

  async runStep(args: StepRunArgs): Promise<void> {
    const context = this.prepareStepRun(args);
    const { stepName, stepSpec } = context;
    // ONE try per call (vibesync-ynmp). Where the step is in its retry policy is
    // read from the BEAD, never from this process: a failed try reopens the step
    // with new counters and the bead graph offers it again, so a restart between
    // tries resumes at the right attempt.
    const policy = resolveRetryPolicy(stepSpec);
    const state = readRetryState(args.step.metadata);
    const attemptStartedAt = new Date();
    await this.deps.walker.recordStepAttempt(args.step.id, state.attempt);
    const rendered = await this.renderStepPrompt(args, stepSpec, stepName, state.attempt);

    const turn = await this.runStepTurn(context, rendered, state);
    let failure = turn.failure;

    if (turn.output !== null) {
      const judged = await this.judgeStepTurn(context, turn.output, attemptStartedAt, state.attempt);
      if (judged === 'finished' || judged === 'looped') return;
      failure = judged;
    }
    if (failure === null) {
      // Unreachable: the turn either threw (failure set in catch) or completed
      // (success returned above, or a declared failure_class set it).
      throw new Error(`step ${args.step.id}: attempt ended with neither an output nor a failure`);
    }

    await this.settleStepFailure(context, policy, state, failure);
  }

  private async runStepTurn(
    context: StepRunContext,
    rendered: string,
    state: RetryState,
  ): Promise<{ readonly output: Awaited<ReturnType<StepAttemptRunner['runStepAttempt']>> | null; readonly failure: StepRunFailure | null }> {
    const { args, stepName, stepSpec, roleConfig } = context;
    // Only the AGENT TURN is retryable; bead persistence after it stays outside this try.
    try {
      const output = await this.deps.stepAttempt.runStepAttempt({
        stepId: args.step.id,
        stepName,
        role: stepSpec.role,
        roleConfig,
        moleculeId: args.moleculeId,
        formulaName: args.input.formula.name,
        ...(args.input.motivatingBeadId ? { motivatingBeadId: args.input.motivatingBeadId } : {}),
        rendered,
        attempt: state.attempt,
        infraRetries: state.infraRetries,
        reviewRound: readReviewRound(args.step.metadata),
        provider: args.provider,
        ...(args.input.projectIdentifier ? { projectIdentifier: args.input.projectIdentifier } : {}),
        ...((stepSpec.turnTimeoutMs ?? args.input.stepTimeoutMs) !== undefined
          ? { turnTimeoutMs: stepSpec.turnTimeoutMs ?? args.input.stepTimeoutMs }
          : {}),
        ...(args.input.workdir !== undefined ? { workdir: args.input.workdir } : {}),
      });
      return { output, failure: null };
    } catch (error) {
      const bead = await this.deps.walker.readStep(args.step.id).catch(() => null);
      return {
        output: null,
        failure: {
          signal: error instanceof AttemptFailure ? error.signal : { origin: 'call' },
          error,
          failureClass: bead ? readFailureClass(bead.metadata) : null,
        },
      };
    }
  }

  private prepareStepRun(args: StepRunArgs): StepRunContext {
    const stepName = readStepName(args.step);
    const stepSpec = args.input.formula.steps.find((candidate) => candidate.name === stepName);
    if (!stepSpec) {
      throw new FormulaDispatchError(`FormulaDispatcher: no formula step for molecule bead ${args.step.id}`, args.moleculeId);
    }
    const roleConfig = args.rolesByName.get(stepSpec.role);
    if (!roleConfig) {
      throw new FormulaDispatchError(`FormulaDispatcher: pack ${args.input.pack.manifest.name} has no role "${stepSpec.role}"`, args.moleculeId);
    }
    if (!stepSpec.promptTemplate) {
      throw new FormulaDispatchError(`FormulaDispatcher: step "${stepName}" has no promptTemplate`, args.moleculeId);
    }
    return { args, stepSpec, stepName, roleConfig };
  }

  private async renderStepPrompt(
    args: StepRunArgs,
    stepSpec: StepSpec,
    stepName: string,
    attempt: number,
  ): Promise<string> {
    const template = stepSpec.promptTemplate;
    if (!template) throw new Error(`step "${stepName}" has no promptTemplate`);
    return renderTemplate({
      packRoot: args.input.pack.root,
      template,
      context: {
        ...renderContext(args.input.input, args.outputs, args.input.formula.steps),
        step_id: args.step.id,
        attempt,
      },
    }) + (this.deps.projectMemory ? renderProjectMemory(await this.readProjectMemory(args.input.projectIdentifier, { moleculeId: args.moleculeId, stepId: args.step.id, stepName })) : '') + STEP_OUTCOME_INSTRUCTIONS;
  }

  /**
   * Memory improves a step and must never stop one. A read failure runs the
   * step without memory and is reported, so broken memory is visible rather
   * than silently missing from every prompt.
   */
  private async readProjectMemory(
    projectIdentifier: string | undefined,
    context: { readonly moleculeId: string; readonly stepId: string; readonly stepName: string },
  ): Promise<ReadonlyMap<string, string>> {
    try {
      return await this.deps.projectMemory!.read(projectIdentifier);
    } catch (error) {
      this.deps.emit(PROJECT_MEMORY_READ_FAILED_EVENT, context.moleculeId, context.stepId, {
        projectIdentifier: projectIdentifier ?? null,
        stepName: context.stepName,
        error: stringifyError(error),
      });
      return new Map();
    }
  }


  private async judgeStepTurn(
    context: StepRunContext,
    output: StepAttemptOutput,
    attemptStartedAt: Date,
    attempt: number,
  ): Promise<'finished' | 'looped' | StepRunFailure> {
    const verdict = await this.handleStepVerdict(context, output, attemptStartedAt);
    if (verdict !== null) return verdict;
    return this.finishStepTurn(context, output, attempt);
  }

  private async handleStepVerdict(
    context: StepRunContext,
    output: StepAttemptOutput,
    attemptStartedAt: Date,
  ): Promise<'looped' | StepRunFailure | null> {
    const { args, stepSpec, stepName } = context;
    const bead = await this.deps.walker.readStep(args.step.id);
    const declared = bead ? readFailureClass(bead.metadata) : null;
    const blocker = await this.deps.stepVerdict.readStepBlocker({ ...args, stepSpec, stepName, output: output.text, outputs: args.outputs });
    const overstepped = blocker === null && declared === null && stepSpec.planOnly
      ? await this.deps.stepVerdict.planOnlyViolation(args.input.motivatingBeadId, attemptStartedAt, planOnlyContext(args))
      : null;
    const overstepFailure = this.overstepVerdict(overstepped);
    if (overstepFailure !== null) return overstepFailure;
    const blockerVerdict = await this.blockerVerdict(context, blocker, output.text);
    if (blockerVerdict !== null) return blockerVerdict;
    const declaredFailure = this.declaredFailureVerdict(declared);
    if (declaredFailure !== null) return declaredFailure;
    return null;
  }

  private overstepVerdict(overstepped: string | null): StepRunFailure | null {
    return overstepped === null
      ? null
      : { signal: { origin: 'stopped' }, error: new StepBlockedError(overstepped), failureClass: null };
  }

  private async blockerVerdict(
    context: StepRunContext,
    blocker: string | null,
    output: string,
  ): Promise<'looped' | StepRunFailure | null> {
    if (blocker === null) return null;
    const { args, stepSpec, stepName } = context;
    const looped = stepSpec.loopsBackTo
      ? await this.deps.stepVerdict.loopBack({ ...args, stepSpec, stepName, blocker, output })
      : 'no-loop';
    if (looped === 'reopened') return 'looped';
    return {
      signal: { origin: 'stopped' },
      error: new StepBlockedError(looped === 'exhausted' ? `${blocker} (review loop exhausted after ${stepSpec.maxRounds ?? 3} rounds; escalated)` : blocker),
      failureClass: null,
    };
  }

  private declaredFailureVerdict(declared: string | null): StepRunFailure | null {
    return declared === null
      ? null
      : {
        signal: { origin: 'event', code: 'failure_class', producedOutput: true },
        error: new Error(`step declared failure_class=${declared}`),
        failureClass: declared,
      };
  }

  private async finishStepTurn(
    context: StepRunContext,
    output: StepAttemptOutput,
    attempt: number,
  ): Promise<'finished'> {
    const { args, stepSpec, stepName } = context;
    args.outputs[stepName] = output.text;
    await this.deps.walker.finishStep(args.step.id, { output: output.text, eventCount: output.eventCount, attempts: attempt });
    this.deps.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
      stepName,
      role: stepSpec.role,
      stepId: args.step.id,
      outputLength: output.text.length,
      attempts: attempt,
    });
    return 'finished';
  }

  private async settleStepFailure(
    context: StepRunContext,
    policy: ResolvedRetryPolicy,
    state: RetryState,
    failure: StepRunFailure,
  ): Promise<void> {
    // A failure_class means the agent ran and declared it; cancel/stop still wins.
    const classified = classifyFailure(failure.signal);
    const kind = failure.failureClass !== null && classified !== 'terminal' ? 'agent' : classified;
    const decision = decideRetry({ policy, state, kind });
    const failureContext: StepFailureContext = {
      stepRun: context,
      policy,
      state,
      failure,
      kind,
      reason: stringifyError(failure.error),
    };
    if (decision.action === 'retry') {
      await this.retryStepFailure(failureContext, decision);
      return;
    }
    await this.finishStepFailure(failureContext, decision);
  }

  private async finishStepFailure(
    failureContext: StepFailureContext,
    decision: Exclude<RetryDecision, { readonly action: 'retry' }>,
  ): Promise<void> {
    const { stepRun: context, state, failure } = failureContext;
    const { args, stepSpec, stepName } = context;
    const { trace, outcomeLabel } = this.stepFailureTrace(failureContext, decision);
    await this.deps.walker.failStep(args.step.id, trace, outcomeLabel);
    this.deps.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
      stepName, role: stepSpec.role, stepId: args.step.id, error: trace, attempts: state.attempt,
      retryOutcome: outcomeLabel,
      ...(decision.action === 'soft_fail' ? { softFail: true } : {}),
      ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
    });
    if (decision.action === 'soft_fail') {
      args.outputs[stepName] = softFailMarker(stepName, trace);
      return;
    }
    if (failure.error instanceof StepBlockedError) {
      throw new FormulaEscalationError(`FormulaDispatcher: step "${stepName}" escalated: ${failure.error.reason}`, args.moleculeId, { cause: failure.error });
    }
    throw new FormulaDispatchError(`FormulaDispatcher: step "${stepName}" failed`, args.moleculeId, { cause: failure.error });
  }

  private async retryStepFailure(
    failureContext: StepFailureContext,
    decision: Extract<RetryDecision, { readonly action: 'retry' }>,
  ): Promise<void> {
    const { stepRun: context, policy, state, failure, kind, reason } = failureContext;
    const { args, stepSpec, stepName } = context;
    await this.deps.walker.reopenStepForRetry(args.step.id, {
      attempt: decision.next.attempt,
      infraRetries: decision.next.infraRetries,
      failureClass: failure.failureClass,
      errorTrace: reason,
    });
    this.deps.emit('dispatcher/step.retry', args.moleculeId, args.step.id, {
      stepName, role: stepSpec.role, stepId: args.step.id, attempt: state.attempt,
      nextAttempt: decision.next.attempt, maxAttempts: policy.maxAttempts, failureKind: kind,
      infraRetries: decision.next.infraRetries, backoffMs: decision.backoffMs, reason,
      ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
    });
    await sleep(decision.backoffMs);
  }

  private stepFailureTrace(
    failureContext: StepFailureContext,
    decision: Exclude<RetryDecision, { readonly action: 'retry' }>,
  ): { readonly trace: string; readonly outcomeLabel: string } {
    const { policy, state, failure, reason } = failureContext;
    const classSuffix = failure.failureClass ? ` (failure_class=${failure.failureClass})` : '';
    const trace = decision.outcome === 'exhausted'
      ? `retry exhausted after ${state.attempt} of ${policy.maxAttempts} attempts${classSuffix}: ${reason}`
      : decision.outcome === 'infra_exhausted'
        ? `infra failure persisted after ${state.infraRetries} retries: ${reason}`
        : reason;
    return { trace, outcomeLabel: decision.action === 'soft_fail' ? 'soft_failed' : decision.outcome };
  }

}

/** What the plan-only guard needs to know about the run: where its events go and whose repository to probe. */
function planOnlyContext(args: StepRunArgs): { readonly moleculeId: string; readonly stepId: string; readonly projectIdentifier?: string } {
  const projectIdentifier = args.input.projectIdentifier;
  return { moleculeId: args.moleculeId, stepId: args.step.id, ...(projectIdentifier ? { projectIdentifier } : {}) };
}
