import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/orchestration/events/index.js';
import { HealthPatrol, type DaemonSupervisor } from '../../../../src/orchestration/health/index.js';
import type {
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from '../../../../src/orchestration/runtime/index.js';

/** Manual clock so tests don't sleep. */
function manualClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeProvider(): { provider: RuntimeProvider; startCount: () => number; stopCount: () => number; nextStartFails?: { value: boolean } } {
  let starts = 0;
  let stops = 0;
  const nextStartFails = { value: false };
  const provider: RuntimeProvider = {
    kind: 'fake',
    async start(spec: SessionSpec): Promise<SessionHandle> {
      starts++;
      if (nextStartFails.value) {
        nextStartFails.value = false;
        throw new Error('start failed');
      }
      return { id: `fake-${spec.role}-${starts}`, providerKind: 'fake' };
    },
    async stop(_handle: SessionHandle): Promise<void> {
      stops++;
    },
    async prompt() {
      return {};
    },
    async nudge(): Promise<void> {},
    observe(): AsyncIterable<SessionEvent> {
      // eslint-disable-next-line require-yield
      return (async function* () {
        return;
      })();
    },
  };
  return { provider, startCount: () => starts, stopCount: () => stops, nextStartFails };
}

describe('HealthPatrol', () => {
  it('does not restart sessions inside their stall threshold', async () => {
    const clock = manualClock();
    const bus = new EventBus({ noPersist: true });
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.kind));
    const fp = fakeProvider();
    const patrol = new HealthPatrol(bus, { defaultStallTimeoutMs: 10_000 }, clock);
    const handle = await fp.provider.start({ role: 'reviewer' });
    patrol.track({ handle, spec: { role: 'reviewer' }, provider: fp.provider });

    clock.advance(5_000);
    await patrol.probe();
    expect(events).toEqual([]);
    expect(fp.stopCount()).toBe(0);
  });

  it('restarts a stalled session with exponential backoff', async () => {
    const clock = manualClock();
    const bus = new EventBus({ noPersist: true });
    const restarts: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === 'session.restarted') restarts.push(String(e.task_id));
    });
    const fp = fakeProvider();
    const patrol = new HealthPatrol(
      bus,
      { defaultStallTimeoutMs: 10_000, initialBackoffMs: 1_000 },
      clock,
    );
    const handle = await fp.provider.start({ role: 'reviewer' });
    patrol.track({ handle, spec: { role: 'reviewer' }, provider: fp.provider });

    // First stall → restart
    clock.advance(11_000);
    await patrol.probe();
    expect(fp.stopCount()).toBe(1);
    expect(restarts).toHaveLength(1);

    // Inside the backoff window — no second restart even though still stalled
    clock.advance(500);
    await patrol.probe();
    expect(restarts).toHaveLength(1);

    // Past the backoff window AND stall threshold → second restart
    clock.advance(11_000);
    await patrol.probe();
    expect(restarts).toHaveLength(2);
  });

  it('trips the circuit breaker after N consecutive restarts', async () => {
    const clock = manualClock();
    const bus = new EventBus({ noPersist: true });
    const unhealthy: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === 'session.unhealthy') unhealthy.push(String(e.task_id));
    });
    const fp = fakeProvider();
    const patrol = new HealthPatrol(
      bus,
      { defaultStallTimeoutMs: 1_000, initialBackoffMs: 100, circuitBreakerThreshold: 3 },
      clock,
    );
    const handle = await fp.provider.start({ role: 'r' });
    patrol.track({ handle, spec: { role: 'r' }, provider: fp.provider });

    // Drive 3 stall → restart cycles, each advancing past backoff + stall.
    for (let i = 0; i < 3; i++) {
      clock.advance(2_000); // past stall
      await patrol.probe();
    }
    // 4th cycle should NOT restart; should emit unhealthy instead.
    clock.advance(2_000);
    await patrol.probe();
    expect(unhealthy).toHaveLength(1);
    // No further restart attempts.
    const stopsBefore = fp.stopCount();
    clock.advance(60_000);
    await patrol.probe();
    expect(fp.stopCount()).toBe(stopsBefore);
  });

  it('markActive resets the stall countdown and restart count', async () => {
    const clock = manualClock();
    const bus = new EventBus({ noPersist: true });
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.kind));
    const fp = fakeProvider();
    const patrol = new HealthPatrol(bus, { defaultStallTimeoutMs: 10_000 }, clock);
    const handle = await fp.provider.start({ role: 'r' });
    patrol.track({ handle, spec: { role: 'r' }, provider: fp.provider });

    // Almost stalled
    clock.advance(9_000);
    patrol.markActive(handle.id);
    clock.advance(9_000);
    await patrol.probe();
    expect(events).toEqual([]); // no stall event
  });

  it('emits restart_failed on provider start error and stays in the backoff loop', async () => {
    const clock = manualClock();
    const bus = new EventBus({ noPersist: true });
    const failures: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === 'session.restart_failed') failures.push(String(e.task_id));
    });
    const fp = fakeProvider();
    const patrol = new HealthPatrol(
      bus,
      { defaultStallTimeoutMs: 1_000, initialBackoffMs: 100 },
      clock,
    );
    const handle = await fp.provider.start({ role: 'r' });
    patrol.track({ handle, spec: { role: 'r' }, provider: fp.provider });

    fp.nextStartFails!.value = true;
    clock.advance(2_000);
    await patrol.probe();
    expect(failures).toHaveLength(1);
  });

  it('start() and stop() are idempotent', () => {
    const patrol = new HealthPatrol(new EventBus({ noPersist: true }));
    patrol.start();
    patrol.start();
    patrol.stop();
    patrol.stop();
    expect(true).toBe(true);
  });

  describe('daemon supervision', () => {
    function fakeDaemon(opts: {
      running: boolean | (() => boolean);
      throwOnIsRunning?: boolean;
      throwOnEnsureRunning?: boolean;
    }): {
      supervisor: DaemonSupervisor;
      starts: () => number;
      stops: () => number;
      setRunning: (v: boolean) => void;
    } {
      let starts = 0;
      let stops = 0;
      let running = typeof opts.running === 'function' ? opts.running() : opts.running;
      const supervisor: DaemonSupervisor = {
        id: 'local-runtime-daemon',
        providerKind: 'letta-code-subagent',
        async isRunning() {
          if (opts.throwOnIsRunning) throw new Error('probe failed');
          return running;
        },
        async ensureRunning() {
          starts += 1;
          if (opts.throwOnEnsureRunning) throw new Error('start failed');
          running = true;
        },
        async stop() {
          stops += 1;
          running = false;
        },
      };
      return {
        supervisor,
        starts: () => starts,
        stops: () => stops,
        setRunning: (v: boolean) => {
          running = v;
        },
      };
    }

    it('no-op probe when the daemon is running', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: true });
      const patrol = new HealthPatrol(bus, {}, clock);
      patrol.trackDaemon(d.supervisor);

      await patrol.probe();
      expect(events).toEqual([]);
      expect(d.starts()).toBe(0);
    });

    it('emits daemon.down + daemon.restarting + daemon.restarted when the daemon is missing', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: false });
      const patrol = new HealthPatrol(bus, { initialBackoffMs: 1_000 }, clock);
      patrol.trackDaemon(d.supervisor);

      await patrol.probe();
      expect(events.map((e) => e.kind)).toEqual([
        'daemon.down',
        'daemon.restarting',
        'daemon.restarted',
      ]);
      expect(d.stops()).toBe(1);
      expect(d.starts()).toBe(1);
    });

    it('emits daemon.restart_failed and stays in backoff when ensureRunning throws', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: false, throwOnEnsureRunning: true });
      const patrol = new HealthPatrol(bus, { initialBackoffMs: 1_000 }, clock);
      patrol.trackDaemon(d.supervisor);

      await patrol.probe();
      expect(events.map((e) => e.kind)).toContain('daemon.restart_failed');
      const failed = events.find((e) => e.kind === 'daemon.restart_failed');
      expect(failed?.payload?.['error']).toBe('start failed');
    });

    it('trips the circuit breaker after N consecutive restarts', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      // Daemon never becomes running; every probe is a restart cycle.
      const d = fakeDaemon({ running: false, throwOnEnsureRunning: true });
      const patrol = new HealthPatrol(
        bus,
        { initialBackoffMs: 100, circuitBreakerThreshold: 3 },
        clock,
      );
      patrol.trackDaemon(d.supervisor);

      for (let i = 0; i < 3; i += 1) {
        await patrol.probe();
        clock.advance(1_000);
      }
      // 4th probe should NOT attempt another restart — circuit broken.
      await patrol.probe();

      const restartingCount = events.filter((e) => e.kind === 'daemon.restarting').length;
      const unhealthy = events.find((e) => e.kind === 'daemon.unhealthy');
      expect(restartingCount).toBe(3);
      expect(unhealthy).toBeTruthy();
      expect(patrol.daemonSnapshot()[0]?.unhealthy).toBe(true);
    });

    it('resets the restart counter once the daemon reports running again', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: false });
      const patrol = new HealthPatrol(bus, { initialBackoffMs: 100 }, clock);
      patrol.trackDaemon(d.supervisor);

      // First probe: daemon is down → restart succeeds via fakeDaemon
      // setting running=true inside ensureRunning(). Restart count goes
      // to 1 before the restart, then the SECOND probe should see
      // running=true and reset it back to 0.
      await patrol.probe();
      expect(patrol.daemonSnapshot()[0]?.restartCount).toBe(1);

      clock.advance(1_000);
      await patrol.probe();
      expect(patrol.daemonSnapshot()[0]?.restartCount).toBe(0);
    });

    it('treats isRunning() throwing the same as "not running"', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: true, throwOnIsRunning: true });
      const patrol = new HealthPatrol(bus, { initialBackoffMs: 100 }, clock);
      patrol.trackDaemon(d.supervisor);

      await patrol.probe();
      expect(events.some((e) => e.kind === 'daemon.down')).toBe(true);
    });

    it('untrackDaemon stops supervising', async () => {
      const clock = manualClock();
      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((e) => events.push(e));
      const d = fakeDaemon({ running: false });
      const patrol = new HealthPatrol(bus, {}, clock);
      patrol.trackDaemon(d.supervisor);
      patrol.untrackDaemon(d.supervisor.id);

      await patrol.probe();
      expect(events).toEqual([]);
    });
  });
});
