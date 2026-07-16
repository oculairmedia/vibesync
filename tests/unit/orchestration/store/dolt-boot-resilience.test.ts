/**
 * Unit tests for resilient Dolt port resolution — vibesync-nl0l.
 *
 * On every vibesync restart the service SIGKILLs its child Dolt fleet and
 * `.beads/dolt-server.port` vanishes. The old code did a single
 * `readFileSync` in the DoltClient constructor, threw ENOENT, and the
 * orchestration plane was permanently disabled (503 until a human
 * restarted Dolt before vibesync).
 *
 * `resolveDoltPort` fixes this by waiting for the port file, and — when it
 * never appears — starting the Dolt server itself via `bd dolt start`
 * before giving up. These tests drive that logic with injected deps (no
 * real fs / `bd` / clock) so they run instantly and deterministically.
 */

import { describe, expect, it, vi } from 'vitest';

import { resolveDoltPort, type DoltBootDeps } from '../../../../src/orchestration/store/dolt-client.js';

function makeDeps(overrides: Partial<DoltBootDeps> = {}): DoltBootDeps {
  return {
    readPortFile: () => null,
    startDoltServer: async () => undefined,
    sleep: async () => undefined,
    ...overrides,
  };
}

describe('resolveDoltPort (vibesync-nl0l)', () => {
  it('returns immediately when the port file is already present (happy path, no start)', async () => {
    const startDoltServer = vi.fn(async () => undefined);
    const deps = makeDeps({ readPortFile: () => '32000\n', startDoltServer });

    const port = await resolveDoltPort({ beadsRoot: '/repo' }, deps);

    expect(port).toBe(32000);
    expect(startDoltServer).not.toHaveBeenCalled();
  });

  it('honors an explicit port override without touching the filesystem', async () => {
    const readPortFile = vi.fn(() => null);
    const deps = makeDeps({ readPortFile });
    const port = await resolveDoltPort({ port: 40404 }, deps);
    expect(port).toBe(40404);
    expect(readPortFile).not.toHaveBeenCalled();
  });

  it('waits and succeeds once the port file appears after polling', async () => {
    let reads = 0;
    // Missing for the first few reads, then present. `startServerIfMissing`
    // is disabled so this exercises the pure wait-and-poll recovery path.
    const deps = makeDeps({
      readPortFile: () => {
        reads += 1;
        return reads >= 3 ? '32001' : null;
      },
    });

    const port = await resolveDoltPort(
      { beadsRoot: '/repo' },
      deps,
      { timeoutMs: 10_000, pollIntervalMs: 100, startServerIfMissing: false },
    );

    expect(port).toBe(32001);
  });

  it('starts the Dolt server itself when the port file never appears on its own', async () => {
    let started = false;
    const startDoltServer = vi.fn(async () => {
      started = true;
    });
    const deps = makeDeps({
      // Only returns a port AFTER startDoltServer has run — proves the
      // resolver actively recovered rather than passively waiting.
      readPortFile: () => (started ? '32002' : null),
      startDoltServer,
    });

    const port = await resolveDoltPort(
      { beadsRoot: '/repo' },
      deps,
      { timeoutMs: 10_000, pollIntervalMs: 100 },
    );

    expect(port).toBe(32002);
    expect(startDoltServer).toHaveBeenCalledTimes(1);
    expect(startDoltServer).toHaveBeenCalledWith('/repo');
  });

  it('does not start the server when startServerIfMissing is false', async () => {
    const startDoltServer = vi.fn(async () => undefined);
    let reads = 0;
    const deps = makeDeps({
      readPortFile: () => {
        reads += 1;
        return reads >= 2 ? '32003' : null;
      },
      startDoltServer,
    });

    const port = await resolveDoltPort(
      { beadsRoot: '/repo' },
      deps,
      { timeoutMs: 10_000, pollIntervalMs: 100, startServerIfMissing: false },
    );

    expect(port).toBe(32003);
    expect(startDoltServer).not.toHaveBeenCalled();
  });

  // RED -> GREEN anchor: on main there is no resolver at all — the
  // DoltClient constructor threw ENOENT synchronously and the plane was
  // permanently disabled. Here we assert the resolver's contract: it waits,
  // attempts a start, and only throws an explicit error after the full
  // budget — instead of failing instantly on first miss.
  it('throws an explicit error after exhausting the budget (and having tried a start)', async () => {
    const startDoltServer = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const deps = makeDeps({
      readPortFile: () => null, // never appears
      startDoltServer,
      sleep,
    });

    await expect(
      resolveDoltPort({ beadsRoot: '/repo' }, deps, { timeoutMs: 1_000, pollIntervalMs: 100 }),
    ).rejects.toThrow(/did not become available within 1000ms.*vibesync-nl0l/s);

    // It must have actually tried to start the server before giving up.
    expect(startDoltServer).toHaveBeenCalledTimes(1);
    // And it must have polled (not failed instantly like the old readFileSync).
    expect(sleep).toHaveBeenCalled();
  });

  it('keeps polling even if `bd dolt start` throws', async () => {
    let started = false;
    const startDoltServer = vi.fn(async () => {
      // First attempt fails, but the server comes up anyway shortly after.
      started = true;
      throw new Error('bd dolt start: boom');
    });
    const deps = makeDeps({
      readPortFile: () => (started ? '32004' : null),
      startDoltServer,
    });

    const port = await resolveDoltPort(
      { beadsRoot: '/repo' },
      deps,
      { timeoutMs: 10_000, pollIntervalMs: 100 },
    );

    expect(port).toBe(32004);
    expect(startDoltServer).toHaveBeenCalled();
  });

  it('surfaces an invalid port value as a clear error', async () => {
    const deps = makeDeps({ readPortFile: () => 'not-a-port' });
    await expect(resolveDoltPort({ beadsRoot: '/repo' }, deps)).rejects.toThrow(/invalid port/);
  });
});
