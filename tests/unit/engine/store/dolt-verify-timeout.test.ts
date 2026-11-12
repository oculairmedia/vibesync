import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOLT_QUERY_TIMEOUT_MS, DoltClient, type DoltBootDeps } from '../../../../src/engine/store/dolt-client.js';

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packet(payload: Buffer, sequence: number): Buffer {
  const header = Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, sequence]);
  return Buffer.concat([header, payload]);
}

function handshakePacket(): Buffer {
  const serverVersion = Buffer.from('8.0.0-dolt\0');
  const scramble1 = Buffer.from('12345678');
  const scramble2 = Buffer.from('abcdefghijkl');
  const pluginName = Buffer.from('mysql_native_password\0');
  const payload = Buffer.alloc(1 + serverVersion.length + 4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10 + 13 + pluginName.length);
  let offset = 0;
  payload[offset++] = 10;
  serverVersion.copy(payload, offset); offset += serverVersion.length;
  payload.writeUInt32LE(1, offset); offset += 4;
  scramble1.copy(payload, offset); offset += 8;
  payload[offset++] = 0;
  const flags = 0x0000_0001 | 0x0000_0200 | 0x0000_8000 | 0x0008_0000 | 0x0000_0008;
  payload.writeUInt16LE(flags & 0xffff, offset); offset += 2;
  payload[offset++] = 45;
  payload.writeUInt16LE(2, offset); offset += 2;
  payload.writeUInt16LE(flags >>> 16, offset); offset += 2;
  payload[offset++] = 21;
  offset += 10;
  scramble2.copy(payload, offset); offset += 12;
  payload[offset++] = 0;
  payload[offset++] = 0;
  pluginName.copy(payload, offset);
  return packet(payload, 0);
}

/**
 * A server that completes the MySQL handshake and then never answers a query.
 * `closed` resolves once the client has closed its socket: the client's pool did
 * not keep the stalled connection (a pool that did would hang `pool.end()`).
 */
async function stallingServer(): Promise<{ port: number; closed: Promise<void> }> {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = () => resolve(); });
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => resolveClosed());
    socket.write(handshakePacket());
    let receivedAuth = false;
    let receivedQuery = false;
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUIntLE(0, 3);
        if (buffered.length < length + 4) return;
        const sequence = buffered[3];
        const payload = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        if (!receivedAuth) {
          receivedAuth = true;
          // Complete authentication, then wait without answering the SQL query.
          socket.write(packet(Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00]), sequence + 1));
        } else if (!receivedQuery && payload[0] === 0x03) {
          receivedQuery = true;
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, closed };
}

function trackerRoot(port: number): string {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-dolt-timeout-'));
  roots.push(root);
  mkdirSync(join(root, '.beads'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.beads', 'metadata.json'), JSON.stringify({ backend: 'dolt', dolt_mode: 'server', dolt_database: 'scratch' }));
  writeFileSync(join(root, '.beads', 'dolt-server.port'), `${port}\n`);
  return root;
}

function bootDeps(startDoltServer: DoltBootDeps['startDoltServer']): DoltBootDeps {
  return {
    readPortFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    startDoltServer,
    sleep: async () => undefined,
  };
}

const timeoutMessage = (port: number, timeoutMs: number): string =>
  `DoltClient: the Dolt server on port ${port} accepted the connection but did not answer the verification query within ${timeoutMs}ms`;

describe('DoltClient verification query timeout', () => {
  it('bounds connect when the server authenticates but stalls on the fingerprint query', async () => {
    const timeoutMs = 150;
    const server = await stallingServer();
    const root = trackerRoot(server.port);
    const started = Date.now();

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any', verifyTimeoutMs: timeoutMs })
      .then(() => { throw new Error('expected connect to time out'); }, (err: unknown) => err as Error & { cause?: NodeJS.ErrnoException });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error.message).toBe(timeoutMessage(server.port, timeoutMs));
    expect(error.cause?.code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
    await expect(server.closed).resolves.toBeUndefined();
  });

  it('does not retry restart after a restarted server stalls during verification', async () => {
    const timeoutMs = 150;
    const dead = await freePort();
    const root = trackerRoot(dead);
    let server: Awaited<ReturnType<typeof stallingServer>> | null = null;
    const start = vi.fn(async () => {
      server = await stallingServer();
      writeFileSync(join(root, '.beads', 'dolt-server.port'), `${server.port}\n`);
    });

    const error = await DoltClient.connect(
      { beadsRoot: root, expectedRepoId: 'any', verifyTimeoutMs: timeoutMs },
      bootDeps(start),
    ).then(() => { throw new Error('expected connect to time out'); }, (err: unknown) => err as Error & { cause?: NodeJS.ErrnoException });

    expect(start).toHaveBeenCalledTimes(1);
    expect(server).not.toBeNull();
    expect(error.message).toBe(timeoutMessage(server!.port, timeoutMs));
    expect(error.cause?.code).toBe('PROTOCOL_SEQUENCE_TIMEOUT');
    await expect(server!.closed).resolves.toBeUndefined();
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

it('uses the production verification timeout by default', () => {
  expect(DOLT_QUERY_TIMEOUT_MS).toBe(10_000);
});
