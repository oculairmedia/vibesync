import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { formatWakeMessage } from '../../../src/engine/pm-wake/waker.js';
import { BdPendingWakeStore } from '../../../src/engine/pm-wake/pending-store.js';
import { FilePmWakeStateStore } from '../../../src/engine/pm-wake/state.js';
import type { PmWakeSink } from '../../../src/engine/pm-wake/waker.js';
import { PmWaker, type PmWakeInput } from '../../../src/engine/pm-wake/waker.js';
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

  afterEach(async () => {
    process.env = { ...originalEnv };
    try { await repo?.teardown(); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); }
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
    const store = new BdPendingWakeStore(repo.runner);
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

  it('concurrent claim contenders authorize one sender across separate processes on the real bd store', async () => {
    const { sender, store } = await setup();
    const created = await store.enqueue(input('wake-concurrent'));
    const worker = join(root, 'claim-worker.ts');
    const sends = join(root, 'authorized-sends.jsonl');
    writeFileSync(worker, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { BdPendingWakeStore } from ${JSON.stringify(pathToFileURL(resolve('src/engine/pm-wake/pending-store.ts')).href)};
      import { createCliRunner } from ${JSON.stringify(pathToFileURL(resolve('src/engine/scheduler/bd-adapters.ts')).href)};
      const [binary, cwd, issue, result, sends] = process.argv.slice(2);
      const run = createCliRunner({ binary, cwd });
      const store = new BdPendingWakeStore(args => run(['--sandbox', '--dolt-auto-commit=off', ...args]));
      const outcome = await store.claimAndSend(issue, {
        wake: async input => {
          appendFileSync(sends, JSON.stringify(input) + '\\n');
          return { ok: true, accepted: true, applicationDelivered: true, msgId: input.wakeId };
        }
      });
      writeFileSync(result, outcome.authorized ? 'won' : 'lost');
    `);
    const results = await Promise.all([0, 1].map((index) => new Promise<string>((resolve, reject) => {
      const result = join(root, `claim-result-${index}`);
      const child = spawn('bun', [worker, repo.binary, repo.root, created.id, result, sends], { env: repo.env, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        try { resolve(readFileSync(result, 'utf8')); } catch { reject(new Error(`claim child exit ${code}: ${stderr || 'no result file'}`)); }
      });
    })));
    expect(results, results.join(',')).toHaveLength(2);
    expect(results.filter((result) => result === 'won')).toHaveLength(1);
    expect(readFileSync(sends, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(sender.records()).toHaveLength(0);
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

    await waitForNativeExpiry(store, pending.id);
    const restarted = new BdPendingWakeStore(repo.runner);
    const second = await restarted.claimAndSend(pending.id, sink);
    expect(second.authorized).toBe(true);
    const records = sender.records();
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(initial);

    const newer = await store.enqueue(input('wake-newer', 'different event'));
    expect(newer.id).not.toBe(pending.id);
    expect((await store.get(pending.id))?.payload).toEqual(pending.payload);
  }, 400_000);

  it('a persisted delivered receipt prevents another send when closing the bead fails', async () => {
    const { sender, store } = await setup();
    const pending = await store.enqueue(input('wake-already-delivered'));
    const claim = await store.claim(pending.id);
    expect(claim.authorized).toBe(true);
    const failingClose = new BdPendingWakeStore(async args => {
      if (args[0] === 'update' && args.includes('--status') && args[args.indexOf('--status') + 1] === 'closed') {
        throw new Error('close failed after receipt persisted');
      }
      return repo.runner(args);
    });
    await expect(failingClose.sendClaimed(claim.record!, sinkFor(sender))).rejects.toThrow('close failed');
    expect((await store.get(pending.id))?.receipt?.applicationDelivered).toBe(true);
    expect(sender.records()).toHaveLength(1);
    const recovered = await store.sendClaimed(claim.record!, sinkFor(sender));
    expect(recovered.outcome).toMatchObject({ ok: true, applicationDelivered: true, msgId: 'wake-already-delivered' });
    expect(sender.records()).toHaveLength(1);
    expect((await store.get(pending.id))?.status).toBe('closed');
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
    const { sender, store } = await setup('accepted');
    const pending = await store.enqueue(input('wake-crash'));
    const initialPayload = pending.payload;
    const crashed = await store.claim(pending.id);
    expect(crashed.authorized).toBe(true);
    await waitForNativeExpiry(store, pending.id);
    const sink = sinkFor(sender);
    const restarted = await store.claimAndSend(pending.id, sink);
    expect(restarted.authorized).toBe(true);
    expect(sender.records()[0]!.args).toContain(initialPayload.msgId);
    expect(sender.records()[0]!.body).toBe(initialPayload.body);

    await waitForNativeExpiry(store, pending.id);
    const restartedStore = new BdPendingWakeStore(repo.runner);
    const beforeReplay = await restartedStore.get(pending.id);
    expect(beforeReplay?.leaseExpiresAt).toBeLessThanOrEqual(Date.now());
    const replayClaim = await restartedStore.claim(pending.id);
    expect(replayClaim.authorized, JSON.stringify(replayClaim)).toBe(true);
    const replay = await restartedStore.sendClaimed(replayClaim.record!, sink);
    expect(replay.authorized).toBe(true);
    expect(sender.records()[1]).toEqual(sender.records()[0]);
  }, 750_000);
});

async function waitForNativeExpiry(store: BdPendingWakeStore, id: string): Promise<void> {
  const record = await store.get(id);
  expect(record?.leaseExpiresAt, 'claim must establish a native bd lease').toBeTypeOf('number');
  const remaining = record!.leaseExpiresAt! - Date.now();
  expect(remaining).toBeLessThan(360_000);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 1500));
}
