import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { PrChecksOptions } from './types.js';

/** Everything a run needs that is bound to ONE repository (vibesync-9lzk.55.1). */
export interface ProjectBinding {
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly shippedWorkProbe: ShippedWorkProbe | null;
  readonly prChecks: PrChecksOptions | null;
}

/**
 * The binding for a run's project; `undefined` is the engine's own (home)
 * project. Throws UnknownProjectError for a project it has no checkout for.
 */
export type ProjectBindingResolver = (projectIdentifier: string | undefined) => ProjectBinding;
