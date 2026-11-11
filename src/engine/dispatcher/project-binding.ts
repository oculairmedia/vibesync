import type { ProjectBinding, ProjectBindingResolver } from './project-binding-types.js';

export class UnknownProjectError extends Error {
  constructor(readonly projectIdentifier: string) {
    super(`unknown project "${projectIdentifier}" has no registered checkout`);
    this.name = 'UnknownProjectError';
  }
}

/** One binding for every project: a dispatcher built without a resolver (single-repository use). */
export function createProjectBindingResolver(binding: ProjectBinding): ProjectBindingResolver {
  return () => binding;
}
