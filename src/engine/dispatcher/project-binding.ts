import type { ProjectBinding as ProjectBindingType } from './project-binding-types.js';

export type ProjectBinding = ProjectBindingType;

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
