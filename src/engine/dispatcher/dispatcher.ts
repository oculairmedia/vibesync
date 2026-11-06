import type { EventBus } from '../events/index.js';

import type { Formula } from '../formula/index.js';
import type { MoleculeWalker, StepSpec } from '../molecule/index.js';
import { newMoleculeStepId } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { Pack, RoleConfig } from '../packs/index.js';
import type { RuntimeProvider, SessionEvent, SessionHandle } from '../runtime/index.js';
import type { ReadyStep, ReadyStepRunner, StepRunOutcome } from '../molecule/index.js';
import { parseBlockedOutcome, STEP_OUTCOME_INSTRUCTIONS } from './step-outcome.js';
import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import { decideStepVerdict, reconcileWithMarker, type StepReplyJudge, type StepVerdict } from '../verdict/index.js';
import { PROJECT_MEMORY_READ_FAILED_EVENT, renderProjectMemory, type ProjectMemorySource } from './project-memory.js';
import { renderTemplate } from './render.js';
import {
  classifyFailure,
  decideRetry,
  readFailureClass,
  readRetryState, readReviewRound,
  resolveRetryPolicy,
  RETRY_OUTCOME_KEY,
  type FailureSignal,
  type RetryState,
} from '../retry/index.js';

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

export interface DispatchInput {
  readonly formula: Formula;
  readonly pack: Pack;
  readonly input: string;
  readonly motivatingBeadId?: string;
  /**
   * Per-project routing key (vibesync-f5g / vibesync-8hk). When set, the
   * dispatcher consults its ProviderResolver to pick the RuntimeProvider for
   * this run and resolves the step's role agent and project memory for this
   * project. When omitted, the default provider supplied at construction runs
   * the molecule.
   */
  readonly projectIdentifier?: string;
  /** Default turn timeout for every step; explicit formula-step timeouts win. */
  readonly stepTimeoutMs?: number;
  /** Absolute directory in which the runtime starts each step session. */
  readonly workdir?: string;
  /**
   * Called once, synchronously, as soon as the molecule exists (right after
   * the walker created it, BEFORE the first step runs) with its id
   * (vibesync-izn3). `run()` only returns the molecule id when the whole
   * formula finishes, which is too late for a caller that must `cancel()` a
   * run that never finishes. A throwing callback is logged-and-ignored by the
   * dispatcher: it can never fail the run.
   */
  readonly onStarted?: (moleculeId: string) => void;
}

/**
 * Routes a dispatch to the right RuntimeProvider based on the project
 * identifier. Implementations look up the per-project routing row
 * (provider_kind, PM parent agent id). See ProjectLettaRepository.
 *
 * Returns null when the project has no override: the dispatcher then uses its
 * default provider. Throws for a row it must not run (a removed provider
 * kind); the run then fails before any molecule is cooked.
 */
export interface ProviderResolver {
  resolve(input: DispatchInput): Promise<RuntimeProvider | null> | RuntimeProvider | null;
}

export interface DispatchResult {
  readonly moleculeId: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface CancelResult {
  readonly moleculeId: string;
  readonly cancelledStepCount: number;
}

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
   * Called (never throws) right after a molecule is cooked and registered, so
   * the step loop can pick up its first ready steps promptly instead of waiting
   * for its next interval. Boot wires this to `StepDispatcher.kick`.
   */
  readonly onMoleculeCooked?: (moleculeId: string) => void;
}

interface QueuedMoleculeRun {
  readonly input: DispatchInput;
  readonly resolve: () => void;
}

/** In-process run context of one cooked molecule (formula, pack, input, outputs). */
interface MoleculeRun {
  readonly input: DispatchInput;
  readonly moleculeId: string;
  readonly provider: RuntimeProvider;
  readonly startedAt: number;
  readonly outputs: Record<string, string>;
  readonly rolesByName: ReadonlyMap<string, RoleConfig>;
  /**
   * Tries already started, keyed `<stepId>@<attempt>.<infraRetries>` (the retry
   * state READ FROM THE BEAD, vibesync-ynmp). A step bead is offered again only
   * after a failed try reopened it with new counters; the same try is never
   * run twice. Not a counter: nothing here decides whether to retry.
   */
  readonly startedSteps: Set<string>;
  running: number;
  failed: boolean;
  failure: unknown;
  cancelled: boolean;
  finalized: boolean;
  readonly resolve: (result: DispatchResult) => void;
  readonly reject: (error: unknown) => void;
}

export class FormulaDispatchError extends Error {
  constructor(
    message: string,
    readonly moleculeId: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'FormulaDispatchError';
  }
}

export class FormulaCancellationConflictError extends FormulaDispatchError {
  constructor(message: string, moleculeId: string) {
    super(message, moleculeId);
    this.name = 'FormulaCancellationConflictError';
  }
}

export class FormulaDispatcher implements ReadyStepRunner {
  private readonly defaultProvider: RuntimeProvider;
  private readonly walker: MoleculeWalker;
  private readonly eventBus: EventBus;
  private readonly idPrefix: string;
  private readonly maxParallelSteps: number;
  private readonly maxConcurrentMolecules: number;
  private readonly providerResolver: ProviderResolver | null;
  private readonly deliveryVerifier: DeliveryVerifier | null;
  private readonly projectMemory: ProjectMemorySource | null;
  private readonly shippedWorkProbe: ShippedWorkProbe | null;
  private readonly stepJudge: StepReplyJudge | null;
  private readonly onMoleculeCooked: ((moleculeId: string) => void) | null;
  private readonly moleculeQueue: QueuedMoleculeRun[] = [];
  private readonly live = new Map<string, MoleculeRun>();
  private activeMolecules = 0;

  constructor(opts: FormulaDispatcherOptions) {
    this.defaultProvider = opts.provider;
    this.walker = opts.walker;
    this.eventBus = opts.eventBus;
    this.idPrefix = opts.idPrefix;
    this.maxParallelSteps = normalizeMaxParallelSteps(opts.maxParallelSteps);
    this.maxConcurrentMolecules = normalizeMaxConcurrentMolecules(opts.maxConcurrentMolecules);
    this.providerResolver = opts.providerResolver ?? null;
    this.deliveryVerifier = opts.deliveryVerifier ?? null;
    this.projectMemory = opts.projectMemory ?? null;
    this.shippedWorkProbe = opts.shippedWorkProbe ?? null;
    this.stepJudge = opts.stepJudge ?? null;
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
    if (input.formula.steps.length === 0) await this.settleMolecule(this.live.get(moleculeId)!);
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
    if (!run || run.failed || run.cancelled) return 'skipped';
    // An agent may CLOSE a step while declaring a failure_class; until the retry
    // policy has ruled on it (reopen, or a final outcome stamp) that closed
    // blocker must not release its dependents.
    if (await this.hasBlockerPendingRetry(ready.step.id)) return 'skipped';
    // A review round (vibesync-9lzk.24) reopens a step with fresh retry
    // counters, so the round is part of the key or the re-run would be skipped.
    const tryKey = `${ready.step.id}@r${readReviewRound(ready.step.metadata)}.${retryStateKey(readRetryState(ready.step.metadata))}`;
    if (run.startedSteps.has(tryKey)) return 'skipped';
    if (run.running >= this.maxParallelSteps) return 'skipped';
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
    await this.settleMolecule(run);
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
   * Finalize a molecule once none of its steps is running: failed if any step
   * failed (siblings in flight finish first), completed once every step bead is
   * closed. Otherwise the next ready steps are the StepDispatcher's to offer.
   */
  private async settleMolecule(run: MoleculeRun): Promise<void> {
    if (run.finalized || run.running > 0) return;
    try {
      if (run.cancelled) {
        // cancel() already closed the root as 'cancelled' and emitted
        // formula.cancelled. The step it stopped may well have thrown on the way
        // down; that must not turn the cancelled root into a 'failed' one.
        run.finalized = true;
        this.live.delete(run.moleculeId);
        run.reject(new FormulaDispatchError(`FormulaDispatcher: molecule ${run.moleculeId} was cancelled`, run.moleculeId));
        return;
      }
      if (run.failed) {
        run.finalized = true;
        this.live.delete(run.moleculeId);
        await this.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'failed');
        this.emit('dispatcher/formula.failed', run.moleculeId, undefined, {
          moleculeId: run.moleculeId,
          error: stringifyError(run.failure),
          // vibesync-u32z: carry the motivating bead on the completion event so
          // the writeback hook can resolve it directly from the event, without
          // depending solely on re-reading the persisted molecule_root row (a
          // single point of failure if any dispatch path or Dolt write dropped
          // the exec.motivating_bead stamp).
          ...(run.input.motivatingBeadId ? { motivating_bead: run.input.motivatingBeadId } : {}),
        });
        run.reject(run.failure);
        return;
      }
      if (!(await this.walker.isComplete(run.moleculeId)) || run.finalized) return;
      // vibesync-9lzk.21: every step finished, but a formula that declares a
      // delivery only completes once that artifact verifiably exists.
      const undelivered = await this.checkDelivery(run);
      if (undelivered !== null) {
        if (run.finalized) return;
        run.failed = true;
        run.failure = new FormulaDispatchError(`FormulaDispatcher: ${undelivered}`, run.moleculeId);
        await this.settleMolecule(run);
        return;
      }
      if (run.finalized) return;
      run.finalized = true;
      this.live.delete(run.moleculeId);
      await this.walker.markMoleculeRootStatus(run.moleculeId, 'closed', 'completed');
      this.emit('dispatcher/formula.completed', run.moleculeId, undefined, {
        moleculeId: run.moleculeId,
        durationMs: Date.now() - run.startedAt,
        // vibesync-u32z: see the failure branch above — the completion event is
        // now self-describing so the writeback hook never has to reverse-engineer
        // the motivating bead from a row that may not carry it.
        ...(run.input.motivatingBeadId ? { motivating_bead: run.input.motivatingBeadId } : {}),
      });
      run.resolve({ moleculeId: run.moleculeId, outputs: run.outputs });
    } catch (error) {
      // Persisting the outcome failed: settle the caller's promise anyway so a
      // run (and the pool slot / molecule slot behind it) is never stuck.
      run.finalized = true;
      this.live.delete(run.moleculeId);
      run.reject(error);
    }
  }

  /**
   * vibesync-9lzk.39: the blocker a step's reply carries, or null. Steps that
   * judge work (a looping step such as the reviewer, or the formula's last
   * step such as the tester) are read by the decision model when one is
   * configured; every other step keeps the marker line. A judge failure is an
   * error (the step fails), never a silent "not blocked". An unsettled reading
   * fails closed with the reply attached.
   */
  private async readStepBlocker(args: {
    readonly input: DispatchInput;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepSpec: StepSpec;
    readonly stepName: string;
    readonly output: string;
  }): Promise<string | null> {
    const marker = parseBlockedOutcome(args.output);
    const steps = args.input.formula.steps;
    const judges = args.stepSpec.loopsBackTo !== undefined || steps[steps.length - 1]?.name === args.stepName;
    if (!this.stepJudge || !judges) return marker;
    const judged = await this.stepJudge.judge({ role: args.stepSpec.role, reply: args.output });
    const summary = marker ?? args.output;
    const finalStep = steps[steps.length - 1]?.name === args.stepName;
    const verdict: StepVerdict = reconcileWithMarker(decideStepVerdict(judged.answers, summary, { finalStep }), marker);
    this.emit('dispatcher/step.verdict', args.moleculeId, args.step.id, {
      stepName: args.stepName, role: args.stepSpec.role, stepId: args.step.id,
      verdict: verdict.kind, answers: judged.answers, model: judged.model, inputTokens: judged.inputTokens, marker: marker !== null,
    });
    switch (verdict.kind) {
      case 'approve': return null;
      case 'changes_requested': return verdict.reason;
      case 'await_ci': return `${verdict.reason}; a reply that only waits on CI is not a block: wait for the checks, then judge the finished result`;
      case 'unsettled': return `verdict unsettled (fail closed): ${verdict.reason}`;
    }
  }

  /**
   * vibesync-9lzk.24: send the work back to `loopsBackTo` for another round.
   * The reviewing step itself is finished (its verdict is its output) and
   * reopened for the next round together with the target and every step
   * between them, so the bead graph re-runs the chain: coder -> reviewer ->
   * ... The round counter lives on the TARGET step bead, so the cap survives
   * a restart. Returns 'exhausted' once `maxRounds` rounds ended blocked.
   */
  private async loopBack(args: {
    readonly input: DispatchInput;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly stepSpec: StepSpec;
    readonly stepName: string;
    readonly blocker: string;
    readonly output: string;
  }): Promise<'reopened' | 'exhausted'> {
    const target = args.stepSpec.loopsBackTo!;
    const maxRounds = args.stepSpec.maxRounds ?? 3;
    const steps = args.input.formula.steps;
    const targetIdx = steps.findIndex((s) => s.name === target);
    const selfIdx = steps.findIndex((s) => s.name === args.stepName);
    const targetId = newMoleculeStepId(args.moleculeId, target);
    const targetBead = await this.walker.readStep(targetId);
    if (targetIdx < 0 || selfIdx <= targetIdx || !targetBead) {
      throw new FormulaDispatchError(`FormulaDispatcher: step "${args.stepName}" loops back to "${target}", which is not an earlier step of this molecule`, args.moleculeId);
    }
    const round = readReviewRound(targetBead.metadata);
    this.emit('dispatcher/step.review_blocked', args.moleculeId, args.step.id, {
      stepName: args.stepName, role: args.stepSpec.role, stepId: args.step.id, loopsBackTo: target, round, maxRounds, reason: args.blocker,
    });
    if (round >= maxRounds) {
      // The reviewing step closes blocked like any other; the caller fails the run.
      this.emit('dispatcher/formula.review_exhausted', args.moleculeId, args.step.id, {
        stepName: args.stepName, loopsBackTo: target, rounds: round, maxRounds, reason: args.blocker,
      });
      return 'exhausted';
    }
    // The verdict is this step's output for the next round; close it finished.
    args.outputs[args.stepName] = args.output;
    await this.walker.finishStep(args.step.id, { output: args.output, round });
    const note = `Round ${round} review (${args.stepName}) requested changes: ${args.blocker}`;
    // Reopen target..self (inclusive) in formula order so the chain re-runs.
    // Later steps that have not run stay open; earlier ones stay closed.
    for (const spec of steps.slice(targetIdx, selfIdx + 1)) {
      const id = newMoleculeStepId(args.moleculeId, spec.name);
      await this.walker.reopenStepForRound(id, { round: round + 1, note });
      delete args.outputs[spec.name];
    }
    // The review text travels to the next round as a prior output under a
    // stable name, so the coder prompt can read it (prior_review).
    args.outputs['review'] = `${note}\n\n${args.output}`;
    this.emit('dispatcher/step.loop_back', args.moleculeId, args.step.id, {
      stepName: args.stepName, loopsBackTo: target, round: round + 1, maxRounds, reopened: steps.slice(targetIdx, selfIdx + 1).map((s) => s.name),
    });
    return 'reopened';
  }

  /**
   * Why a plan-only step overstepped its role, or null. A step that opened a
   * PR naming the work bead did the coder's job. A probe failure is reported
   * as an event and does not fail the step: the check is a guard, and an
   * unreachable GitHub must not stop planning.
   */
  private async planOnlyViolation(
    bead: string | undefined,
    since: Date,
    context: { readonly moleculeId: string; readonly stepId: string },
  ): Promise<string | null> {
    if (!this.shippedWorkProbe || !bead) return null;
    try {
      const prs = await this.shippedWorkProbe.pullRequestsOpenedSince(bead, since);
      if (prs.length === 0) return null;
      return `plan-only step shipped work: it opened ${prs.join(', ')} for ${bead}; planning steps must not edit, commit, push or open pull requests`;
    } catch (error) {
      this.emit('dispatcher/plan-only.check_failed', context.moleculeId, context.stepId, { bead, error: stringifyError(error) });
      return null;
    }
  }

  /**
   * Null when the formula declares no delivery or the verifier confirms it;
   * otherwise the reason the run must fail. Verifier errors fail closed.
   */
  private async checkDelivery(run: MoleculeRun): Promise<string | null> {
    const kind = run.input.formula.delivers;
    if (kind === undefined) return null;
    if (!this.deliveryVerifier) return `formula "${run.input.formula.name}" declares delivers = "${kind}" but no delivery verifier is configured`;
    try {
      const verdict = await this.deliveryVerifier.verify({
        kind, outputs: run.outputs, moleculeId: run.moleculeId, startedAt: new Date(run.startedAt),
        ...(run.input.motivatingBeadId ? { motivatingBeadId: run.input.motivatingBeadId } : {}),
      });
      // `in` narrowing works under the test tree's non-strict config too.
      if ('reason' in verdict) return `declared delivery not met: ${verdict.reason}`;
      this.emit('dispatcher/formula.delivered', run.moleculeId, undefined, { moleculeId: run.moleculeId, kind, artifact: verdict.artifact });
      return null;
    } catch (err) {
      return `declared delivery could not be verified: ${stringifyError(err)}`;
    }
  }

  /**
   * resume() has no formula in scope, so it reads the delivery the root
   * recorded at dispatch (vibesync-9lzk.21 review). Throws, after failing the
   * root and emitting formula.failed, when that delivery is not met.
   */
  private async requireResumedDelivery(
    root: BeadRow,
    moleculeId: string,
    outputs: Record<string, string>,
    startedAt: number,
    motivatingBeadId: string | null | undefined,
  ): Promise<void> {
    const exec = root.metadata['exec'];
    const kind = typeof exec === 'object' && exec !== null ? (exec as Record<string, unknown>)['delivers'] : undefined;
    if (kind === undefined) return;
    // The run this resumes began when the root was created, not at this resume.
    const runStarted = root.created_at instanceof Date ? root.created_at.getTime() : startedAt;
    let reason: string | null = null;
    if (kind !== 'pull_request') reason = `molecule records an unknown delivery kind ${JSON.stringify(kind)}`;
    else if (!this.deliveryVerifier) reason = 'molecule declares delivers = "pull_request" but no delivery verifier is configured';
    else {
      try {
        const verdict = await this.deliveryVerifier.verify({
          kind, outputs, moleculeId, startedAt: new Date(runStarted),
          ...(motivatingBeadId ? { motivatingBeadId } : {}),
        });
        if ('reason' in verdict) reason = `declared delivery not met: ${verdict.reason}`;
        else this.emit('dispatcher/formula.delivered', moleculeId, undefined, { moleculeId, kind, artifact: verdict.artifact, resumed: true });
      } catch (err) {
        reason = `declared delivery could not be verified: ${stringifyError(err)}`;
      }
    }
    if (reason === null) return;
    await this.walker.markMoleculeRootStatus(moleculeId, 'closed', 'failed');
    this.emit('dispatcher/formula.failed', moleculeId, undefined, {
      moleculeId, error: reason, resumed: true,
      ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
    });
    throw new FormulaDispatchError(`FormulaDispatcher: ${reason}`, moleculeId);
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

  async resume(moleculeId: string): Promise<DispatchResult> {
    const startedAt = Date.now();
    const view = await this.walker.load(moleculeId);
    if (!view) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    }

    const outputs = outputsFromClosedSteps(view.steps);
    // vibesync-u32z: on resume, `input` is not in scope — recover the
    // motivating bead from the persisted molecule_root exec so the completion
    // event stays self-describing across a restart/resume too.
    const motivatingBeadId = readMotivatingBead(view.root);
    this.emit('dispatcher/formula.resumed', moleculeId, undefined, {
      moleculeId,
      runningStepCount: view.steps.filter((step) => step.status === 'in_progress').length,
    });

    const running = await this.walker.findRunning(moleculeId);
    if (running.length === 0) {
      if (await this.walker.isComplete(moleculeId)) {
        await this.requireResumedDelivery(view.root, moleculeId, outputs, startedAt, motivatingBeadId);
        this.emit('dispatcher/formula.completed', moleculeId, undefined, {
          moleculeId,
          durationMs: Date.now() - startedAt,
          resumed: true,
          ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
        });
        return { moleculeId, outputs };
      }
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to resume`, moleculeId);
    }

    try {
      for (const step of running) {
        await this.resumeStep({ step, moleculeId, outputs });
      }
    } catch (error) {
      this.emit('dispatcher/formula.failed', moleculeId, undefined, {
        moleculeId,
        error: stringifyError(error),
        resumed: true,
        ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
      });
      throw error;
    }

    if (await this.walker.isComplete(moleculeId)) {
      await this.requireResumedDelivery(view.root, moleculeId, outputs, startedAt, motivatingBeadId);
      this.emit('dispatcher/formula.completed', moleculeId, undefined, {
        moleculeId,
        durationMs: Date.now() - startedAt,
        resumed: true,
        ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
      });
    } else {
      this.emit('dispatcher/formula.resume.paused', moleculeId, undefined, {
        moleculeId,
        reason: 'running steps completed; open successors require a fresh formula run context',
      });
    }

    return { moleculeId, outputs };
  }

  async cancel(moleculeId: string): Promise<CancelResult> {
    const view = await this.walker.load(moleculeId);
    if (!view) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    }
    const running = await this.walker.findRunning(moleculeId);
    if (running.length === 0) {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to cancel`, moleculeId);
    }

    // Closing the running steps below unblocks their dependents in the bead
    // graph; mark the run so none of them is started.
    const liveRun = this.live.get(moleculeId);
    if (liveRun) liveRun.cancelled = true;

    let cancelledStepCount = 0;
    for (const step of running) {
      const stepName = readStepName(step);
      const role = readStepRole(step);
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      const providerKind = readString(exec.provider_kind);
      const taskId = readString(exec.task_id) ?? undefined;
      if (sessionId && providerKind) {
        await this.provider.stop({ id: sessionId, providerKind });
      }
      await this.walker.failStep(step.id, 'cancelled');
      cancelledStepCount++;
      this.emit('dispatcher/step.cancelled', moleculeId, taskId, {
        stepName,
        role,
        stepId: step.id,
        ...(sessionId ? { sessionId } : {}),
      });
    }

    await this.walker.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled');
    this.emit('dispatcher/formula.cancelled', moleculeId, undefined, {
      moleculeId,
      cancelledStepCount,
    });
    // Release the run() caller now if no step of this process is still unwinding.
    if (liveRun) await this.settleMolecule(liveRun);
    return { moleculeId, cancelledStepCount };
  }

  private async runStep(args: {
    readonly input: DispatchInput;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly rolesByName: ReadonlyMap<string, RoleConfig>;
    readonly provider: RuntimeProvider;
  }): Promise<void> {
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

    // ONE try per call (vibesync-ynmp). Where the step is in its retry policy is
    // read from the BEAD, never from this process: a failed try reopens the step
    // with new counters and the bead graph offers it again, so a restart between
    // tries resumes at the right attempt.
    const policy = resolveRetryPolicy(stepSpec);
    const state = readRetryState(args.step.metadata);
    const attemptStartedAt = new Date();
    await this.walker.recordStepAttempt(args.step.id, state.attempt);
    const rendered = renderTemplate({
      packRoot: args.input.pack.root,
      template: stepSpec.promptTemplate,
      context: {
        ...renderContext(args.input.input, args.outputs),
        step_id: args.step.id,
        attempt: state.attempt,
      },
    }) + (this.projectMemory ? renderProjectMemory(await this.readProjectMemory(args.input.projectIdentifier, { moleculeId: args.moleculeId, stepId: args.step.id, stepName })) : '') + STEP_OUTCOME_INSTRUCTIONS;

    let failure: { readonly signal: FailureSignal; readonly error: unknown; readonly failureClass: string | null } | null = null;
    // Only the AGENT TURN is retryable. Anything after it succeeded (reading the
    // bead, persisting the result) runs outside this try: a store error there
    // must fail the molecule, never re-run a turn that already completed and
    // may have had side effects (CodeRabbit on #59).
    let output: Awaited<ReturnType<FormulaDispatcher['runStepAttempt']>> | null = null;
    try {
      output = await this.runStepAttempt({
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
        provider: args.provider,
        ...(args.input.projectIdentifier ? { projectIdentifier: args.input.projectIdentifier } : {}),
        ...((stepSpec.turnTimeoutMs ?? args.input.stepTimeoutMs) !== undefined
          ? { turnTimeoutMs: stepSpec.turnTimeoutMs ?? args.input.stepTimeoutMs }
          : {}),
        ...(args.input.workdir !== undefined ? { workdir: args.input.workdir } : {}),
      });
    } catch (error) {
      const bead = await this.walker.readStep(args.step.id).catch(() => null);
      failure = {
        signal: error instanceof AttemptFailure ? error.signal : { origin: 'call' },
        error,
        failureClass: bead ? readFailureClass(bead.metadata) : null,
      };
    }

    if (output !== null) {
      // The turn completed. The agent declares a retryable failure by writing
      // failure_class on the step bead during its turn; success carries none.
      // Store errors from here on propagate (fail the molecule), never retry.
      const bead = await this.walker.readStep(args.step.id);
      const declared = bead ? readFailureClass(bead.metadata) : null;
      // vibesync-zvcm: a step that reports itself blocked must stop the formula.
      // Terminal: retrying cannot clear a blocker the agent named.
      // vibesync-9lzk.39: for a step that judges work (one that loops back, or
      // the last step), the reply is read by the decision model, not by its
      // marker line alone; the marker is a second signal (see verdict/decide).
      const blocker = await this.readStepBlocker({ ...args, stepSpec, stepName, output: output.text });
      const overstepped = blocker === null && declared === null && stepSpec.planOnly
        ? await this.planOnlyViolation(args.input.motivatingBeadId, attemptStartedAt, { moleculeId: args.moleculeId, stepId: args.step.id })
        : null;
      if (overstepped !== null) {
        // Terminal like a blocked step: the plan was not the work product, and
        // re-running the planner cannot undo a PR it already opened.
        failure = {
          signal: { origin: 'stopped' },
          error: new StepBlockedError(overstepped),
          failureClass: null,
        };
      } else if (blocker !== null) {
        // vibesync-9lzk.24: a reviewing step that blocks sends the work back
        // for another round, up to the formula's cap; then the run fails with
        // an escalation instead of looping forever.
        const looped = stepSpec.loopsBackTo
          ? await this.loopBack({ ...args, stepSpec, stepName, blocker, output: output.text })
          : 'no-loop';
        if (looped === 'reopened') return;
        failure = {
          signal: { origin: 'stopped' },
          error: new StepBlockedError(looped === 'exhausted' ? `${blocker} (review loop exhausted after ${stepSpec.maxRounds ?? 3} rounds; escalated)` : blocker),
          failureClass: null,
        };
      } else if (declared === null) {
        args.outputs[stepName] = output.text;
        await this.walker.finishStep(args.step.id, { output: output.text, eventCount: output.eventCount, attempts: state.attempt });
        this.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
          stepName,
          role: stepSpec.role,
          stepId: args.step.id,
          outputLength: output.text.length,
          attempts: state.attempt,
        });
        return;
      } else {
        failure = {
          signal: { origin: 'event', code: 'failure_class', producedOutput: true },
          error: new Error(`step declared failure_class=${declared}`),
          failureClass: declared,
        };
      }
    }
    if (failure === null) {
      // Unreachable: the turn either threw (failure set in catch) or completed
      // (success returned above, or a declared failure_class set it).
      throw new Error(`step ${args.step.id}: attempt ended with neither an output nor a failure`);
    }

    // A failure_class on the bead means the agent RAN and declared it: that burns
    // an attempt whatever else went wrong around it. Cancel/stop still wins.
    const classified = classifyFailure(failure.signal);
    const kind = failure.failureClass !== null && classified !== 'terminal' ? 'agent' : classified;
    const decision = decideRetry({ policy, state, kind });
    const reason = stringifyError(failure.error);
    if (decision.action === 'retry') {
      // Durable first: the reopen is what survives a restart.
      await this.walker.reopenStepForRetry(args.step.id, {
        attempt: decision.next.attempt,
        infraRetries: decision.next.infraRetries,
        failureClass: failure.failureClass,
        errorTrace: reason,
      });
      this.emit('dispatcher/step.retry', args.moleculeId, args.step.id, {
        stepName,
        role: stepSpec.role,
        stepId: args.step.id,
        attempt: state.attempt,
        nextAttempt: decision.next.attempt,
        maxAttempts: policy.maxAttempts,
        failureKind: kind,
        infraRetries: decision.next.infraRetries,
        backoffMs: decision.backoffMs,
        reason,
        ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
      });
      await sleep(decision.backoffMs);
      return;
    }

    const classSuffix = failure.failureClass ? ` (failure_class=${failure.failureClass})` : '';
    const trace =
      decision.outcome === 'exhausted'
        ? `retry exhausted after ${state.attempt} of ${policy.maxAttempts} attempts${classSuffix}: ${reason}`
        : decision.outcome === 'infra_exhausted'
          ? `infra failure persisted after ${state.infraRetries} retries: ${reason}`
          : reason;
    const outcomeLabel = decision.action === 'soft_fail' ? 'soft_failed' : decision.outcome;
    await this.walker.failStep(args.step.id, trace, outcomeLabel);
    this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
      stepName,
      role: stepSpec.role,
      stepId: args.step.id,
      error: trace,
      attempts: state.attempt,
      retryOutcome: outcomeLabel,
      ...(decision.action === 'soft_fail' ? { softFail: true } : {}),
      ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
    });
    if (decision.action === 'soft_fail') {
      // Closed-failed: the graph unblocks dependents; they see the marker, not output.
      args.outputs[stepName] = softFailMarker(stepName, trace);
      return;
    }
    throw new FormulaDispatchError(`FormulaDispatcher: step "${stepName}" failed`, args.moleculeId, { cause: failure.error });
  }

  private async runStepAttempt(args: {
    readonly stepId: string;
    readonly stepName: string;
    readonly role: string;
    readonly roleConfig: RoleConfig;
    readonly moleculeId: string;
    readonly formulaName: string;
    readonly motivatingBeadId?: string;
    readonly rendered: string;
    readonly attempt: number;
    readonly infraRetries: number;
    readonly provider: RuntimeProvider;
    readonly projectIdentifier?: string;
    readonly turnTimeoutMs?: number;
    readonly workdir?: string;
  }): Promise<{ readonly text: string; readonly eventCount: number }> {
    this.emit('dispatcher/step.started', args.moleculeId, args.stepId, {
      stepName: args.stepName,
      role: args.role,
      stepId: args.stepId,
      attempt: args.attempt,
    });

    let handle: Awaited<ReturnType<RuntimeProvider['start']>> | null = null;
    let eventCount = 0;
    let output = '';
    // Did the agent do anything (text or tool use)? A failure before that is infra.
    let agentActed = false;
    try {
      await this.walker.startStep(args.stepId);
      handle = await args.provider.start({
        role: args.role,
        label: `${args.formulaName}/${args.stepName}`,
        extra: {
          moleculeId: args.moleculeId,
          stepName: args.stepName,
          formulaName: args.formulaName,
          ...(args.motivatingBeadId ? { motivatingBeadId: args.motivatingBeadId } : {}),
          attempt: args.attempt,
          infraRetries: args.infraRetries,
          stepId: args.stepId,
          memfsEnabled: false,
          memoryBlocks: args.roleConfig.memoryBlocks ?? [],
          ...(args.roleConfig.memoryBlocksPolicy?.mode === 'replace' ? { memoryBlockSeedMode: 'replace' } : {}),
          ...(args.roleConfig.tools && args.roleConfig.tools.length > 0 ? { tools: [...args.roleConfig.tools] } : {}),
          ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
          ...(args.turnTimeoutMs !== undefined ? { turnTimeoutMs: args.turnTimeoutMs } : {}),
          ...(args.workdir !== undefined ? { workdir: args.workdir } : {}),
        },
      });
      const promptResult = await args.provider.prompt(handle, [{ type: 'text', text: args.rendered }]);
      // Persist execution metadata whenever there is any: a taskId (resume
      // contract) or a conversationId. Absent fields are not written.
      // vibesync-jni4: the provider creates the conversation on the host and
      // reports its real id; that is the id the trace records.
      const traceConversationId = promptResult.conversationId;
      if (promptResult.taskId || traceConversationId) {
        await this.walker.recordStepTask(args.stepId, {
          ...(promptResult.taskId ? { taskId: promptResult.taskId } : {}),
          providerKind: handle.providerKind,
          sessionId: handle.id,
          ...(traceConversationId ? { conversationId: traceConversationId } : {}),
        });
        this.emit('dispatcher/step.task_recorded', args.moleculeId, promptResult.taskId, {
          stepName: args.stepName,
          role: args.role,
          stepId: args.stepId,
          sessionId: handle.id,
          attempt: args.attempt,
          ...(traceConversationId ? { conversationId: traceConversationId } : {}),
        });
      }
      for await (const event of args.provider.observe(handle)) {
        eventCount++;
        this.emitRuntimeSessionEvent(event, {
          moleculeId: args.moleculeId,
          stepId: args.stepId,
          stepName: args.stepName,
          role: args.role,
          attempt: args.attempt,
          providerKind: handle.providerKind,
          sessionId: handle.id,
          ...(promptResult.taskId ? { taskId: promptResult.taskId } : {}),
          ...(traceConversationId ? { conversationId: traceConversationId } : {}),
          ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
        });
        if (event.kind === 'message-delta') {
          output += event.text;
          if (event.text.length > 0) agentActed = true;
        }
        if (event.kind === 'tool-call' || event.kind === 'tool-result') agentActed = true;
        if (event.kind === 'error') {
          throw new AttemptFailure(event.message, { origin: 'event', code: event.code, producedOutput: agentActed });
        }
        if (event.kind === 'stopped') {
          throw new AttemptFailure('runtime stopped before turn completion', { origin: 'stopped' });
        }
        if (event.kind === 'turn-done') {
          // vibesync-uuas: a turn that ended on requires_approval did NOT
          // do the work — the agent halted waiting for an approver that
          // never comes on the headless dispatch path. Treating it as
          // success closes the step green with empty output (silent
          // failure). Fail the step instead so retries/visibility kick in.
          if (event.stopReason === 'requires_approval') {
            throw new AttemptFailure(
              'runtime halted on requires_approval — no approver attached for headless dispatch; ' +
                'the Agent/tool call never executed (set SHIM_PERMISSION_MODE=bypassPermissions on the shim)',
              { origin: 'event', code: 'requires_approval', producedOutput: agentActed },
            );
          }
          break;
        }
      }
      return { text: output, eventCount };
    } finally {
      if (handle) await args.provider.stop(handle);
    }
  }

  private async resumeStep(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
  }): Promise<void> {
    const stepName = readStepName(args.step);
    const role = readStepRole(args.step);
    const exec = readExec(args.step);
    const taskId = readString(exec.task_id);
    if (!taskId) {
      const error = `FormulaDispatcher.resume: running step ${args.step.id} has no metadata.exec.task_id`;
      await this.walker.failStep(args.step.id, error);
      this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, { stepName, role, stepId: args.step.id, error });
      throw new FormulaDispatchError(error, args.moleculeId);
    }

    let handle: SessionHandle | null = null;
    let eventCount = 0;
    let output = '';
    try {
      handle = await this.provider.start({
        role,
        label: `resume/${args.moleculeId}/${stepName}`,
        extra: {
          moleculeId: args.moleculeId,
          stepName,
          resumeTaskId: taskId,
          memfsEnabled: false,
        },
      });
      this.emit('dispatcher/step.reattached', args.moleculeId, taskId, {
        stepName,
        role,
        stepId: args.step.id,
        sessionId: handle.id,
      });
      for await (const event of this.provider.observe(handle)) {
        eventCount++;
        this.emitRuntimeSessionEvent(event, {
          moleculeId: args.moleculeId,
          stepId: args.step.id,
          stepName,
          role,
          providerKind: handle.providerKind,
          sessionId: handle.id,
          taskId,
          resumed: true,
        });
        if (event.kind === 'message-delta') output += event.text;
        if (event.kind === 'error') throw new Error(event.message);
        if (event.kind === 'stopped') throw new Error('runtime stopped before turn completion');
        if (event.kind === 'turn-done') break;
      }
      // vibesync-zvcm: a resumed step that reports itself blocked fails like a
      // fresh one; the catch below closes it failed and aborts the molecule.
      const blocker = parseBlockedOutcome(output);
      if (blocker !== null) throw new StepBlockedError(blocker);
      args.outputs[stepName] = output;
      await this.walker.finishStep(args.step.id, { output, eventCount, resumed: true });
      this.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
        stepName,
        role,
        stepId: args.step.id,
        outputLength: output.length,
        resumed: true,
      });
    } catch (error) {
      const retryOutcome = error instanceof StepBlockedError ? 'not_retryable' : undefined;
      await this.walker.failStep(args.step.id, stringifyError(error), retryOutcome);
      this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
        stepName,
        role,
        stepId: args.step.id,
        error: stringifyError(error),
        resumed: true,
        ...(retryOutcome ? { retryOutcome } : {}),
      });
      throw new FormulaDispatchError(`FormulaDispatcher: resumed step "${stepName}" failed`, args.moleculeId, { cause: error });
    } finally {
      if (handle) await this.provider.stop(handle);
    }
  }

  private emit(kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>): void {
    this.eventBus.emit({
      layer: 'dispatcher',
      kind,
      ...(moleculeId ? { molecule_id: moleculeId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      payload,
    });
  }

  private emitRuntimeSessionEvent(event: SessionEvent, context: RuntimeSessionEventContext): void {
    this.eventBus.emit({
      layer: 'runtime',
      kind: `runtime/session.${event.kind.replace(/-/g, '_')}`,
      molecule_id: context.moleculeId,
      ...(context.taskId ? { task_id: context.taskId } : {}),
      teammate: context.role,
      payload: {
        ...sessionEventPayload(event),
        stepId: context.stepId,
        stepName: context.stepName,
        role: context.role,
        providerKind: context.providerKind,
        sessionId: context.sessionId,
        ...(context.attempt ? { attempt: context.attempt } : {}),
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.projectIdentifier ? { projectIdentifier: context.projectIdentifier } : {}),
        ...(context.resumed ? { resumed: true } : {}),
      },
    });
  }
}

interface RuntimeSessionEventContext {
  readonly moleculeId: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly role: string;
  readonly providerKind: string;
  readonly sessionId: string;
  readonly attempt?: number;
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly projectIdentifier?: string;
  readonly resumed?: boolean;
}

function sessionEventPayload(event: SessionEvent): Readonly<Record<string, unknown>> {
  switch (event.kind) {
    case 'started':
    case 'first-token':
    case 'stopped':
      return { eventKind: event.kind, ts: event.ts };
    case 'message-delta':
      return { eventKind: event.kind, ts: event.ts, text: event.text, textLength: event.text.length };
    case 'tool-call':
      return { eventKind: event.kind, ts: event.ts, tool: event.tool, args: event.args };
    case 'tool-result':
      return { eventKind: event.kind, ts: event.ts, tool: event.tool, result: event.result, ok: event.ok };
    case 'usage':
      return { eventKind: event.kind, ts: event.ts, prompt: event.prompt, completion: event.completion };
    case 'turn-done':
      return { eventKind: event.kind, ts: event.ts, ...(event.stopReason ? { stopReason: event.stopReason } : {}) };
    case 'error':
      return { eventKind: event.kind, ts: event.ts, code: event.code, message: event.message };
  }
}

function renderContext(input: string, outputs: Readonly<Record<string, string>>): Readonly<Record<string, string | number | boolean>> {
  const context: Record<string, string> = {
    input,
    prior_outputs: formatPriorOutputs(outputs),
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

/** A failed try with the structured signal the retry policy classifies on (never the message text). */
/** A step's reply ended with the structured blocked line (vibesync-zvcm). */
class StepBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`step blocked: ${reason}`);
    this.name = 'StepBlockedError';
  }
}

class AttemptFailure extends Error {
  constructor(message: string, readonly signal: FailureSignal) {
    super(message);
    this.name = 'AttemptFailure';
  }
}

function retryStateKey(state: RetryState): string {
  return `${state.attempt}.${state.infraRetries}`;
}

/** What a dependent's prompt sees in place of the output of a step that soft-failed. */
function softFailMarker(stepName: string, errorTrace: string): string {
  return `[step "${stepName}" soft-failed and produced no output: ${errorTrace}]`;
}

function readStepName(row: BeadRow): string {
  const exec = readExec(row);
  if (!('step' in exec) || typeof exec.step !== 'string') {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing metadata.exec.step`);
  }
  return exec.step;
}

function readStepRole(row: BeadRow): string {
  const match = /] (.+)$/.exec(row.title);
  if (!match?.[1]) {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing role in title`);
  }
  return match[1];
}

function outputsFromClosedSteps(steps: readonly BeadRow[]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const step of steps) {
    if (step.status !== 'closed') continue;
    const stepName = readStepName(step);
    const payload = readExec(step).output_payload;
    if (payload && typeof payload === 'object' && 'output' in payload && typeof payload.output === 'string') {
      outputs[stepName] = payload.output;
    } else if (step.metadata['gc.retry_outcome'] === 'soft_failed') {
      outputs[stepName] = softFailMarker(stepName, readString(readExec(step).error_trace) ?? 'soft_fail');
    }
  }
  return outputs;
}

function readExec(row: BeadRow): Record<string, unknown> {
  const exec = row.metadata.exec;
  return exec && typeof exec === 'object' ? exec as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * vibesync-u32z: recover the motivating bead id from a molecule_root row's
 * exec metadata. Used by resume() (where the original DispatchInput is not in
 * scope) so the completion event can still carry the motivating bead.
 */
function readMotivatingBead(row: BeadRow): string | null {
  return readString(readExec(row)['motivating_bead']);
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

