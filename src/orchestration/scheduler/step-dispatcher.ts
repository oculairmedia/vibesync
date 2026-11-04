/**
 * Step dispatch (vibesync-efee): "ready step beads of open molecules".
 *
 * A cooked molecule is a root bead plus step beads linked by `blocks` edges, so
 * the bead graph — not an in-process loop — decides what may run next. This
 * module is the whole executor that replaced the dispatcher's while-loop:
 *
 *   ReadyStepSource.readySteps()   which steps does the graph say are runnable?
 *   StepDispatcher.tick()          offer each one to the runner (does not wait)
 *   ReadyStepRunner.runReadyStep   FormulaDispatcher: run ONE step, record it
 *
 * The source is SEPARATE from BdReadyBeadSource (bd-adapters.ts), which feeds
 * WORK beads and deliberately excludes `molecule_step`. Readiness here is
 * molecule-scoped (`findReadyStepsForMolecule`, the same predicate as
 * `bd ready --mol <root>`), NEVER plain `bd ready`: plain ready lists every open
 * step of every molecule, including steps whose blockers are still open.
 *
 * Steps do NOT take an AgentPool slot. A work bead's run already owns one slot
 * for its whole molecule, and a formula started over HTTP never had one.
 *
 * Who calls `tick()` (none of them decide anything):
 *   - scheduler ON:  the daemon's loop runs it as a phase of every tick, and
 *     `kick()` (a molecule was cooked / a step settled) is routed to the
 *     daemon's `requestStepTick()` through {@link StepDispatcher.setWake}
 *     — the scheduler loop stays the one place dispatch happens.
 *   - scheduler OFF (the production default): orchestration boot calls
 *     `start(intervalMs)`; `kick()` then ticks directly (coalesced), so a chain
 *     of steps does not wait for the interval.
 */

import type { BeadRow } from '../store/index.js';
import type { ReadyStep, ReadyStepRunner, StepRunOutcome } from '../molecule/index.js';

export type { ReadyStep, ReadyStepRunner, StepRunOutcome };

/** The narrow store port the source needs (DoltClient and the in-memory fixture satisfy it). */
export interface ReadyStepStore {
  /** Open `molecule_step` beads under `rootId` whose blockers are all closed. */
  findReadyStepsForMolecule(rootId: string): Promise<readonly BeadRow[]>;
}

export interface ReadyStepSource {
  readySteps(): Promise<readonly ReadyStep[]>;
}

/**
 * Ready steps for the molecules this process can run. The molecule list is the
 * runner's live set (its run context — formula, pack, input — lives in-process);
 * readiness for each is asked of the store PER MOLECULE.
 */
export class StoreReadyStepSource implements ReadyStepSource {
  constructor(
    private readonly store: ReadyStepStore,
    private readonly moleculeIds: () => readonly string[],
  ) {}

  async readySteps(): Promise<readonly ReadyStep[]> {
    const out: ReadyStep[] = [];
    for (const moleculeId of this.moleculeIds()) {
      for (const step of await this.store.findReadyStepsForMolecule(moleculeId)) {
        out.push({ moleculeId, step });
      }
    }
    return out;
  }
}

export interface StepDispatcherLogger {
  warn?(o: unknown, m: string): void;
}

export interface StepDispatcherDeps {
  readonly source: ReadyStepSource;
  readonly runner: ReadyStepRunner;
  readonly logger?: StepDispatcherLogger;
}

export interface StepTickResult {
  /** Ids of the step beads offered to the runner this tick. */
  readonly offered: readonly string[];
}

export const DEFAULT_STEP_TICK_INTERVAL_MS = 1_000;

export class StepDispatcher {
  private readonly deps: StepDispatcherDeps;
  /** Steps offered and not yet settled: never offer one twice. */
  private readonly inFlight = new Set<string>();
  private readonly settlements = new Set<Promise<void>>();
  private kicking: Promise<void> | null = null;
  private kickAgain = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(deps: StepDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * Route `kick()` to an external loop (the scheduler daemon's `requestStepTick`)
   * instead of ticking directly. Pass null to go back to self-ticking.
   */
  setWake(wake: (() => void) | null): void {
    this.wake = wake;
  }

  /** Offer every ready step to the runner and return; steps run off the tick. Idempotent and safe to call concurrently. */
  async tick(): Promise<StepTickResult> {
    const ready = await this.deps.source.readySteps();
    const offered: string[] = [];
    for (const item of ready) {
      const stepId = item.step.id;
      if (this.inFlight.has(stepId)) continue;
      this.inFlight.add(stepId);
      offered.push(stepId);
      const settlement: Promise<void> = this.deps.runner
        .runReadyStep(item)
        .then(
          (outcome) => {
            // A step that ran to its end may have made dependents ready.
            // `skipped` must not kick: it would spin on a capped molecule.
            if (outcome !== 'skipped') this.kick();
          },
          (err: unknown) => {
            this.deps.logger?.warn?.({ stepId, moleculeId: item.moleculeId, error: msg(err) }, 'step-dispatcher: runner rejected');
            this.kick();
          },
        )
        .finally(() => {
          this.inFlight.delete(stepId);
          this.settlements.delete(settlement);
        });
      this.settlements.add(settlement);
    }
    return { offered };
  }

  /** Tick soon (see {@link StepDispatcher.setWake}); requests made while a tick is running collapse into one follow-up tick. Never rejects. */
  kick(): void {
    if (this.stopped) return;
    if (this.wake) {
      try {
        this.wake();
      } catch (err) {
        this.deps.logger?.warn?.({ error: msg(err) }, 'step-dispatcher: wake failed');
      }
      return;
    }
    if (this.kicking) {
      this.kickAgain = true;
      return;
    }
    this.kicking = this.kickLoop().finally(() => {
      this.kicking = null;
    });
  }

  private async kickLoop(): Promise<void> {
    do {
      this.kickAgain = false;
      try {
        await this.tick();
      } catch (err) {
        this.deps.logger?.warn?.({ error: msg(err) }, 'step-dispatcher: tick failed');
      }
    } while (this.kickAgain && !this.stopped);
  }

  /**
   * The scheduler-off driver: kick on an interval. It decides nothing (readiness
   * comes from the bead graph); it exists so formulas still execute when
   * `scheduler.enabled=false`. Not used when the scheduler daemon owns the loop.
   */
  start(intervalMs: number = DEFAULT_STEP_TICK_INTERVAL_MS): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop kicking and wait for the tick in flight. Steps already running are NOT awaited. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.kicking;
  }

  /** Wait for every offered step to settle. For supervised one-shot rigs and tests. */
  async drain(): Promise<void> {
    while (this.settlements.size > 0) await Promise.all([...this.settlements]);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
