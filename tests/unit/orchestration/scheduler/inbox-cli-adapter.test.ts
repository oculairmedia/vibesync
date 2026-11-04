import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createInboxCliAdapter } from '../../../../src/orchestration/pm-wake/inbox-cli-adapter.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(code: number, ack: string) {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
  dirs.push(dir);
  const executable = join(dir, 'sender');
  const capture = join(dir, 'captured.json');
  writeFileSync(executable, `#!${process.execPath}
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => body += c);
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),body}));
  process.stdout.write(${JSON.stringify(ack)});
  process.exitCode = ${code};
});
`, { mode: 0o700 });
  return { capture, options: { executable, senderAgentId: 'agent-service', identityDir: dir, addressStore: join(dir, 'hosts'), contractVerified: true } };
}

it.each([0, 1])('preserves JSON outcome on exit %i and passes literal body via stdin', async (code) => {
  const ack = { msgId: 'wake-1', accepted: true, applicationDelivered: code === 0, reason: 'queued' };
  const f = fixture(code, JSON.stringify(ack));
  const adapter = createInboxCliAdapter(f.options);
  const input = { to: 'agent-pm', msgId: 'wake-1', body: 'quote "\n$(touch should-not-exist)', correlation: { bead: 'project-1', run: 'mol-1' } };
  expect(await adapter.sendInboxMessage(input)).toEqual(ack);
  const first = JSON.parse(readFileSync(f.capture, 'utf8'));
  expect(first.body).toBe(input.body);
  expect(first.args).toEqual(['agent-message', 'send', '--from', 'agent-service', '--to', 'agent-pm', '--msg-id', 'wake-1', '--body-file', '-', '--identity-dir', f.options.identityDir, '--address-store', f.options.addressStore, '--correlation-json', JSON.stringify(input.correlation)]);
  expect(await adapter.sendInboxMessage(input)).toEqual(ack);
  expect(JSON.parse(readFileSync(f.capture, 'utf8'))).toEqual(first);
});

it('refuses unverified activation and blank identity rather than generating a UUID', async () => {
  const f = fixture(0, '{}');
  expect(() => createInboxCliAdapter({ ...f.options, contractVerified: false })).toThrow('not been verified');
  await expect(createInboxCliAdapter(f.options).sendInboxMessage({ to: 'agent-pm', msgId: ' ', body: 'wake' })).rejects.toThrow('stable msgId');
});

it('reports malformed receipt as unknown, not delivered', async () => {
  const f = fixture(1, 'not json');
  await expect(createInboxCliAdapter(f.options).sendInboxMessage({ to: 'agent-pm', msgId: 'wake-1', body: 'wake' })).rejects.toThrow('delivery is unknown');
});
