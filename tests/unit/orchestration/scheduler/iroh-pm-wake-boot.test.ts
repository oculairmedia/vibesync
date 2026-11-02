/**
 * vibesync-2bgv — the Iroh PM wake sink through the REAL boot path.
 *
 * bootOrchestrationPlane -> startSchedulerDaemon -> PmWaker -> IrohPmWakeSink ->
 * the plane's ONE shared IrohConnection -> FakeIrohWrapper. Nothing calls the sink
 * directly: a wake exists only because a (fake-clock) daemon tick decided it.
 *
 * False passes guarded against:
 *   - a sink that dials its own connection (asserted: one dial in total, shared with a formula step);
 *   - ok:true while the PM never got the message (asserted on the FAKE's persisted PM conversation);
 *   - the config flag silently ignored (asserted: 'log' reaches no wrapper at all).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/orchestration/boot.js';
import type { Event } from '../../../../src/orchestration/events/index.js';
import { IrohConnection } from '../../../../src/orchestration/runtime/iroh/connection.js';
import type { BootSchedulerOptions } from '../../../../src/orchestration/scheduler/boot-scheduler.js';
import { formatWakeMessage, PM_WOKEN_EVENT } from '../../../../src/orchestration/scheduler/index.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = new Date('2026-01-01T00:00:00Z');
const PROJECT = 'proj-x';
const PM = 'agent-pm-1';
const ROLE = 'agent-role-1';

const bd = async (args: readonly string[]): Promise<string> => {
  if (args[0] === 'ready') return '[]';
  if (args[0] === 'list') return '[]';
  if (args[0] === 'comments') return args[1] === 'add' ? '{}' : '[]';
  throw new Error(`unexpected bd call: ${args.join(' ')}`);
};

function schedulerConfig(pmWake: Partial<NonNullable<BootSchedulerOptions['config']['pmWake']>>): BootSchedulerOptions['config'] {
  return {
    enabled: true,
    projectIdentifier: PROJECT,
    intervalMs: 30 * MIN,
    poolSize: 2,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [],
    allowedRepos: [],
    pmWake: { enabled: true, minIntervalMs: 30 * MIN, backstopMs: 8 * HOUR, statePath: '', sink: 'iroh', conversationId: '', ...pmWake },
  };
}

describe('Iroh PM wake sink through boot (vibesync-2bgv)', () => {
  const originalEnv = { ...process.env };
  let dir: string;
  const handles: OrchestrationHandle[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iroh-wake-'));
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.shutdown();
    vi.useRealTimers();
    process.env = { ...originalEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(fake: FakeIrohWrapper, over: { provider?: string; pmWake?: Partial<NonNullable<BootSchedulerOptions['config']['pmWake']>>; connections?: IrohConnection[] } = {}) {
    process.env['VIBESYNC_WORK_ACTIVITY_REPORT'] = '0';
    process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = over.provider ?? 'letta-code-iroh';
    process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = PM;
    process.env['VIBESYNC_LETTA_CODE_SHIM_URL'] = 'http://shim:8291';
    const handle = await bootOrchestrationPlane({
      dolt: new InMemoryDoltClient() as never,
      persistEvents: false,
      runDriftAuditOnBoot: false,
      irohConnectionFactory: () => {
        const c = new IrohConnection({ dial: fake.dial, peerName: 'boot-wake-test', backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } });
        over.connections?.push(c);
        return c;
      },
      scheduler: {
        config: schedulerConfig({ statePath: path.join(dir, 'pm-wake-state.json'), ...over.pmWake }),
        listPoolMembers: () => [
          { agentId: 'agent-a', role: 'role-one', lettaBaseUrl: 'http://shim' },
          { agentId: 'agent-b', role: 'role-two', lettaBaseUrl: 'http://shim' },
        ],
        bd,
        appRoot: process.cwd(),
        // The registry lookup, exactly the shape src/index.ts wires: the PM id is DATA.
        pmWake: { lookupAgentId: () => PM },
      },
    });
    handles.push(handle);
    const woken: Event[] = [];
    handle.bus.subscribe((e) => {
      if (e.kind === PM_WOKEN_EVENT) woken.push(e);
    });
    return { handle, woken };
  }

  it("7. sink 'iroh' + scheduler on: the 8 h backstop wake (fake clock) arrives at the PM's live conversation as exactly one turn", async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.seedConversation(PM, { id: 'conv-heartbeat', lastMessageAt: '2026-01-01T00:00:00.000Z', extra: { conversation_class: 'autonomous' } });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const { woken } = await boot(fake);

    await vi.advanceTimersByTimeAsync(8 * HOUR - MIN);
    expect(fake.turnsExecuted).toBe(0); // nothing earlier than the backstop
    await vi.advanceTimersByTimeAsync(40 * MIN);

    expect(woken).toHaveLength(1);
    const p = woken[0]!.payload as Record<string, unknown>;
    expect(p).toMatchObject({ reason: 'backstop', agentId: PM, ok: true, project: PROJECT });
    expect(fake.turnsExecuted).toBe(1);
    const texts = fake.userTexts('conv-live');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe(
      formatWakeMessage({ reason: 'backstop', detail: String(p['detail']), wakeId: String(p['wakeId']) }),
    );
    expect(texts[0]).toMatch(/^\[vibesync wake\] reason=backstop detail=no wake for \d+ min wakeId=proj-x-backstop-\d+$/);
    expect(fake.userTexts('conv-heartbeat')).toEqual([]);
    expect(fake.inputsFor(String(p['wakeId']))).toHaveLength(1);
    expect(fake.violations).toEqual([]);
  });

  it('5. the wake shares the provider connection: a formula-step session and a wake cost ONE dial in total', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM, ROLE] });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const connections: IrohConnection[] = [];
    const { handle, woken } = await boot(fake, { connections });
    expect(fake.dials).toBe(0); // lazy: nothing dialed at boot

    const session = await handle.provider.start({ role: 'r', extra: { agentId: ROLE, moleculeId: 'm', stepName: 's' } });
    await handle.provider.prompt(session, [{ type: 'text', text: 'do the step' }]);
    const events: unknown[] = [];
    for await (const e of handle.provider.observe(session)) events.push(e);
    await handle.provider.stop(session);
    expect(fake.dials).toBe(1);

    await vi.advanceTimersByTimeAsync(8 * HOUR + 40 * MIN);
    expect(woken.map((w) => (w.payload as Record<string, unknown>)['ok'])).toEqual([true]);
    expect(fake.userTexts('conv-live')).toHaveLength(1);
    expect(fake.dials).toBe(1); // the wake reused the step's connection
    expect(connections).toHaveLength(1); // and boot built exactly one IrohConnection
  });

  it("5b. a wake that comes FIRST dials once and a later formula step reuses that connection (no second dial)", async () => {
    const fake = new FakeIrohWrapper({ scope: [PM, ROLE] });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const connections: IrohConnection[] = [];
    const { handle } = await boot(fake, { connections });
    await vi.advanceTimersByTimeAsync(8 * HOUR + 40 * MIN);
    expect(fake.dials).toBe(1);

    const session = await handle.provider.start({ role: 'r', extra: { agentId: ROLE, moleculeId: 'm', stepName: 's' } });
    await handle.provider.prompt(session, [{ type: 'text', text: 'do the step' }]);
    for await (const _ of handle.provider.observe(session)) { /* drain */ }
    await handle.provider.stop(session);
    expect(fake.dials).toBe(1);
    expect(connections).toHaveLength(1);
  });

  it("a failed wake (PM outside the grant) is ok:false on the bus, lastWokenAt unchanged, and the retry reuses the wakeId", async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-someone-else'] });
    const { woken } = await boot(fake);
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(woken.length).toBeGreaterThanOrEqual(1);
    for (const w of woken) expect((w.payload as Record<string, unknown>)['ok']).toBe(false);
    expect(String((woken[0]!.payload as Record<string, unknown>)['error'])).toMatch(/forbidden/i);
    expect(new Set(woken.map((w) => (w.payload as Record<string, unknown>)['wakeId'])).size).toBe(1); // same wakeId on every retry
    expect(fake.turnsExecuted).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'pm-wake-state.json'), 'utf8')) as Record<string, { lastWokenAt: string | null }>;
    expect(state[PROJECT]!.lastWokenAt).toBeNull();
  });

  it("sink 'log' (the default) never touches the wrapper, even with the Iroh provider selected", async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const { woken } = await boot(fake, { pmWake: { sink: 'log' } });
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(woken.map((w) => (w.payload as Record<string, unknown>)['ok'])).toEqual([true]);
    expect(fake.dials).toBe(0);
    expect(fake.received).toEqual([]);
  });

  it("sink 'iroh' without the Iroh provider kind refuses to boot (no silent fall back to logging)", async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    await expect(boot(fake, { provider: 'letta-code-subagent' })).rejects.toThrow(/sink='iroh' requires VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh/);
  });

  it("sink 'iroh' with the waker disabled is inert: no throw, nothing dialed", async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    await boot(fake, { provider: 'letta-code-subagent', pmWake: { enabled: false } });
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(fake.dials).toBe(0);
  });
});
