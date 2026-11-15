import { expect, it, vi } from 'vitest';
import { PmWaker, stallDetail } from '../../../../src/engine/pm-wake/waker.js';
import type { PmWakeInput } from '../../../../src/engine/pm-wake/contract.js';

function harness() {
  const sent: PmWakeInput[] = [];
  const waker = new PmWaker({
    projectIdentifier: 'project',
    lookupAgentId: () => 'pm',
    sink: { wake: async input => { sent.push(input); return { ok: true }; } },
    store: {
      load: () => ({ firstSeenAt: new Date(0).toISOString(), lastWokenAt: null, lastByReason: {} }),
      save: vi.fn(),
    },
    backlog: () => null,
    emit: () => {},
    minIntervalMs: 0,
    backstopMs: 1_000_000,
    now: () => 10_000,
  });
  return { waker, sent };
}

async function sendStalls(stalls: ReadonlyArray<readonly [string, string]>) {
  const { waker, sent } = harness();
  for (const [id, reason] of stalls) waker.noteStall(id, reason);
  waker.onTick({ result: { scheduler: { dispatched: [] } } });
  await waker.idle();
  waker.dispose();
  return sent[0]?.detail;
}

it('keeps each coalesced stall paired with its own reason', async () => {
  await expect(sendStalls([
    ['bead-escalated', 'escalated, needs the PM: verdict failed closed'],
    ['other-bead', 'run deadline exceeded'],
  ])).resolves.toBe('stalled bead-escalated: escalated, needs the PM: verdict failed closed; other-bead: run deadline exceeded');
});

it('keeps the single-stall detail format unchanged', async () => {
  await expect(sendStalls([['one-bead', 'run deadline exceeded']]))
    .resolves.toBe('stalled one-bead: run deadline exceeded');
});

it('preserves a single stall reason exactly, including multiple lines and long text', () => {
  const multiline = new Map([['one-bead', 'first line\nsecond line']]);
  const long = new Map([['one-bead', 'x'.repeat(161)]]);
  expect(stallDetail(multiline)).toBe('stalled one-bead: first line\nsecond line');
  expect(stallDetail(long)).toBe(`stalled one-bead: ${'x'.repeat(161)}`);
});

it('uses the first reason line and truncates long reasons', async () => {
  const reason = `${'x'.repeat(161)}\nignored second line`;
  await expect(sendStalls([['first', reason], ['second', 'next']]))
    .resolves.toBe(`stalled first: ${'x'.repeat(157)}...; second: next`);
});

it('caps stall details and names every omitted bead', async () => {
  const stalls = Array.from({ length: 12 }, (_, i) => [`bead-${String(i).padStart(2, '0')}`, 'r'.repeat(160)] as const);
  const detail = await sendStalls(stalls);
  expect(detail).toContain('; +');
  expect(detail!.length).toBeLessThanOrEqual(1_000);
  const omitted = detail!.match(/; \+\d+ more: (.+)$/)?.[1]?.split(', ') ?? [];
  expect(omitted.length).toBeGreaterThan(0);
  const included = detail!.slice(0, detail!.indexOf('; +'));
  expect(omitted).toEqual(stalls.filter(([id]) => !included.includes(`${id}: `)).map(([id]) => id));
  for (const [id] of stalls) expect(detail).toContain(id);
  expect(detail!.slice(0, detail!.indexOf('; +')).length).toBeLessThanOrEqual(1_000);
});

it('strictly bounds output to 1000 characters even with a very large batch of omitted beads', async () => {
  const stalls = Array.from({ length: 100 }, (_, i) => [`bead-${String(i).padStart(3, '0')}`, 'r'.repeat(160)] as const);
  const detail = await sendStalls(stalls);
  expect(detail!.length).toBeLessThanOrEqual(1_000);
  expect(detail).toContain('; +');
});
