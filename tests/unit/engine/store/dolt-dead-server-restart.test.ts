/**
 * vibesync-9lzk.55.7: a port file can outlive its server.
 *
 * A service restart kills the engine's own Dolt server (it lives in the
 * service's cgroup) and leaves `.beads/dolt-server.port` behind. The port then
 * resolves at once and every connection is refused; the engine boot retried
 * the same refused connection five times and came up with orchestration off
 * (deploy of 2d338ce, 2026-11-11). `DoltClient.connect` must start the server
 * itself in that case.
 *
 * The connection is real here: mysql2 dials a real TCP port. A dead server is a
 * port nobody listens on. A running server is a listener that answers the way
 * MySQL answers a client it will not serve: an ERR packet in place of the
 * handshake (1130, host not allowed). mysql2 reports that as a server error,
 * which is not a refusal, so these tests are deterministic and need no Dolt.
 * The path where the restarted server then serves queries is covered by the
 * real-bd boot check (scripts/ci/engine-boot-check.sh).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DoltClient, type DoltBootDeps } from '../../../../src/engine/store/dolt-client.js';

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A port nobody listens on: bind, read the number, release. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** MySQL ERR packet sent in place of the handshake: error 1130, sequence 0, no SQL state. */
function hostNotAllowedPacket(): Buffer {
  const payload = Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), Buffer.from('Host is not allowed to connect to this server')]);
  const header = Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, 0]);
  return Buffer.concat([header, payload]);
}
const SERVER_ANSWERED = 'ER_HOST_NOT_PRIVILEGED';

/** A running server: accepts the connection and answers it. Connections are counted. */
async function listener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.end(hostNotAllowedPacket());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, connections: () => connections };
}

/** A tracker root with a port file and no git remote (so no fingerprint query is sent on connect). */
function trackerRoot(port: number): string {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-dead-dolt-'));
  roots.push(root);
  mkdirSync(join(root, '.beads'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.beads', 'metadata.json'), JSON.stringify({ backend: 'dolt', dolt_mode: 'server', dolt_database: 'scratch' }));
  writeFileSync(join(root, '.beads', 'dolt-server.port'), `${port}\n`);
  return root;
}

const portFile = (root: string): string => join(root, '.beads', 'dolt-server.port');

function deps(root: string, startDoltServer: DoltBootDeps['startDoltServer']): DoltBootDeps & { logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    readPortFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    startDoltServer,
    sleep: async () => undefined,
    log: (level, _obj, msg) => { logs.push({ level, msg }); },
    logs,
  };
}

describe('DoltClient.connect when the port file points at a dead server (vibesync-9lzk.55.7)', () => {
  it('starts the server once and dials the port the restarted server wrote', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    let live: Awaited<ReturnType<typeof listener>> | null = null;
    const start = vi.fn(async (beadsRoot: string) => {
      live = await listener();
      writeFileSync(portFile(root), `${live.port}\n`); // the restarted server may pick another port
      void beadsRoot;
    });
    const d = deps(root, start);

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, d).catch((err: unknown) => err as NodeJS.ErrnoException);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(root);
    expect(live).not.toBeNull();
    expect(live!.connections()).toBe(1); // the retry dialled the NEW port, once
    // The fake server answers but serves nothing, so connect ends with the SERVER's answer, not a refusal.
    expect((error as NodeJS.ErrnoException).code).toBe(SERVER_ANSWERED);
    expect(d.logs.some((l) => l.level === 'warn' && l.msg.includes('connection refused'))).toBe(true);
  });

  it('gives the restarted server time to accept: it keeps trying while the new port still refuses', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    let live: Awaited<ReturnType<typeof listener>> | null = null;
    const start = vi.fn(async () => undefined); // returns before anything listens
    const d = deps(root, start);
    let sleeps = 0;
    d.sleep = async () => {
      sleeps += 1;
      if (sleeps === 3) { live = await listener(); writeFileSync(portFile(root), `${live.port}\n`); }
    };

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, d).catch((err: unknown) => err as NodeJS.ErrnoException);

    expect(start).toHaveBeenCalledTimes(1);
    expect(sleeps).toBe(3);
    expect(live!.connections()).toBe(1);
    expect((error as NodeJS.ErrnoException).code).toBe(SERVER_ANSWERED);
  });

  it('a server that answers is never restarted, whatever it answers', async () => {
    const live = await listener();
    const root = trackerRoot(live.port);
    const start = vi.fn(async () => undefined);

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, deps(root, start)).catch((err: unknown) => err as NodeJS.ErrnoException);

    expect((error as NodeJS.ErrnoException).code).toBe(SERVER_ANSWERED);
    expect(live.connections()).toBe(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('a second refusal after the start is an error naming both ports and what was tried', async () => {
    const dead = await freePort();
    const stillDead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => { writeFileSync(portFile(root), `${stillDead}\n`); });

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, deps(root, start)).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(start).toHaveBeenCalledTimes(1); // one start, no loop
    expect((error as Error).message).toContain(`connection refused on port ${dead}`);
    expect((error as Error).message).toContain('bd dolt start');
    expect((error as Error).message).toContain(`port ${stillDead}`);
  });

  it('a zero poll interval still gives up (the wait is bounded whatever the caller passes)', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => undefined);
    const d = deps(root, start);
    let sleeps = 0;
    d.sleep = async () => { sleeps += 1; };

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, d, { pollIntervalMs: 0 }).catch((err: unknown) => err as Error);

    expect((error as Error).message).toContain('still refuses connections');
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleeps).toBeGreaterThan(0);
    expect(sleeps).toBeLessThanOrEqual(201); // 10 s budget at the 50 ms floor
  });

  it('a port file that vanishes after the start is waited for within the restart budget, not forever', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => { rmSync(portFile(root)); }); // the restarted server never writes one
    const d = deps(root, start);
    let slept = 0;
    d.sleep = async (ms: number) => { slept += ms; };

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, d, { pollIntervalMs: 0 })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('never appeared');
    expect(start).toHaveBeenCalledTimes(1);
    expect(slept).toBeGreaterThan(0); // a 0 ms interval still advances the budget (50 ms floor)
    expect(slept).toBeLessThanOrEqual(10_050); // bounded by the 10 s restart budget, not resolveDoltPort's 30 s
  });

  it('a failing `bd dolt start` is reported with the refused port, not swallowed', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => { throw new Error('bd: dolt binary not found'); });

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, deps(root, start)).catch((err: unknown) => err as Error);

    expect((error as Error).message).toContain(`connection refused on port ${dead}`);
    expect((error as Error).message).toContain('bd: dolt binary not found');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('an explicit port is someone else\'s server: a refusal is returned as it is and nothing is started', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => undefined);

    const error = await DoltClient.connect({ beadsRoot: root, port: dead, database: 'scratch', expectedRepoId: 'any' }, deps(root, start))
      .catch((err: unknown) => err as NodeJS.ErrnoException);

    expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(start).not.toHaveBeenCalled();
  });

  it('startServerIfMissing: false also forbids the restart (an external supervisor owns the server)', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    const start = vi.fn(async () => undefined);

    const error = await DoltClient.connect({ beadsRoot: root, expectedRepoId: 'any' }, deps(root, start), { startServerIfMissing: false })
      .catch((err: unknown) => err as NodeJS.ErrnoException);

    expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(start).not.toHaveBeenCalled();
  });

  it('a tracker with no git remote is covered too (its fingerprint comes from the path, so connect still dials)', async () => {
    const dead = await freePort();
    const root = trackerRoot(dead);
    let live: Awaited<ReturnType<typeof listener>> | null = null;
    const start = vi.fn(async () => { live = await listener(); writeFileSync(portFile(root), `${live.port}\n`); });

    const error = await DoltClient.connect({ beadsRoot: root }, deps(root, start)).catch((err: unknown) => err as NodeJS.ErrnoException);

    expect(start).toHaveBeenCalledTimes(1);
    expect(live!.connections()).toBe(1);
    expect((error as NodeJS.ErrnoException).code).toBe(SERVER_ANSWERED);
  });
});
