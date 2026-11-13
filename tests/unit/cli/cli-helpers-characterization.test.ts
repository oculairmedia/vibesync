/**
 * Characterisation tests for the CLI helpers (vibesync-9lzk.59), written BEFORE
 * refactoring them (watchMoleculeEvents cc 14 and nested 4 deep, fetchJson
 * cc 14). Until the split, the helpers lived inside cli.ts, which exports
 * nothing and parses argv on import, so coverage could not see them: the CLI
 * tests spawn it as a child process. These run in-process against a local
 * HTTP server.
 */
import { once } from 'node:events';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compactPayload, fetchJson, globalOptsFrom, parseSseFrame, preview, probe, toArray, toRecord, watchMoleculeEvents, type GlobalOpts } from '../../../src/app/cli-helpers.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let handler: Handler;
let opts: GlobalOpts;

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(404); res.end(); };
  server = http.createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  opts = { apiUrl: `http://127.0.0.1:${address.port}`, json: false, timeout: 2000 };
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
});

const sse = (frames: string[]): Handler => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const frame of frames) res.write(frame);
  res.end();
};

describe('globalOptsFrom', () => {
  it('strips trailing slashes, defaults the url and the timeout, and reads --json', () => {
    expect(globalOptsFrom({ apiUrl: 'http://h:1///', json: 1, timeout: '250' })).toEqual({ apiUrl: 'http://h:1', json: true, timeout: 250 });
    expect(globalOptsFrom({})).toEqual({ apiUrl: 'http://localhost:3099', json: false, timeout: 5000 });
    expect(globalOptsFrom({ timeout: 'soon' }).timeout).toBe(5000);
  });
});

describe('fetchJson', () => {
  it('joins a relative path to the api url and returns the parsed body', async () => {
    handler = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: req.url })); };
    expect(await fetchJson(opts, '/health')).toEqual({ path: '/health' });
  });

  it('uses an absolute url as is', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('{"ok":true}'); };
    expect(await fetchJson(opts, `${opts.apiUrl}/x`)).toEqual({ ok: true });
  });

  it('an error status throws "HTTP <status> — <body>", or the status text when the body is empty', async () => {
    handler = (_req, res) => { res.writeHead(409); res.end('molecule busy'); };
    await expect(fetchJson(opts, '/m')).rejects.toThrow('HTTP 409 — molecule busy');
    handler = (_req, res) => { res.writeHead(503); res.end(); };
    await expect(fetchJson(opts, '/m')).rejects.toThrow('HTTP 503 — Service Unavailable');
  });

  it('a request slower than the timeout throws "Timeout after <ms>ms: <url>"; a per-call timeoutMs wins over the global one', async () => {
    handler = () => { /* never answers */ };
    await expect(fetchJson({ ...opts, timeout: 60_000 }, '/slow', { timeoutMs: 100 })).rejects.toThrow(`Timeout after 100ms: ${opts.apiUrl}/slow`);
    await expect(fetchJson({ ...opts, timeout: 120 }, '/slow')).rejects.toThrow('Timeout after 120ms');
  });

  it('a refused connection throws "Connection refused: <url>"', async () => {
    const dead = { ...opts, apiUrl: 'http://127.0.0.1:1' };
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(refused);
    await expect(fetchJson(dead, '/health')).rejects.toThrow('Connection refused: http://127.0.0.1:1/health');
  });

  it('any other failure is rethrown unchanged', async () => {
    const odd = new TypeError('something else');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(odd);
    await expect(fetchJson(opts, '/x')).rejects.toBe(odd);
  });
});

describe('probe', () => {
  it('reports ok and the status, and a failure as ok false with its message', async () => {
    handler = (_req, res) => { res.writeHead(204); res.end(); };
    expect(await probe(opts, `${opts.apiUrl}/h`)).toEqual({ ok: true, status: 204 });
    handler = (_req, res) => { res.writeHead(500); res.end(); };
    expect(await probe(opts, `${opts.apiUrl}/h`)).toEqual({ ok: false, status: 500 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('unreachable'));
    expect(await probe(opts, `${opts.apiUrl}/h`)).toEqual({ ok: false, error: 'unreachable' });
  });
});

describe('parseSseFrame', () => {
  it('reads the event type and joins multi-line data, parsing JSON when it can', () => {
    expect(parseSseFrame('event: step\ndata: {"a":1}', 'message')).toEqual({ eventType: 'step', nextEventType: 'step', data: { a: 1 } });
    expect(parseSseFrame('data: line one\ndata: line two', 'message')).toEqual({ eventType: 'message', nextEventType: 'message', data: 'line one\nline two' });
  });

  it('a frame with no data keeps the event type and has null data', () => {
    expect(parseSseFrame('event: ping', 'message')).toEqual({ eventType: 'ping', nextEventType: 'ping', data: null });
    expect(parseSseFrame(': comment only', 'prior')).toEqual({ eventType: 'prior', nextEventType: 'prior', data: null });
  });
});

describe('watchMoleculeEvents', () => {
  it('prints each event and exits 0 on completion, 1 on failure', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    handler = sse([
      'event: dispatcher/step.started\ndata: {"kind":"dispatcher/step.started","ts":"2026-01-01T00:00:00Z","payload":{"stepName":"coder"}}\n\n',
      'data: {"kind":"dispatcher/formula.completed","payload":{}}\n\n',
      'data: {"kind":"after.completion"}\n\n',
    ]);
    expect(await watchMoleculeEvents(opts, 'm-1')).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/dispatcher\/step\.started stepName=coder$/);
    handler = sse(['data: {"kind":"dispatcher/formula.failed"}\n\n']);
    expect(await watchMoleculeEvents(opts, 'm-1')).toBe(1);
  });

  it('a frame split across chunks is reassembled; the event type comes from the event line when the data has no kind', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: custom.kind\nda');
      setTimeout(() => { res.write('ta: {"payload":{"n":1}}\n\n'); res.end(); }, 20);
    };
    expect(await watchMoleculeEvents(opts, 'm-2')).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/custom\.kind n=1$/)]);
  });

  it('the stream ending without a terminal event exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handler = sse(['data: {"kind":"dispatcher/step.started"}\n\n']);
    expect(await watchMoleculeEvents(opts, 'm-3')).toBe(0);
  });

  it('an error status throws "event stream failed: HTTP <status>"; the molecule id is url-encoded', async () => {
    let path = '';
    handler = (req, res) => { path = req.url ?? ''; res.writeHead(404); res.end(); };
    await expect(watchMoleculeEvents(opts, 'a b/c')).rejects.toThrow('event stream failed: HTTP 404');
    expect(path).toBe('/molecules/a%20b%2Fc/events');
  });

  it('Ctrl-C while waiting exits 130', async () => {
    handler = () => { /* never answers */ };
    const watching = watchMoleculeEvents({ ...opts, timeout: 60_000 }, 'm-4');
    setTimeout(() => process.emit('SIGINT'), 50);
    expect(await watching).toBe(130);
  });
});

describe('small formatters', () => {
  it('toRecord, toArray, preview and compactPayload', () => {
    expect(toRecord([1])).toEqual({});
    expect(toRecord(null)).toEqual({});
    expect(toArray('x')).toEqual([]);
    expect(preview('abcdef', 4)).toBe('abc…');
    expect(preview({ a: 1 })).toBe('{"a":1}');
    expect(compactPayload({ a: 1, b: null, c: undefined, d: 'x' })).toBe('a=1 d=x');
  });
});
