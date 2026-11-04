import { FormulaDispatcher, type FormulaDispatcherOptions } from '../../src/engine/dispatcher/index.js';
import { StepDispatcher, StoreReadyStepSource, type ReadyStepStore } from '../../src/engine/scheduler/step-dispatcher.js';

/**
 * A FormulaDispatcher wired exactly like orchestration boot wires it
 * (vibesync-efee): the dispatcher only cooks and waits; a StepDispatcher reads
 * ready steps from the bead graph and offers them back. Cooking wakes it.
 * Without this wiring `dispatcher.run()` never finishes: that is the point.
 */
export function newDriven(store: ReadyStepStore, opts: FormulaDispatcherOptions): FormulaDispatcher & { readonly steps: StepDispatcher } {
  let steps: StepDispatcher | undefined;
  const dispatcher = new FormulaDispatcher({ idPrefix: 'mol', ...opts, onMoleculeCooked: () => steps?.kick() });
  steps = new StepDispatcher({
    source: new StoreReadyStepSource(store, () => dispatcher.liveMoleculeIds()),
    runner: dispatcher,
  });
  return Object.assign(dispatcher, { steps });
}
