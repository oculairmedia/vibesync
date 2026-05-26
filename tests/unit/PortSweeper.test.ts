/**
 * Tests for src/beads/PortSweeper.ts.
 *
 * Covers vibesync-d15: detection (duplicate-configured-port + wrong-owner),
 * pickFreePort recompute, repairProject command sequence + dry-run, and
 * the sweepAll fleet entry point.
 */

import { describe, expect, it } from 'vitest';
import {
  detectConflict,
  pickFreePort,
  repairProject,
  sweepAll,
  type CommandResult,
  type PortSweeperDeps,
  type SweeperProject,
} from '../../src/beads/PortSweeper.js';

function makeDeps(overrides: Partial<PortSweeperDeps> = {}): PortSweeperDeps {
  return {
    readPort: () => null,
    listeningPorts: () => new Set<number>(),
    portOwnerCwd: () => null,
    runBd: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  };
}

const projectA: SweeperProject = { identifier: 'a', filesystem_path: '/srv/a' };
const projectB: SweeperProject = { identifier: 'b', filesystem_path: '/srv/b' };

describe('detectConflict', () => {
  it('returns null when no port file is present', () => {
    const result = detectConflict(projectA, [projectA], makeDeps({ readPort: () => null }));
    expect(result).toBeNull();
  });

  it('returns null when port is healthy (owner cwd matches expected dolt dir)', () => {
    const result = detectConflict(projectA, [projectA], makeDeps({
      readPort: () => 3308,
      portOwnerCwd: () => '/srv/a/.beads/dolt',
    }));
    expect(result).toBeNull();
  });

  it('detects duplicate-configured-port and lists the conflicting projects', () => {
    const result = detectConflict(projectA, [projectA, projectB], makeDeps({
      readPort: () => 3308,
      portOwnerCwd: () => '/srv/a/.beads/dolt',
    }));
    expect(result?.kind).toBe('duplicate-configured-port');
    expect(result?.currentPort).toBe(3308);
    expect(result?.conflictsWith).toEqual(['b']);
  });

  it('detects wrong-owner when the listening process cwd belongs to another project', () => {
    // Only one project pins this port → no duplicate. But the listening
    // process cwd is not /srv/a/.beads/dolt → wrong-owner.
    const result = detectConflict(projectA, [projectA], makeDeps({
      readPort: () => 3308,
      portOwnerCwd: () => '/opt/stacks/letta-code-parallel/home/.beads/shared-server/dolt',
    }));
    expect(result?.kind).toBe('wrong-owner');
    expect(result?.detail).toContain('/opt/stacks/letta-code-parallel');
  });

  it('prefers duplicate-configured-port over wrong-owner when both fire', () => {
    // Two pins on 3308 AND the listening cwd is foreign — duplicate wins
    // because it's the upstream cause (the second project that pinned the
    // port is the one that lost the race).
    const result = detectConflict(projectA, [projectA, projectB], makeDeps({
      readPort: () => 3308,
      portOwnerCwd: () => '/elsewhere',
    }));
    expect(result?.kind).toBe('duplicate-configured-port');
  });
});

describe('pickFreePort', () => {
  it('skips ports pinned by any registered project', () => {
    const reserved = new Map<string, number>([
      ['/srv/a', 32000],
      ['/srv/b', 32001],
    ]);
    const port = pickFreePort([projectA, projectB], makeDeps({
      readPort: (p) => reserved.get(p) ?? null,
    }));
    expect(port).toBe(32002);
  });

  it('skips ports currently in LISTEN state on the host', () => {
    const port = pickFreePort([], makeDeps({
      listeningPorts: () => new Set([32000, 32001, 32002]),
    }));
    expect(port).toBe(32003);
  });

  it('throws when the range is exhausted', () => {
    const allReserved = new Set<number>();
    for (let p = 40000; p <= 40002; p++) allReserved.add(p);
    expect(() =>
      pickFreePort([], makeDeps({ listeningPorts: () => allReserved }), 40000, 40002),
    ).toThrow(/No free Beads\/Dolt port in range 40000-40002/);
  });
});

describe('repairProject', () => {
  it('runs `bd dolt set port` then `bd dolt start` in the project cwd', async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const result = await repairProject(
      projectA,
      3308,
      32100,
      makeDeps({
        runBd: async (_cmd, args, opts): Promise<CommandResult> => {
          calls.push({ args, cwd: opts.cwd });
          return { stdout: '', stderr: '' };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.oldPort).toBe(3308);
    expect(result.newPort).toBe(32100);
    expect(calls).toEqual([
      { args: ['dolt', 'set', 'port', '32100'], cwd: '/srv/a' },
      { args: ['dolt', 'start'], cwd: '/srv/a' },
    ]);
  });

  it('dry-run records the commands but does not invoke bd', async () => {
    const recorded: string[] = [];
    let invoked = 0;
    const result = await repairProject(
      projectA,
      3308,
      32100,
      makeDeps({
        runBd: async () => {
          invoked++;
          return { stdout: '', stderr: '' };
        },
      }),
      { dryRun: true, recordCommand: (cmd) => recorded.push(cmd) },
    );
    expect(result.ok).toBe(true);
    expect(invoked).toBe(0);
    expect(recorded).toEqual([
      'cd /srv/a && bd dolt set port 32100',
      'cd /srv/a && bd dolt start',
    ]);
  });

  it('returns an error result when bd throws', async () => {
    const result = await repairProject(
      projectA,
      3308,
      32100,
      makeDeps({
        runBd: async () => {
          throw new Error('bd: connection refused');
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
  });
});

describe('sweepAll', () => {
  it('flags both projects as duplicate when two pin the same port (symmetric)', async () => {
    // Two projects pin port 32000. detectConflict is symmetric: a sees b as
    // duplicate, b sees a as duplicate. Both surface as conflicts so the
    // caller can repair both to new ports — neither was authoritatively
    // holding the port (whichever bound first only won by race).
    const report = await sweepAll([projectA, projectB], makeDeps({
      readPort: () => 32000,
      portOwnerCwd: () => '/srv/a/.beads/dolt',
    }));
    expect(report.conflicts).toHaveLength(2);
    expect(report.conflicts.map((c) => c.project.identifier).sort()).toEqual(['a', 'b']);
    expect(report.conflicts.every((c) => c.kind === 'duplicate-configured-port')).toBe(true);
  });

  it('emits zero conflicts when each project pins a unique port owned by itself', async () => {
    const ports = new Map<string, number>([
      ['/srv/a', 32000],
      ['/srv/b', 32001],
    ]);
    const cwds = new Map<number, string>([
      [32000, '/srv/a/.beads/dolt'],
      [32001, '/srv/b/.beads/dolt'],
    ]);
    const report = await sweepAll([projectA, projectB], makeDeps({
      readPort: (p) => ports.get(p) ?? null,
      portOwnerCwd: (port) => cwds.get(port) ?? null,
    }));
    expect(report.scanned).toBe(2);
    expect(report.conflicts).toHaveLength(0);
    expect(report.repairs).toHaveLength(0);
  });

  it('apply=true repairs conflicts and returns the new port assignments', async () => {
    const calls: { identifier: string; args: readonly string[] }[] = [];
    const report = await sweepAll(
      [projectA, projectB],
      makeDeps({
        readPort: () => 3308, // both pinned to 3308 → duplicate
        runBd: async (_cmd, args, opts): Promise<CommandResult> => {
          const identifier = opts.cwd === '/srv/a' ? 'a' : 'b';
          calls.push({ identifier, args });
          return { stdout: '', stderr: '' };
        },
      }),
      { apply: true },
    );
    // Project a sees b as duplicate; project b sees a as duplicate. Both
    // conflicts fire → both get repaired.
    expect(report.conflicts).toHaveLength(2);
    expect(report.repairs).toHaveLength(2);
    expect(report.repairs.every((r) => r.ok)).toBe(true);
    expect(calls.length).toBe(4); // 2 projects × (set port + start)
  });

  it('only honors the `only` filter', async () => {
    const report = await sweepAll(
      [projectA, projectB],
      makeDeps({ readPort: () => 3308 }),
      { only: new Set(['a']) },
    );
    expect(report.scanned).toBe(1);
    expect(report.conflicts.map((c) => c.project.identifier)).toEqual(['a']);
  });

  it('records skipped projects that lack a filesystem_path', async () => {
    const orphan: SweeperProject = { identifier: 'orphan', filesystem_path: null };
    const report = await sweepAll([orphan], makeDeps());
    expect(report.skipped).toEqual([{ identifier: 'orphan', reason: 'no filesystem_path' }]);
  });
});
