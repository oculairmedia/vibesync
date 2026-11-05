/**
 * vibesync-9g24 — config activation (invariant 4) through the REAL boot path.
 * waits.enabled=false must construct nothing: no watcher, no bus subscriber,
 * no timer, no bd call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { BootWaitsOptions } from '../../../../src/engine/waits/index.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';

/** These tests never dispatch a turn; a dial would mean a real Iroh host. */
function neverDialIroh(): IrohConnection {
  return new IrohConnection({
    dial: async () => { throw new Error('test must not dial Iroh'); },
    peerName: 'waits-test', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 1 },
  });
}

function fakeBd() {
  const calls: string[][] = [];
  return { calls, run: async (args: readonly string[]) => { calls.push([...args]); return '[]'; } };
}

async function boot(waits: BootWaitsOptions | undefined): Promise<OrchestrationHandle> {
  process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-iroh';
  process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = 'agent-parent';
  return bootOrchestrationPlane({
    ...inMemoryBeads(),
    irohConnectionFactory: neverDialIroh,
    persistEvents: false,
    runDriftAuditOnBoot: false,
    ...(waits ? { waits } : {}),
  });
}

describe('bootOrchestrationPlane — wait watcher wiring (vibesync-9g24)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); process.env = { ...originalEnv }; });

  it('waits.enabled=false: nothing is constructed (no watcher, no subscriber, no timer, no bd call)', async () => {
    const bd = fakeBd();
    const baseline = await boot(undefined);
    const baselineSubscribers = baseline.bus.subscriberCount();
    const baselineTimers = vi.getTimerCount(); // the plane's own timers (health patrol)
    await baseline.shutdown();

    const handle = await boot({ config: { enabled: false, reconcileIntervalMs: 1000, maxWakeAttempts: 5 }, bd: bd.run });
    expect(handle.waits).toBeNull();
    expect(handle.bus.subscriberCount()).toBe(baselineSubscribers);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bd.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    await handle.shutdown();
  });

  it('absent waits option behaves like disabled', async () => {
    const handle = await boot(undefined);
    expect(handle.waits).toBeNull();
    await handle.shutdown();
  });

  it('waits.enabled=true: the boot path starts the watcher (boot reconcile + bus hint), shutdown stops it', async () => {
    const bd = fakeBd();
    const baseline = await boot(undefined);
    const baselineSubscribers = baseline.bus.subscriberCount();
    await baseline.shutdown();

    const handle = await boot({ config: { enabled: true, reconcileIntervalMs: 1000, maxWakeAttempts: 5 }, bd: bd.run });
    expect(handle.waits).not.toBeNull();
    expect(handle.bus.subscriberCount()).toBe(baselineSubscribers + 1);
    await vi.advanceTimersByTimeAsync(0);
    // Boot reconcile listed the waits through the injected runner (argv array).
    expect(bd.calls.some((c) => c[0] === 'list' && c.includes('vibesync:wait'))).toBe(true);
    const before = bd.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(bd.calls.length).toBeGreaterThan(before); // slow interval reconcile

    await handle.shutdown();
    expect(handle.bus.subscriberCount()).toBe(0);
    const afterStop = bd.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(bd.calls.length).toBe(afterStop);
  });
});
