/**
 * Unit Tests for Configuration Management
 *
 * Tests configuration loading, validation, and utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  validateConfig,
  getConfigSummary,
  isLettaEnabled,
  getEnvironmentOverrides,
} from '../../src/config';

describe('config', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset to clean environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load default configuration', () => {
      const config = loadConfig();

      expect(config).toBeDefined();
      expect(config.sync).toBeDefined();
      expect(config.stacks).toBeDefined();
      expect(config.letta).toBeDefined();
    });

    it('should use environment variables when provided', () => {
      process.env.SYNC_INTERVAL = '60000';
      process.env.MAX_WORKERS = '10';

      const config = loadConfig();

      expect(config.sync.interval).toBe(60000);
      expect(config.sync.maxWorkers).toBe(10);
    });

    it('should parse boolean flags correctly', () => {
      process.env.DRY_RUN = 'true';
      process.env.PARALLEL_SYNC = 'true';
      process.env.SKIP_EMPTY_PROJECTS = 'true';

      const config = loadConfig();

      expect(config.sync.dryRun).toBe(true);
      expect(config.sync.parallel).toBe(true);
      expect(config.sync.skipEmpty).toBe(true);
    });

    it('should default incremental sync based on environment', () => {
      // In test environment, INCREMENTAL_SYNC is set to 'false' in setup.js
      const config = loadConfig();
      expect(config.sync.incremental).toBe(false);
    });

    it('should allow disabling incremental sync', () => {
      process.env.INCREMENTAL_SYNC = 'false';
      const config = loadConfig();
      expect(config.sync.incremental).toBe(false);
    });

    it('should enable AST graphiti ingestion by default', () => {
      delete process.env.GRAPHITI_AST_ENABLED;
      const config = loadConfig();
      expect(config.graphiti.astEnabled).toBe(true);
    });

    it('should allow disabling AST graphiti ingestion', () => {
      process.env.GRAPHITI_AST_ENABLED = 'false';
      const config = loadConfig();
      expect(config.graphiti.astEnabled).toBe(false);
    });

    it('should enable Letta when credentials are provided', () => {
      process.env.LETTA_BASE_URL = 'http://letta.local';
      process.env.LETTA_PASSWORD = 'secret123';

      const config = loadConfig();

      // enabled is truthy (both URL and password are set)
      expect(config.letta.enabled).toBeTruthy();
      expect(config.letta.baseURL).toBe('http://letta.local');
      expect(config.letta.password).toBe('secret123');
    });

    it('should disable Letta when credentials are missing', () => {
      delete process.env.LETTA_BASE_URL;
      delete process.env.LETTA_PASSWORD;

      const config = loadConfig();

      expect(config.letta.enabled).toBeFalsy();
    });

    it('should use stacks directory from environment', () => {
      const config = loadConfig();
      // In test environment, STACKS_DIR is overridden in setup.js
      expect(config.stacks.baseDir).toContain('stacks');
    });

    it('should allow custom stacks directory', () => {
      process.env.STACKS_DIR = '/custom/stacks';
      const config = loadConfig();
      expect(config.stacks.baseDir).toBe('/custom/stacks');
    });
  });

  describe('validateConfig', () => {
    it('should validate a valid configuration', () => {
      const config = loadConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should reject sync interval less than 1000ms', () => {
      const config = {
        vibeKanban: { apiUrl: 'http://vibe.local' },
        sync: { interval: 500, maxWorkers: 5, apiDelay: 10 },
        letta: { enabled: false },
      };

      expect(() => validateConfig(config)).toThrow('SYNC_INTERVAL must be a number >= 1000');
    });

    it('should reject invalid maxWorkers', () => {
      const config = {
        vibeKanban: { apiUrl: 'http://vibe.local' },
        sync: { interval: 5000, maxWorkers: 0, apiDelay: 10 },
        letta: { enabled: false },
      };

      expect(() => validateConfig(config)).toThrow('MAX_WORKERS must be a number >= 1');
    });

    it('should reject negative API delay', () => {
      const config = {
        vibeKanban: { apiUrl: 'http://vibe.local' },
        sync: { interval: 5000, maxWorkers: 5, apiDelay: -1 },
        letta: { enabled: false },
      };

      expect(() => validateConfig(config)).toThrow('API_DELAY must be a number >= 0');
    });

    it('should reject enabled Letta without base URL', () => {
      const config = {
        vibeKanban: { apiUrl: 'http://vibe.local' },
        sync: { interval: 5000, maxWorkers: 5, apiDelay: 10 },
        reconciliation: { intervalMinutes: 60, action: 'mark_deleted' },
        bookstack: { enabled: false },
        letta: { enabled: true, baseURL: '', password: 'secret' },
      };

      expect(() => validateConfig(config)).toThrow(
        'LETTA_BASE_URL must be set when Letta is enabled'
      );
    });

    it('should reject enabled Letta without password', () => {
      const config = {
        vibeKanban: { apiUrl: 'http://vibe.local' },
        sync: { interval: 5000, maxWorkers: 5, apiDelay: 10 },
        reconciliation: { intervalMinutes: 60, action: 'mark_deleted' },
        bookstack: { enabled: false },
        letta: { enabled: true, baseURL: 'http://letta.local', password: '' },
      };

      expect(() => validateConfig(config)).toThrow(
        'LETTA_PASSWORD must be set when Letta is enabled'
      );
    });
  });

  describe('getConfigSummary', () => {
    it('should return a formatted summary', () => {
      const config = loadConfig();
      const summary = getConfigSummary(config);

      expect(summary).toHaveProperty('syncInterval');
      expect(summary).toHaveProperty('dryRun');
    });

    it('should format sync interval in seconds', () => {
      process.env.SYNC_INTERVAL = '60000';
      const config = loadConfig();
      const summary = getConfigSummary(config);

      expect(summary.syncInterval).toBe('60s');
    });

    it('should include all sync settings', () => {
      process.env.DRY_RUN = 'true';
      process.env.PARALLEL_SYNC = 'true';
      process.env.MAX_WORKERS = '10';
      process.env.SKIP_EMPTY_PROJECTS = 'true';

      const config = loadConfig();
      const summary = getConfigSummary(config);

      expect(summary.dryRun).toBe(true);
      expect(summary.parallelProcessing).toBe(true);
      expect(summary.maxWorkers).toBe(10);
      expect(summary.skipEmptyProjects).toBe(true);
    });

    it('should include AST graphiti ingestion status', () => {
      process.env.GRAPHITI_AST_ENABLED = 'false';
      const config = loadConfig();
      const summary = getConfigSummary(config);

      expect(summary.graphitiAstEnabled).toBe(false);
    });
  });

  describe('isLettaEnabled', () => {
    it('should return true when Letta is fully configured', () => {
      process.env.LETTA_BASE_URL = 'http://letta.local';
      process.env.LETTA_PASSWORD = 'secret';

      const config = loadConfig();
      expect(isLettaEnabled(config)).toBeTruthy();
    });

    it('should return false when Letta is disabled', () => {
      delete process.env.LETTA_BASE_URL;
      delete process.env.LETTA_PASSWORD;

      const config = loadConfig();
      expect(isLettaEnabled(config)).toBeFalsy();
    });

    it('should return false when base URL is missing', () => {
      delete process.env.LETTA_BASE_URL;
      process.env.LETTA_PASSWORD = 'secret';

      const config = loadConfig();
      expect(isLettaEnabled(config)).toBeFalsy();
    });

    it('should return false when password is missing', () => {
      process.env.LETTA_BASE_URL = 'http://letta.local';
      delete process.env.LETTA_PASSWORD;

      const config = loadConfig();
      expect(isLettaEnabled(config)).toBeFalsy();
    });
  });

  describe('getEnvironmentOverrides', () => {
    it('should return test overrides for test environment', () => {
      const overrides = getEnvironmentOverrides('test');

      expect(overrides.sync.interval).toBe(1000);
      expect(overrides.sync.dryRun).toBe(true);
      expect(overrides.sync.parallel).toBe(false);
    });

    it('should return development overrides for development environment', () => {
      const overrides = getEnvironmentOverrides('development');

      expect(overrides.sync.interval).toBe(60000);
    });

    it('should return production overrides by default', () => {
      const overrides = getEnvironmentOverrides('production');
      expect(overrides).toBeDefined();
    });

    it('should return production overrides for unknown environment', () => {
      const overrides = getEnvironmentOverrides('unknown');
      expect(overrides).toBeDefined();
    });

    it('should use NODE_ENV when no environment specified', () => {
      process.env.NODE_ENV = 'test';
      const overrides = getEnvironmentOverrides();

      expect(overrides.sync.dryRun).toBe(true);
    });
  });

  describe('scheduler section (vibesync-z2ws)', () => {
    const SCHED_KEYS = Object.keys(process.env).filter((k) => k.startsWith('VIBESYNC_SCHEDULER_'));

    beforeEach(() => {
      for (const k of SCHED_KEYS) delete process.env[k];
    });

    it('is OFF by default, with safe defaults (autoMerge off, no required checks)', () => {
      const { scheduler } = loadConfig();
      expect(scheduler).toMatchObject({
        enabled: false,
        paused: false,
        autoMerge: false,
        intervalMs: 30000,
        eventDebounceMs: 5000,
        poolSize: 1,
        batchSize: 1,
        requiredChecks: [],
      });
    });

    it('VIBESYNC_SCHEDULER_ENABLED=true turns it on and env keys map through', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      process.env.VIBESYNC_SCHEDULER_PROJECT = 'vibesync';
      process.env.VIBESYNC_SCHEDULER_INTERVAL_MS = '5000';
      process.env.VIBESYNC_SCHEDULER_POOL_SIZE = '3';
      process.env.VIBESYNC_SCHEDULER_BATCH_SIZE = '2';
      process.env.VIBESYNC_SCHEDULER_PAUSED = 'true';
      const { scheduler } = loadConfig();
      expect(scheduler).toMatchObject({
        enabled: true,
        projectIdentifier: 'vibesync',
        intervalMs: 5000,
        poolSize: 3,
        batchSize: 2,
        paused: true,
        autoMerge: false,
      });
    });

    it('VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS maps through; the WHOLE string must be a non-negative integer (vibesync-p489)', () => {
      process.env.VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS = '2500';
      expect(loadConfig().scheduler.eventDebounceMs).toBe(2500);
      process.env.VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS = '0';
      expect(loadConfig().scheduler.eventDebounceMs).toBe(0);
      for (const bad of ['5s', '1e3', '-1', '5.5', ' 5', '0x10', 'abc']) {
        process.env.VIBESYNC_SCHEDULER_EVENT_DEBOUNCE_MS = bad;
        expect(() => loadConfig(), bad).toThrow('Config validation failed');
      }
    });

    it('any value other than "true" leaves it off', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = '1';
      expect(loadConfig().scheduler.enabled).toBe(false);
    });

    it('enabled without a project fails config validation', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_PROJECT');
    });

    it('autoMerge is only on with the explicit flag, and then needs required checks', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      process.env.VIBESYNC_SCHEDULER_PROJECT = 'vibesync';
      process.env.VIBESYNC_SCHEDULER_AUTO_MERGE = 'true';
      expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_REQUIRED_CHECKS');
      process.env.VIBESYNC_SCHEDULER_REQUIRED_CHECKS = 'typecheck, test';
      const { scheduler } = loadConfig();
      expect(scheduler.autoMerge).toBe(true);
      expect(scheduler.requiredChecks).toEqual(['typecheck', 'test']);
    });
  });
});
