import type { EventBus } from '../events/index.js';

import type { MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { RuntimeProvider, SessionEvent } from '../runtime/index.js';
import type { ReadyStep, ReadyStepRunner, StepRunOutcome } from '../molecule/index.js';
import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { StepReplyJudge } from '../verdict/index.js';
import type { ProjectMemorySource } from './project-memory.js';
import { StepTurnRunner } from './step-turn.js';
import type { TurnLimitRecordStore, TurnLimitPreserver } from './turn-limit.js';
import {
  readFailureClass,
  readRetryState,
  readReviewRound,
  RETRY_OUTCOME_KEY,
  type RetryState,
} from '../retry/index.js';
import {
  FormulaDispatchError,
  type CancelResult,
  type DispatchInput,
  type DispatchResult,
  type MoleculeRun,
  type ProviderResolver,
  type QueuedMoleculeRun,
  type RuntimeSessionEventContext,
  type PrChecksOptions,
} from './types.js';
import { createDispatcherEmitter } from './emit.js';
import { readExec, readStepName, readString, softFailMarker } from './util.js';
import { MoleculeSettler } from './settlement.js';
import { ResumeCoordinator } from './resume.js';
import { StepAttemptRunner } from './step-attempt.js';
import { StepVerdictReader } from './step-verdict.js';
import { createProjectBindingResolver } from './project-binding.js';
import type { ProjectBinding, ProjectBindingResolver } from './project-binding-types.js';

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
  readonly projectBindings?: ProjectBindingResolver;
  readonly turnLimitPreserver?: TurnLimitPreserver;
  readonly turnLimitRecordStore?: TurnLimitRecordStore;
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
  private readonly stepTurn: StepTurnRunner;
  private readonly settler: MoleculeSettler;
  private readonly resumeCoordinator: ResumeCoordinator;
  private readonly idPrefix: string;
  private readonly maxParallelSteps: number;
  private readonly maxConcurrentMolecules: number;
  private readonly providerResolver: ProviderResolver | null;
  private readonly projectBindings: ProjectBindingResolver;
  private readonly turnLimitRecordStore: TurnLimitRecordStore;
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
    const defaultBinding: ProjectBinding = {
      workBeads: null,
      deliveryVerifier: opts.deliveryVerifier ?? null,
      shippedWorkProbe: opts.shippedWorkProbe ?? null,
      prChecks: opts.prChecks ?? null,
    };
    this.projectBindings = opts.projectBindings ?? createProjectBindingResolver(defaultBinding);
    this.turnLimitRecordStore = opts.turnLimitRecordStore ?? opts.walker;
    this.projectMemory = opts.projectMemory ?? null;
    this.stepJudge = opts.stepJudge ?? null;
    this.stepVerdict = new StepVerdictReader({
      walker: this.walker,
      emit: this.emit,
      stepJudge: this.stepJudge,
      projectBindings: this.projectBindings,
    });
    this.stepTurn = new StepTurnRunner({
      walker: this.walker,
      emit: this.emit,
      stepAttempt: this.stepAttempt,
      stepVerdict: this.stepVerdict,
      projectMemory: this.projectMemory,
      ...(opts.turnLimitPreserver ? { turnLimitPreserver: opts.turnLimitPreserver } : {}),
      turnLimitRecordStore: this.turnLimitRecordStore,
    });
    this.settler = new MoleculeSettler({
      walker: this.walker,
      live: this.live,
      projectBindings: this.projectBindings,
      defaultProvider: this.defaultProvider,
      providerResolver: this.providerResolver,
      emit: this.emit,
    });
    this.resumeCoordinator = new ResumeCoordinator({
      walker: this.walker,
      defaultProvider: this.defaultProvider,
      providerResolver: this.providerResolver,
      projectBindings: this.projectBindings,
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

  projectOfLiveMolecule(moleculeId: string): string | undefined {
    return this.live.get(moleculeId)?.input.projectIdentifier;
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
      ...(input.projectIdentifier ? { projectIdentifier: input.projectIdentifier } : {}),
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
      outputs: outputsFromClosedSteps(view.steps), announce: false,
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
      await this.stepTurn.runStep({
        input: run.input,
        step: ready.step,
        moleculeId: run.moleculeId,
        outputs: run.outputs,
        rolesByName: run.rolesByName,
        provider: run.provider,
        ...(run.input.workdir !== undefined ? { workdir: run.input.workdir } : {}),
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
}

function retryStateKey(state: RetryState): string {
  return `${state.attempt}.${state.infraRetries}`;
}

function outputsFromClosedSteps(steps: readonly BeadRow[]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const step of steps) {
    if (step.status !== 'closed') continue;
    const stepName = readStepName(step);
    const payload = readExec(step).output_payload;
    if (hasOutputPayload(payload)) {
      outputs[stepName] = payload.output;
    } else if (isSoftFailedStep(step)) {
      outputs[stepName] = softFailMarker(stepName, readString(readExec(step).error_trace) ?? 'soft_fail');
    }
  }
  return outputs;
}

function hasOutputPayload(payload: unknown): payload is { readonly output: string } {
  return payload !== null && typeof payload === 'object' && 'output' in payload && typeof payload.output === 'string';
}

function isSoftFailedStep(step: BeadRow): boolean {
  return step.metadata['gc.retry_outcome'] === 'soft_failed';
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
