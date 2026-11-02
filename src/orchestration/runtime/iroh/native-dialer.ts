/**
 * Native (@number0/iroh) adapter: the only file that touches the library.
 * Everything else works against the IrohLink/DuplexLike seam so it can be
 * tested without a network.
 *
 * Library quirks (iroh 1.2.0 index.d.ts, proven live): connect() takes the
 * ALPN as number[] (not Buffer); builder methods mutate and return void;
 * BiStream.send/.recv are GETTERS; RecvStream.read(limit) -> number[] (empty
 * at end); SendStream.writeAll(number[]).
 *
 * The secret key is read from a 0600 file and handed to the library; it is
 * never logged and never appears in an error message.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

import { FRAME_PART_CAPABILITY } from './frame-codec.js';
import { IrohConfigError, IrohConnection } from './connection.js';
import type { DuplexLike, IrohConnectionOptions, IrohLink } from './connection.js';

export const IROH_ALPN = '/letta/appserver/0';
export const DEFAULT_IROH_SECRET_KEY_PATH = '/root/.letta/vibesync/iroh-secret.key';
export const DEFAULT_IROH_PEER_NAME = 'vibesync-orchestrator';
export const DEFAULT_IROH_ADDRESSES_KV = '/root/.letta/iroh/agent-addresses.kv';

export interface IrohHostAddress {
  /** 64-hex node (endpoint) id of the wrapper. */
  readonly nodeId: string;
  /** ip:port candidates, preferred first. */
  readonly addrs: readonly string[];
}

/**
 * Parse `<nodehex>@<addr>,<addr>…` (the value half of a `host:<prefix>=…` kv
 * row, or VIBESYNC_IROH_HOST_ADDR). Loopback is preferred: the wrapper runs on
 * this machine, and the kv row lists LAN/docker addresses only.
 */
export function parseHostAddress(raw: string): IrohHostAddress {
  const value = raw.trim();
  const m = /^([0-9a-fA-F]{64})@(.+)$/.exec(value);
  if (!m) throw new IrohConfigError('iroh host address must look like <64-hex-node-id>@<ip:port>[,<ip:port>...]');
  const addrs = m[2]!.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
  if (addrs.length === 0) throw new IrohConfigError('iroh host address lists no ip:port candidates');
  const port = /:(\d+)$/.exec(addrs[0]!)?.[1];
  const loopback = port ? `127.0.0.1:${port}` : null;
  const ordered = loopback && !addrs.includes(loopback) ? [loopback, ...addrs] : [...addrs];
  return { nodeId: m[1]!.toLowerCase(), addrs: ordered };
}

/** Read the `host:` row of the wrapper's address kv. */
export function readHostFromKv(path = DEFAULT_IROH_ADDRESSES_KV): IrohHostAddress {
  if (!existsSync(path)) throw new IrohConfigError(`iroh address file not found: ${path} (set VIBESYNC_IROH_HOST_ADDR)`);
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^host:[^=]*=(.+)$/.exec(line.trim());
    if (m) return parseHostAddress(m[1]!);
  }
  throw new IrohConfigError(`no host: row in ${path} (set VIBESYNC_IROH_HOST_ADDR)`);
}

export function readSecretKey(path: string): number[] {
  if (!existsSync(path)) {
    throw new IrohConfigError(`iroh secret key file not found: ${path} (pair this device first; set VIBESYNC_IROH_SECRET_KEY_PATH)`);
  }
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) throw new IrohConfigError(`iroh secret key file ${path} must not be group/world accessible (chmod 600)`);
  const bytes = readFileSync(path);
  if (bytes.length !== 32) throw new IrohConfigError(`iroh secret key file ${path} must be exactly 32 raw bytes`);
  return Array.from(bytes);
}

export interface NativeIrohConfig {
  readonly hostAddr?: string | undefined;
  readonly secretKeyPath?: string | undefined;
  readonly peerName?: string | undefined;
  readonly addressesKvPath?: string | undefined;
}

export function resolveNativeIrohConfig(env: NodeJS.ProcessEnv = process.env): NativeIrohConfig {
  const pick = (k: string): string | undefined => (env[k] && env[k]!.length > 0 ? env[k] : undefined);
  return {
    hostAddr: pick('VIBESYNC_IROH_HOST_ADDR'),
    secretKeyPath: pick('VIBESYNC_IROH_SECRET_KEY_PATH'),
    peerName: pick('VIBESYNC_IROH_PEER_NAME'),
  };
}

type NativeStream = {
  send: { writeAll(b: number[]): Promise<void>; finish(): Promise<void> };
  recv: { read(limit: number): Promise<number[] | null> };
};
type NativeConn = { openBi(): Promise<NativeStream>; close(code: bigint, reason: number[]): void };
type NativeEndpoint = { connect(addr: unknown, alpn: number[]): Promise<NativeConn>; close(): Promise<void> };

function duplex(s: NativeStream): DuplexLike {
  return {
    write: (bytes) => s.send.writeAll(Array.from(bytes)),
    read: async (limit) => {
      const chunk = await s.recv.read(limit);
      return chunk == null || chunk.length === 0 ? null : Uint8Array.from(chunk);
    },
    finish: () => s.send.finish(),
  };
}

/**
 * Build an IrohConnection that dials the wrapper with the persistent paired
 * key. The native module is imported lazily so nothing loads (or binds a
 * socket) unless this provider kind is actually selected.
 */
export function createNativeIrohConnection(
  cfg: NativeIrohConfig = {},
  extra: Partial<IrohConnectionOptions> = {},
): IrohConnection {
  const host = cfg.hostAddr ? parseHostAddress(cfg.hostAddr) : readHostFromKv(cfg.addressesKvPath);
  const keyPath = cfg.secretKeyPath ?? DEFAULT_IROH_SECRET_KEY_PATH;
  const alpn = Array.from(new TextEncoder().encode(IROH_ALPN));
  let endpointP: Promise<NativeEndpoint> | null = null;

  const endpoint = (): Promise<NativeEndpoint> => {
    endpointP ??= (async () => {
      const key = readSecretKey(keyPath); // validated before any socket is bound
      const lib = (await import('@number0/iroh')) as unknown as {
        Endpoint: { builder(): { applyN0DisableRelay(): void; secretKey(b: number[]): void; bind(): Promise<NativeEndpoint> } };
      };
      const b = lib.Endpoint.builder();
      b.applyN0DisableRelay();
      b.secretKey(key);
      return b.bind();
    })();
    return endpointP;
  };

  const dial = async (): Promise<IrohLink> => {
    const ep = await endpoint();
    const lib = (await import('@number0/iroh')) as unknown as {
      EndpointAddr: new (id: unknown, relay: null, addrs: string[]) => unknown;
      EndpointId: { fromString(hex: string): unknown };
    };
    const addr = new lib.EndpointAddr(lib.EndpointId.fromString(host.nodeId), null, [...host.addrs]);
    const conn = await ep.connect(addr, alpn);
    // Order matters: control first, then stream.
    const control = await conn.openBi();
    const stream = await conn.openBi();
    return {
      control: duplex(control),
      stream: duplex(stream),
      close: async () => {
        try {
          conn.close(0n, []);
        } catch {
          /* already closed */
        }
      },
    };
  };

  return new IrohConnection({
    dial,
    peerName: cfg.peerName ?? DEFAULT_IROH_PEER_NAME,
    token: '', // paired key: reconnect auth succeeds with an empty token
    capabilities: [FRAME_PART_CAPABILITY],
    dispose: async () => {
      if (endpointP) await (await endpointP).close();
    },
    ...extra,
  });
}
