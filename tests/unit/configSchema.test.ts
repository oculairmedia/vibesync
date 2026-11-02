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
    poolSize: 1,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [] as string[],
    allowedRepos: [] as string[],
    pmWake: { enabled: false, minIntervalMs: 1_800_000, backstopMs: 28_800_000, statePath: '/tmp/pm-wake-state.json' },
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  return {
    sync: {
      interval: 300000,
      dryRun: false,
      incremental: true,
      parallel: false,
      maxWorkers: 5,
      skipEmpty: false,
      apiDelay: 10,
    },
    reconciliation: { enabled: true, intervalMinutes: 1440, action: 'mark_deleted', dryRun: false },
    stacks: { baseDir: '/opt/stacks' },
    letta: { enabled: false, baseURL: undefined, password: undefined },
    graphiti: {
      enabled: false,
      apiUrl: 'http://localhost:8003',
      groupIdPrefix: 'vibesync_',
      astEnabled: true,
      astGroupIdPrefix: 'ast_',
      timeout: 30000,
      retries: 3,
    },
    codePerception: {
      enabled: false,
      debounceMs: 2000,
      batchSize: 50,
      maxFileSizeKb: 500,
      excludePatterns: [],
    },
    bookstack: {
      enabled: false,
      url: 'http://192.168.50.80:8087',
      tokenId: '',
      tokenSecret: '',
      syncInterval: 3600000,
      exportFormats: ['markdown'],
      exportImages: true,
      exportAttachments: true,
      exportMeta: true,
      modifyMarkdownLinks: true,
      docsSubdir: 'docs/bookstack',
      projectBookMappings: [],
      exporterOutputPath: '/bookstack-exports',
      importOnSync: false,
      bidirectionalSync: false,
    },
    projectMcp: {
      enabled: true,
      path: '/mcp',
    },
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
    ...overrides,
  };
}

describe('configSchema', () => {
  it('accepts a fully valid config', () => {
    const result = configSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
  });

  it('rejects negative sync interval', () => {
    const cfg = validConfig();
    cfg.sync.interval = -1;
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('rejects maxWorkers < 1', () => {
    const cfg = validConfig();
    cfg.sync.maxWorkers = 0;
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('rejects invalid reconciliation action', () => {
    const cfg = validConfig();
    cfg.reconciliation.action = 'nuke';
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('mark_deleted');
  });

  it('rejects enabled Letta without baseURL', () => {
    const cfg = validConfig({ letta: { enabled: true, baseURL: '', password: 'secret' } });
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('LETTA_BASE_URL');
  });

  it('rejects enabled Letta without password', () => {
    const cfg = validConfig({
      letta: { enabled: true, baseURL: 'http://letta.local', password: '' },
    });
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('LETTA_PASSWORD');
  });

  it('accepts Letta when disabled with no credentials', () => {
    const cfg = validConfig({ letta: { enabled: false } });
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  it('rejects enabled bookstack without tokenId', () => {
    const cfg = validConfig();
    cfg.bookstack.enabled = true;
    cfg.bookstack.url = 'https://example.com';
    cfg.bookstack.tokenId = '';
    cfg.bookstack.tokenSecret = 'secret';
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('BOOKSTACK_TOKEN_ID');
  });

  it('rejects NaN sync values (simulating SYNC_INTERVAL=abc)', () => {
    const cfg = validConfig();
    cfg.sync.interval = NaN;
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('accepts zero sync interval (run-once mode)', () => {
    const cfg = validConfig();
    cfg.sync.interval = 0;
    const result = configSchema.safeParse(cfg);
    expect(result.success).toBe(true);
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
              pmWake: { enabled: true, minIntervalMs: 1_800_000, backstopMs: 28_800_000, statePath: '/x.json', ...over },
            }),
          }),
        );
      expect(pm({}).success).toBe(true);
      expect(pm({ minIntervalMs: 999 }).success).toBe(false);
      expect(pm({ backstopMs: 1.5 }).success).toBe(false);
      expect(pm({ backstopMs: Number.NaN }).success).toBe(false);
      expect(pm({ statePath: '' }).success).toBe(false);
    });

    it('rejects an interval under 1s', () => {
      const result = configSchema.safeParse(validConfig({ scheduler: schedulerDefaults({ intervalMs: 10 }) }));
      expect(result.success).toBe(false);
    });
  });
});
