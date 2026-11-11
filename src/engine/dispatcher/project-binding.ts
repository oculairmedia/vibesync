import type { ProjectBinding, ProjectBindingResolver } from './project-binding-types.js';

/** The run names a project this engine has no usable checkout for. Never retried as a GitHub outage. */
export class UnknownProjectError extends Error {
  constructor(readonly projectIdentifier: string, detail = 'has no registered checkout') {
    super(`unknown project "${projectIdentifier}": ${detail}`);
    this.name = 'UnknownProjectError';
  }
}

/** One binding for every project: a dispatcher built without a resolver (single-repository use). */
export function createProjectBindingResolver(binding: ProjectBinding): ProjectBindingResolver {
  return () => binding;
}

/**
 * Registry lookup for a project's checkout (`projects.filesystem_path`); null
 * when the registry has no such project or no path for it. Structural, so the
 * engine does not import the app's registry (same shape as registryPmAgentLookup).
 */
export function registryProjectRoot(registry: {
  getProject(identifier: string): { readonly filesystem_path?: string | null } | null | undefined;
}): (projectIdentifier: string) => string | null {
  return (projectIdentifier) => registry.getProject(projectIdentifier)?.filesystem_path || null;
}
