import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type Event } from '../../../src/engine/events/index.js';
import { BEADS_ISSUE_STATUS_CHANGED_EVENT } from '../../../src/engine/events/beads.js';
import { StatusChangePoller } from '../../../src/engine/store/status-change-poller.js';
import { startSchedulerDaemon, type SchedulerHandle } from '../../../src/engine/scheduler/boot-scheduler.js';
import type { Pack } from '../../../src/engine/packs/pack.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './isolated-beads.js';

describe.skipIf(!RUN_ISOLATED_BEADS)('status change poller on real bd (isolated repo)', () => {
  let h: Awaited<ReturnType<typeof provisionIsolatedBeads>>;
  beforeAll(async () => { h = await provisionIsolatedBeads('fresh'); }, 120_000);
  afterAll(async () => { await h?.close(); }, 120_000);

  it('emits an event after bd closes a work issue', async () => {
    const id = String(JSON.parse(h.bd('create', 'poller integration', '--type', 'task', '--json'))['id']);
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    let bootRead: (() => void) | undefined;
    let bootReadStarted: (() => void) | undefined;
    const bootReadDone = new Promise<void>(resolve => { bootRead = resolve; });
    const bootReadStart = new Promise<void>(resolve => { bootReadStarted = resolve; });
    const originalReader = h.client.listIssueStatusSince.bind(h.client);
    const store = {
      listIssueStatusSince: async (...args: Parameters<typeof h.client.listIssueStatusSince>) => {
        bootReadStarted?.();
        bootReadStarted = undefined;
        const rows = await originalReader(...args);
        bootRead?.();
        bootRead = undefined;
        return rows;
      },
    };
    const runningPoller = new StatusChangePoller({ store, bus, intervalMs: 100 });
    const schedulerTicks: Event[] = [];
    const unsubscribeTicks = bus.subscribe((event) => {
      if (event.kind === 'daemon/scheduler.tick' && event.payload?.['reason'] === 'bead-status') {
        schedulerTicks.push(event);
      }
    });
    const scheduler: SchedulerHandle = startSchedulerDaemon({
      config: {
        enabled: true, projectIdentifier: 'integration', intervalMs: 60_000, poolSize: 1, batchSize: 1, paused: true,
        readyLabel: 'scheduler:eligible', formula: 'onboard-feature', packDir: '.', autoMerge: false,
        requiredChecks: [], allowedRepos: [], eventDebounceMs: 0,
      },
      listPoolMembers: () => [{ agentId: 'integration-agent', role: 'worker' }],
      bd: async () => '[]',
      dispatcher: { run: async () => undefined, cancel: async () => undefined } as never,
      loadPack: () => ({ formulas: [{ name: 'onboard-feature' }], manifest: { name: 'integration' } } as unknown as Pack),
      bus,
    });
    try {
      runningPoller.start();
      await bootReadStart;
      await bootReadDone;
      h.bd('close', id);
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('status change was not emitted within two poll intervals')), 200);
        const unsubscribe = bus.subscribe((event) => {
          if (event.kind !== BEADS_ISSUE_STATUS_CHANGED_EVENT || event.task_id !== id) return;
          clearTimeout(deadline);
          unsubscribe();
          resolve();
        });
      });
      expect(events.filter((event) => event.kind === BEADS_ISSUE_STATUS_CHANGED_EVENT && event.task_id === id)).toHaveLength(1);
      expect(events.find((event) => event.task_id === id)?.payload).toEqual({ issueId: id, from: 'open', to: 'closed' });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('bead-status scheduler tick was not observed')), 200);
        if (schedulerTicks.length > 0) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        const unsubscribe = bus.subscribe((event) => {
          if (event.kind === 'daemon/scheduler.tick' && event.payload?.['reason'] === 'bead-status') {
            schedulerTicks.push(event);
            clearTimeout(deadline);
            unsubscribe();
            resolve();
          }
        });
      });
      expect(schedulerTicks.length).toBeGreaterThan(0);
    } finally {
      await runningPoller.stop();
      await scheduler.stop();
      unsubscribeTicks();
      await bootReadStart.catch(() => undefined);
    }
  }, 30_000);
});
