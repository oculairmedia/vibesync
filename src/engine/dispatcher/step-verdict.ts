import type { MoleculeWalker, StepSpec } from '../molecule/index.js';
import { newMoleculeStepId } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import { decideStepVerdict, reconcileWithMarker, settleCi, summarizeReplyForReason, type FinalStepVerdict, type CiOutcome, type StepReplyJudge, type StepVerdict } from '../verdict/index.js';
import { readReviewRound } from '../retry/index.js';
import { parseBlockedOutcome } from './step-outcome.js';
import { candidatePullRequests, repositoryOf, type ShippedWorkProbe } from './delivery.js';
import type { ProjectBinding, ProjectBindingResolver } from './project-binding-types.js';
import { UnknownProjectError } from './project-binding.js';
import { FormulaDispatchError, type DispatchInput, type PrChecksOptions } from './types.js';
import { sleep, stringifyError } from './util.js';

export interface StepVerdictDeps {
  readonly walker: MoleculeWalker;
  readonly emit: (kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>) => void;
  readonly stepJudge: StepReplyJudge | null;
  readonly projectBindings: ProjectBindingResolver;
}

export class StepVerdictReader {
  constructor(private readonly deps: StepVerdictDeps) {}

  /**
   * vibesync-9lzk.39: the blocker a step's reply carries, or null. Steps that
   * judge work (a looping step such as the reviewer, or the formula's last
   * step such as the tester) are read by the decision model when one is
   * configured; every other step keeps the marker line. A judge failure is an
   * error (the step fails), never a silent "not blocked". An unsettled reading
   * fails closed with the reply attached.
   */
  async readStepBlocker(args: {
    readonly input: DispatchInput;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepSpec: StepSpec;
    readonly stepName: string;
    readonly output: string;
    readonly outputs?: Readonly<Record<string, string>>;
      readonly projectIdentifier?: string;
  }): Promise<string | null> {
    const marker = parseBlockedOutcome(args.output);
    const steps = args.input.formula.steps;
    const finalStep = isFinalFormulaStep(steps, args.stepName);
    const judges = args.stepSpec.loopsBackTo !== undefined || finalStep;
    // vibesync-9lzk.55.4: a project that names no CI checks has no definition of green, so its
    // final step never completes, whether or not a judge is configured and whether or not the
    // reply names a PR.
    if (finalStep && !marker) {
      const noChecks = this.noChecksConfigured(args.input.projectIdentifier);
      if (noChecks) return noChecks;
    }
    if (!this.deps.stepJudge || !judges) return marker;
    return this.judgeStepBlocker({
      step: args.step,
      moleculeId: args.moleculeId,
      stepSpec: args.stepSpec,
      stepName: args.stepName,
      output: args.output,
      ...(args.outputs ? { outputs: args.outputs } : {}),
      ...(args.input.projectIdentifier ? { projectIdentifier: args.input.projectIdentifier } : {}),
      marker,
      finalStep,
    });
  }

  /** The blocker for a project whose binding names no CI checks, or null when it names some (or has no reader at all). */
  private noChecksConfigured(projectIdentifier: string | undefined): string | null {
    let cfg: PrChecksOptions | null;
    try {
      cfg = this.deps.projectBindings(projectIdentifier).prChecks;
    } catch {
      return null; // the binding error is reported by the CI settlement, on the judge path
    }
    return cfg && cfg.names.length === 0
      ? 'the project names no CI checks (no CI checks configured in .meridian/project.json), so the final step cannot be confirmed'
      : null;
  }

  private async judgeStepBlocker(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepSpec: StepSpec;
    readonly stepName: string;
    readonly output: string;
    readonly outputs?: Readonly<Record<string, string>>;
    readonly projectIdentifier?: string;
    readonly marker: string | null;
    readonly finalStep: boolean;
  }): Promise<string | null> {
    const judged = await this.deps.stepJudge!.judge({ role: args.stepSpec.role, reply: args.output });
    const summary = args.marker ?? summarizeReplyForReason(args.output);
    const judgedVerdict: FinalStepVerdict = reconcileWithMarker(decideStepVerdict(judged.answers, summary, { finalStep: args.finalStep }), args.marker);
    this.deps.emit('dispatcher/step.verdict', args.moleculeId, args.step.id, {
      stepName: args.stepName, role: args.stepSpec.role, stepId: args.step.id,
      verdict: judgedVerdict.kind, answers: judged.answers, model: judged.model, inputTokens: judged.inputTokens, marker: args.marker !== null,
    });
    const verdict: StepVerdict = judgedVerdict.kind === 'check_ci'
      ? await this.settleFinalStepCi({ ...args, reason: judgedVerdict.reason, from: judgedVerdict.from, summary })
      : judgedVerdict;
    switch (verdict.kind) {
      case 'approve': return null;
      case 'changes_requested': return verdict.reason;
      case 'await_ci': return `${verdict.reason}; a reply that only waits on CI is not a block: wait for the checks, then judge the finished result`;
      case 'unsettled': return `verdict unsettled (fail closed): ${verdict.reason}`;
    }
  }

  /**
   * vibesync-9lzk.46: the final step's CI verdict comes from the delivered PR's
   * real checks (the configured fast checks only), never from the reply's
   * wording. Pending waits (polled, capped); any failed check is a change
   * request; all green approves. With no PR or no reader it fails closed.
   */
  private async settleFinalStepCi(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepName: string;
    readonly output: string;
    readonly outputs?: Readonly<Record<string, string>>;
    readonly projectIdentifier?: string;
    readonly reason: string;
    readonly from: 'approve' | 'pending';
    readonly summary: string;
  }): Promise<StepVerdict> {
    const prUrl = candidatePullRequests({ ...(args.outputs ?? {}), [args.stepName]: args.output }).at(-1);
    let cfg: PrChecksOptions | null;
    try {
      const binding = this.deps.projectBindings(args.projectIdentifier);
      cfg = binding.prChecks;
      const foreign = cfg && prUrl ? await foreignRepository(prUrl, binding) : null;
      if (foreign !== null) return { kind: 'unsettled', reason: `${args.reason}, but ${foreign}: ${args.summary}` };
    } catch (err) {
      return { kind: 'unsettled', reason: `${args.reason}, but project binding failed (${stringifyError(err)}): ${args.summary}` };
    }
    if (this.canApproveWithoutReadableCi(args.from, prUrl, cfg)) return { kind: 'approve' };
    if (!cfg || !prUrl) return this.unreadableCiVerdict(args, prUrl);
    return this.readFinalStepCi({
      step: args.step, moleculeId: args.moleculeId, stepName: args.stepName,
      prUrl, reason: args.reason, summary: args.summary, cfg,
    });
  }

  private canApproveWithoutReadableCi(from: 'approve' | 'pending', prUrl: string | undefined, cfg: PrChecksOptions | null): boolean {
    return from === 'approve' && (!cfg || !prUrl);
  }

  private async readFinalStepCi(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly stepName: string;
    readonly prUrl: string;
    readonly reason: string;
    readonly summary: string;
    readonly cfg: PrChecksOptions;
  }): Promise<StepVerdict> {
    const { cfg, prUrl } = args;
    let outcome;
    try {
      outcome = await settleCi(cfg.reader, prUrl, {
        names: cfg.names, pollMs: cfg.pollMs ?? 20_000, maxWaitMs: cfg.maxWaitMs ?? 10 * 60_000, sleep, now: () => Date.now(),
      });
    } catch (err) {
      return { kind: 'unsettled', reason: `${args.reason}, but reading the PR checks failed (${stringifyError(err)}): ${args.summary}` };
    }
    this.deps.emit('dispatcher/step.ci_checks', args.moleculeId, args.step.id, { stepName: args.stepName, prUrl, checks: cfg.names, outcome: outcome.kind, ...(outcome.kind === 'failed' ? { failed: outcome.failed } : {}), ...(outcome.kind === 'still_pending' ? { pending: outcome.pending } : {}) });
    return ciOutcomeVerdict(outcome, prUrl);
  }

  private unreadableCiVerdict(
    args: { readonly reason: string; readonly from: 'approve' | 'pending'; readonly summary: string },
    prUrl: string | undefined,
  ): StepVerdict {
    return { kind: 'unsettled', reason: `${args.reason}, but the PR checks cannot be read (${!prUrl ? 'no PR URL in the run outputs' : 'no PR checks reader configured'}): ${args.summary}` };
  }

  /**
   * vibesync-9lzk.24: send the work back to `loopsBackTo` for another round.
   * The reviewing step itself is finished (its verdict is its output) and
   * reopened for the next round together with the target and every step
   * between them, so the bead graph re-runs the chain: coder -> reviewer ->
   * ... The round counter lives on the TARGET step bead, so the cap survives
   * a restart. Returns 'exhausted' once `maxRounds` rounds ended blocked.
   */
  async loopBack(args: {
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
    const targetBead = await this.deps.walker.readStep(targetId);
    if (!isEarlierLoopTarget(targetIdx, selfIdx, targetBead)) {
      throw new FormulaDispatchError(`FormulaDispatcher: step "${args.stepName}" loops back to "${target}", which is not an earlier step of this molecule`, args.moleculeId);
    }
    const round = readReviewRound(targetBead.metadata);
    this.deps.emit('dispatcher/step.review_blocked', args.moleculeId, args.step.id, {
      stepName: args.stepName, role: args.stepSpec.role, stepId: args.step.id, loopsBackTo: target, round, maxRounds, reason: args.blocker,
    });
    if (round >= maxRounds) {
      this.emitReviewExhausted(args, target, round, maxRounds);
      return 'exhausted';
    }
    // The verdict travels to the next round in memory (outputs.review, below), not
    // on the bead. The reviewer is NOT closed here (vibesync-9lzk.58): a closed
    // reviewer makes the step after it ready for as long as the reopens below
    // take, and the engine's 1 s step loop starts it there. reopenLoopSteps
    // reopens the round, reviewer included, from the reviewer's current state.
    args.outputs[args.stepName] = args.output;
    const note = `Round ${round} review (${args.stepName}) requested changes: ${args.blocker}`;
    await this.reopenLoopSteps({
      steps, targetIdx, selfIdx, step: args.step, moleculeId: args.moleculeId,
      outputs: args.outputs, stepName: args.stepName, output: args.output,
      note, round, target, maxRounds,
    });
    return 'reopened';
  }

  private async reopenLoopSteps(args: {
    readonly steps: readonly StepSpec[];
    readonly targetIdx: number;
    readonly selfIdx: number;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly stepName: string;
    readonly output: string;
    readonly note: string;
    readonly round: number;
    readonly target: string;
    readonly maxRounds: number;
  }): Promise<void> {
    const reopened = args.steps.slice(args.targetIdx, args.selfIdx + 1);
    // Reopen target..self (inclusive) in formula order so the chain re-runs.
    // Later steps that have not run stay open; earlier ones stay closed.
    for (const spec of reopened) {
      const id = newMoleculeStepId(args.moleculeId, spec.name);
      await this.deps.walker.reopenStepForRound(id, { round: args.round + 1, note: args.note });
      delete args.outputs[spec.name];
    }
    // The review text travels to the next round as a prior output under a
    // stable name, so the coder prompt can read it (prior_review).
    args.outputs['review'] = `${args.note}\n\n${args.output}`;
    this.deps.emit('dispatcher/step.loop_back', args.moleculeId, args.step.id, {
      stepName: args.stepName, loopsBackTo: args.target, round: args.round + 1,
      maxRounds: args.maxRounds, reopened: reopened.map((s) => s.name),
    });
  }

  private emitReviewExhausted(
    args: { readonly moleculeId: string; readonly step: BeadRow; readonly stepName: string; readonly blocker: string },
    target: string,
    round: number,
    maxRounds: number,
  ): void {
    // The reviewing step closes blocked like any other; the caller fails the run.
    this.deps.emit('dispatcher/formula.review_exhausted', args.moleculeId, args.step.id, {
      stepName: args.stepName, loopsBackTo: target, rounds: round, maxRounds, reason: args.blocker,
    });
  }

  /**
   * Why a plan-only step overstepped its role, or null. A step that opened a
   * PR naming the work bead did the coder's job. A probe failure is reported
   * as an event and does not fail the step: the check is a guard, and an
   * unreachable GitHub must not stop planning.
   */
  async planOnlyViolation(
    bead: string | undefined,
    since: Date,
    context: { readonly moleculeId: string; readonly stepId: string; readonly projectIdentifier?: string },
  ): Promise<string | null> {
    if (!bead) return null;
    try {
      const probe: ShippedWorkProbe | null = this.deps.projectBindings(context.projectIdentifier).shippedWorkProbe;
      if (!probe) return null;
      const prs = await probe.pullRequestsOpenedSince(bead, since);
      if (prs.length === 0) return null;
      return `plan-only step shipped work: it opened ${prs.join(', ')} for ${bead}; planning steps must not edit, commit, push or open pull requests`;
    } catch (error) {
      this.deps.emit('dispatcher/plan-only.check_failed', context.moleculeId, context.stepId, { bead, error: stringifyError(error) });
      // An unreachable GitHub must not stop planning; a project with no checkout is not an outage.
      return error instanceof UnknownProjectError ? `plan-only check cannot run: ${error.message}` : null;
    }
  }
}

function ciOutcomeVerdict(outcome: CiOutcome, prUrl: string): StepVerdict {
  switch (outcome.kind) {
    case 'green': return { kind: 'approve' };
    case 'failed': return { kind: 'changes_requested', reason: `required check(s) failed on ${prUrl}: ${outcome.failed.join(', ')}` };
    case 'still_pending': return { kind: 'unsettled', reason: `required check(s) still pending on ${prUrl} after the wait cap: ${outcome.pending.join(', ')}` };
  }
}

function isFinalFormulaStep(steps: readonly StepSpec[], stepName: string): boolean {
  return steps[steps.length - 1]?.name === stepName;
}

function isEarlierLoopTarget(targetIdx: number, selfIdx: number, targetBead: BeadRow | null): targetBead is BeadRow {
  return targetIdx >= 0 && selfIdx > targetIdx && targetBead !== null;
}

/**
 * Why CI must not be read from `prUrl` for this binding, or null when it may.
 * A reply can name any pull request; only one in the run's own repository
 * counts. A binding that names no repository (a caller-supplied reader) is not
 * checked here.
 */
async function foreignRepository(prUrl: string, binding: ProjectBinding): Promise<string | null> {
  if (!binding.repository) return null;
  const expected = (await binding.repository()).toLowerCase();
  return repositoryOf(prUrl) === expected ? null : `${prUrl} is not in the project repository ${expected}`;
}
