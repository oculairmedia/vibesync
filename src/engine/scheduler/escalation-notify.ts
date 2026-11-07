/**
 * vibesync-9lzk.53: tell the project PM when a run escalated.
 *
 * An escalated run (a blocked step, a verdict that failed closed, a review
 * loop out of rounds) stops and waits for a person. The person is the project's
 * PM agent, reached over the PM-wake path that already exists (an Iroh inbox
 * message, coalesced by the waker), plus a comment on the work bead that keeps
 * the reason with the work. Not the Meridian escalation manager: a routine
 * escalation belongs to the project PM, not up the chain.
 *
 * Both effects are best-effort and independent: a failure of either is logged
 * and never breaks run settlement.
 */
export interface EscalationNotifierDeps {
  /** noteStall of the PM waker; absent when PM wake is disabled. */
  readonly wakePm?: (workBeadId: string, detail: string) => void;
  /** Post a comment on the work bead (bd comments add). */
  readonly commentOnBead: (workBeadId: string, text: string) => Promise<void>;
  readonly logger?: { warn?(o: unknown, m: string): void };
}

const REASON_MAX = 1500;

export function createEscalationNotifier(deps: EscalationNotifierDeps) {
  return async (input: { workBeadId: string; contextId: string; reason: string }): Promise<void> => {
    const reason = input.reason.length > REASON_MAX ? `${input.reason.slice(0, REASON_MAX)} [truncated]` : input.reason;
    try {
      deps.wakePm?.(input.workBeadId, `escalated, needs the PM: ${reason.split('\n')[0]!.slice(0, 240)}`);
    } catch (err) {
      deps.logger?.warn?.({ workBeadId: input.workBeadId, error: err instanceof Error ? err.message : String(err) }, 'escalation-notify: PM wake failed');
    }
    try {
      await deps.commentOnBead(input.workBeadId, `ENGINE ESCALATION (context ${input.contextId}): the run stopped and is waiting for the PM.\n\n${reason}`);
    } catch (err) {
      deps.logger?.warn?.({ workBeadId: input.workBeadId, error: err instanceof Error ? err.message : String(err) }, 'escalation-notify: bead comment failed');
    }
  };
}
