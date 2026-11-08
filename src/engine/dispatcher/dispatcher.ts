import type { EventBus } from '../events/index.js';

import type { MoleculeWalker, StepSpec } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { RuntimeProvider, SessionEvent } from '../runtime/index.js';
import type { ReadyStep, ReadyStepRunner, StepRunOutcome } from '../molecule/index.js';
import { STEP_OUTCOME_INSTRUCTIONS } from './step-outcome.js';
import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { StepReplyJudge } from '../verdict/index.js';
import { PROJECT_MEMORY_READ_FAILED_EVENT, renderProjectMemory, type ProjectMemorySource } from './project-memory.js';
import { renderTemplate } from './render.js';
import {
  classifyFailure,
  decideRetry,
  readFailureClass,
  readRetryState, readReviewRound,
  resolveRetryPolicy,
  RETRY_OUTCOME_KEY,
  type RetryDecision,
  type ResolvedRetryPolicy,
  type RetryState,
} from '../retry/index.js';
import {
  AttemptFailure,
  FormulaDispatchError,
  FormulaEscalationError,
  StepBlockedError,
  type CancelResult,
  type DispatchInput,
  type DispatchResult,
  type MoleculeRun,
  type ProviderResolver,
  type QueuedMoleculeRun,
  type RuntimeSessionEventContext,
  type StepAttemptOutput,
  type StepFailureContext,
  type StepRunArgs,
  type StepRunContext,
  type StepRunFailure,
  type PrChecksOptions,
} from './types.js';
import { createDispatcherEmitter } from './emit.js';
import { StepAttemptRunner } from './step-attempt.js';
import { StepVerdictReader } from './step-verdict.js';
import { readStepName, sleep, stringifyError } from './util.js';
import { MoleculeSettler } from './settlement.js';
import { ResumeCoordinator } from './resume.js';

export { FormulaDispatchError, FormulaEscalationError, FormulaCancellationConflictError } from './types.js';
export type { DispatchInput, ProviderResolver, DispatchResult, CancelResult } from './types.js';

/**
 * FormulaDispatcher runs formula steps and records enough provider-opaque
 * execution metadata on molecule-step beads to resume after restart.
 * Whole-molecule runs can be capped with `maxConcurrentMolecules`; calls
 * above that limit wait in a FIFO in-process queue so a burst of formula runs
 * cannot consume every runtime teammate slot at once.
 * The dispatcher no longer decides what runs next (vibesync-efee): it cooks the
 * molecule (root + step beads with `blocks` edges), registers the run context,
 * and waits. The bead graph says which steps are ready; the StepDispatcher
 * (scheduler/step-dispatcher.ts) offers them one at a time to `runReadyStep`.
 * Ready steps fan out in parallel up to `maxParallelSteps`, so formulas opt
 * into parallelism by declaring independent steps.
 *
 * Example restart recovery:
 *
 *   await dispatcher.resume('hvsyn-mol-abc123')
 *
 * `resume()` re-attaches only to steps already marked `in_progress` with
 * `metadata.exec.task_id`; it does not redispatch open successor steps.
 */

export interface FormulaDispatcherOptions {
  readonly provider: RuntimeProvider;
  readonly walker: MoleculeWalker;
  readonly eventBus: EventBus;
  /**
   * The project's bd `issue_prefix`; molecule ids are minted under it. bd
   * rejects creating a bead with any other prefix, so this is required.
   */
  readonly idPrefix: string;
  readonly maxParallelSteps?: number;
  readonly maxConcurrentMolecules?: number;
  /**
   * Optional per-dispatch provider resolver (vibesync-f5g / vibesync-8hk).
   * When supplied, the dispatcher consults this before falling back
   * to the default `provider`. A resolver that returns null for a
   * given dispatch yields the default — same as if no resolver were
   * configured. Resolution happens once per run; the chosen provider
   * is then used for every step (and on cancel/resume) of that
   * molecule, so concurrent runs against different projects can hit
   * different providers without interfering.
   */
  readonly providerResolver?: ProviderResolver;
  /**
   * Confirms a formula's declared delivery (`delivers = "pull_request"`)
   * before the molecule may complete (vibesync-9lzk.21). Required whenever a
   * formula declares one: a declared delivery with no verifier fails the run.
   */
  readonly deliveryVerifier?: DeliveryVerifier;
  /**
   * Durable codebase knowledge rendered into every step prompt, read fresh
   * before each step (vibesync-9lzk.25). Absent = no memory section.
   */
  readonly projectMemory?: ProjectMemorySource;
  /**
   * Holds plan-only steps to their role (vibesync-9lzk.37): a plan-only step
   * that opened a PR naming the work bead fails. Absent = not checked.
   */
  readonly shippedWorkProbe?: ShippedWorkProbe;
  /**
   * vibesync-9lzk.39: the decision model that reads a reviewing or testing
   * step's reply. Absent = marker line only (the pre-Jev behaviour).
   */
  readonly stepJudge?: StepReplyJudge;
  /**
   * vibesync-9lzk.46: reads the delivered PR's checks when the final step's
   * verdict depends on CI. Absent = the final step cannot confirm CI, and a
   * CI-shaped verdict fails closed (unsettled), never passes.
   */
  readonly prChecks?: PrChecksOptions;
  /**
   * Called (never throws) right after a molecule is cooked and registered, so
   * the step loop can pick up its first ready steps promptly instead of waiting
   * for its next interval. Boot wires this to `StepDispatcher.kick`.
   */
  readonly onMoleculeCooked?: (moleculeId: string) => void;
}

export class FormulaDispatcher implements ReadyStepRunner {
  private readonly defaultProvider: RuntimeProvider;
  private readonly walker: MoleculeWalker;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly emitRuntimeSessionEvent: (event: SessionEvent, context: RuntimeSessionEventContext) => void;
  private readonly stepAttempt: StepAttemptRunner;
  private readonly stepVerdict: StepVerdictReader;
  private readonly settler: MoleculeSettler;
  private readonly resumeCoordinator: ResumeCoordinator;
  private readonly idPrefix: string;
  private readonly maxParallelSteps: number;
  private readonly maxConcurrentMolecules: number;
  private readonly providerResolver: ProviderResolver | null;
  private readonly deliveryVerifier: DeliveryVerifier | null;
  private readonly projectMemory: ProjectMemorySource | null;
  private readonly stepJudge: StepReplyJudge | null;
  private readonly onMoleculeCooked: ((moleculeId: string) => void) | null;
  private readonly moleculeQueue: QueuedMoleculeRun[] = [];
  private readonly live = new Map<string, MoleculeRun>();
  private activeMolecules = 0;

  constructor(opts: FormulaDispatcherOptions) {
    this.defaultProvider = opts.provider;
    this.walker = opts.walker;
    const emitter = createDispatcherEmitter(opts.eventBus);
    this.emit = emitter.emit;
    this.emitRuntimeSessionEvent = emitter.emitRuntimeSessionEvent;
    this.stepAttempt = new StepAttemptRunner({
      walker: this.walker,
      emit: this.emit,
      emitRuntimeSessionEvent: this.emitRuntimeSessionEvent,
    });
    this.idPrefix = opts.idPrefix;
    this.maxParallelSteps = normalizeMaxParallelSteps(opts.maxParallelSteps);
    this.maxConcurrentMolecules = normalizeMaxConcurrentMolecules(opts.maxConcurrentMolecules);
    this.providerResolver = opts.providerResolver ?? null;
    this.deliveryVerifier = opts.deliveryVerifier ?? null;
    this.projectMemory = opts.projectMemory ?? null;
    this.stepJudge = opts.stepJudge ?? null;
    this.stepVerdict = new StepVerdictReader({
      walker: this.walker,
      emit: this.emit,
      stepJudge: this.stepJudge,
      prChecks: opts.prChecks ?? null,
      shippedWorkProbe: opts.shippedWorkProbe ?? null,
    });
    this.settler = new MoleculeSettler({
      walker: this.walker,
      live: this.live,
      deliveryVerifier: this.deliveryVerifier,
      defaultProvider: this.defaultProvider,
      emit: this.emit,
    });
    this.resumeCoordinator = new ResumeCoordinator({
      walker: this.walker,
      defaultProvider: this.defaultProvider,
      deliveryVerifier: this.deliveryVerifier,
      emit: this.emit,
      emitRuntimeSessionEvent: this.emitRuntimeSessionEvent,
    });
    this.onMoleculeCooked = opts.onMoleculeCooked ?? null;
  }

  /**
   * Back-compat alias: many callsites and tests still read
   * `dispatcher.provider` to introspect which RuntimeProvider was
   * wired in at boot. Returns the default; per-dispatch overrides
   * resolved at run time are NOT visible here.
   */
  get provider(): RuntimeProvider {
    return this.defaultProvider;
  }

  /**
   * Resolve the RuntimeProvider for a given dispatch. Returns the
   * default when no resolver is configured, the resolver yields null,
   * or the dispatch has no projectIdentifier.
   *
   * Exposed for tests; production code goes through run().
   */
  async resolveProvider(input: DispatchInput): Promise<RuntimeProvider> {
    if (!this.providerResolver || !input.projectIdentifier) return this.defaultProvider;
    const resolved = await this.providerResolver.resolve(input);
    return resolved ?? this.defaultProvider;
  }

  async run(input: DispatchInput): Promise<DispatchResult> {
    await this.acquireMoleculeSlot(input);
    try {
      return await this.cookAndAwait(input);
    } finally {
      this.releaseMoleculeSlot();
    }
  }

  getQueueDepth(): number {
    return this.moleculeQueue.length;
  }

  getActiveMoleculeCount(): number {
    return this.activeMolecules;
  }

  /**
   * Molecules this process cooked and can still run (their formula/pack/input
   * live here). The StepDispatcher asks the bead graph which of THEIR steps are
   * ready; molecules left open by a previous process are `resume()`'s.
   */
  liveMoleculeIds(): readonly string[] {
    return [...this.live.keys()];
  }

  /**
   * Cook the molecule and wait for it to settle. Nothing here runs a step: the
   * StepDispatcher does, as the bead graph makes steps ready, and the last step
   * to settle finalizes the molecule (`settleMolecule`).
   */
  private async cookAndAwait(input: DispatchInput): Promise<DispatchResult> {
    const startedAt = Date.now();
    const provider = await this.resolveProvider(input);
    const view = await this.walker.dispatch({
      prefix: this.idPrefix,
      formulaName: input.formula.name,
      title: `[formula:${input.formula.name}] ${input.formula.description || input.input.slice(0, 80)}`,
      ...(input.motivatingBeadId ? { motivatingBeadId: input.motivatingBeadId } : {}),
      ...(input.formula.delivers ? { delivers: input.formula.delivers } : {}),
      steps: input.formula.steps,
    });
    return this.registerAndAwait({ input, view, provider, startedAt, outputs: {}, announce: true });
  }

  /**
   * Take over an already-cooked, still-open molecule (vibesync-ynmp): the
   * restart path. A new process has the molecule's beads but not its run
   * context (formula, pack, input), so the caller supplies it; the bead graph
   * and the retry counters on the step beads say where to continue. Outputs of
   * steps that already closed are recovered from the beads.
   */
  async adopt(moleculeId: string, input: DispatchInput): Promise<DispatchResult> {
    const view = await this.walker.load(moleculeId);
    if (!view) throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    if (view.root.status === 'closed') throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} is already closed`, moleculeId);
    const provider = await this.resolveProvider(input);
    return this.registerAndAwait({
      input, view, provider, startedAt: Date.now(),
      outputs: {}, announce: false,
    });
  }

  private async registerAndAwait(args: {
    readonly input: DispatchInput;
    readonly view: { readonly rootId: string };
    readonly provider: RuntimeProvider;
    readonly startedAt: number;
    readonly outputs: Record<string, string>;
    readonly announce: boolean;
  }): Promise<DispatchResult> {
    const { input, provider, startedAt } = args;
    const moleculeId = args.view.rootId;
    const done = new Promise<DispatchResult>((resolve, reject) => {
      this.live.set(moleculeId, {
        input,
        moleculeId,
        provider,
        startedAt,
        outputs: args.outputs,
        rolesByName: new Map(input.pack.roles.map((role) => [role.name, role])),
        startedSteps: new Set(),
        running: 0,
        failed: false,
        failure: undefined,
        cancelled: false,
        finalized: false,
        resolve,
        reject,
      });
    });
    try {
      input.onStarted?.(moleculeId);
    } catch {
      // An observer must never fail the run it observes.
    }

    this.emit(args.announce ? 'dispatcher/formula.started' : 'dispatcher/formula.adopted', moleculeId, undefined, {
      formulaName: input.formula.name,
      moleculeId,
      stepCount: input.formula.steps.length,
      providerKind: provider.kind,
      ...(input.projectIdentifier ? { projectIdentifier: input.projectIdentifier } : {}),
    });
    // A formula with no steps has nothing to settle it.
    if (input.formula.steps.length === 0) await this.settler.settleMolecule(this.live.get(moleculeId)!);
    try {
      this.onMoleculeCooked?.(moleculeId);
    } catch {
      // Waking the step loop is best-effort; its interval is the fallback.
    }
    return done;
  }

  /**
   * Run ONE ready step of a live molecule (the {@link ReadyStepRunner} port).
   * Resolves, never rejects, once the step has settled; a step failure fails
   * the molecule. `skipped` = nothing was run (unknown/finished/failed/cancelled
   * molecule, the step already ran, or `maxParallelSteps` reached).
   */
  async runReadyStep(ready: ReadyStep): Promise<StepRunOutcome> {
    const run = this.live.get(ready.moleculeId);
    if (!run || cannotStartSteps(run)) return 'skipped';
    // An agent may CLOSE a step while declaring a failure_class; until the retry
    // policy has ruled on it (reopen, or a final outcome stamp) that closed
    // blocker must not release its dependents.
    if (await this.hasBlockerPendingRetry(ready.step.id)) return 'skipped';
    // A review round (vibesync-9lzk.24) reopens a step with fresh retry
    // counters, so the round is part of the key or the re-run would be skipped.
    const tryKey = readyStepTryKey(ready.step);
    if (hasStartedTryOrAtParallelLimit(run, tryKey, this.maxParallelSteps)) return 'skipped';
    run.startedSteps.add(tryKey);
    run.running++;
    let outcome: StepRunOutcome = 'finished';
    try {
      // A failed try that the retry policy allows another of REOPENS the step
      // bead and resolves 'finished': the bead graph offers it again.
      await this.runStep({
        input: run.input,
        step: ready.step,
        moleculeId: run.moleculeId,
        outputs: run.outputs,
        rolesByName: run.rolesByName,
        provider: run.provider,
      });
    } catch (error) {
      if (!run.failed) {
        run.failed = true;
        run.failure = error;
      }
      outcome = 'failed';
    } finally {
      run.running--;
    }
    await this.settler.settleMolecule(run);
    return outcome;
  }

  /** True while a `blocks` predecessor is closed with a failure_class the retry policy has not yet ruled on. */
  private async hasBlockerPendingRetry(stepId: string): Promise<boolean> {
    for (const blockerId of await this.walker.blockersOf(stepId)) {
      const blocker = await this.walker.readStep(blockerId);
      if (!blocker || blocker.status !== 'closed') continue;
      const outcome = blocker.metadata[RETRY_OUTCOME_KEY];
      // Closed with a failure_class the retry policy has not ruled on yet.
      if (readFailureClass(blocker.metadata) !== null && outcome === undefined) return true;
      // Closed FAILED (blocked, exhausted, not retryable): never releases its
      // dependents, even in the window before the molecule is marked failed
      // (vibesync-zvcm). A soft-failed step releases them on purpose.
      if (outcome !== undefined && outcome !== 'soft_failed') return true;
    }
    return false;
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
      return await this.projectMemory!.read(projectIdentifier);
    } catch (error) {
      this.emit(PROJECT_MEMORY_READ_FAILED_EVENT, context.moleculeId, context.stepId, {
        projectIdentifier: projectIdentifier ?? null,
        stepName: context.stepName,
        error: stringifyError(error),
      });
      return new Map();
    }
  }

  private acquireMoleculeSlot(input: DispatchInput): Promise<void> {
    if (this.activeMolecules < this.maxConcurrentMolecules) {
      this.activeMolecules++;
      return Promise.resolve();
    }

    const position = this.moleculeQueue.length + 1;
    const depth = position;
    this.emit('dispatcher/formula.queued', undefined, undefined, {
      formulaName: input.formula.name,
      pack: input.pack.manifest.name,
      depth,
      position,
      active: this.activeMolecules,
      maxConcurrentMolecules: this.maxConcurrentMolecules,
    });

    return new Promise<void>((resolve) => {
      this.moleculeQueue.push({ input, resolve });
    });
  }

  private releaseMoleculeSlot(): void {
    this.activeMolecules--;
    const next = this.moleculeQueue.shift();
    if (!next) return;
    this.activeMolecules++;
    next.resolve();
  }

  resume(moleculeId: string): Promise<DispatchResult> {
    return this.resumeCoordinator.resume(moleculeId);
  }

  cancel(moleculeId: string): Promise<CancelResult> {
    return this.settler.cancel(moleculeId);
  }

  private async runStep(args: StepRunArgs): Promise<void> {
    const context = this.prepareStepRun(args);
    const { stepName, stepSpec } = context;
    // ONE try per call (vibesync-ynmp). Where the step is in its retry policy is
    // read from the BEAD, never from this process: a failed try reopens the step
    // with new counters and the bead graph offers it again, so a restart between
    // tries resumes at the right attempt.
    const policy = resolveRetryPolicy(stepSpec);
    const state = readRetryState(args.step.metadata);
    const attemptStartedAt = new Date();
    await this.walker.recordStepAttempt(args.step.id, state.attempt);
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
      const output = await this.stepAttempt.runStepAttempt({
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
      const bead = await this.walker.readStep(args.step.id).catch(() => null);
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
    }) + (this.projectMemory ? renderProjectMemory(await this.readProjectMemory(args.input.projectIdentifier, { moleculeId: args.moleculeId, stepId: args.step.id, stepName })) : '') + STEP_OUTCOME_INSTRUCTIONS;
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
    const bead = await this.walker.readStep(args.step.id);
    const declared = bead ? readFailureClass(bead.metadata) : null;
    const blocker = await this.stepVerdict.readStepBlocker({ ...args, stepSpec, stepName, output: output.text, outputs: args.outputs });
    const overstepped = blocker === null && declared === null && stepSpec.planOnly
      ? await this.stepVerdict.planOnlyViolation(args.input.motivatingBeadId, attemptStartedAt, { moleculeId: args.moleculeId, stepId: args.step.id })
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
      ? await this.stepVerdict.loopBack({ ...args, stepSpec, stepName, blocker, output })
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
    await this.walker.finishStep(args.step.id, { output: output.text, eventCount: output.eventCount, attempts: attempt });
    this.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
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
    await this.walker.failStep(args.step.id, trace, outcomeLabel);
    this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
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
    await this.walker.reopenStepForRetry(args.step.id, {
      attempt: decision.next.attempt,
      infraRetries: decision.next.infraRetries,
      failureClass: failure.failureClass,
      errorTrace: reason,
    });
    this.emit('dispatcher/step.retry', args.moleculeId, args.step.id, {
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

function renderContext(input: string, outputs: Readonly<Record<string, string>>, steps: readonly StepSpec[]): Readonly<Record<string, string | number | boolean>> {
  const context: Record<string, string> = {
    input,
    prior_outputs: formatPriorOutputs(outputs),
    roles: steps.map((step) => step.role).join(', '),
  };
  for (const [stepName, output] of Object.entries(outputs)) {
    context[`prior_${stepName}`] = output;
  }
  return context;
}

function formatPriorOutputs(outputs: Readonly<Record<string, string>>): string {
  const entries = Object.entries(outputs);
  if (entries.length === 0) return 'No prior step outputs yet.';
  return entries
    .map(([stepName, output]) => [`## ${stepName}`, output.trim() || '(empty output)'].join('\n'))
    .join('\n\n');
}

function retryStateKey(state: RetryState): string {
  return `${state.attempt}.${state.infraRetries}`;
}

/** What a dependent's prompt sees in place of the output of a step that soft-failed. */
function softFailMarker(stepName: string, errorTrace: string): string {
  return `[step "${stepName}" soft-failed and produced no output: ${errorTrace}]`;
}

function cannotStartSteps(run: MoleculeRun | undefined): boolean {
  return !run || run.failed || run.cancelled;
}

function readyStepTryKey(step: BeadRow): string {
  return `${step.id}@r${readReviewRound(step.metadata)}.${retryStateKey(readRetryState(step.metadata))}`;
}

function hasStartedTryOrAtParallelLimit(run: MoleculeRun, tryKey: string, maxParallelSteps: number): boolean {
  return run.startedSteps.has(tryKey) || run.running >= maxParallelSteps;
}

function normalizeMaxParallelSteps(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (value < 1) {
    throw new Error('FormulaDispatcher: maxParallelSteps must be at least 1');
  }
  return Math.floor(value);
}

function normalizeMaxConcurrentMolecules(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (value < 1) {
    throw new Error('FormulaDispatcher: maxConcurrentMolecules must be at least 1');
  }
  return Math.floor(value);
}
