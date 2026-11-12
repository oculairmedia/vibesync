/**
 * Unit Tests for Configuration Management
 *
 * Tests configuration loading, validation, and utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfigSummary } from '../../src/app/config';
import { resolveFromAppRoot } from '../../src/app/runtimePaths';

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

  describe('getConfigSummary', () => {
    it('summarizes the engine settings that are actually configurable', () => {
      const summary = getConfigSummary(loadConfig());
      expect(summary).toMatchObject({ schedulerEnabled: false, schedulerAutoMerge: false, pmWakeEnabled: false, pmWakeSink: 'log', waitsEnabled: false });
      expect(summary).not.toHaveProperty('syncInterval');
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
        runDeadlineMs: 3600000,
        poolSize: 1,
        batchSize: 1,
        requiredChecks: [],
        allowedRepos: [],
      });
    });

    it('VIBESYNC_SCHEDULER_ENABLED=true turns it on and env keys map through', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      process.env.VIBESYNC_SCHEDULER_PROJECTS = 'vibesync';
      process.env.VIBESYNC_SCHEDULER_INTERVAL_MS = '5000';
      process.env.VIBESYNC_SCHEDULER_POOL_SIZE = '3';
      process.env.VIBESYNC_SCHEDULER_BATCH_SIZE = '2';
      process.env.VIBESYNC_SCHEDULER_PAUSED = 'true';
      const { scheduler } = loadConfig();
      expect(scheduler).toMatchObject({
        enabled: true,
        projectIdentifiers: ['vibesync'],
        intervalMs: 5000,
        poolSize: 3,
        batchSize: 2,
        paused: true,
        autoMerge: false,
      });
    });

    it('scheduler integer settings reject trailing junk but accept valid integers', () => {
      const keys = [
        'VIBESYNC_SCHEDULER_INTERVAL_MS',
        'VIBESYNC_SCHEDULER_POOL_SIZE',
        'VIBESYNC_SCHEDULER_BATCH_SIZE',
      ];
      // One setting junk at a time, the others valid: each parser is tested
      // on its own (a leftover invalid value would make every later check
      // pass for the wrong reason).
      for (const key of keys) {
        for (const other of keys) delete process.env[other];
        process.env[key] = '30000junk';
        expect(() => loadConfig(), key).toThrow('Config validation failed');
        delete process.env[key];
      }
      process.env.VIBESYNC_SCHEDULER_INTERVAL_MS = '30000';
      process.env.VIBESYNC_SCHEDULER_POOL_SIZE = '1';
      process.env.VIBESYNC_SCHEDULER_BATCH_SIZE = '1';
      expect(loadConfig().scheduler).toMatchObject({ intervalMs: 30000, poolSize: 1, batchSize: 1 });
      process.env.VIBESYNC_SCHEDULER_INTERVAL_MS = '45000';
      process.env.VIBESYNC_SCHEDULER_POOL_SIZE = '3';
      process.env.VIBESYNC_SCHEDULER_BATCH_SIZE = '2';
      expect(loadConfig().scheduler).toMatchObject({ intervalMs: 45000, poolSize: 3, batchSize: 2 });
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

    it('pmWake: off by default with 30 min / 8 h defaults (vibesync-2bgv)', () => {
      expect(loadConfig().scheduler.pmWake).toEqual({
        enabled: false,
        minIntervalMs: 1_800_000,
        backstopMs: 28_800_000,
        statePath: resolveFromAppRoot('logs/pm-wake-state.json'),
        sink: 'log',
      });
    });

    it('PM wakes support log/inbox only and reject retired direct-target settings', () => {
      try {
        delete process.env.VIBESYNC_PM_WAKE_SINK;
        expect(loadConfig().scheduler.pmWake.sink).toBe('log');

        process.env.VIBESYNC_PM_WAKE_SINK = 'inbox';
        delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
        expect(loadConfig().scheduler.pmWake.sink).toBe('inbox');
        process.env.VIBESYNC_PM_WAKE_SINK = 'iroh';
        expect(() => loadConfig()).toThrow('Config validation failed');
        process.env.VIBESYNC_ORCHESTRATION_PROVIDER = 'letta-code-iroh';
        expect(() => loadConfig()).toThrow('Config validation failed');
        process.env.VIBESYNC_PM_WAKE_SINK = 'inbox';
        process.env.VIBESYNC_PM_WAKE_CONVERSATION_ID = 'conv-fixed';
        expect(() => loadConfig()).toThrow('VIBESYNC_PM_WAKE_CONVERSATION_ID was removed');
        delete process.env.VIBESYNC_PM_WAKE_CONVERSATION_ID;

        // whole-string enum: no trimming, no case folding, no near misses
        for (const bad of ['IROH', 'iroh ', 'INBOX', ' inbox', ' log', 'matrix', 'log,iroh']) {
          process.env.VIBESYNC_PM_WAKE_SINK = bad;
          expect(() => loadConfig(), bad).toThrow('Config validation failed');
        }
      } finally {
        delete process.env.VIBESYNC_PM_WAKE_SINK;
        delete process.env.VIBESYNC_PM_WAKE_CONVERSATION_ID;
        delete process.env.VIBESYNC_ORCHESTRATION_PROVIDER;
      }
    });

    it('maps explicit inbox CLI settings and rejects incomplete paths without assuming approval', () => {
      const keys = {
        VIBESYNC_PM_WAKE_SINK: 'inbox',
        VIBESYNC_PM_WAKE_CLI_EXECUTABLE: '/release/bin/meridian-iroh-wrapper',
        VIBESYNC_PM_WAKE_CLI_SENDER: '  service-agent  ',
        VIBESYNC_PM_WAKE_CLI_IDENTITIES: '/service/identities',
        VIBESYNC_PM_WAKE_CLI_ADDRESS_STORE: '/service/hosts',
      };
      Object.assign(process.env, keys);
      try {
        expect(loadConfig().scheduler.pmWake.cli).toEqual({
          executable: keys.VIBESYNC_PM_WAKE_CLI_EXECUTABLE, senderAgentId: 'service-agent',
          identityDir: '/service/identities', addressStore: '/service/hosts', contractVerified: false,
        });
        process.env.VIBESYNC_PM_WAKE_CLI_CONTRACT_VERIFIED = 'true';
        expect(loadConfig().scheduler.pmWake.cli?.contractVerified).toBe(true);
        process.env.VIBESYNC_PM_WAKE_CLI_SENDER = '   ';
        expect(() => loadConfig()).toThrow('Config validation failed');
        process.env.VIBESYNC_PM_WAKE_CLI_SENDER = keys.VIBESYNC_PM_WAKE_CLI_SENDER;
        process.env.VIBESYNC_PM_WAKE_CLI_EXECUTABLE = 'meridian';
        expect(() => loadConfig()).toThrow('Config validation failed');
        process.env.VIBESYNC_PM_WAKE_CLI_EXECUTABLE = keys.VIBESYNC_PM_WAKE_CLI_EXECUTABLE;
        delete process.env.VIBESYNC_PM_WAKE_CLI_SENDER;
        expect(() => loadConfig()).toThrow('Config validation failed');
      } finally {
        for (const key of Object.keys(keys)) delete process.env[key];
        delete process.env.VIBESYNC_PM_WAKE_CLI_CONTRACT_VERIFIED;
      }
    });

    it('pmWake env keys map through; ms are whole-string integers capped at the timer ceiling (vibesync-2bgv)', () => {
      process.env.VIBESYNC_PM_WAKE_ENABLED = 'true';
      process.env.VIBESYNC_PM_WAKE_MIN_INTERVAL_MS = '60000';
      process.env.VIBESYNC_PM_WAKE_BACKSTOP_MS = '99999999999999';
      process.env.VIBESYNC_PM_WAKE_STATE_PATH = '/tmp/x/state.json';
      try {
        expect(loadConfig().scheduler.pmWake).toEqual({
          enabled: true,
          minIntervalMs: 60000,
          backstopMs: 2_147_483_647,
          statePath: '/tmp/x/state.json',
          sink: 'log',
        });
        for (const bad of ['8h', '1e3', '-1', '5.5', ' 5', 'abc']) {
          process.env.VIBESYNC_PM_WAKE_BACKSTOP_MS = bad;
          expect(() => loadConfig(), bad).toThrow('Config validation failed');
        }
        process.env.VIBESYNC_PM_WAKE_BACKSTOP_MS = '28800000';
        process.env.VIBESYNC_PM_WAKE_MIN_INTERVAL_MS = '1s';
        expect(() => loadConfig()).toThrow('Config validation failed');
      } finally {
        for (const k of Object.keys(process.env)) if (k.startsWith('VIBESYNC_PM_WAKE_')) delete process.env[k];
      }
    });

    it('VIBESYNC_SCHEDULER_RUN_DEADLINE_MS maps through; 0 = no deadline; the WHOLE string must be a non-negative integer (vibesync-izn3)', () => {
      process.env.VIBESYNC_SCHEDULER_RUN_DEADLINE_MS = '120000';
      expect(loadConfig().scheduler.runDeadlineMs).toBe(120000);
      process.env.VIBESYNC_SCHEDULER_RUN_DEADLINE_MS = '0';
      expect(loadConfig().scheduler.runDeadlineMs).toBe(0);
      for (const bad of ['1h', '1e3', '-1', '5.5', ' 5', '0x10', 'abc']) {
        process.env.VIBESYNC_SCHEDULER_RUN_DEADLINE_MS = bad;
        expect(() => loadConfig(), bad).toThrow('Config validation failed');
      }
    });

    it('any value other than "true" leaves it off', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = '1';
      expect(loadConfig().scheduler.enabled).toBe(false);
    });

    it('enabled without a project fails config validation', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_PROJECTS');
    });

    it('parses a trimmed project list and rejects empty or duplicate entries', () => {
      process.env.VIBESYNC_SCHEDULER_PROJECTS = ' alpha, beta ';
      expect(loadConfig().scheduler.projectIdentifiers).toEqual(['alpha', 'beta']);
      for (const projects of ['alpha,,beta', 'alpha, ', 'alpha,alpha']) {
        process.env.VIBESYNC_SCHEDULER_PROJECTS = projects;
        expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_PROJECTS');
      }
    });

    it('rejects the removed singular project key with both names', () => {
      process.env.VIBESYNC_SCHEDULER_PROJECT = 'vibesync';
      expect(() => loadConfig()).toThrow(/VIBESYNC_SCHEDULER_PROJECT.*VIBESYNC_SCHEDULER_PROJECTS/);
    });

    it('names the old key even when the scheduler is enabled (the live config at upgrade)', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      process.env.VIBESYNC_SCHEDULER_PROJECT = 'vibesync';
      delete process.env.VIBESYNC_SCHEDULER_PROJECTS;
      expect(() => loadConfig()).toThrow(/VIBESYNC_SCHEDULER_PROJECT was replaced by VIBESYNC_SCHEDULER_PROJECTS/);
    });

    it('autoMerge is only on with the explicit flag, and then needs required checks', () => {
      process.env.VIBESYNC_SCHEDULER_ENABLED = 'true';
      process.env.VIBESYNC_SCHEDULER_PROJECTS = 'vibesync';
      process.env.VIBESYNC_SCHEDULER_AUTO_MERGE = 'true';
      expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_REQUIRED_CHECKS');
      process.env.VIBESYNC_SCHEDULER_REQUIRED_CHECKS = 'typecheck, test';
      // vibesync-5c8y: checks alone are not enough — the repos must be named too.
      expect(() => loadConfig()).toThrow('VIBESYNC_SCHEDULER_ALLOWED_REPOS');
      process.env.VIBESYNC_SCHEDULER_ALLOWED_REPOS = 'oculairmedia/vibesync';
      const { scheduler } = loadConfig();
      expect(scheduler.autoMerge).toBe(true);
      expect(scheduler.requiredChecks).toEqual(['typecheck', 'test']);
      expect(scheduler.allowedRepos).toEqual(['oculairmedia/vibesync']);
    });

    it('VIBESYNC_SCHEDULER_ALLOWED_REPOS is parsed as trimmed CSV and every entry is validated (vibesync-5c8y)', () => {
      process.env.VIBESYNC_SCHEDULER_ALLOWED_REPOS = ' oculairmedia/vibesync , o/r ,,';
      expect(loadConfig().scheduler.allowedRepos).toEqual(['oculairmedia/vibesync', 'o/r']);
      for (const bad of ['not-a-repo', 'a/b/c', 'o/r,evil', 'o/r;rm', 'o/r,']) {
        process.env.VIBESYNC_SCHEDULER_ALLOWED_REPOS = bad;
        if (bad === 'o/r,') { expect(loadConfig().scheduler.allowedRepos).toEqual(['o/r']); continue; }
        expect(() => loadConfig(), bad).toThrow('VIBESYNC_SCHEDULER_ALLOWED_REPOS');
      }
    });
  });
});
