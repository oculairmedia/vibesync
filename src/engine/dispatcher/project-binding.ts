import type { DeliveryVerifier, ShippedWorkProbe } from './delivery.js';
import type { PrChecksOptions } from './types.js';

export interface ProjectBinding {
  readonly deliveryVerifier: DeliveryVerifier | null;
  readonly shippedWorkProbe: ShippedWorkProbe | null;
  readonly prChecks: PrChecksOptions | null;
}

/** Resolves repository-bound collaborators for one run's project. */
export type ProjectBindingResolver = (projectIdentifier: string | undefined) => ProjectBinding;

export class UnknownProjectError extends Error {
  constructor(readonly projectIdentifier: string) {
    super(`unknown project "${projectIdentifier}" has no registered checkout`);
    this.name = 'UnknownProjectError';
  }
}

export function createProjectBindingResolver(binding: ProjectBinding): ProjectBindingResolver {
  return () => binding;
}
