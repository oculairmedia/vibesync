import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { PrChecksOptions } from './types.js';
import type { BeadRow } from '../store/index.js';

/** Everything a run needs that is bound to ONE repository (vibesync-9lzk.55.1). */
export interface ProjectBinding {
  /** Null means the engine's own tracker; otherwise use this project's bd for work beads. */
  readonly workBeads: {
    getBead(id: string): Promise<BeadRow | null>;
    appendNoteToBead(beadId: string, note: string): Promise<void>;
  } | null;
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly shippedWorkProbe: ShippedWorkProbe | null;
  readonly prChecks: PrChecksOptions | null;
  /**
   * `owner/name` of the repository this binding checks, when it is bound to one.
   * A final step never reads CI from a pull request in any other repository.
   */
  readonly repository?: () => Promise<string>;
}

/**
 * The binding for a run's project; `undefined` is the engine's own (home)
 * project. Throws UnknownProjectError for a project it has no checkout for.
 */
export type ProjectBindingResolver = (projectIdentifier: string | undefined) => ProjectBinding;
