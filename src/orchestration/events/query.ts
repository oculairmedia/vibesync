import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Event } from './bus.js';

export interface EventLogWarning {
  readonly line: number;
  readonly message: string;
}

export interface EventLogQuery {
  readonly after?: string | null;
  readonly limit?: number;
  readonly moleculeId?: string | null;
  readonly layer?: Event['layer'] | null;
  readonly kind?: string | null;
}

export interface EventLogPage {
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly total_known: number;
}

export interface EventLogQueryResult {
  readonly items: Event[];
  readonly page: EventLogPage;
  readonly warnings: EventLogWarning[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function defaultEventLogPath(root = process.cwd()): string {
  return join(root, '.beads', 'events.jsonl');
}

export function queryEventLog(logPath: string, query: EventLogQuery = {}): EventLogQueryResult {
  const startLine = parseCursor(query.after);
  const limit = normalizeLimit(query.limit);
  const warnings: EventLogWarning[] = [];
  const items: Event[] = [];

  if (!existsSync(logPath)) {
    return {
      items: [],
      page: { next_cursor: null, has_more: false, total_known: 0 },
      warnings,
    };
  }

  const raw = readFileSync(logPath, 'utf8');
  const lines = raw.length === 0 ? [] : raw.split('\n');
  let scannedLine = startLine;
  let hasMore = false;

  for (let index = startLine; index < lines.length; index++) {
    scannedLine = index + 1;
    const line = lines[index];
    if (!line || line.trim().length === 0) continue;
    const parsed = parseEventLine(line, index + 1, warnings);
    if (!parsed) continue;
    if (!matchesEvent(parsed, query)) continue;
    if (items.length >= limit) {
      hasMore = true;
      scannedLine = index;
      break;
    }
    items.push(parsed);
  }

  const nextCursor = hasMore ? String(scannedLine) : null;
  return {
    items,
    page: {
      next_cursor: nextCursor,
      has_more: hasMore,
      total_known: lines.filter((line) => line.trim().length > 0).length,
    },
    warnings,
  };
}

function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function parseEventLine(line: string, lineNumber: number, warnings: EventLogWarning[]): Event | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isEvent(parsed)) return parsed;
    warnings.push({ line: lineNumber, message: 'Malformed event object skipped' });
    return null;
  } catch {
    warnings.push({ line: lineNumber, message: 'Malformed JSON line skipped' });
    return null;
  }
}

function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.ts === 'string' &&
    typeof record.layer === 'string' &&
    typeof record.kind === 'string'
  );
}

function matchesEvent(event: Event, query: EventLogQuery): boolean {
  if (query.moleculeId && event.molecule_id !== query.moleculeId) return false;
  if (query.layer && event.layer !== query.layer) return false;
  if (query.kind && !event.kind.startsWith(query.kind)) return false;
  return true;
}
