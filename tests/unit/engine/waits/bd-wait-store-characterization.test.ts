/**
 * Characterisation tests for the durable-wait store (vibesync-9lzk.59), written
 * BEFORE refactoring its record parser (toRecord, cc 19). The real-bd waits
 * suite covers the happy paths; these pin the branches it never takes: a
 * malformed or foreign wait row, the defaults, invalid ids, and an output that
 * is not a JSON array. bd is faked: each call returns the canned JSON.
 */
import { describe, expect, it } from 'vitest';

import { BdWaitStore, assertBeadId } from '../../../../src/engine/waits/bd-wait-store.js';

const good = (over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) => ({
  id: 'w-1',
  status: 'open',
  metadata: { on: ['b-1'], mode: 'any', state: 'pending', waiter: { kind: 'step', id: 's-1' }, ...metaOver },
  ...over,
});

const storeReturning = (rows: unknown) => new BdWaitStore(async () => JSON.stringify(rows));

describe('reading wait records', () => {
  it.each([
    ['no id', good({ id: '' })],
    ['no metadata', good({ metadata: null })],
    ['an empty on list', good({}, { on: [] })],
    ['an on list with a non-string', good({}, { on: ['b-1', 7] })],
    ['on that is not a list', good({}, { on: 'b-1' })],
    ['an unknown mode', good({}, { mode: 'some' })],
    ['an unknown state', good({}, { state: 'sleeping' })],
    ['a non-string state', good({}, { state: 3 })],
    ['no waiter', good({}, { waiter: undefined })],
    ['a waiter without a kind', good({}, { waiter: { id: 's-1' } })],
    ['a waiter without an id', good({}, { waiter: { kind: 'step' } })],
  ])('a row with %s is not a wait (and does not break the sweep)', async (_case, row) => {
    expect(await storeReturning([row, good({ id: 'w-ok' })]).listActive()).toEqual([expect.objectContaining({ id: 'w-ok' })]);
  });

  it('accepts every wait state', async () => {
    for (const state of ['pending', 'ready', 'closed', 'canceled', 'expired', 'failed']) {
      expect((await storeReturning([good({}, { state })]).listActive())[0]?.state).toBe(state);
    }
  });

  it('defaults: no wakeAttempts counts as 0, a non-number too; createdAt, expiresAt, note and reason are optional; the bead status is read', async () => {
    const [plain] = await storeReturning([good()]).listActive();
    expect(plain).toMatchObject({ wakeAttempts: 0, beadStatus: 'open' });
    expect(plain!.createdAt).toBeUndefined();
    expect(plain!.expiresAt).toBeUndefined();
    expect(plain!.note).toBeUndefined();
    expect(plain!.reason).toBeUndefined();
    const [junk] = await storeReturning([good({}, { wakeAttempts: 'many' })]).listActive();
    expect(junk!.wakeAttempts).toBe(0);
    const [full] = await storeReturning([good({ status: 'in_progress' }, { wakeAttempts: 2, createdAt: 'c', expiresAt: 'e', note: 'n', reason: 'r' })]).listActive();
    expect(full).toMatchObject({ wakeAttempts: 2, createdAt: 'c', expiresAt: 'e', note: 'n', reason: 'r', beadStatus: 'in_progress' });
  });

  it('a row without a status reads as an empty bead status', async () => {
    const [w] = await storeReturning([good({ status: undefined })]).listActive();
    expect(w!.beadStatus).toBe('');
  });

  it('get returns null for an unknown id and for a malformed row', async () => {
    expect(await storeReturning([]).get('w-1')).toBeNull();
    expect(await storeReturning([good({}, { mode: 'some' })]).get('w-1')).toBeNull();
  });

  it('rejects output that is not a JSON array', async () => {
    await expect(storeReturning({ not: 'an array' }).listActive()).rejects.toThrow(/expected a JSON array/);
  });
});

describe('ids and bead statuses', () => {
  it('rejects an invalid bead id before calling bd', async () => {
    let called = false;
    const store = new BdWaitStore(async () => { called = true; return '[]'; });
    await expect(store.get('bad id; rm')).rejects.toThrow(/is not a valid bead id/);
    expect(called).toBe(false);
    expect(() => assertBeadId('-leading-dash', 'target')).toThrow(/target: "-leading-dash" is not a valid bead id/);
  });

  it('beadStatuses: no ids makes no bd call; rows without an id are skipped; a missing status is empty', async () => {
    let calls = 0;
    const store = new BdWaitStore(async () => { calls += 1; return JSON.stringify([{ id: 'b-1', status: 'closed' }, { status: 'open' }, { id: 'b-2' }]); });
    expect(await store.beadStatuses([])).toEqual(new Map());
    expect(calls).toBe(0);
    expect(await store.beadStatuses(['b-1', 'b-2'])).toEqual(new Map([['b-1', 'closed'], ['b-2', '']]));
  });

  it('create rejects an id bd returns that is not a bead id', async () => {
    const store = new BdWaitStore(async () => 'Error: something went wrong\n');
    await expect(store.create({ mode: 'any', on: ['b-1'], waiter: { kind: 'step', id: 's-1' } } as never, { createdAt: 'c', expiresAt: undefined })).rejects.toThrow(/unexpected wait id/);
  });
});
