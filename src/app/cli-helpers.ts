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
  const { apiUrl, timeout } = global;
  const url = path.startsWith('http') ? path : `${apiUrl}${path}`;
  const { timeoutMs, ...fetchOptions } = options;
  const requestTimeout = Number(timeoutMs) || timeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${body || res.statusText}`);
    }
    return await res.json() as T;
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError')
      throw new Error(`Timeout after ${requestTimeout}ms: ${url}`);
    if ((err as { code?: string })?.code === 'ECONNREFUSED')
      throw new Error(`Connection refused: ${url}`);
    throw err;
  }
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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
  const { apiUrl, timeout } = global;
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const headersTimer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(`${apiUrl}/molecules/${encodeURIComponent(moleculeId)}/events`, { signal: controller.signal });
    clearTimeout(headersTimer);
    if (!response.ok || !response.body) throw new Error(`event stream failed: HTTP ${response.status}`);
    const body = response.body;
    let buffer = '';
    let eventType = 'message';
    let exitCode = 0;
    for await (const chunk of body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame, eventType);
        eventType = 'message';
        if (parsed) {
          eventType = parsed.nextEventType;
          if (parsed.data) {
            const event = toRecord(parsed.data);
            const kind = String(event.kind ?? parsed.eventType);
            const ts = event.ts ? new Date(String(event.ts)).toLocaleTimeString() : new Date().toLocaleTimeString();
            console.log(`${ts} ${kind} ${compactPayload(event.payload)}`.trim());
            if (kind === 'dispatcher/formula.failed') exitCode = 1;
            if (kind === 'dispatcher/formula.completed' || kind === 'dispatcher/formula.failed') return exitCode;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    return exitCode;
  } catch (error) {
    if (interrupted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
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
