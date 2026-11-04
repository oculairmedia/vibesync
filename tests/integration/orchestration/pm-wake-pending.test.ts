import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { formatWakeMessage } from '../../../src/orchestration/scheduler/pm-waker.js';
import { BdPendingWakeStore } from '../../../src/orchestration/scheduler/bd-pending-wake-store.js';
import { FilePmWakeStateStore } from '../../../src/orchestration/scheduler/pm-wake-state.js';
import type { PmWakeSink } from '../../../src/orchestration/scheduler/pm-waker.js';
import { PmWaker, type PmWakeInput } from '../../../src/orchestration/scheduler/pm-waker.js';
import { RUN_ISOLATED_WAKES, provisionIsolatedWakeRepo } from './isolated-bd-wakes.js';

const describeWithBd = RUN_ISOLATED_WAKES ? describe : describe.skip;
const originalEnv = { ...process.env };

interface SpawnRecord {
  readonly args: string[];
  readonly body: string;
  readonly result: { readonly msgId: string };
}

function fixture(root: string, mode: 'delivered' | 'accepted' | 'unaddressable' = 'delivered') {
  const recordPath = join(root, 'sender.jsonl');
  const script = join(root, 'controlled-sender.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const msgId = process.argv[2]; const to = process.argv[3]; const correlation = JSON.parse(process.argv[4]);",
    "let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => {",
    `const mode = fs.readFileSync(${JSON.stringify(join(root, 'fixture-mode'))}, 'utf8');`,
    "const result = mode === 'delivered' ? {ok:true,accepted:true,applicationDelivered:true,msgId} : mode === 'accepted' ? {ok:true,accepted:true,applicationDelivered:false,msgId,reason:'receiver_busy'} : {ok:false,accepted:false,applicationDelivered:false,msgId,reason:'unknown_host'};",
    `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({args:[msgId,to,correlation],body,result}) + '\\n');`,
    "process.stdout.write(JSON.stringify(result));",
    "process.exitCode = result.applicationDelivered ? 0 : 1; });",
  ].join('\n'));
  return {
    script,
    setMode(mode: 'delivered' | 'accepted' | 'unaddressable') { writeFileSync(join(root, 'fixture-mode'), mode); },
    records(): SpawnRecord[] {
      return existsSync(recordPath) ? readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpawnRecord) : [];
    },
  };
}

describeWithBd('durable PM inbox wakes (real isolated bd + CLI subprocess)', () => {
  let repo: Awaited<ReturnType<typeof provisionIsolatedWakeRepo>>;
  let root: string;

  afterAll(async () => {
    process.env = { ...originalEnv };
    await repo?.teardown();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const sinkFor = (sender: ReturnType<typeof fixture>): PmWakeSink => ({
    async wake(input) {
      const child = spawn(process.execPath, [sender.script, input.wakeId, input.agentId, JSON.stringify(input.correlation ?? {})], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const body = formatWakeMessage(input);
      const ack = await new Promise<{ ok: boolean; accepted: boolean; applicationDelivered: boolean; msgId: string; reason?: string }>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        child.on('error', reject);
        child.on('close', () => {
          try { resolve(JSON.parse(output) as { ok: boolean; accepted: boolean; applicationDelivered: boolean; msgId: string; reason?: string }); } catch (error) { reject(error); }
        });
        child.stdin.end(body);
      });
      return { ok: ack.ok, accepted: ack.accepted, applicationDelivered: ack.applicationDelivered, msgId: ack.msgId, ...(ack.reason ? { reason: ack.reason } : {}) };
    },
  });

  async function setup(mode: 'delivered' | 'accepted' | 'unaddressable' = 'delivered') {
    repo = await provisionIsolatedWakeRepo();
    root = mkdtempSync(join(tmpdir(), 'vibesync-wake-fixture-'));
    const sender = fixture(root, mode);
    sender.setMode(mode);
    const store = new BdPendingWakeStore(repo.runner, { leaseMs: 1000, now: () => Date.now() });
    return { sender, store };
  }

  function input(wakeId: string, detail = 'work-1 changed'): PmWakeInput {
    return {
      agentId: 'agent-pm', projectIdentifier: 'project-a', reason: 'event', detail, wakeId,
      correlation: { bead: 'work-1', step: 'step-2', moleculeRun: 'run:mol-1', appServerRun: 'turn-9', lease: 'lease-3' },
    };
  }

  async function waker(store: BdPendingWakeStore, sink: PmWakeSink, now: () => number) {
    return new PmWaker({
      projectIdentifier: 'project-a', lookupAgentId: () => 'agent-pm',
      sink, pendingWakeStore: store,
      store: new FilePmWakeStateStore(join(root, 'legacy-state.json')),
      backlog: () => null, emit: () => undefined,
      minIntervalMs: 0, backstopMs: 60_000, now,
    });
  }

  it('persists the immutable payload before sending; a storage failure sends nothing', async () => {
    const { sender, store } = await setup();
    const failingStore = new BdPendingWakeStore(
      async (args) => {
        if (args[0] === 'create' && args.includes('vibesync:pending-wake')) throw new Error('store unavailable');
        return repo.runner(args);
      },
      { leaseMs: 1000 },
    );
    let now = Date.now();
    const subject = await waker(failingStore, sinkFor(sender), () => now);
    subject.noteEvent('webhook', 'work-1 changed');
    subject.onTick({ result: { scheduler: { dispatched: [] } } });
    await subject.idle();
    expect(sender.records()).toHaveLength(0);
    subject.dispose();

    const ready = await waker(store, sinkFor(sender), () => now);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ready.noteEvent('webhook', 'work-1 changed');
    ready.onTick({ result: { scheduler: { dispatched: [] } } });
    await ready.idle();
    expect(sender.records()).toHaveLength(1);
    expect(sender.records()[0]!.result.msgId).toMatch(/^project-a-event-/);
  });

  it('concurrent claim contenders authorize at most one sender while the lease is held', async () => {
    const { sender, store } = await setup();
    const created = await store.enqueue(input('wake-concurrent'));
    const sink = sinkFor(sender);
    const outcomes = await Promise.all([store.claimAndSend(created.id, sink), store.claimAndSend(created.id, sink)]);
    expect(outcomes.filter((value) => value.authorized)).toHaveLength(1);
    expect(outcomes).toHaveLength(2);
  });

  it('restart after receiver acceptance reuses exact ID, recipient, body and correlation after bounded lease recovery', async () => {
    const { sender, store } = await setup('accepted');
    const pending = await store.enqueue(input('wake-stable'));
    const sink = sinkFor(sender);
    const first = await store.claimAndSend(pending.id, sink);
    expect(first.receipt).toMatchObject({ accepted: true, applicationDelivered: false, reason: 'receiver_busy' });
    const initial = sender.records()[0]!;
    expect(initial.args).not.toContain('--conversation-id');
    expect(initial.args).not.toContain('--lane');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await store.claimAndSend(pending.id, sink);
    expect(second.authorized).toBe(true);
    const records = sender.records();
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(initial);

    const newer = await store.enqueue(input('wake-newer', 'different event'));
    expect(newer.id).not.toBe(pending.id);
    expect((await store.get(pending.id))?.payload).toEqual(pending.payload);
  });

  it('retains explicit denial and timeout ambiguity without generating a fresh logical ID', async () => {
    const { sender, store } = await setup('unaddressable');
    const pending = await store.enqueue(input('wake-denied'));
    const denial = await store.claimAndSend(pending.id, sinkFor(sender));
    expect(denial.receipt).toMatchObject({ accepted: false, applicationDelivered: false, reason: 'unknown_host' });
    const saved = await store.get(pending.id);
    expect(saved?.payload.msgId).toBe('wake-denied');
    expect(saved?.receipt).toMatchObject({ reason: 'unknown_host' });
    expect(sender.records()).toHaveLength(1);
  });

  it('survives process replacement before any send and after send before receipt recording', async () => {
    const { sender, store } = await setup();
    const pending = await store.enqueue(input('wake-crash'));
    const initialPayload = pending.payload;
    const crashed = await store.claim(pending.id);
    expect(crashed.authorized).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const sink = sinkFor(sender);
    const restarted = await store.claimAndSend(pending.id, sink);
    expect(restarted.authorized).toBe(true);
    expect(sender.records()[0]!.args).toContain(initialPayload.msgId);
    expect(sender.records()[0]!.body).toBe(initialPayload.body);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const replay = await store.claimAndSend(pending.id, sink);
    expect(replay.authorized).toBe(true);
    expect(sender.records()[1]).toEqual(sender.records()[0]);
  });
});
