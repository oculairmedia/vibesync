/**
 * The CLI's helpers: HTTP calls to the service, the molecule event stream, and
 * output formatting. Kept apart from the command definitions in cli.ts so they
 * can be tested in-process; they take the shared options as an argument
 * instead of reading commander's parsed state.
 */
import chalk from 'chalk';

// ── Types ───────────────────────────────────────────────────────────

export interface GlobalOpts {
  apiUrl: string;
  json: boolean;
  timeout: number;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/** The options every command shares, read from commander's parsed --api-url, --json and --timeout. */
export function globalOptsFrom(opts: Record<string, unknown>): GlobalOpts {
  return {
    apiUrl: String(opts.apiUrl || 'http://localhost:3099').replace(/\/+$/, ''),
    json: Boolean(opts.json),
    timeout: Number(opts.timeout) || 5000,
  };
}

export async function fetchJson<T = unknown>(global: GlobalOpts, path: string, options: FetchOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${global.apiUrl}${path}`;
  const { timeoutMs, ...fetchOptions } = options;
  const requestTimeout = Number(timeoutMs) || global.timeout;
  try {
    const res = await fetchWithTimeout(url, fetchOptions, requestTimeout);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text().catch(() => '')) || res.statusText}`);
    return await res.json() as T;
  } catch (err) {
    throw describeFetchError(err, url, requestTimeout);
  }
}

/** fetch, aborted after `ms`. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A timeout and a refused connection get a plain message; anything else is rethrown as is. */
function describeFetchError(err: unknown, url: string, ms: number): unknown {
  if ((err as Error)?.name === 'AbortError') return new Error(`Timeout after ${ms}ms: ${url}`);
  if ((err as { code?: string })?.code === 'ECONNREFUSED') return new Error(`Connection refused: ${url}`);
  return err;
}

export async function probe(global: GlobalOpts, url: string, timeoutMs?: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  const saved = global.timeout;
  const controller = new AbortController();
  const ms = timeoutMs ?? saved;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

export function formatTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_: string, i: number) =>
    Math.max(...all.map((r: (string | number | null | undefined)[]) => String(r[i] ?? '').length)),
  );
  const sep = widths.map((w: number) => '─'.repeat(w + 2)).join('┼');
  const fmt = (row: (string | number | null | undefined)[], color: (s: string) => string): string =>
    row.map((c: string | number | null | undefined, i: number) =>
      ` ${color(String(c ?? '').padEnd(widths[i]!))} `).join('│');

  const lines: string[] = [fmt(headers, chalk.bold as (s: string) => string), sep];
  for (const row of rows) lines.push(fmt(row, (s) => s));
  return lines.join('\n');
}

export function die(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

export function toRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function compactPayload(value: unknown): string {
  const payload = toRecord(value);
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== null);
  return entries.map(([k, v]) => `${k}=${preview(v, 60)}`).join(' ');
}

export async function watchMoleculeEvents(global: GlobalOpts, moleculeId: string): Promise<number> {
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const body = await openEventStream(global, moleculeId, controller);
    return await printEventsUntilDone(body);
  } catch (error) {
    if (interrupted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** GET the molecule's event stream; the timeout covers the response headers only. */
async function openEventStream(global: GlobalOpts, moleculeId: string, controller: AbortController): Promise<AsyncIterable<Uint8Array>> {
  const headersTimer = setTimeout(() => controller.abort(), global.timeout);
  const response = await fetch(`${global.apiUrl}/molecules/${encodeURIComponent(moleculeId)}/events`, { signal: controller.signal });
  clearTimeout(headersTimer);
  if (!response.ok || !response.body) throw new Error(`event stream failed: HTTP ${response.status}`);
  return response.body as unknown as AsyncIterable<Uint8Array>;
}

/**
 * Print each event as it arrives. Exits 0 when the formula completes or the
 * stream ends, 1 when it fails.
 */
async function printEventsUntilDone(body: AsyncIterable<Uint8Array>): Promise<number> {
  let buffer = '';
  let eventType = 'message';
  for await (const chunk of body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const parsed = parseSseFrame(frame, eventType);
      eventType = parsed?.nextEventType ?? 'message';
      const exitCode = parsed?.data ? printEvent(parsed.data, parsed.eventType) : null;
      if (exitCode !== null) return exitCode;
    }
  }
  return 0;
}

/** Complete frames (separated by a blank line) and the unfinished remainder. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  return { frames: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

/** Print one event; return its exit code when it ends the formula (0 completed, 1 failed), else null. */
function printEvent(data: unknown, fallbackKind: string): number | null {
  const event = toRecord(data);
  const kind = String(event.kind ?? fallbackKind);
  const ts = event.ts ? new Date(String(event.ts)).toLocaleTimeString() : new Date().toLocaleTimeString();
  console.log(`${ts} ${kind} ${compactPayload(event.payload)}`.trim());
  if (kind === 'dispatcher/formula.failed') return 1;
  if (kind === 'dispatcher/formula.completed') return 0;
  return null;
}

export function parseSseFrame(frame: string, currentEventType: string): { eventType: string; nextEventType: string; data: unknown } | null {
  let eventType = currentEventType;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return { eventType, nextEventType: eventType, data: null };
  const dataRaw = dataLines.join('\n');
  try {
    return { eventType, nextEventType: eventType, data: JSON.parse(dataRaw) };
  } catch {
    return { eventType, nextEventType: eventType, data: dataRaw };
  }
}
