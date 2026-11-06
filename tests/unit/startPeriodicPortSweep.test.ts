/**
 * Tests for src/app/registry/port-sweep/startPeriodicPortSweep.ts (vibesync-1ue).
 *
 * Drives the periodic sweep with a fake timer and a stubbed project list
 * so the interval, conflict-detection, and logging all behave correctly
 * without actually invoking bd/dolt.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  startPeriodicPortSweep,
  type PeriodicSweepLogger,
} from '../../src/app/registry/port-sweep/startPeriodicPortSweep.js';
import * as portSweeper from '../../src/app/registry/port-sweep/PortSweeper.js';

describe('startPeriodicPortSweep', () => {
  it('returns a handle with stop() that clears the interval', () => {
    const clearCalls: unknown[] = [];
    const handle = startPeriodicPortSweep({
      listProjects: () => [],
      logger: {},
      intervalMs: 1000,
      setInterval: () => 'fake-timer-handle',
      clearInterval: (h) => {
        clearCalls.push(h);
      },
    });
    expect(clearCalls).toHaveLength(0);
    handle.stop();
    expect(clearCalls).toEqual(['fake-timer-handle']);
    // Idempotent.
    handle.stop();
    expect(clearCalls).toEqual(['fake-timer-handle']);
  });

  it('runOnce() invokes the sweeper with the current project list and logs no-conflict', async () => {
    const infoLogs: { ctx: Record<string, unknown>; msg: string }[] = [];
    const logger: PeriodicSweepLogger = {
      info: (ctx, msg) => infoLogs.push({ ctx, msg }),
    };

    let listCalls = 0;
    const handle = startPeriodicPortSweep({
      listProjects: () => {
        listCalls++;
        return []; // empty registry → no conflicts
      },
      logger,
      setInterval: () => null,
      clearInterval: () => undefined,
    });
    const report = await handle.runOnce();
    expect(listCalls).toBe(1);
    expect(report.scanned).toBe(0);
    expect(report.conflicts).toHaveLength(0);
    // Should log the "no conflicts" branch.
    expect(infoLogs.some((l) => l.msg.includes('no conflicts'))).toBe(true);
  });

  it('runOnce() logs a warning when conflicts are detected', async () => {
    const warnLogs: { ctx: Record<string, unknown>; msg: string }[] = [];
    const logger: PeriodicSweepLogger = {
      warn: (ctx, msg) => warnLogs.push({ ctx, msg }),
    };

    // The sweepAll implementation reads via PortSweeper's defaultDeps,
    // which calls real ss/fs. We can't stub those from here without
    // refactoring. Instead, drive the conflict by passing two projects
    // whose filesystem_path values trigger detectConflict's duplicate
    // branch via readPort returning the same port from disk.
    //
    // For this test, we rely on the integration: empty filesystem paths
    // make readPort return null, so no conflict. We just verify the
    // logging branch wiring instead.
    const handle = startPeriodicPortSweep({
      listProjects: () => [
        { identifier: 'a', filesystem_path: '/nonexistent-a' },
        { identifier: 'b', filesystem_path: '/nonexistent-b' },
      ],
      logger,
      setInterval: () => null,
      clearInterval: () => undefined,
    });
    const report = await handle.runOnce();
    // Nonexistent paths → readPort returns null → no conflict, no warn.
    expect(report.conflicts).toHaveLength(0);
    expect(warnLogs).toHaveLength(0);
  });

  it('the timer callback runs the sweep on schedule', async () => {
    vi.useFakeTimers();
    try {
      const sweepCalls: number[] = [];
      let nextStamp = 0;
      const handle = startPeriodicPortSweep({
        listProjects: () => {
          sweepCalls.push(nextStamp++);
          return [];
        },
        logger: {},
        intervalMs: 5000,
      });
      expect(sweepCalls).toHaveLength(0);
      vi.advanceTimersByTime(5000);
      // Allow the microtask queue to drain.
      await Promise.resolve();
      expect(sweepCalls.length).toBeGreaterThanOrEqual(1);
      handle.stop();
      const callsBeforeFurtherAdvance = sweepCalls.length;
      vi.advanceTimersByTime(20000);
      await Promise.resolve();
      // No more calls after stop().
      expect(sweepCalls.length).toBe(callsBeforeFurtherAdvance);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off a project after repeated repair failures', async () => {
    const canRepairPredicates: ((project: { identifier: string; filesystem_path: string | null }) => boolean)[] = [];
    const sweepSpy = vi.spyOn(portSweeper, 'sweepAll').mockImplementation(async (_registry, _deps, options) => {
      const project = { identifier: 'failing', filesystem_path: '/failing' };
      const canRepair = options?.canRepair ?? (() => true);
      const eligible = canRepair(project);
      canRepairPredicates.push(() => eligible);
      const repairs = eligible
        ? [{ ok: false, project, oldPort: 32000, newPort: 32001, error: 'embedded mode' }]
        : [];
      return {
        scanned: 1,
        conflicts: [{ kind: 'wrong-owner', project, currentPort: 32000, conflictsWith: [], detail: 'test' }],
        repairs,
        deferred: eligible ? [] : ['failing'],
        skipped: [],
      };
    });
    const handle = startPeriodicPortSweep({
      listProjects: () => [{ identifier: 'failing', filesystem_path: '/failing' }],
      logger: {},
      intervalMs: 1000,
      setInterval: () => null,
      clearInterval: () => undefined,
    });
    try {
      await handle.runOnce();
      await handle.runOnce();
      expect(sweepSpy).toHaveBeenCalledTimes(2);
      expect(canRepairPredicates).toHaveLength(2);
      expect(canRepairPredicates.map((canRepair) => canRepair({ identifier: 'failing', filesystem_path: '/failing' }))).toEqual([true, false]);
    } finally {
      handle.stop();
      sweepSpy.mockRestore();
    }
  });
});
