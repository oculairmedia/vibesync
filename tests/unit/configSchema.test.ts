/**
 * Unit Tests for Zod Configuration Schema
 */

import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/configSchema';

function schedulerDefaults(overrides = {}) {
  return {
    enabled: false,
    projectIdentifier: '',
    intervalMs: 30000,
    eventDebounceMs: 5000,
    runDeadlineMs: 3600000,
    poolSize: 1,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [] as string[],
    allowedRepos: [] as string[],
    pmWake: { enabled: false, minIntervalMs: 1_800_000, backstopMs: 28_800_000, statePath: '/tmp/pm-wake-state.json', sink: 'log' },
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  return {
    stacks: { baseDir: '/opt/stacks' },
    doltHub: {
      enabled: false,
      dryRun: false,
      apiUrl: 'https://www.dolthub.com/api/v1alpha1',
      apiToken: '',
      owner: 'oulair',
      defaultVisibility: 'private',
      remoteName: 'origin',
    },
    scheduler: schedulerDefaults(),
    waits: { enabled: false, reconcileIntervalMs: 60000, maxWakeAttempts: 5 },
    ...overrides,
  };
}

describe('configSchema', () => {
  it('accepts a fully valid config', () => {
    const result = configSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
  });

  it('rejects a removed legacy section rather than silently accepting it', () => {
    const result = configSchema.strict().safeParse(validConfig({ sync: { interval: 300000 } }));
    expect(result.success).toBe(false);
  });

  it('rejects enabled DoltHub provisioning without an API token outside dry-run', () => {
    const cfg = validConfig({
      doltHub: {
        enabled: true,
        dryRun: false,
        apiUrl: 'https://www.dolthub.com/api/v1alpha1',
        apiToken: '',
        owner: 'oulair',
        defaultVisibility: 'private',
        remoteName: 'origin',
      },
    });
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('DOLTHUB_API_TOKEN');
  });

  it('accepts DoltHub provisioning dry-run without an API token', () => {
    const cfg = validConfig({
      doltHub: {
        enabled: false,
        dryRun: true,
        apiUrl: 'https://www.dolthub.com/api/v1alpha1',
        apiToken: '',
        owner: 'oulair',
        defaultVisibility: 'private',
        remoteName: 'origin',
      },
    });
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  describe('scheduler section (vibesync-z2ws)', () => {
    it('accepts the disabled defaults', () => {
      expect(configSchema.safeParse(validConfig()).success).toBe(true);
    });

    it('rejects enabled without a project', () => {
      const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ enabled: true }) }));
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toContain('VIBESYNC_SCHEDULER_PROJECT');
    });

    it('rejects autoMerge without required checks', () => {
      const result = configSchema.safeParse(
        validConfig({ scheduler: schedulerDefaults({ enabled: true, projectIdentifier: 'p', autoMerge: true }) }),
      );
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toContain('VIBESYNC_SCHEDULER_REQUIRED_CHECKS');
    });

    it('rejects autoMerge with an empty allowedRepos (vibesync-5c8y)', () => {
      const result = configSchema.safeParse(
        validConfig({
          scheduler: schedulerDefaults({ enabled: true, projectIdentifier: 'p', autoMerge: true, requiredChecks: ['ci'] }),
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error.issues.map((i: { message: string }) => i.message).join(';')).toContain(
        'VIBESYNC_SCHEDULER_ALLOWED_REPOS',
      );
    });

    it('accepts autoMerge once allowedRepos is non-empty, and an empty allowedRepos while autoMerge is off', () => {
      expect(
        configSchema.safeParse(
          validConfig({
            scheduler: schedulerDefaults({
              enabled: true, projectIdentifier: 'p', autoMerge: true, requiredChecks: ['ci'], allowedRepos: ['o/r'],
            }),
          }),
        ).success,
      ).toBe(true);
      expect(configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ allowedRepos: [] }) })).success).toBe(true);
    });

    it('rejects malformed allowedRepos entries (vibesync-5c8y)', () => {
      for (const bad of ['not-a-repo', 'a/b/c', '/r', 'o/', 'o/r x', 'https://github.com/o/r', '']) {
        const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ allowedRepos: [bad] }) }));
        expect(result.success, bad).toBe(false);
      }
      expect(
        configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ allowedRepos: ['Oculair-Media/vibe.sync_2'] }) })).success,
      ).toBe(true);
    });

    it('rejects a negative or fractional eventDebounceMs (vibesync-p489)', () => {
      for (const bad of [-1, 1.5, Number.NaN]) {
        const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ eventDebounceMs: bad }) }));
        expect(result.success).toBe(false);
      }
      expect(configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ eventDebounceMs: 0 }) })).success).toBe(true);
    });

    it('validates the pmWake section (vibesync-2bgv)', () => {
      const pm = (over: object) =>
        configSchema.safeParse(
          validConfig({
            scheduler: schedulerDefaults({
              pmWake: { enabled: true, minIntervalMs: 1_800_000, backstopMs: 28_800_000, statePath: '/x.json', sink: 'log', ...over },
            }),
          }),
        );
      expect(pm({}).success).toBe(true);
      expect(pm({ minIntervalMs: 999 }).success).toBe(false);
      expect(pm({ backstopMs: 1.5 }).success).toBe(false);
      expect(pm({ backstopMs: Number.NaN }).success).toBe(false);
      expect(pm({ statePath: '' }).success).toBe(false);
      expect(pm({ sink: 'iroh' }).success).toBe(false);
      expect(pm({ sink: 'matrix' }).success).toBe(false);
    });

    it('rejects a negative or fractional runDeadlineMs; 0 (no deadline) is valid (vibesync-izn3)', () => {
      for (const bad of [-1, 1.5, Number.NaN]) {
        const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ runDeadlineMs: bad }) }));
        expect(result.success).toBe(false);
      }
      expect(configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ runDeadlineMs: 0 }) })).success).toBe(true);
    });

    it('rejects an interval under 1s', () => {
      const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ intervalMs: 10 }) }));
      expect(result.success).toBe(false);
    });
  });

  describe('waits section (vibesync-9g24)', () => {
    it('accepts the default (disabled)', () => {
      expect(configSchema.safeParse(validConfig()).success).toBe(true);
    });
    it('requires the section and rejects out-of-range values', () => {
      const { waits: _omit, ...rest } = validConfig() as Record<string, unknown>;
      expect(configSchema.safeParse(rest).success).toBe(false);
      expect(configSchema.safeParse(validConfig({ waits: { enabled: false, reconcileIntervalMs: -1, maxWakeAttempts: 5 } })).success).toBe(false);
      expect(configSchema.safeParse(validConfig({ waits: { enabled: false, reconcileIntervalMs: 0, maxWakeAttempts: 0 } })).success).toBe(false);
    });
  });
});
