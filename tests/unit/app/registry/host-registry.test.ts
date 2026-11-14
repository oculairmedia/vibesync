/**
 * The host registry reader against letta-mobile's project-registry-v1 contract
 * fixtures (copied verbatim into tests/fixtures/project-registry-v1 from
 * letta-mobile f52f8be37). The fake RPC answers each request with the fixture
 * case whose params match, and refuses the way the real Iroh connection does
 * (refusalFrom: "admin_rpc <method> refused: <code>").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HostRegistryReader, isRunnable, parseRecord, primaryCheckout, RegistryError, type RegistryRpc } from '../../../../src/app/registry/host-registry.js';
import { refusalFrom } from '../../../../src/engine/runtime/iroh/connection.js';

const DIR = join(process.cwd(), 'tests', 'fixtures', 'project-registry-v1');
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Record<string, unknown>;

type Case = { name: string; params: Record<string, unknown>; result?: unknown; error?: { error: string } };
const cases = (file: string): Case[] => fixture(file)['cases'] as Case[];
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** An RPC that answers from fixture cases, recording each call. */
function fixtureRpc(byMethod: Record<string, Case[]>, calls: { method: string; params: Record<string, unknown> }[] = []): RegistryRpc {
  return async (method, params) => {
    calls.push({ method, params });
    const match = (byMethod[method] ?? []).find((c) => same(c.params, params));
    if (!match) throw new Error(`no fixture case for ${method} ${JSON.stringify(params)}`);
    if (match.error) throw refusalFrom(`admin_rpc ${method}`, match.error.error);
    return match.result;
  };
}

const list = cases('project.registry.list.json');
const get = cases('project.registry.get.json');
const caseNamed = (name: string) => list.find((c) => c.name === name)!;

describe('records (contract §2, §6)', () => {
  it('parses an active record with two checkouts and three role agents; it is runnable in its primary checkout', () => {
    const record = parseRecord(fixture('record-active.json'));
    expect(record).toMatchObject({ key: 'fixture-project', state: 'active', providerKind: 'letta-code-iroh', repositorySlug: 'example-owner/fixture-project' });
    expect(Object.keys(record.roleAgents).sort()).toEqual(['coder', 'reviewer', 'tester']);
    expect(record.engine).toMatchObject({ enabled: true, formula: 'implement-fix', poolSize: 1 });
    expect(record.engine.ciChecks.length).toBeGreaterThan(0);
    expect(primaryCheckout(record)?.primary).toBe(true);
    expect(isRunnable(record)).toBe(true);
  });

  it.each(['record-unconfirmed.json', 'record-invalid.json', 'record-key-conflict.json'])('%s is not runnable (X3)', (file) => {
    expect(isRunnable(parseRecord(fixture(file)))).toBe(false);
  });

  it('an unconfirmed record has no key (K5); an invalid record keeps its reason', () => {
    expect(parseRecord(fixture('record-unconfirmed.json')).key).toBeUndefined();
    expect(parseRecord(fixture('record-invalid.json'))).toMatchObject({ state: 'invalid', invalidReason: 'field_out_of_range', key: 'broken-file' });
  });

  it('an unknown state is kept as unknown and is not runnable; unknown fields are ignored (X4)', () => {
    const record = parseRecord({ ...fixture('record-active.json'), state: 'quarantined', somethingNew: { a: 1 } });
    expect(record.state).toBe('unknown');
    expect(isRunnable(record)).toBe(false);
    expect(record).not.toHaveProperty('somethingNew');
  });

  it('an active record with engine.enabled false, or with no primary checkout, is not runnable', () => {
    const active = fixture('record-active.json');
    expect(isRunnable(parseRecord({ ...active, engine: { ...(active['engine'] as object), enabled: false } }))).toBe(false);
    const noPrimary = parseRecord({ ...active, checkouts: (active['checkouts'] as object[]).map((c) => ({ ...c, primary: false })) });
    expect(primaryCheckout(noPrimary)).toBeNull();
    expect(isRunnable(noPrimary)).toBe(false);
  });

  it('role agents whose id is not a string are dropped', () => {
    const record = parseRecord({ ...fixture('record-active.json'), roleAgents: { coder: 'agent-c', reviewer: 42, tester: null } });
    expect(record.roleAgents).toEqual({ coder: 'agent-c' });
  });

  it('a record missing a required field is refused as malformed', () => {
    const noRevision = fixture('record-active.json');
    delete noRevision['revision'];
    expect(() => parseRecord(noRevision)).toThrow(RegistryError);
  });
});

describe('snapshot: listing every record (contract §3, §5)', () => {
  it('walks the pages with the cursor and keeps the first page\'s revision', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const reader = new HostRegistryReader(fixtureRpc({ 'project.registry.list': list }, calls), 2);
    const snap = await reader.snapshot();
    expect(snap.revision).toBe('r-000041');
    expect(snap.records.map((r) => r.state)).toEqual([
      ...(caseNamed('first_page').result as { items: { state: string }[] }).items.map((i) => i.state),
      'invalid',
    ]);
    expect(calls.map((c) => c.params)).toEqual([{ limit: 2 }, { limit: 2, cursor: 'c-r000041-2' }]);
  });

  it('asks with ifRevision afterwards and reuses what it holds when the host answers notModified (P2)', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const reader = new HostRegistryReader(fixtureRpc({ 'project.registry.list': list }, calls), 2);
    const first = await reader.snapshot();
    const second = await reader.snapshot();
    expect(second).toBe(first);
    expect(calls.at(-1)!.params).toEqual({ ifRevision: 'r-000041' });
  });

  it('an empty registry is an empty snapshot', async () => {
    const reader = new HostRegistryReader(fixtureRpc({ 'project.registry.list': [{ ...caseNamed('empty_registry'), params: { limit: 100 } }] }));
    expect((await reader.snapshot()).records).toEqual([]);
  });

  it('a cursor gone stale mid-walk starts the walk again (L2), and gives up after three tries', async () => {
    let firstPages = 0;
    const page1 = caseNamed('first_page').result;
    const stalingRpc: RegistryRpc = async (_method, params) => {
      if (!('cursor' in params)) { firstPages += 1; return page1; }
      if (firstPages < 2) throw refusalFrom('admin_rpc project.registry.list', 'cursor_stale');
      return caseNamed('next_page').result;
    };
    const snap = await new HostRegistryReader(stalingRpc, 2).snapshot();
    expect(firstPages).toBe(2);
    expect(snap.records).toHaveLength(3);

    let walks = 0;
    const alwaysStale: RegistryRpc = async (_m, params) => {
      if (!('cursor' in params)) { walks += 1; return page1; }
      throw refusalFrom('admin_rpc project.registry.list', 'cursor_stale');
    };
    await expect(new HostRegistryReader(alwaysStale, 2).snapshot()).rejects.toMatchObject({ code: 'cursor_stale' });
    expect(walks).toBe(3);
  });

  it('any other refusal surfaces as a RegistryError with its code', async () => {
    const refusing: RegistryRpc = async () => { throw refusalFrom('admin_rpc project.registry.list', 'invalid_request'); };
    await expect(new HostRegistryReader(refusing).snapshot()).rejects.toMatchObject({ name: 'RegistryError', code: 'invalid_request' });
  });

  it('a host without the method, or a peer without projects.read, is an error, not an empty registry', async () => {
    const noMethod: RegistryRpc = async () => { throw refusalFrom('admin_rpc project.registry.list', 'method not found: project.registry.list'); };
    await expect(new HostRegistryReader(noMethod).snapshot()).rejects.toThrow(/method not found/);
  });
});

describe('get: one record by key or projectId (contract §3)', () => {
  const reader = () => new HostRegistryReader(fixtureRpc({ 'project.registry.get': get }));

  it('finds the same record by projectId and by key', async () => {
    const byId = await reader().get({ projectId: '3f6c1e52-8a4d-4c0b-9e7a-1b2c3d4e5f60' });
    const byKey = await reader().get({ key: 'fixture-project' });
    expect(byId).toEqual(byKey);
    expect(byId?.key).toBe('fixture-project');
  });

  it('an unknown project is null, by id or by key', async () => {
    expect(await reader().get({ projectId: '00000000-0000-4000-8000-000000000000' })).toBeNull();
    expect(await reader().get({ key: 'no-such-project' })).toBeNull();
  });

  it('a key outside the grammar is refused before the host is asked (K2: no case folding)', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    await expect(new HostRegistryReader(fixtureRpc({ 'project.registry.get': get }, calls)).get({ key: 'Fixture-Project' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  it('a malformed id is refused by the host as invalid_request', async () => {
    await expect(reader().get({ projectId: 'Fixture Project' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
