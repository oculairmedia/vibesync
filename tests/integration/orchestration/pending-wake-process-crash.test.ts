import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { BdPendingWakeStore } from '../../../src/orchestration/scheduler/bd-pending-wake-store.js';
import { provisionIsolatedWakeRepo, RUN_ISOLATED_WAKES } from './isolated-bd-wakes.js';

// Controlled subprocess receipts exercise the actual producer/CLI boundary,
// not the mobile receiver or its UI. No exactly-once execution claim is made.
it.skipIf(!RUN_ISOLATED_WAKES)('SIGKILL before send and after acceptance recovers the same immutable send in a fresh process', async () => {
  const repo = await provisionIsolatedWakeRepo();
  try {
    const capture = join(repo.root, 'requests.jsonl');
    const mode = join(repo.root, 'receipt-mode');
    const executable = join(repo.root, 'controlled-sender');
    writeFileSync(mode, 'accepted');
    writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => body += c);
process.stdin.on('end', () => {
  const msgId = args[args.indexOf('--msg-id') + 1];
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, body, msgId}) + '\\n');
  const delivered = fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'delivered';
  process.stdout.write(JSON.stringify({ok:true,accepted:true,applicationDelivered:delivered,msgId,reason:delivered?'delivered':'queued'}));
  process.exitCode = delivered ? 0 : 1;
});
`, { mode: 0o700 });
    const worker = join(repo.root, 'producer.ts');
    const source = (name: string) => JSON.stringify(pathToFileURL(resolve(`src/orchestration/scheduler/${name}.ts`)).href);
    writeFileSync(worker, `
import { writeFileSync } from 'node:fs';
import { BdPendingWakeStore } from ${source('bd-pending-wake-store')};
import { createCliRunner } from ${source('bd-adapters')};
import { createInboxCliAdapter } from ${source('inbox-cli-adapter')};
import { formatWakeMessage } from ${source('pm-waker')};
const [binary,cwd,id,stage,marker,executable] = process.argv.slice(2);
const cli = createCliRunner({binary,cwd});
const runner = async args => {
  if (stage === 'after-acceptance' && args[0] === 'update' && args.includes('--metadata')) {
    const meta = JSON.parse(args[args.indexOf('--metadata') + 1]);
    if (meta.receipt) {
      writeFileSync(marker, JSON.stringify(meta.receipt));
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
  }
  return cli(['--sandbox','--dolt-auto-commit=off',...args]);
};
const store = new BdPendingWakeStore(runner);
if (stage === 'after-claim') {
  const claim = await store.claim(id);
  if (!claim.authorized) throw new Error('initial claim denied');
  writeFileSync(marker, JSON.stringify(claim));
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
}
const adapter = createInboxCliAdapter({executable,senderAgentId:'agent-service-test',identityDir:cwd,addressStore:cwd+'/hosts',contractVerified:true});
const result = await store.claimAndSend(id, {
  wake: async input => {
    if (stage === 'before-send') {
      writeFileSync(marker, JSON.stringify(input));
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    return adapter.sendInboxMessage({to:input.agentId,msgId:input.wakeId,body:formatWakeMessage(input),correlation:input.correlation});
  }
});
if (!result.authorized) throw new Error('recovery claim denied');
writeFileSync(marker, JSON.stringify(result.receipt));
`);
    const launch = (id: string, stage: string, marker: string) => new Promise<{ code: number | null; signal: string | null }>((fulfill, reject) => {
      const child = spawn('bun', [worker, repo.binary, repo.root, id, stage, marker, executable], { env: repo.env, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('producer child timed out')); }, 60_000);
      child.stderr.on('data', chunk => { errors += String(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 && signal !== 'SIGKILL') reject(new Error(`producer failed: ${errors}`));
        else fulfill({ code, signal });
      });
    });
    const store = new BdPendingWakeStore(repo.runner);
    const pending = [];
    for (const stage of ['after-claim', 'before-send', 'after-acceptance']) {
      const row = await store.enqueue({ agentId: 'agent-pm-test', projectIdentifier: 'test', reason: 'event', detail: stage, wakeId: `stable-${stage}`, correlation: { bead: 'test-1', moleculeRun: 'mol-test' } });
      const marker = join(repo.root, stage);
      expect((await launch(row.id, stage, marker)).signal).toBe('SIGKILL');
      expect(existsSync(marker)).toBe(true);
      const claimed = await store.get(row.id);
      expect(claimed?.receipt).toBeUndefined();
      expect(claimed?.payload).toEqual(row.payload);
      expect(claimed?.leaseExpiresAt).toBeTypeOf('number');
      pending.push({ row, expires: claimed!.leaseExpiresAt! });
    }
    const requests = () => readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests()).toHaveLength(1);
    expect(requests()[0].msgId).toBe('stable-after-acceptance');
    const remaining = Math.max(...pending.map(p => p.expires)) - Date.now();
    expect(remaining).toBeLessThan(360_000);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining) + 1500));
    writeFileSync(mode, 'delivered');
    for (const { row } of pending) {
      expect((await launch(row.id, 'recover', join(repo.root, `${row.id}-result`))).code).toBe(0);
      const recovered = await store.get(row.id);
      expect(recovered?.payload).toEqual(row.payload);
      expect(recovered?.status).toBe('closed');
      expect(recovered?.receipt).toMatchObject({ msgId: row.payload.msgId, accepted: true, applicationDelivered: true });
    }
    const replayed = requests().filter(r => r.msgId === 'stable-after-acceptance');
    expect(replayed).toHaveLength(2);
    expect(replayed[1]).toEqual(replayed[0]);
    expect(requests().filter(r => r.msgId === 'stable-before-send')).toHaveLength(1);
    expect(requests().filter(r => r.msgId === 'stable-after-claim')).toHaveLength(1);
  } finally { await repo.teardown(); }
}, 450_000);
