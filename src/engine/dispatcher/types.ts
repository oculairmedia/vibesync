import type { Formula } from '../formula/index.js';
import type { StepSpec } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { Pack, RoleConfig } from '../packs/index.js';
import type { RuntimeProvider } from '../runtime/index.js';
import type { PrChecksReader } from '../verdict/index.js';
import type { FailureKind, FailureSignal, ResolvedRetryPolicy, RetryState } from '../retry/index.js';
export interface PrChecksOptions {
  readonly reader: PrChecksReader;
  readonly names: readonly string[];
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
}

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
  resolve(input: { readonly projectIdentifier?: string }): Promise<RuntimeProvider | null> | RuntimeProvider | null;
}

export interface DispatchResult {
  readonly moleculeId: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface CancelResult {
  readonly moleculeId: string;
  readonly cancelledStepCount: number;
}

export type StepRunArgs = {
  readonly input: DispatchInput;
  readonly workdir?: string;
  readonly step: BeadRow;
  readonly moleculeId: string;
  readonly outputs: Record<string, string>;
  readonly rolesByName: ReadonlyMap<string, RoleConfig>;
  readonly provider: RuntimeProvider;
  /**
   * True once the run has been told to cancel (MoleculeRun.cancelled). The step
   * turn asks before every write: under a cancelled run it writes nothing, and
   * cancel() records the step once the turn has returned (vibesync-6zos.3).
   */
  readonly cancelled: () => boolean;
  /**
   * The turn found its step closed under it by someone else (bd refused the start and this run was not cancelled).
   * The run must then end through its root, never as completed (fourth outside review of PR #188).
   */
  readonly closedUnder?: () => void;
  /**
   * The turn found its step held by someone else (bd refused the start because the step is in_progress: another
   * dispatcher claimed it). That owner runs it and closes the root; this run stops, writing nothing (CodeRabbit on
   * PR #188: treating this as closedUnder made the run close the root and sweep the owner's active step).
   */
  readonly claimedElsewhere?: () => void;
};

export type StepRunFailure = { readonly signal: FailureSignal; readonly error: unknown; readonly failureClass: string | null; readonly code?: string };

export interface StepFailureContext {
  readonly stepRun: StepRunContext;
  readonly policy: ResolvedRetryPolicy;
  readonly state: RetryState;
  readonly failure: StepRunFailure;
  readonly kind: FailureKind;
  readonly reason: string;
}

export interface StepRunContext {
  readonly args: StepRunArgs;
  readonly stepSpec: StepSpec;
  readonly stepName: string;
  readonly roleConfig: RoleConfig;
}

export interface ResumedDeliveryArgs {
  readonly root: BeadRow;
  readonly moleculeId: string;
  readonly outputs: Record<string, string>;
  readonly startedAt: number;
  readonly motivatingBeadId: string | null;
}

export interface QueuedMoleculeRun {
  readonly input: DispatchInput;
  readonly resolve: () => void;
}

/** In-process run context of one cooked molecule (formula, pack, input, outputs). */
export interface MoleculeRun {
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
  /**
   * Step beads with a turn of this process in flight. While a step is here its
   * turn is the ONLY writer of its record: cancel() waits for the turn to
   * return (it writes nothing once the run is cancelled) before it records the
   * step as cancelled.
   */
  readonly inFlight: Set<string>;
  /**
   * True while cancel() is still stopping sessions, waiting for turns, recording
   * steps and closing the root. The run is not settled (its run() caller is not
   * told) until this is false again: the stopped turns return in the middle of
   * cancel(), and a caller told then would read a root that is still open.
   */
  cancelInProgress: boolean;
  running: number;
  failed: boolean;
  failure: unknown;
  /** Never cleared once set: a turn that saw it has given its step up to cancel() (outside review of PR #188). */
  cancelled: boolean;
  /** The root has been closed as cancelled (by cancel() or, if that failed part-way, by settlement). */
  rootClosed: boolean;
  /** A step of this run was closed by someone else (another dispatcher's sweep): the run ends through its root. */
  closedUnder: boolean;
  /** A step of this run is held by another dispatcher: this run stops without writing; the owner settles the root. */
  claimedElsewhere: boolean;
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

/**
 * vibesync-9lzk.43: a run that stopped on purpose, waiting for a person: a
 * step reported itself blocked, a verdict failed closed, or the review loop
 * ran out of rounds. Retrying it would restart work a reviewer rejected, so
 * the scheduler must not treat it as a retryable dispatch failure.
 */
export class FormulaEscalationError extends FormulaDispatchError {
  constructor(message: string, moleculeId: string, options: { readonly cause?: unknown } = {}) {
    super(message, moleculeId, options);
    this.name = 'FormulaEscalationError';
  }
}

export class FormulaCancellationConflictError extends FormulaDispatchError {
  constructor(message: string, moleculeId: string) {
    super(message, moleculeId);
    this.name = 'FormulaCancellationConflictError';
  }
}

export class StepBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`step blocked: ${reason}`);
    this.name = 'StepBlockedError';
  }
}

export class AttemptFailure extends Error {
  constructor(message: string, readonly signal: FailureSignal, readonly code?: string) {
    super(message);
    this.name = 'AttemptFailure';
  }
}

export interface RuntimeSessionEventContext {
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

/** What one provider attempt produced: the reply text and how many session events it took. */
export interface StepAttemptOutput {
  readonly text: string;
  readonly eventCount: number;
  /**
   * True when no session was started or its turn was abandoned: bd refused the start (the step is no longer open),
   * or the run was cancelled. There is no agent reply; the turn must not judge or write anything (third outside
   * review of PR #188: an empty reply was judged and written when another dispatcher had closed the step).
   */
  readonly notStarted?: true;
}

export type StepAttemptArgs = {
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
  readonly reviewRound: number;
  readonly provider: RuntimeProvider;
  readonly projectIdentifier?: string;
  readonly turnTimeoutMs?: number;
  readonly workdir?: string;
  /** True once the run is cancelled: the attempt then writes nothing more on the step (outside review of PR #188). */
  readonly cancelled?: () => boolean;
};
