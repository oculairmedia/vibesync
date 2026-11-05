/**
 * Inbox PM wake composition through the real boot path.
 *
 * bootOrchestrationPlane -> startSchedulerDaemon -> PmWaker -> inbox adapter.
 * A wake exists only because a (fake-clock) daemon tick decided it. Formula
 * runtime input remains separate from mailbox routing.
 *
 * False passes guarded against:
 *   - a wake bypassing inbox routing by writing into a PM conversation;
 *   - treating accepted-only as confirmed application delivery;
 *   - the config flag silently ignored (asserted: 'log' reaches no wrapper at all).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../../src/engine/boot.js';
import type { Event } from '../../../../src/engine/events/index.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';
import { normalizeInboxWakeAck, type BootSchedulerOptions, type InboxMessageAdapter } from '../../../../src/engine/scheduler/boot-scheduler.js';
import { formatWakeMessage, PM_WOKEN_EVENT } from '../../../../src/engine/scheduler/index.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';
import { InMemoryDoltClient, inMemoryBeads } from '../../../_fixtures/in-memory-dolt-client.js';

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

function pendingWakeBd() {
  const records = new Map<string, Record<string, unknown>>();
  const run = async (args: readonly string[]): Promise<string> => {
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    if (args[0] === 'create') {
      const id = `pending-${records.size + 1}`;
      records.set(id, { id, status: 'open', assignee: '', metadata: JSON.parse(value('--metadata')!) });
      return id;
    }
    if (args[0] === 'list' && (value('--id') || value('--label') === 'vibesync:pending-wake')) {
      return JSON.stringify([...records.values()].filter(row => value('--id') ? row.id === value('--id') : row.status !== 'closed'));
    }
    if (args[0] !== 'update' && args[0] !== 'heartbeat') return bd(args);
    const row = records.get(args[1]!);
    if (!row) throw new Error('unknown pending wake');
    if (value('--if-assignee') !== undefined && row.assignee !== value('--if-assignee')) throw new Error('stale assignee');
    if (value('--if-status') !== undefined && row.status !== value('--if-status')) throw new Error('stale status');
    if (args.includes('--claim')) {
      if (row.assignee && row.assignee !== value('--actor')) throw new Error('already claimed');
      row.assignee = value('--actor');
      row.status = 'in_progress';
      row.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
    }
    if (args[0] === 'heartbeat') {
      if (row.status !== 'in_progress' || row.assignee !== value('--actor')) throw new Error('not lease holder');
      row.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
    }
    if (value('--metadata')) row.metadata = { ...(row.metadata as object), ...JSON.parse(value('--metadata')!) };
    if (value('--status')) row.status = value('--status');
    return '{}';
  };
  return { records, run };
}

function schedulerConfig(pmWake: Partial<NonNullable<BootSchedulerOptions['config']['pmWake']>>): BootSchedulerOptions['config'] {
  return {
    enabled: true,
    projectIdentifier: PROJECT,
    intervalMs: MIN,
    poolSize: 2,
    batchSize: 1,
    paused: false,
    readyLabel: 'scheduler:eligible',
    formula: 'onboard-feature',
    packDir: 'packs/gastown',
    autoMerge: false,
    requiredChecks: [],
    allowedRepos: [],
    pmWake: { enabled: true, minIntervalMs: 30 * MIN, backstopMs: 8 * HOUR, statePath: '', sink: 'log', ...pmWake },
  };
}

describe('Iroh PM wake sink through boot (vibesync-2bgv)', () => {
  it('normalizes mobile ACKs without treating accepted-only as application delivery', () => {
    expect(normalizeInboxWakeAck({ msgId: 'wake-1', accepted: true }, 'wake-1')).toEqual({
      msgId: 'wake-1', accepted: true, applicationDelivered: false,
    });
    expect(normalizeInboxWakeAck({ msgId: 'wake-1', accepted: false, applicationDelivered: false, reason: 'home_lane_forbidden' }, 'wake-1'))
      .toMatchObject({ accepted: false, applicationDelivered: false, reason: 'home_lane_forbidden' });
    expect(normalizeInboxWakeAck({ msgId: 'wake-2', accepted: true, applicationDelivered: true }, 'wake-1')).toBeNull();
    expect(normalizeInboxWakeAck({ msgId: 'wake-1', accepted: 'yes' }, 'wake-1')).toBeNull();
    expect(normalizeInboxWakeAck(null, 'wake-1')).toBeNull();
  });

  it('requires inbox adapter at composition rather than silently using direct-input mode', async () => {
    const sharedProvider = { kind: 'letta-code-iroh', capabilities: [], start: vi.fn(), prompt: vi.fn(), observe: vi.fn(), stop: vi.fn() } as never;
    await expect(bootOrchestrationPlane({
      provider: sharedProvider,
      ...inMemoryBeads(),
      persistEvents: false,
      runDriftAuditOnBoot: false,
      scheduler: {
        config: schedulerConfig({ statePath: path.join(dir, 'pm-wake-state.json'), sink: 'inbox' }),
        listPoolMembers: () => [],
        bd,
        pmWake: { lookupAgentId: () => PM },
      },
    })).rejects.toThrow(/MobileAgentMessageSender service adapter/);
  });

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

  async function boot(fake: FakeIrohWrapper, over: { intervalMs?: number; bd?: typeof bd; pmWake?: Partial<NonNullable<BootSchedulerOptions['config']['pmWake']>>; connections?: IrohConnection[]; inboxAdapter?: InboxMessageAdapter; wakeSink?: import('../../../../src/engine/pm-wake/waker.js').PmWakeSink; listPoolMembers?: () => readonly { agentId: string; role: string }[] } = {}) {
    process.env['VIBESYNC_ORCHESTRATION_PROVIDER'] = 'letta-code-iroh';
    process.env['VIBESYNC_LETTA_CODE_PARENT_AGENT_ID'] = PM;
    const handle = await bootOrchestrationPlane({
      ...inMemoryBeads(),
      persistEvents: false,
      runDriftAuditOnBoot: false,
      irohConnectionFactory: () => {
        const c = new IrohConnection({ dial: fake.dial, peerName: 'boot-wake-test', backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } });
        over.connections?.push(c);
        return c;
      },
      scheduler: {
        config: { ...schedulerConfig({ statePath: path.join(dir, 'pm-wake-state.json'), ...over.pmWake }), ...(over.intervalMs ? { intervalMs: over.intervalMs } : {}) },
        listPoolMembers: () => over.listPoolMembers?.() ?? [
          { agentId: 'agent-a', role: 'role-one' },
          { agentId: 'agent-b', role: 'role-two' },
        ],
        bd: over.bd ?? bd,
        appRoot: process.cwd(),
        // The registry lookup, exactly the shape src/index.ts wires: the PM id is DATA.
        pmWake: { lookupAgentId: () => PM, ...(over.wakeSink ? { sink: over.wakeSink } : {}), ...(over.inboxAdapter ? { inboxAdapter: over.inboxAdapter } : {}) },
      },
    });
    handles.push(handle);
    const woken: Event[] = [];
    handle.bus.subscribe((e) => {
      if (e.kind === PM_WOKEN_EVENT) woken.push(e);
    });
    return { handle, woken };
  }

  it('the backstop goes through the inbox adapter without direct input into any conversation', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    fake.seedConversation(PM, { id: 'conv-heartbeat', lastMessageAt: '2026-01-01T00:00:00.000Z', extra: { conversation_class: 'autonomous' } });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const sent: unknown[] = [];
    const { handle, woken } = await boot(fake, {
      pmWake: { sink: 'inbox' }, bd: pendingWakeBd().run,
      inboxAdapter: { sendInboxMessage: async request => {
        sent.push(request);
        return { msgId: request.msgId, accepted: true, applicationDelivered: true };
      } },
    });

    await vi.advanceTimersByTimeAsync(8 * HOUR + 40 * MIN);

    const p = woken.find((event) => (event.payload as Record<string, unknown>)['reason'] === 'backstop')!.payload as Record<string, unknown>;
    expect(p).toMatchObject({ reason: 'backstop', agentId: PM, ok: true, accepted: true, applicationDelivered: true, project: PROJECT });
    expect(woken).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(fake.turnsExecuted).toBe(0);
    expect(fake.userTexts('conv-live')).toEqual([]);
    expect(fake.userTexts('conv-heartbeat')).toEqual([]);
    expect(fake.violations).toEqual([]);
    expect(p['wakeId']).toContain('backstop');
    expect(fake.received).toEqual([]);
    await handle.shutdown();
  });

  it('an injected wake sink takes precedence over inbox adapter configuration', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const { handle } = await boot(fake, {
      pmWake: { sink: 'inbox' },
      wakeSink: { wake: async () => ({ ok: true }) },
    });
    expect(handle.scheduler).not.toBeNull();
    expect(fake.dials).toBe(0);
    await handle.shutdown();
  });

  it('configured distribution sender refuses unverified activation before dialing', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    await expect(boot(fake, {
      pmWake: { sink: 'inbox', cli: {
        executable: '/not-a-release/bin/meridian-iroh-wrapper', senderAgentId: 'service-agent',
        identityDir: '/service-identities', addressStore: '/host-addresses', contractVerified: false,
      } },
    })).rejects.toThrow('Inbox sender contract has not been verified');
    expect(fake.dials).toBe(0);
  });

  it('disabled inbox sender does not inspect or execute its unverified configuration', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const { handle } = await boot(fake, {
      pmWake: { enabled: false, sink: 'inbox', cli: {
        executable: '/not-a-release/bin/meridian-iroh-wrapper', senderAgentId: 'service-agent',
        identityDir: '/service-identities', addressStore: '/host-addresses', contractVerified: false,
      } },
    });
    expect(handle.scheduler!.pmWaker).toBeNull();
    expect(fake.dials).toBe(0);
    await handle.shutdown();
  });

  it('an injected sink still takes precedence over unverified CLI configuration', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const { handle } = await boot(fake, {
      pmWake: { sink: 'inbox', cli: {
        executable: '/not-a-release/bin/meridian-iroh-wrapper', senderAgentId: 'service-agent',
        identityDir: '/service-identities', addressStore: '/host-addresses', contractVerified: false,
      } },
      wakeSink: { wake: async () => ({ ok: true }) },
    });
    expect(fake.dials).toBe(0);
    await handle.shutdown();
  });

  it('boots a configured distribution adapter and sends literal stdin to receiver-owned inbox routing', async () => {
    vi.useRealTimers();
    const executable = path.join(dir, 'test-sender');
    const capture = path.join(dir, 'sent.json');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,body}));
  process.stdout.write(JSON.stringify({msgId:args[args.indexOf('--msg-id')+1],accepted:true,applicationDelivered:true}));
});
`, { mode: 0o700 });
    const pending = pendingWakeBd();
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const { handle, woken } = await boot(fake, {
      intervalMs: 1000, bd: pending.run,
      pmWake: { sink: 'inbox', backstopMs: 1000, cli: {
        executable, senderAgentId: 'service-agent', identityDir: dir,
        addressStore: path.join(dir, 'hosts'), contractVerified: true,
      } },
    });
    await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 8000 });
    const sent = JSON.parse(fs.readFileSync(capture, 'utf8')) as { args: string[]; body: string };
    const wakeId = (woken[0]!.payload as Record<string, unknown>)['wakeId'];
    expect(sent.args).toEqual(['agent-message', 'send', '--from', 'service-agent', '--to', PM, '--msg-id', wakeId, '--body-file', '-', '--identity-dir', dir, '--address-store', path.join(dir, 'hosts')]);
    expect(sent.body).toContain(`wakeId=${wakeId}`);
    expect(pending.records.size).toBe(1);
    expect(fake.received).toEqual([]);
    await handle.shutdown();
  });

  it('inbox sends preserve wake identity and do not write directly into a PM conversation', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    const pending = pendingWakeBd();
    const sent: Array<{ to: string; body: string; msgId: string; correlation?: Readonly<Record<string, string>> }> = [];
    const { handle, woken } = await boot(fake, {
      bd: pending.run,
      pmWake: { sink: 'inbox', backstopMs: MIN, minIntervalMs: MIN },
      inboxAdapter: {
        sendInboxMessage: async (request) => {
          expect(pending.records.size).toBe(1);
          const row = [...pending.records.values()][0]!;
          expect(row.status).toBe('in_progress');
          expect(row.metadata).toMatchObject({ payload: { msgId: request.msgId, agentId: request.to, body: request.body } });
          sent.push(request);
          return { msgId: request.msgId, accepted: true, applicationDelivered: false, reason: 'queued' };
        },
      },
    });
    await vi.advanceTimersByTimeAsync(MIN);

    expect(sent).toHaveLength(1);
    expect(new Set(sent.map((request) => request.msgId)).size).toBe(1);
    expect(sent.every((request) => request.to === PM)).toBe(true);
    expect(sent.every((request) => request.body.includes(`wakeId=${request.msgId}`))).toBe(true);
    expect(sent.every((request) => request.correlation === undefined)).toBe(true);
    expect(fake.received.filter((frame) => frame['type'] === 'input' || frame['type'] === 'runtime_start')).toEqual([]);
    expect(woken.every((event) => {
      const value = event.payload as Record<string, unknown>;
      return value['accepted'] === true && value['applicationDelivered'] === false && value['ok'] === false && value['reason'] === 'backstop' && value['sinkReason'] === 'queued';
    })).toBe(true);
    await handle.shutdown();
  });

  it('formula task Iroh execution remains available with log-only wakes', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM, ROLE] });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const connections: IrohConnection[] = [];
    const { handle } = await boot(fake, { connections, pmWake: { sink: 'log', backstopMs: MIN }, listPoolMembers: () => [] });
    expect(fake.dials).toBe(0); // lazy: nothing dialed at boot

    const session = await handle.provider.start({ role: 'r', extra: { agentId: ROLE, moleculeId: 'm', stepName: 's' } });
    await handle.provider.prompt(session, [{ type: 'text', text: 'do the step' }]);
    const events: unknown[] = [];
    for await (const e of handle.provider.observe(session)) events.push(e);
    await handle.provider.stop(session);
    expect(fake.dials).toBe(1);
    await vi.advanceTimersByTimeAsync(8 * HOUR + 40 * MIN);
    expect(fake.dials).toBe(1); // accepted-only fake outcome avoids a second connection
    expect(connections).toHaveLength(1); // boot still built exactly one IrohConnection
    await handle.shutdown();
  });

  it('a logged wake opens no runtime connection; a later formula step dials normally', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM, ROLE] });
    fake.seedConversation(PM, { id: 'conv-live', lastMessageAt: '2025-12-31T23:00:00.000Z' });
    const connections: IrohConnection[] = [];
    const { handle } = await boot(fake, { connections });
    await vi.advanceTimersByTimeAsync(8 * HOUR + 40 * MIN);
    expect(fake.dials).toBe(0);

    const session = await handle.provider.start({ role: 'r', extra: { agentId: ROLE, moleculeId: 'm', stepName: 's' } });
    await handle.provider.prompt(session, [{ type: 'text', text: 'do the step' }]);
    for await (const _ of handle.provider.observe(session)) { /* drain */ }
    await handle.provider.stop(session);
    expect(fake.dials).toBe(1);
    expect(connections).toHaveLength(1);
  });

  it("a failed wake (PM outside the grant) is ok:false on the bus, lastWokenAt unchanged, and the retry reuses the wakeId", async () => {
    const fake = new FakeIrohWrapper({ scope: ['agent-someone-else'] });
    const { woken } = await boot(fake, { pmWake: { sink: 'inbox' }, bd: pendingWakeBd().run,
      inboxAdapter: { sendInboxMessage: async request => ({ msgId: request.msgId, accepted: false, applicationDelivered: false, reason: 'forbidden' }) },
    });
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

  it('inbox without an adapter refuses to boot instead of falling back to direct input', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    await expect(boot(fake, { pmWake: { sink: 'inbox' } })).rejects.toThrow(/requires an approved/);
  });

  it('disabled inbox wakes never dial the formula transport', async () => {
    const fake = new FakeIrohWrapper({ scope: [PM] });
    // The Iroh connection is lazy: with wakes off and no work, nothing dials.
    await boot(fake, { pmWake: { enabled: false } });
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(fake.dials).toBe(0);
  });
});
