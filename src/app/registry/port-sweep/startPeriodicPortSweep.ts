/**
 * Recurring Beads/Dolt port-collision sweep (vibesync-1ue).
 *
 * The boot-time sweep (`sweepAll` from index.ts) handles the host-reboot
 * case, but post-boot races still leak: a project's dolt server can crash
 * and a sibling project then steals the port on its next start. This
 * module runs the same `sweepAll(..., { apply: true })` on a timer so the
 * fleet self-heals between boots.
 *
 * Default cadence is conservative — every 2 minutes — because the sweep
 * shells out to `ss`/`bd` and the conflict case is rare. Override via
 * `VIBESYNC_PORT_SWEEP_INTERVAL_MS` for tests or busier environments.
 *
 * Returned handle's `stop()` clears the timer; `runOnce()` triggers an
 * immediate out-of-band sweep (used by tests).
 */

import { sweepAll, type SweepReport, type SweeperProject } from './PortSweeper.js';

export const DEFAULT_PORT_SWEEP_INTERVAL_MS = 120_000;
const MAX_REPAIR_BACKOFF_MS = 30 * 60_000;

export interface PeriodicSweepLogger {
  info?: (ctx: Record<string, unknown>, msg: string) => void;
  warn?: (ctx: Record<string, unknown>, msg: string) => void;
  error?: (ctx: Record<string, unknown>, msg: string) => void;
}

export interface PeriodicSweepDeps {
  /** Fetch the current registered-projects list. Re-called every tick so
   *  newly-registered projects are included without restarting the loop. */
  readonly listProjects: () => readonly SweeperProject[];
  /**
   * Projects eligible for repair. Every listed project's port is still
   * compared (an archived project's pinned port can collide with an active
   * one), but only these are rewritten. Default: all listed projects.
   */
  readonly repairable?: () => ReadonlySet<string>;
  readonly logger: PeriodicSweepLogger;
  /** Interval in ms. Default 120s. */
  readonly intervalMs?: number;
  /** Override setInterval/clearInterval for tests. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface PeriodicSweepHandle {
  /** Stop the recurring sweep. Idempotent. */
  stop(): void;
  /** Run one sweep immediately (off-cycle). Returns the report. */
  runOnce(): Promise<SweepReport>;
}

export function startPeriodicPortSweep(deps: PeriodicSweepDeps): PeriodicSweepHandle {
  const interval = deps.intervalMs ?? DEFAULT_PORT_SWEEP_INTERVAL_MS;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  let stopped = false;
  let inFlight: Promise<SweepReport> | null = null;
  const failures = new Map<string, { count: number; retryAt: number }>();

  async function performSweep(): Promise<SweepReport> {
    const registry = deps.listProjects();
    const only = deps.repairable?.();
    const report = await sweepAll(registry, undefined, {
      apply: true,
      ...(only ? { only } : {}),
      canRepair: (project) => (failures.get(project.identifier)?.retryAt ?? 0) <= Date.now(),
    });
    for (const repair of report.repairs) {
      if (repair.ok) {
        failures.delete(repair.project.identifier);
      } else {
        const count = (failures.get(repair.project.identifier)?.count ?? 0) + 1;
        const delay = Math.min(deps.intervalMs ?? DEFAULT_PORT_SWEEP_INTERVAL_MS, MAX_REPAIR_BACKOFF_MS)
          * 2 ** Math.min(count - 1, 10);
        failures.set(repair.project.identifier, {
          count,
          retryAt: Date.now() + Math.min(delay, MAX_REPAIR_BACKOFF_MS),
        });
      }
    }
    if (report.conflicts.length > 0) {
      deps.logger.warn?.(
        {
          scanned: report.scanned,
          conflicts: report.conflicts.length,
          deferred: report.deferred.length,
          repaired: report.repairs.filter((r) => r.ok).length,
          failed: report.repairs.filter((r) => !r.ok).length,
          details: report.conflicts.map((c) => ({
            project: c.project.identifier,
            kind: c.kind,
            port: c.currentPort,
            detail: c.detail,
          })),
        },
        'Periodic Beads/Dolt port sweep detected and repaired conflicts',
      );
      for (const failure of report.repairs.filter((r) => !r.ok)) {
        deps.logger.error?.(
          {
            project: failure.project.identifier,
            oldPort: failure.oldPort,
            newPort: failure.newPort,
            err: failure.error,
          },
          'Periodic Beads/Dolt port repair failed — project may read the wrong database',
        );
      }
    } else {
      deps.logger.info?.(
        { scanned: report.scanned },
        'Periodic Beads/Dolt port sweep: no conflicts',
      );
    }
    return report;
  }

  function runSweep(): Promise<SweepReport> {
    if (inFlight) return inFlight;
    const running = performSweep();
    inFlight = running;
    const settled = running.then(() => {
      if (inFlight === running) inFlight = null;
    }, () => {
      if (inFlight === running) inFlight = null;
    }).catch(() => undefined);
    void settled;
    return running;
  }

  const handle = setIntervalFn(() => {
    if (stopped) return;
    void runSweep().catch((err: unknown) => {
      deps.logger.warn?.({ err }, 'Periodic Beads/Dolt port sweep threw');
    });
  }, interval);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      (clearIntervalFn as (handle: unknown) => void)(handle);
    },
    runOnce: runSweep,
  };
}
