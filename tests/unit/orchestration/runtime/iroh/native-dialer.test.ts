import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IrohConfigError } from '../../../../../src/orchestration/runtime/iroh/connection.js';
import {
  createNativeIrohConnection,
  type NativeIrohLib,
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


/** Fake native lib: bind and openBi can be told to fail; tracks closes. */
function fakeLib(o: { bindFails?: number; openBiFailsOn?: number } = {}) {
  const st = { binds: 0, bindAttempts: 0, connects: 0, connCloses: 0, epCloses: 0, opens: 0 };
  const lib: NativeIrohLib = {
    Endpoint: {
      builder() {
        return {
          applyN0DisableRelay() {},
          secretKey() {},
          async bind() {
            st.bindAttempts += 1;
            if (st.bindAttempts <= (o.bindFails ?? 0)) throw new Error('bind failed (transient)');
            st.binds += 1;
            return {
              async connect() {
                st.connects += 1;
                return {
                  async openBi() {
                    st.opens += 1;
                    if (o.openBiFailsOn !== undefined && st.opens === o.openBiFailsOn) throw new Error('openBi failed');
                    return { send: { async writeAll() {}, async finish() {} }, recv: { async read() { return null; } } };
                  },
                  close() { st.connCloses += 1; },
                };
              },
              async close() { st.epCloses += 1; },
            };
          },
        };
      },
    },
    EndpointAddr: class { constructor(..._a: unknown[]) {} } as never,
    EndpointId: { fromString: (h: string) => h },
  };
  return { lib, st };
}

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iroh-key-'));
  const p = join(dir, 'k');
  writeFileSync(p, Buffer.alloc(32, 1));
  chmodSync(p, 0o600);
  return p;
}

/** Reach the private dial function the connection holds, without opening a real socket. */
function dialOf(conn: unknown): () => Promise<{ close(): Promise<void> }> {
  return (conn as { o: { dial: () => Promise<{ close(): Promise<void> }> } }).o.dial;
}

describe('native-dialer dial (CodeRabbit #55)', () => {
  it('a failed bind is NOT cached: the next dial binds again and succeeds', async () => {
    const { lib, st } = fakeLib({ bindFails: 1 });
    const conn = createNativeIrohConnection({ hostAddr: `${NODE}@127.0.0.1:4501`, secretKeyPath: keyFile(), loadLib: async () => lib });
    const dial = dialOf(conn);
    await expect(dial()).rejects.toThrow(/bind failed/);
    const link = await dial();
    expect(st.bindAttempts).toBe(2);
    expect(st.binds).toBe(1);
    await link.close();
  });

  it('when openBi fails after connect, the QUIC connection is closed (no leak per retry)', async () => {
    const { lib, st } = fakeLib({ openBiFailsOn: 2 }); // control opens, stream fails
    const conn = createNativeIrohConnection({ hostAddr: `${NODE}@127.0.0.1:4501`, secretKeyPath: keyFile(), loadLib: async () => lib });
    await expect(dialOf(conn)()).rejects.toThrow(/openBi failed/);
    expect(st.connects).toBe(1);
    expect(st.connCloses).toBe(1);
  });
});
