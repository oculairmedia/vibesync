/**
 * What a role-agent assignment must look like (vibesync-9lzk.55.5). The PUT
 * route validates with these and the published API description states them,
 * so the two cannot disagree.
 */

/** A role a formula step dispatches to: lower case, starting with a letter, at most 64 characters. */
export const ROLE_NAME_PATTERN = '^[a-z][a-z0-9-]{0,63}$';
export const ROLE_NAME_MAX_LENGTH = 64;

/** A Letta agent id: `agent-` followed by at least 8 hex digits or hyphens. */
export const AGENT_ID_PATTERN = '^agent-[0-9a-f-]{8,}$';

export const ROLE_NAME = new RegExp(ROLE_NAME_PATTERN);

/**
 * The project is not active, so its role agents cannot be set: startup deletes
 * the role agents of every project that is not active. Thrown from inside the
 * replace transaction, so a project archived while a request was in flight is
 * caught at the moment of writing, not only when the request arrived.
 */
export class ProjectNotActiveError extends Error {
  constructor(readonly projectIdentifier: string, readonly status: string | null) {
    super(`project ${projectIdentifier} is ${status ?? 'missing'}, not active`);
    this.name = 'ProjectNotActiveError';
  }
}
export const AGENT_ID = new RegExp(AGENT_ID_PATTERN);
