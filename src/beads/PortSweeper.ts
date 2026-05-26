/**
 * Shared Beads/Dolt port-collision sweeper.
 *
 * Background (vibesync-jhb): two projects can race for the same TCP port at
 * boot. Each project's `.beads/dolt-server.port` is just a pinned number;
 * whichever project's `dolt sql-server` binds first wins. If a sibling
 * project happens to host a database of the same name (e.g., both have a
 * `letta_mobile` DB), bd connects without erroring and silently reads the
 * wrong data. This module is the single place that detects and repairs
 * those conflicts.
 *
 * Detection (`detectConflict`):
 *   1. Duplicate-configured-port: two registered projects pin the same
 *      .beads/dolt-server.port. Whichever loads first owns the port; the
 *      loser silently reads someone else's database.
 *   2. Wrong-owner: the process listening on the configured port has a
 *      `/proc/<pid>/cwd` that is NOT this project's `.beads/dolt`. Same
 *      failure mode as above, after a race.
 *
 * Repair (`repairProject`): use bd's supported subcommands only —
 * `bd dolt set port <free>` followed by `bd dolt start`. Never edit
 * `.beads/dolt` contents directly. Never kill-by-port (the offending pid
 * may be a different project's healthy server).
 *
 * Used by:
 *   - `DoltHubProvisioningService.ensureUniqueBeadsPort` (per-project,
 *     invoked during DoltHub provisioning)
 *   - `scripts/preflight/bd-fleet-port-repair.ts` (fleet-wide CLI)
 *   - `sweepAll`: fleet-wide programmatic entry point used by boot/recurring
 *     sweep callers (vibesync-52g, vibesync-1ue)
 *
 * Test seams: all process/filesystem calls go through `PortSweeperDeps` so
 * tests can stub them. `defaultDeps` are exported for callers that want to
 * pass through.
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_FLEET_PORT_START = 32000;
export const DEFAULT_FLEET_PORT_END = 60999;

/**
 * Minimal project shape consumed by the sweeper. Both the vibesync registry
 * row and the DoltHubProvisioningService `BeadsProject` are compatible.
 */
export interface SweeperProject {
  readonly identifier: string;
  readonly filesystem_path: string | null;
}

export type ConflictKind = 'duplicate-configured-port' | 'wrong-owner';

export interface PortConflict {
  readonly kind: ConflictKind;
  readonly project: SweeperProject;
  readonly currentPort: number;
  /** For duplicate-configured-port: the other projects that share the port. */
  readonly conflictsWith: readonly string[];
  /** Detail string suitable for logging or error messages. */
  readonly detail: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface PortSweeperDeps {
  /** Read .beads/dolt-server.port. */
  readonly readPort: (projectPath: string) => number | null;
  /** Return the set of TCP ports currently in LISTEN state on this host. */
  readonly listeningPorts: () => Set<number>;
  /** Resolve /proc/<pid>/cwd → directory the process was started in. */
  readonly portOwnerCwd: (port: number) => string | null;
  /** Run `bd <args>` in the given cwd. Used by repairProject. */
  readonly runBd: CommandRunner;
}

export interface RepairOptions {
  readonly dryRun?: boolean;
  readonly timeoutMs?: number;
  /** Hook to record the human-readable command for plan/audit output. */
  readonly recordCommand?: (cmd: string) => void;
}

export interface RepairResult {
  readonly ok: boolean;
  readonly project: SweeperProject;
  readonly oldPort: number;
  readonly newPort: number;
  readonly error?: string;
}

export interface SweepReport {
  readonly scanned: number;
  readonly conflicts: readonly PortConflict[];
  readonly repairs: readonly RepairResult[];
  readonly skipped: readonly { identifier: string; reason: string }[];
}

export interface SweepOptions extends RepairOptions {
  readonly apply?: boolean;
  /** Only sweep these project identifiers (default: all). */
  readonly only?: ReadonlySet<string>;
  readonly portStart?: number;
  readonly portEnd?: number;
}

/* --------------------------------------------------------------------- *
 * Default dependency implementations (read real fs/proc/ss).
 * --------------------------------------------------------------------- */

export function readBeadsPortFromDisk(projectPath: string): number | null {
  try {
    const raw = readFileSync(join(projectPath, '.beads', 'dolt-server.port'), 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function listeningPortsFromSs(): Set<number> {
  try {
    const output = execFileSync('ss', ['-H', '-tln'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ports = new Set<number>();
    for (const line of output.split('\n')) {
      const match = /:(\d+)\s/.exec(line);
      if (match?.[1]) ports.add(Number.parseInt(match[1], 10));
    }
    return ports;
  } catch {
    return new Set();
  }
}

export function portOwnerCwdFromProc(port: number): string | null {
  try {
    const output = execFileSync('ss', ['-H', '-tlnp', `sport = :${port}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = output.split('\n').find((entry) => entry.trim().length > 0);
    if (!line) return null;
    const pid = /pid=(\d+)/.exec(line)?.[1];
    if (!pid) return null;
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function defaultRunBd(
  _command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const result = await execFileAsync('bd', args as string[], {
    cwd: options.cwd,
    timeout: options.timeout,
    env: options.env,
  });
  return {
    stdout: (result as { stdout?: string }).stdout || '',
    stderr: (result as { stderr?: string }).stderr || '',
  };
}

export const defaultDeps: PortSweeperDeps = {
  readPort: readBeadsPortFromDisk,
  listeningPorts: listeningPortsFromSs,
  portOwnerCwd: portOwnerCwdFromProc,
  runBd: defaultRunBd,
};

/* --------------------------------------------------------------------- *
 * Detection.
 * --------------------------------------------------------------------- */

/**
 * Decide whether a project's currently configured port is in conflict.
 * Returns null when the project is healthy or has no port file yet.
 *
 * Detects two kinds of conflict in priority order:
 *   - duplicate-configured-port (another registered project pins the same
 *     port — whichever wins the race silently reads the wrong DB)
 *   - wrong-owner (some process is already listening on the port but its
 *     `/proc/<pid>/cwd` is NOT this project's `.beads/dolt`)
 */
export function detectConflict(
  project: SweeperProject,
  registry: readonly SweeperProject[],
  deps: PortSweeperDeps = defaultDeps,
): PortConflict | null {
  const projectPath = project.filesystem_path;
  if (!projectPath) return null;
  const port = deps.readPort(projectPath);
  if (port === null) return null;

  const others = registry.filter(
    (candidate) =>
      candidate.identifier !== project.identifier &&
      candidate.filesystem_path !== null &&
      candidate.filesystem_path !== undefined &&
      deps.readPort(candidate.filesystem_path) === port,
  );
  if (others.length > 0) {
    return {
      kind: 'duplicate-configured-port',
      project,
      currentPort: port,
      conflictsWith: others.map((entry) => entry.identifier),
      detail: `port ${port} is also pinned by ${others.map((entry) => entry.identifier).join(', ')}`,
    };
  }

  const expectedDoltDir = join(projectPath, '.beads', 'dolt');
  const ownerCwd = deps.portOwnerCwd(port);
  if (ownerCwd !== null && ownerCwd !== expectedDoltDir) {
    return {
      kind: 'wrong-owner',
      project,
      currentPort: port,
      conflictsWith: [],
      detail: `port ${port} is owned by another process at cwd=${ownerCwd}, expected ${expectedDoltDir}`,
    };
  }

  return null;
}

/**
 * Pick the lowest free port in the fleet range that is neither pinned by a
 * registered project nor currently in LISTEN state on the host.
 */
export function pickFreePort(
  registry: readonly SweeperProject[],
  deps: PortSweeperDeps = defaultDeps,
  portStart: number = DEFAULT_FLEET_PORT_START,
  portEnd: number = DEFAULT_FLEET_PORT_END,
): number {
  const reserved = new Set<number>();
  for (const project of registry) {
    if (!project.filesystem_path) continue;
    const port = deps.readPort(project.filesystem_path);
    if (port !== null) reserved.add(port);
  }
  for (const port of deps.listeningPorts()) reserved.add(port);
  for (let port = portStart; port <= portEnd; port++) {
    if (!reserved.has(port)) return port;
  }
  throw new Error(`No free Beads/Dolt port in range ${portStart}-${portEnd}`);
}

/* --------------------------------------------------------------------- *
 * Repair.
 * --------------------------------------------------------------------- */

/**
 * Repair a single project by moving it to `newPort`. Uses only supported
 * bd subcommands; never mutates `.beads/dolt` contents or kills processes.
 */
export async function repairProject(
  project: SweeperProject,
  oldPort: number,
  newPort: number,
  deps: PortSweeperDeps = defaultDeps,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const projectPath = project.filesystem_path;
  if (!projectPath) {
    return {
      ok: false,
      project,
      oldPort,
      newPort,
      error: 'project has no filesystem_path',
    };
  }
  const timeout = opts.timeoutMs ?? 30000;
  const env = process.env as NodeJS.ProcessEnv;

  const setCmd = `cd ${projectPath} && bd dolt set port ${newPort}`;
  const startCmd = `cd ${projectPath} && bd dolt start`;
  opts.recordCommand?.(setCmd);
  opts.recordCommand?.(startCmd);

  if (opts.dryRun) {
    return { ok: true, project, oldPort, newPort };
  }

  try {
    await deps.runBd('bd', ['dolt', 'set', 'port', String(newPort)], {
      cwd: projectPath,
      timeout,
      env,
    });
    await deps.runBd('bd', ['dolt', 'start'], { cwd: projectPath, timeout, env });
    return { ok: true, project, oldPort, newPort };
  } catch (error) {
    return {
      ok: false,
      project,
      oldPort,
      newPort,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* --------------------------------------------------------------------- *
 * Fleet-wide sweep.
 * --------------------------------------------------------------------- */

/**
 * Scan every registered project, detect conflicts, and (when `apply: true`)
 * repair them in-place. Returns a structured report suitable for logging.
 *
 * Repair allocates one free port per conflict, recomputing reservations
 * after each fix so two concurrently-broken projects don't collide on the
 * same replacement port.
 */
export async function sweepAll(
  registry: readonly SweeperProject[],
  deps: PortSweeperDeps = defaultDeps,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const conflicts: PortConflict[] = [];
  const repairs: RepairResult[] = [];
  const skipped: { identifier: string; reason: string }[] = [];

  const selected = opts.only
    ? registry.filter((project) => opts.only!.has(project.identifier))
    : registry;

  for (const project of selected) {
    if (!project.filesystem_path) {
      skipped.push({ identifier: project.identifier, reason: 'no filesystem_path' });
      continue;
    }
    const conflict = detectConflict(project, registry, deps);
    if (!conflict) continue;
    conflicts.push(conflict);

    if (opts.apply) {
      const newPort = pickFreePort(
        registry,
        deps,
        opts.portStart ?? DEFAULT_FLEET_PORT_START,
        opts.portEnd ?? DEFAULT_FLEET_PORT_END,
      );
      const result = await repairProject(project, conflict.currentPort, newPort, deps, opts);
      repairs.push(result);
    }
  }

  return { scanned: selected.length, conflicts, repairs, skipped };
}
