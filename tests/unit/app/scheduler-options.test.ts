/**
 * vibesync-9lzk.55.9: the wiring main.ts uses to give each project's scheduler
 * its own `bd` and `gh`. The rule under test is the one multi-project
 * scheduling cannot get wrong: project B's scheduler never runs a command in
 * project A's checkout.
 */
import { describe, expect, it } from 'vitest';

import { buildSchedulerOptions, projectRunner, type CheckoutRunners, type SchedulerRegistry } from '../../../src/app/scheduler-options.js';
import type { BootSchedulerOptions } from '../../../src/engine/scheduler/boot-scheduler.js';

function registry(paths: Record<string, string | null>): SchedulerRegistry & { paths: Record<string, string | null> } {
  return {
    paths,
    getProject: (id) => (id in paths ? { filesystem_path: paths[id] } : null),
    listRoleAgents: (id) => [{ agentId: `agent-${id}`, roleName: 'coder' }],
  };
}

/** Records which checkout each command ran in. */
function recordingRunners(): CheckoutRunners & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    bd: (checkout, actor) => async (args) => { calls.push(`bd ${checkout} ${actor} ${args.join(' ')}`); return '[]'; },
    gh: (checkout) => async (args) => { calls.push(`gh ${checkout} ${args.join(' ')}`); return '{}'; },
  };
}

const baseConfig = {
  enabled: true, intervalMs: 30_000, poolSize: 1, batchSize: 1, paused: false,
  readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: 'packs/gastown',
  autoMerge: false, requiredChecks: [], allowedRepos: [],
} as unknown as Omit<BootSchedulerOptions['config'], 'projectIdentifier'>;

describe('per-project scheduler wiring', () => {
  it('each project\'s scheduler runs bd and gh in its own checkout only', async () => {
    const reg = registry({ alpha: '/stacks/alpha', beta: '/stacks/beta' });
    const runners = recordingRunners();
    const [a, b] = buildSchedulerOptions({
      config: { ...baseConfig, projectIdentifiers: ['alpha', 'beta'] },
      registry: reg, runners, shared: {},
    });

    expect(a!.config.projectIdentifier).toBe('alpha');
    expect(b!.config.projectIdentifier).toBe('beta');
    await a!.bd(['ready', '--json']);
    await b!.bd(['ready', '--json']);
    await b!.gh!(['pr', 'list']);

    expect(runners.calls).toEqual([
      'bd /stacks/alpha vibesync-scheduler ready --json',
      'bd /stacks/beta vibesync-scheduler ready --json',
      'gh /stacks/beta pr list',
    ]);
  });

  it('each project\'s pool comes from its own role agents', () => {
    const [a, b] = buildSchedulerOptions({
      config: { ...baseConfig, projectIdentifiers: ['alpha', 'beta'] },
      registry: registry({ alpha: '/a', beta: '/b' }), runners: recordingRunners(), shared: {},
    });
    expect(a!.listPoolMembers('alpha')).toEqual([{ agentId: 'agent-alpha', role: 'coder' }]);
    expect(b!.listPoolMembers('beta')).toEqual([{ agentId: 'agent-beta', role: 'coder' }]);
  });

  it('overrides the project settings, preserves absent global values and skips only invalid projects', () => {
    const warnings: unknown[] = [];
    const options = buildSchedulerOptions({
      config: { ...baseConfig, projectIdentifiers: ['alpha', 'beta'] },
      registry: registry({ alpha: '/a', beta: '/b' }), runners: recordingRunners(),
      shared: { logger: { warn: (...args: unknown[]) => warnings.push(args) } as never },
      settings: (project) => project === 'alpha'
        ? { formula: 'implement-fix', readyLabel: 'ready:now', poolSize: 3 }
        : (() => { throw new Error('engine.poolSize must be an integer from 1 to 8'); })(),
    });
    expect(options).toHaveLength(1);
    expect(options[0]!.config).toMatchObject({ formula: 'implement-fix', readyLabel: 'ready:now', poolSize: 3 });
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('Project settings are invalid');
  });

  it('leaves global settings unchanged when the project file omits fields', () => {
    const [option] = buildSchedulerOptions({
      config: { ...baseConfig, projectIdentifiers: ['alpha'] },
      registry: registry({ alpha: '/a' }), runners: recordingRunners(), shared: {}, settings: () => ({}),
    });
    expect(option!.config).toMatchObject({ formula: 'onboard-feature', readyLabel: 'scheduler:eligible', poolSize: 1 });
  });

  it('a runner follows a project whose checkout moves, and names a project with none', async () => {
    const reg = registry({ alpha: '/stacks/alpha', gone: null });
    const runners = recordingRunners();
    const bd = projectRunner(reg, runners, 'bd', 'vibesync-waits', 'alpha');
    await bd(['list']);
    reg.paths['alpha'] = '/elsewhere/alpha';
    await bd(['list']);
    expect(runners.calls).toEqual(['bd /stacks/alpha vibesync-waits list', 'bd /elsewhere/alpha vibesync-waits list']);
    await expect(projectRunner(reg, runners, 'bd', 'x', 'gone')(['list'])).rejects.toThrow('project "gone" has no filesystem_path');
  });
});
