export interface ProjectBinding {
  readonly deliveryVerifier: import('./delivery.js').DeliveryVerifier | null;
  readonly shippedWorkProbe: import('./delivery.js').ShippedWorkProbe | null;
  readonly prChecks: import('./types.js').PrChecksOptions | null;
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
