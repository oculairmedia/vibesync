import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { queryEventLog } from '../../../../src/orchestration/events/index.js';
import type { Event } from '../../../../src/orchestration/events/index.js';

describe('queryEventLog', () => {
  it('filters by molecule, layer, and kind prefix with cursor pagination', () => {
    const logPath = writeEvents([
      event({ id: 'e1', layer: 'dispatcher', kind: 'dispatcher/formula.started', molecule_id: 'mol-1' }),
      event({ id: 'e2', layer: 'runtime', kind: 'runtime/session.tool_call', molecule_id: 'mol-1' }),
      event({ id: 'e3', layer: 'runtime', kind: 'runtime/session.message_delta', molecule_id: 'mol-2' }),
      event({ id: 'e4', layer: 'runtime', kind: 'runtime/session.tool_result', molecule_id: 'mol-1' }),
    ]);

    const first = queryEventLog(logPath, { moleculeId: 'mol-1', layer: 'runtime', kind: 'runtime/session.tool', limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(['e2']);
    expect(first.page.has_more).toBe(true);
    expect(first.page.next_cursor).not.toBeNull();

    const second = queryEventLog(logPath, { moleculeId: 'mol-1', layer: 'runtime', kind: 'runtime/session.tool', after: first.page.next_cursor, limit: 1 });
    expect(second.items.map((item) => item.id)).toEqual(['e4']);
    expect(second.page.has_more).toBe(false);
  });

  it('skips malformed lines and returns sanitized warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-events-'));
    const logPath = join(dir, 'events.jsonl');
    writeFileSync(logPath, `${JSON.stringify(event({ id: 'ok' }))}\nnot-json\n${JSON.stringify({ id: 'bad' })}\n`);

    const result = queryEventLog(logPath);

    expect(result.items.map((item) => item.id)).toEqual(['ok']);
    expect(result.warnings).toEqual([
      { line: 2, message: 'Malformed JSON line skipped' },
      { line: 3, message: 'Malformed event object skipped' },
    ]);
  });

  it('returns an empty page for a missing log', () => {
    const result = queryEventLog(join(tmpdir(), 'missing-vibesync-events.jsonl'));

    expect(result.items).toEqual([]);
    expect(result.page).toEqual({ next_cursor: null, has_more: false, total_known: 0 });
    expect(result.warnings).toEqual([]);
  });
});

function writeEvents(events: readonly Event[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vs-events-'));
  const logPath = join(dir, 'events.jsonl');
  writeFileSync(logPath, events.map((item) => JSON.stringify(item)).join('\n'));
  return logPath;
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-id',
    ts: '2026-05-25T00:00:00.000Z',
    layer: 'runtime',
    kind: 'runtime/session.started',
    ...overrides,
  };
}
