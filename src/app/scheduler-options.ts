/**
 * Scheduler wiring per project (vibesync-9lzk.55.9). Kept out of main.ts,
 * which starts the service on import, so the one rule that matters for
 * multi-project scheduling can be tested: each project's scheduler runs `bd`
 * and `gh` in THAT project's own checkout, never in another project's.
 */
import type { BootSchedulerOptions } from '../engine/scheduler/boot-scheduler.js';
import type { CommandRunner } from '../engine/beads/cli.js';

/** What the wiring needs from the registry. */
export interface SchedulerRegistry {
  getProject(identifier: string): { readonly filesystem_path?: string | null } | null | undefined;
  listRoleAgents(identifier: string): readonly { readonly agentId: string; readonly roleName: string }[];
}

/** How a CLI is bound to a checkout. Production passes `createCliRunner` / `createCheckoutGhRunner`. */
export interface CheckoutRunners {
  bd(checkout: string, actor: string): CommandRunner;
  gh(checkout: string): CommandRunner;
}

/**
 * A runner for one project's `bd` or `gh`. The checkout is looked up on every
 * call, so a project whose registered path changes is followed; a project with
 * no checkout fails the call with its name.
 */
export function projectRunner(
  registry: SchedulerRegistry,
  runners: CheckoutRunners,
  binary: 'bd' | 'gh',
  actor: string,
  projectIdentifier: string,
): CommandRunner {
  return async (args) => {
    const checkout = registry.getProject(projectIdentifier)?.filesystem_path;
    if (!checkout) throw new Error(`project "${projectIdentifier}" has no filesystem_path`);
    return binary === 'gh' ? runners.gh(checkout)(args) : runners.bd(checkout, actor)(args);
  };
}

/** One scheduler option per listed project, each bound to its own checkout. */
export function buildSchedulerOptions(args: {
  readonly config: Omit<BootSchedulerOptions['config'], 'projectIdentifier'> & { readonly projectIdentifiers: readonly string[] };
  readonly registry: SchedulerRegistry;
  readonly runners: CheckoutRunners;
  readonly shared: Pick<BootSchedulerOptions, 'logger' | 'pmWake'>;
}): BootSchedulerOptions[] {
  const { projectIdentifiers, ...config } = args.config;
  return projectIdentifiers.map((projectIdentifier) => ({
    ...args.shared,
    config: { ...config, projectIdentifier },
    listPoolMembers: (id: string) => args.registry.listRoleAgents(id).map((row) => ({ agentId: row.agentId, role: row.roleName })),
    bd: projectRunner(args.registry, args.runners, 'bd', 'vibesync-scheduler', projectIdentifier),
    gh: projectRunner(args.registry, args.runners, 'gh', 'vibesync-scheduler', projectIdentifier),
  }));
}
