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

it('uses only the first line of a short multi-line reason', async () => {
  // A short first line: nothing but the first-line rule can drop the second.
  await expect(sendStalls([['first', 'verdict failed closed\nstack trace line'], ['second', 'next']]))
    .resolves.toBe('stalled first: verdict failed closed; second: next');
  expect(stallDetail(new Map([['a', 'one\r\ntwo'], ['b', 'three']]))).toBe('stalled a: one; b: three');
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

/** What a coalesced detail says about each stalled bead. */
function readDetail(detail: string, ids: readonly string[]) {
  const at = detail.indexOf('; +');
  const head = at < 0 ? detail : detail.slice(0, at);
  const shown = head.replace(/^stalled /, '').split('; ').map((entry) => entry.slice(0, entry.indexOf(': ')));
  const tail = at < 0 ? '' : detail.slice(at);
  const more = Number(/^; \+(\d+) more/.exec(tail)?.[1] ?? 0);
  const unnamed = Number(/, \+(\d+) unnamed$/.exec(tail)?.[1] ?? 0);
  const listed = tail.replace(/^; \+\d+ more:? ?/, '').replace(/, \+\d+ unnamed$/, '').replace(/^\(ids not shown\)$/, '');
  const named = listed === '' ? [] : listed.split(', ');
  return { shown, more, named, unnamed, omitted: ids.filter((id) => !shown.includes(id)) };
}

it('names both omitted beads when the shown reasons nearly fill the cap (the case the first version lost)', async () => {
  // Measured on 48f8221: 15 beads with 55-character reasons gave "+2 more: vibesync-9lzk...." naming neither.
  const stalls = Array.from({ length: 15 }, (_, i) => [`vibesync-9lzk.${i + 1}`, 'r'.repeat(55)] as const);
  const detail = (await sendStalls(stalls))!;
  const ids = stalls.map(([id]) => id);
  const read = readDetail(detail, ids);
  expect(detail.length).toBeLessThanOrEqual(1_000);
  expect(read.named).toEqual(read.omitted);
  expect(read.named.length).toBeGreaterThan(0);
  expect(read.unnamed).toBe(0);
  expect(detail.endsWith('...')).toBe(false);
});

it('with too many beads for their ids to fit, names whole ids only and says how many are unnamed', async () => {
  const stalls = Array.from({ length: 100 }, (_, i) => [`vibesync-9lzk.${i + 1}`, 'escalated, needs the PM: verdict unsettled (fail closed)'] as const);
  const detail = (await sendStalls(stalls))!;
  const ids = stalls.map(([id]) => id);
  const read = readDetail(detail, ids);
  expect(detail.length).toBeLessThanOrEqual(1_000);
  expect(read.shown).toEqual([ids[0]]);
  expect(read.more).toBe(99);
  expect(read.named).toEqual(read.omitted.slice(0, read.named.length)); // whole ids, in order
  expect(read.named.length).toBeGreaterThan(30);
  expect(read.named.length + read.unnamed).toBe(99);
  expect(detail.endsWith('...')).toBe(false);
});

it('for every batch size and reason length: within the cap, and every stalled bead is shown, named whole, or counted', () => {
  // A sweep, not one example: the first version passed its single example and lost the ids in 217 of 218 sizes.
  let overflowing = 0;
  for (const reasonLength of [0, 1, 20, 55, 90, 160, 400]) {
    for (let count = 2; count <= 120; count++) {
      const ids = Array.from({ length: count }, (_, i) => `vibesync-9lzk.${i + 1}`);
      const detail = stallDetail(new Map(ids.map((id) => [id, 'r'.repeat(reasonLength)])));
      const read = readDetail(detail, ids);
      const where = `reasonLength=${reasonLength} count=${count}: ${detail.slice(-60)}`;
      expect(detail.length, where).toBeLessThanOrEqual(1_000);
      expect(read.more, where).toBe(read.omitted.length);
      expect(read.named, where).toEqual(read.omitted.slice(0, read.named.length));
      expect(read.named.length + read.unnamed, where).toBe(read.omitted.length);
      expect(read.shown, where).toEqual(ids.slice(0, read.shown.length));
      if (read.omitted.length > 0) {
        overflowing++;
        expect(read.shown.length, where).toBeGreaterThan(0);
        // As many reasons as fit: showing one more entry (and naming one fewer) must not fit.
        if (read.unnamed === 0) {
          const oneMore = read.shown.length + 1;
          const head = `stalled ${ids.slice(0, oneMore).map((id) => `${id}: ${'r'.repeat(Math.min(reasonLength, 160)).slice(0, reasonLength > 160 ? 157 : 160)}${reasonLength > 160 ? '...' : ''}`).join('; ')}`;
          const rest = ids.slice(oneMore);
          const wider = rest.length > 0 ? `${head}; +${rest.length} more: ${rest.join(', ')}` : head;
          expect(wider.length, `${where} (one more entry would have fit)`).toBeGreaterThan(1_000);
        }
        // Ids are dropped only when they cannot all fit beside ONE shown entry.
        if (read.unnamed > 0) expect(read.shown.length, where).toBe(1);
      }
    }
  }
  expect(overflowing).toBeGreaterThan(200);
});

it('stays fast for a very large batch: the work grows with the batch, not with its square (CodeRabbit on #184)', () => {
  // Counts character work instead of timing it, so the test is exact and does not flake:
  // every string the function builds is made by Array.prototype.join or a template over
  // slices, so the total length of all joined pieces bounds its work.
  const batch = (count: number) => new Map(Array.from({ length: count }, (_, i) => [`vibesync-9lzk.${i + 1}`, 'escalated, needs the PM'] as const));
  const joined = (count: number) => {
    const stalls = batch(count);
    const original = Array.prototype.join;
    let pieces = 0;
    Array.prototype.join = function (this: unknown[], ...args: [string?]) { pieces += this.length; return original.apply(this, args); };
    try { stallDetail(stalls); } finally { Array.prototype.join = original; }
    return pieces;
  };
  const small = joined(2_000);
  const large = joined(20_000);
  // 10x the batch must not cost 100x. The version first pushed to #184 joined ~2,000,000 pieces
  // for 2,000 beads; this one joins a few dozen whatever the batch size.
  expect(small).toBeLessThan(2_000);
  expect(large).toBeLessThan(small * 20);
  expect(stallDetail(batch(20_000)).length).toBeLessThanOrEqual(1_000);
});

