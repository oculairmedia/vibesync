import { describe, expect, it } from 'vitest';

import { evaluateWait, readyReason, type EvaluableWait } from '../../../../src/orchestration/waits/index.js';

const wait = (over: Partial<EvaluableWait> = {}): EvaluableWait => ({
  id: 'w1', mode: 'all', on: ['a', 'b'], note: undefined, expiresAt: undefined, ...over,
});
const st = (o: Record<string, string>) => new Map(Object.entries(o));
const NOW = Date.parse('2026-11-02T12:00:00Z');

describe('evaluateWait (vibesync-9g24, pure)', () => {
  it('all: pending until every named bead is closed', () => {
    expect(evaluateWait(wait(), st({ a: 'closed', b: 'open' }), NOW).kind).toBe('pending');
    expect(evaluateWait(wait(), st({ a: 'open', b: 'in_progress' }), NOW).kind).toBe('pending');
    expect(evaluateWait(wait(), st({ a: 'closed', b: 'closed' }), NOW).kind).toBe('ready');
  });

  it('any: ready on the first closed bead', () => {
    expect(evaluateWait(wait({ mode: 'any' }), st({ a: 'open', b: 'open' }), NOW).kind).toBe('pending');
    expect(evaluateWait(wait({ mode: 'any' }), st({ a: 'open', b: 'closed' }), NOW).kind).toBe('ready');
  });

  it('only "closed" counts: blocked/deferred/in_progress do not satisfy a wait', () => {
    for (const s of ['blocked', 'deferred', 'in_progress', 'open', 'pinned']) {
      expect(evaluateWait(wait({ mode: 'any' }), st({ a: s, b: s }), NOW).kind).toBe('pending');
    }
  });

  it('the note is the ready reason verbatim; without one the reason names the wait', () => {
    expect(evaluateWait(wait({ note: 'resume the loop' }), st({ a: 'closed', b: 'closed' }), NOW))
      .toEqual({ kind: 'ready', reason: 'resume the loop' });
    expect(readyReason(wait())).toContain('w1');
  });

  it('a vanished bead can never close: all -> failed; any -> failed only when none can still close', () => {
    expect(evaluateWait(wait(), st({ a: 'closed' }), NOW).kind).toBe('failed');
    expect(evaluateWait(wait({ mode: 'any' }), st({ a: 'open' }), NOW).kind).toBe('pending');
    expect(evaluateWait(wait({ mode: 'any' }), st({}), NOW).kind).toBe('failed');
    expect(evaluateWait(wait({ mode: 'any' }), st({ b: 'closed' }), NOW).kind).toBe('ready');
  });

  it('deadline: expires only while unsatisfied; satisfied beats expired; time alone is never ready', () => {
    const exp = { expiresAt: '2026-11-02T11:00:00Z' };
    expect(evaluateWait(wait(exp), st({ a: 'open', b: 'open' }), NOW).kind).toBe('expired');
    expect(evaluateWait(wait(exp), st({ a: 'closed', b: 'closed' }), NOW).kind).toBe('ready');
    expect(evaluateWait(wait({ expiresAt: '2026-11-02T13:00:00Z' }), st({ a: 'open', b: 'open' }), NOW).kind).toBe('pending');
    expect(evaluateWait(wait({ expiresAt: 'not-a-date' }), st({ a: 'open', b: 'open' }), NOW).kind).toBe('pending');
  });
});
