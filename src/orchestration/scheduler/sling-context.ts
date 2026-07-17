/**
 * Sling-context bead layer (vibesync-63zx.1) — the atomic-claim foundation of
 * the Gas Town scheduler port (see .gastown-reference/scheduler.md).
 *
 * A *sling context* is a SEPARATE ephemeral bead (label `vibesync:sling-context`)
 * with a `tracks` dependency to the work bead. All scheduling parameters live
 * as JSON (version 1) in the context bead's description. The work bead is
 * NEVER modified by the scheduler.
 *
 * Atomic-claim invariant (the whole point): because scheduling state lives on
 * a distinct bead created in a single atomic operation, a work bead can be
 * claimed exactly once. `scheduleBead()` is idempotent — if an OPEN context
 * already tracks the work bead, it is returned instead of creating a second.
 * This prevents trampling and double-dispatch when multiple scheduler ticks or
 * callers race.
 *
 * Lifecycle: open context = SCHEDULED; closeContext(reason) → CLOSED where
 * reason ∈ dispatched | circuit-broken | cleared. Closing is terminal.
 *
 * This module owns ONLY the sling-context layer. The persistent pool
 * (63zx.2), scheduler loop / PlanDispatch (63zx.3), and propulsion (63zx.4)
 * are separate, downstream slices and are intentionally NOT implemented here.
 */

/** Label every sling-context bead carries; the query key for open contexts. */
export const SLING_CONTEXT_LABEL = 'vibesync:sling-context';

/** Current sling-context JSON schema version. */
export const SLING_CONTEXT_VERSION = 1 as const;

/** Reasons a sling context may be closed. Maps to the state machine terminals. */
export type SlingCloseReason = 'dispatched' | 'circuit-broken' | 'cleared';

/** Circuit-breaker threshold: consecutive dispatch failures that trip a close. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * The scheduling parameters persisted (as JSON) in a sling context's
 * description. `version` gates forward/backward migration. Field set follows
 * the vibesync-63zx.1 bead + scheduler.md (VibeSync naming: target_project,
 * not Gas Town's target_rig).
 */
export interface SlingContextParams {
  readonly version: typeof SLING_CONTEXT_VERSION;
  readonly work_bead_id: string;
  readonly target_project: string;
  readonly formula: string;
  readonly args: string;
  /** Newline-separated formula variables (`key=value`). */
  readonly vars: string;
  /** RFC3339 timestamp of when the bead was scheduled. */
  readonly enqueued_at: string;
  /** Merge strategy applied at completion. */
  readonly merge: 'direct' | 'mr' | 'local';
  /** Convoy bead id, when this schedule is part of a convoy. */
  readonly convoy: string;
  /** Consecutive dispatch failures (circuit breaker input). */
  readonly dispatch_failures: number;
  /** Most recent dispatch error message. */
  readonly last_failure: string;
}

/** A materialized sling-context bead. */
export interface SlingContextRecord {
  /** The sling-context bead id (NOT the work bead id). */
  readonly id: string;
  /** open = SCHEDULED; closed = terminal. */
  readonly status: 'open' | 'closed';
  /** The parsed scheduling params (from the bead description JSON). */
  readonly params: SlingContextParams;
  /** Close reason when status === 'closed'. */
  readonly closeReason?: SlingCloseReason;
}

/**
 * The narrow store surface the sling-context layer needs. Deliberately minimal
 * and free of any Dolt/SQL specifics so it is testable with an in-memory fake
 * and portable to the Kotlin embedded store later. The production adapter is
 * backed by the beads/Dolt store (a separate binding, not this module's
 * concern).
 *
 * CONTRACT: no method here may read or mutate the WORK bead. The store only
 * ever creates/queries/closes sling-context beads and the `tracks` edge. This
 * is what makes the work bead pristine (atomic-claim invariant).
 */
export interface SlingContextStore {
  /**
   * Atomically create a single sling-context bead: an ephemeral bead labelled
   * SLING_CONTEXT_LABEL, with `description` = JSON(params) and a `tracks`
   * dependency to params.work_bead_id. Returns the new context bead id.
   * MUST NOT touch the work bead.
   */
  createSlingContext(input: {
    readonly label: string;
    readonly title: string;
    readonly description: string;
    readonly tracksWorkBeadId: string;
  }): Promise<string>;

  /**
   * Return all OPEN sling-context beads (status='open', labelled
   * SLING_CONTEXT_LABEL). Each carries its raw description JSON for parsing.
   */
  listOpenSlingContexts(label: string): Promise<ReadonlyArray<{
    readonly id: string;
    readonly description: string;
  }>>;

  /**
   * Close a sling-context bead with the given reason. Terminal. MUST NOT touch
   * the work bead.
   */
  closeSlingContext(contextId: string, reason: SlingCloseReason): Promise<void>;
}

/** Everything a caller must supply to schedule a work bead (minus derived fields). */
export interface ScheduleBeadInput {
  readonly workBeadId: string;
  readonly targetProject: string;
  readonly formula: string;
  readonly args?: string;
  readonly vars?: string;
  readonly merge?: 'direct' | 'mr' | 'local';
  readonly convoy?: string;
}

/** Result of scheduleBead: the context and whether it was newly created. */
export interface ScheduleResult {
  readonly context: SlingContextRecord;
  /** false when an OPEN context already existed for the work bead (idempotent skip). */
  readonly created: boolean;
}

export interface SlingContextManagerDeps {
  readonly store: SlingContextStore;
  /** Injectable clock so tests can pin enqueued_at. Defaults to Date. */
  readonly now?: () => Date;
}

/**
 * The sling-context layer. Ops: scheduleBead (idempotent), queryPending,
 * closeContext. Everything is expressed against SlingContextStore so this is
 * pure orchestration logic — no store internals leak in.
 */
export class SlingContextManager {
  private readonly store: SlingContextStore;
  private readonly now: () => Date;

  constructor(deps: SlingContextManagerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Schedule a work bead for deferred dispatch by creating a sling context.
   *
   * IDEMPOTENT: if an OPEN sling context already tracks this work bead, no new
   * context is created — the existing one is returned with created=false. This
   * is the double-dispatch / trample guard: the work bead can be claimed once.
   */
  async scheduleBead(input: ScheduleBeadInput): Promise<ScheduleResult> {
    const existing = await this.findOpenContextForWorkBead(input.workBeadId);
    if (existing) {
      return { context: existing, created: false };
    }

    const params: SlingContextParams = {
      version: SLING_CONTEXT_VERSION,
      work_bead_id: input.workBeadId,
      target_project: input.targetProject,
      formula: input.formula,
      args: input.args ?? '',
      vars: input.vars ?? '',
      enqueued_at: this.now().toISOString(),
      merge: input.merge ?? 'direct',
      convoy: input.convoy ?? '',
      dispatch_failures: 0,
      last_failure: '',
    };

    const id = await this.store.createSlingContext({
      label: SLING_CONTEXT_LABEL,
      title: `[sling-context] ${input.workBeadId} → ${input.targetProject}/${input.formula}`,
      description: serializeParams(params),
      tracksWorkBeadId: input.workBeadId,
    });

    return {
      context: { id, status: 'open', params },
      created: true,
    };
  }

  /**
   * Query all pending (open = SCHEDULED) sling contexts. Malformed contexts
   * (undeserializable description) are skipped rather than throwing, so one
   * corrupt bead cannot wedge the whole scheduler.
   */
  async queryPending(): Promise<SlingContextRecord[]> {
    const rows = await this.store.listOpenSlingContexts(SLING_CONTEXT_LABEL);
    const out: SlingContextRecord[] = [];
    for (const row of rows) {
      const params = tryParseParams(row.description);
      if (!params) continue;
      out.push({ id: row.id, status: 'open', params });
    }
    return out;
  }

  /** Close a sling context (terminal). Does not touch the work bead. */
  async closeContext(contextId: string, reason: SlingCloseReason): Promise<void> {
    await this.store.closeSlingContext(contextId, reason);
  }

  private async findOpenContextForWorkBead(workBeadId: string): Promise<SlingContextRecord | null> {
    const pending = await this.queryPending();
    return pending.find((ctx) => ctx.params.work_bead_id === workBeadId) ?? null;
  }
}

/** Serialize params to the description JSON persisted on the context bead. */
export function serializeParams(params: SlingContextParams): string {
  return JSON.stringify(params);
}

/**
 * Parse+validate a context description into params. Returns null on any
 * malformed / wrong-version payload (callers skip rather than throw).
 */
export function tryParseParams(description: string): SlingContextParams | null {
  let raw: unknown;
  try {
    raw = JSON.parse(description);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== SLING_CONTEXT_VERSION) return null;
  if (typeof o['work_bead_id'] !== 'string' || o['work_bead_id'].length === 0) return null;
  if (typeof o['target_project'] !== 'string') return null;
  if (typeof o['formula'] !== 'string') return null;
  return {
    version: SLING_CONTEXT_VERSION,
    work_bead_id: o['work_bead_id'],
    target_project: o['target_project'],
    formula: o['formula'],
    args: typeof o['args'] === 'string' ? o['args'] : '',
    vars: typeof o['vars'] === 'string' ? o['vars'] : '',
    enqueued_at: typeof o['enqueued_at'] === 'string' ? o['enqueued_at'] : '',
    merge: o['merge'] === 'mr' || o['merge'] === 'local' ? o['merge'] : 'direct',
    convoy: typeof o['convoy'] === 'string' ? o['convoy'] : '',
    dispatch_failures: typeof o['dispatch_failures'] === 'number' ? o['dispatch_failures'] : 0,
    last_failure: typeof o['last_failure'] === 'string' ? o['last_failure'] : '',
  };
}
