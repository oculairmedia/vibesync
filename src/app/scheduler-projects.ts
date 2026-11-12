/**
 * VIBESYNC_SCHEDULER_PROJECTS as a list of project identifiers (vibesync-9lzk.55.9).
 *
 * Read while the config is built, before schema validation, so a config that
 * still sets only the removed singular VIBESYNC_SCHEDULER_PROJECT is told to
 * rename it. With the scheduler on, schema validation would otherwise fail first
 * with "must contain at least one project" and never name the old key.
 */
export function schedulerProjectsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.VIBESYNC_SCHEDULER_PROJECTS;
  if (raw === undefined && env.VIBESYNC_SCHEDULER_PROJECT !== undefined) {
    throw new Error('Config validation failed: VIBESYNC_SCHEDULER_PROJECT was replaced by VIBESYNC_SCHEDULER_PROJECTS');
  }
  return raw ? parseList(raw) : [];
}

function parseList(raw: string): string[] {
  const identifiers = raw.split(',').map((identifier) => identifier.trim());
  if (identifiers.includes('')) throw new Error('Config validation failed: VIBESYNC_SCHEDULER_PROJECTS must not contain empty entries');
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error('Config validation failed: VIBESYNC_SCHEDULER_PROJECTS must not contain duplicates');
  }
  return identifiers;
}
