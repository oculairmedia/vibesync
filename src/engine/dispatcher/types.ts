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

export type StepRunArgs = {
  readonly input: DispatchInput;
  readonly step: BeadRow;
  readonly moleculeId: string;
  readonly outputs: Record<string, string>;
  readonly rolesByName: ReadonlyMap<string, RoleConfig>;
  readonly provider: RuntimeProvider;
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
};
