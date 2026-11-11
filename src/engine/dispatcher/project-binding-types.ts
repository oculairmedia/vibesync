import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { PrChecksOptions } from './types.js';

export interface ProjectBinding {
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly shippedWorkProbe: ShippedWorkProbe | null;
  readonly prChecks: PrChecksOptions | null;
}

export type ProjectBindingResolver = (projectIdentifier: string | undefined) => ProjectBinding;
