import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus, type Event } from '../../../../src/orchestration/events/index.js';

describe('EventBus', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'evbus-'));
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('emit returns an event with id and ts', () => {
    const bus = new EventBus({ beadsRoot: tmpRoot });
    const ev = bus.emit({ layer: 'daemon', kind: 'test.event' });
    expect(ev.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(ev.ts).toString()).not.toBe('Invalid Date');
    expect(ev.layer).toBe('daemon');
    expect(ev.kind).toBe('test.event');
  });

  it('persists each event as a JSON line in .beads/events.jsonl', () => {
    const bus = new EventBus({ beadsRoot: tmpRoot });
    bus.emit({ layer: 'daemon', kind: 'a' });
    bus.emit({ layer: 'molecule', kind: 'b', molecule_id: 'mol-1' });
    const log = readFileSync(join(tmpRoot, '.beads', 'events.jsonl'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l) as Event);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.kind).toBe('a');
    expect(lines[1]!.kind).toBe('b');
    expect(lines[1]!.molecule_id).toBe('mol-1');
  });

  it('notifies subscribers synchronously in registration order', () => {
    const bus = new EventBus({ noPersist: true });
    const received: string[] = [];
    bus.subscribe((ev) => received.push(`A:${ev.kind}`));
    bus.subscribe((ev) => received.push(`B:${ev.kind}`));
    bus.emit({ layer: 'daemon', kind: 'first' });
    bus.emit({ layer: 'daemon', kind: 'second' });
    expect(received).toEqual(['A:first', 'B:first', 'A:second', 'B:second']);
  });

  it('unsubscribe removes the subscriber', () => {
    const bus = new EventBus({ noPersist: true });
    let received = 0;
    const off = bus.subscribe(() => received++);
    bus.emit({ layer: 'daemon', kind: 'x' });
    off();
    bus.emit({ layer: 'daemon', kind: 'y' });
    expect(received).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('does not let a throwing subscriber block other subscribers', () => {
    const bus = new EventBus({ noPersist: true });
    let bCalled = 0;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => bCalled++);
    bus.emit({ layer: 'daemon', kind: 'x' });
    expect(bCalled).toBe(1);
  });

  it('honors noPersist for tests', () => {
    const bus = new EventBus({ beadsRoot: tmpRoot, noPersist: true });
    bus.emit({ layer: 'daemon', kind: 'x' });
    expect(existsSync(join(tmpRoot, '.beads', 'events.jsonl'))).toBe(false);
  });
});
