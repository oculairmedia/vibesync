import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IrohConfigError } from '../../../../../src/orchestration/runtime/iroh/connection.js';
import {
  parseHostAddress,
  readHostFromKv,
  readSecretKey,
  resolveNativeIrohConfig,
} from '../../../../../src/orchestration/runtime/iroh/native-dialer.js';

const NODE = 'ab'.repeat(32);

describe('native-dialer config helpers', () => {
  it('parses <node>@<addrs> and prefers loopback on the first port', () => {
    const h = parseHostAddress(`${NODE}@192.168.50.90:4501,10.0.0.1:4501`);
    expect(h.nodeId).toBe(NODE);
    expect(h.addrs[0]).toBe('127.0.0.1:4501');
    expect(h.addrs).toContain('192.168.50.90:4501');
  });
  it('keeps an explicit loopback address first and does not duplicate it', () => {
    expect(parseHostAddress(`${NODE}@127.0.0.1:4501`).addrs).toEqual(['127.0.0.1:4501']);
  });
  it('rejects malformed addresses as config errors (never retried)', () => {
    expect(() => parseHostAddress('nope')).toThrow(IrohConfigError);
    expect(() => parseHostAddress(`${NODE}@`)).toThrow(IrohConfigError);
  });
  it('reads the host: row of the kv and ignores other rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iroh-kv-'));
    const p = join(dir, 'agent-addresses.kv');
    writeFileSync(p, `agent:1234=zzz\nhost:330415cc=${NODE}@192.168.50.90:4501,10.0.0.1:4501\n`);
    expect(readHostFromKv(p).nodeId).toBe(NODE);
    writeFileSync(p, 'agent:1=x\n');
    expect(() => readHostFromKv(p)).toThrow(/no host: row/);
  });
  it('validates the secret key file: exists, 0600, 32 bytes; never echoes contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iroh-key-'));
    const p = join(dir, 'k');
    expect(() => readSecretKey(p)).toThrow(/not found/);
    writeFileSync(p, Buffer.alloc(32, 7));
    chmodSync(p, 0o644);
    expect(() => readSecretKey(p)).toThrow(/chmod 600/);
    chmodSync(p, 0o600);
    expect(readSecretKey(p)).toHaveLength(32);
    writeFileSync(p, Buffer.alloc(31, 7));
    chmodSync(p, 0o600);
    let msg = '';
    try { readSecretKey(p); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/32 raw bytes/);
    expect(msg).not.toContain('7,7');
  });
  it('resolves env keys', () => {
    expect(resolveNativeIrohConfig({ VIBESYNC_IROH_HOST_ADDR: 'a', VIBESYNC_IROH_PEER_NAME: 'n' })).toEqual({ hostAddr: 'a', secretKeyPath: undefined, peerName: 'n' });
  });
});
