/**
 * Persistent agent pool (vibesync-63zx.2) — the rate-limit governor of the
 * Gas Town scheduler port (see .gastown-reference/pool.md).
 *
 * A pool holds a FIXED number of slots per project (`poolSize`). That fixed
 * size is the concurrency CAP — the cost ceiling that is independent of how
 * deep the backlog is. It is the single mechanism that prevents rate-limit /
 * memory / CPU blowout when a large batch is scheduled: the scheduler (63zx.3)
 * must never dispatch beyond the pool's available capacity.
 *
 * Lifecycle separation (pool.md):
 *   - IDENTITY (persistent): the Letta agent — reused from the existing
 *     project_role_agents table. The pool does NOT create a parallel agent
 *     stack; it is handed the persistent identities at construction.
 *   - SESSION (ephemeral): a conversation, attached on allocate() and RETIRED
 *     on completion (current Gas Town behavior: retire clean completed
 *     sessions rather than reusing the session context). The identity/slot
 *     returns to IDLE so a FRESH session can run on it next.
 *
 * Slot states: IDLE → WORKING → (DONE, transient retire) → IDLE.
 *
 * This module owns ONLY the pool. Dispatch/PlanDispatch (63zx.3) and
 * propulsion (63zx.4) are separate downstream slices and are NOT built here.
 * The pool is a pure in-memory capacity governor: it neither creates agents,
 * nor opens conversations, nor talks to Dolt — those are the caller's job.
 */

/** Slot lifecycle states (pool.md). DONE is a transient retirement step. */
export type PoolSlotState = 'idle' | 'working' | 'done';

/**
 * The persistent identity of a pool member. Sourced from the existing
 * project_role_agents table (vibesync-mcz) — NOT a parallel agent stack.
 */
export interface PoolMemberIdentity {
  /** Persistent Letta agent id (project_role_agents.agent_id). */
  readonly agentId: string;
  /** The role this persistent agent fills (project_role_agents.role_name). */
  readonly role: string;
  /** Shim base url for this agent (project_role_agents.letta_base_url). */
  readonly lettaBaseUrl: string;
}

/** An ephemeral session attached to a slot while it is WORKING. */
export interface PoolSession {
  /** The work bead this session was allocated for. */
  readonly workBeadId: string;
  /** The conversation id, if the caller has opened one. Optional at allocate
   *  time — the caller may set it, but the pool only needs the work bead id to
   *  track occupancy. */
  readonly conversationId?: string;
  /** When the slot was allocated (WORKING transition). */
  readonly allocatedAt: Date;
}

/** A materialized view of one slot for callers/tests. */
export interface PoolSlotView {
  readonly slotId: string;
  readonly identity: PoolMemberIdentity;
  readonly state: PoolSlotState;
  /** Present only while WORKING. */
  readonly session?: PoolSession;
}

/** Input to allocate a slot for a unit of work. */
export interface AllocateInput {
  readonly workBeadId: string;
  /** Optional conversation id if the caller already opened one. */
  readonly conversationId?: string;
}

/** A successful allocation: the claimed slot + its persistent identity. */
export interface Allocation {
  readonly slotId: string;
  readonly identity: PoolMemberIdentity;
  readonly session: PoolSession;
}

export interface AgentPoolDeps {
  /**
   * The persistent identities that make up this pool, sourced from
   * project_role_agents for the target project. The number of identities IS
   * the pool size / concurrency cap. Must be non-empty; ids must be unique.
   */
  readonly members: readonly PoolMemberIdentity[];
  /** Injectable clock so tests can pin allocatedAt. Defaults to Date. */
  readonly now?: () => Date;
}

interface Slot {
  readonly slotId: string;
  readonly identity: PoolMemberIdentity;
  state: PoolSlotState;
  session: PoolSession | undefined;
}

/**
 * Fixed-size, in-memory capacity governor over a set of persistent agent
 * identities. The size (members.length) is the hard concurrency cap.
 */
export class AgentPool {
  private readonly slots: Slot[];
  private readonly now: () => Date;
  /** work_bead_id → slotId, so a work bead is never double-allocated. */
  private readonly workBeadToSlot = new Map<string, string>();

  constructor(deps: AgentPoolDeps) {
    if (deps.members.length === 0) {
      throw new Error('AgentPool: members must be non-empty (pool size = concurrency cap)');
    }
    const seen = new Set<string>();
    for (const m of deps.members) {
      if (seen.has(m.agentId)) {
        throw new Error(`AgentPool: duplicate member agentId ${m.agentId}`);
      }
      seen.add(m.agentId);
    }
    this.now = deps.now ?? (() => new Date());
    this.slots = deps.members.map((identity, i) => ({
      slotId: `slot-${i}-${identity.agentId}`,
      identity,
      state: 'idle' as PoolSlotState,
      session: undefined,
    }));
  }

  /** The fixed pool size = the concurrency cap. */
  get poolSize(): number {
    return this.slots.length;
  }

  /** Number of slots currently WORKING (occupied). The scheduler compares this
   *  against poolSize to decide how much it may dispatch. */
  get activeCount(): number {
    return this.slots.reduce((n, s) => n + (s.state === 'working' ? 1 : 0), 0);
  }

  /** Number of IDLE slots available to allocate right now. */
  get availableCount(): number {
    return this.slots.reduce((n, s) => n + (s.state === 'idle' ? 1 : 0), 0);
  }

  /**
   * Allocate an IDLE slot for the given work bead, transitioning it to
   * WORKING. Returns the Allocation, or null when the pool is AT CAP (no IDLE
   * slot). Idempotent per work bead: allocating a work bead that already holds
   * a WORKING slot returns that same allocation rather than consuming a second
   * slot (defends against a scheduler double-dispatch racing the sling-context
   * guard).
   */
  allocate(input: AllocateInput): Allocation | null {
    const existingSlotId = this.workBeadToSlot.get(input.workBeadId);
    if (existingSlotId) {
      const existing = this.slots.find((s) => s.slotId === existingSlotId);
      if (existing && existing.state === 'working' && existing.session) {
        return { slotId: existing.slotId, identity: existing.identity, session: existing.session };
      }
    }
    const slot = this.slots.find((s) => s.state === 'idle');
    if (!slot) return null; // at cap
    const session: PoolSession = {
      workBeadId: input.workBeadId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      allocatedAt: this.now(),
    };
    slot.state = 'working';
    slot.session = session;
    this.workBeadToSlot.set(input.workBeadId, slot.slotId);
    return { slotId: slot.slotId, identity: slot.identity, session };
  }

  /**
   * Complete the work on a slot: transition WORKING → DONE (retire the
   * ephemeral session) → IDLE (identity persists, slot free for a FRESH
   * session). This frees capacity so the scheduler can dispatch the next ready
   * bead. Retiring the session (not reusing its context) is the current Gas
   * Town behavior (pool.md).
   *
   * Returns true if a WORKING slot was freed, false if the slot id was unknown
   * or not WORKING (idempotent / safe to call once per completion).
   */
  onComplete(slotId: string): boolean {
    const slot = this.slots.find((s) => s.slotId === slotId);
    if (!slot || slot.state !== 'working') return false;
    // DONE is the transient retirement step; the session is dropped and the
    // slot returns to IDLE with its persistent identity intact.
    if (slot.session) this.workBeadToSlot.delete(slot.session.workBeadId);
    slot.state = 'idle';
    slot.session = undefined;
    return true;
  }

  /** Snapshot of all slots (for the scheduler + tests). */
  view(): PoolSlotView[] {
    return this.slots.map((s) => ({
      slotId: s.slotId,
      identity: s.identity,
      state: s.state,
      ...(s.session ? { session: s.session } : {}),
    }));
  }
}
