import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DoltClient } from '../../../src/orchestration/store/dolt-client.js';
import { computeSchemaFingerprint, WrongBdSchemaError } from '../../../src/orchestration/store/schema-fingerprint.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS, SCHEMA65_FINGERPRINT, FRESH65_FINGERPRINT } from './isolated-beads.js';

/** Exact-shape compatibility: only newly CLI-provisioned temporary databases
 * are exercised, with the production schema gate required before operations.
 * Run with VIBESYNC_TEST_BD=/absolute/path/to/pinned/bd npx vitest run tests/integration/orchestration/dolt-client.test.ts
 */
describe.skipIf(!RUN_ISOLATED_BEADS).each(['fresh', 'live'] as const)('Beads gateway: bd writes, SQL reads (disposable schema65 %s)', (shape) => {
  let store: Awaited<ReturnType<typeof provisionIsolatedBeads>> | undefined;
  beforeAll(async () => { store = await provisionIsolatedBeads(shape); }, 120_000);
  afterAll(async () => { await store?.close(); }, 120_000);

  it('roundtrips production molecule operations and compares the readonly bd view', async () => {
    const { client, bd } = store!;
    // vibesync-9lzk.9: writes go through the bd-backed gateway; reads stay on SQL.
    const writes = store!.store;
    bd('config', 'set', 'types.custom', 'molecule_root,molecule_step,mail');
    const schemas = ['issues', 'dependencies', 'metadata'].map(table => ({
      table, createTableSql: JSON.parse(bd('--readonly', 'sql', `SHOW CREATE TABLE ${table}`, '--json'))[0]['Create Table'],
    }));
    expect(computeSchemaFingerprint(schemas)).toBe(shape === 'live' ? SCHEMA65_FINGERPRINT : FRESH65_FINGERPRINT);
    await client.verifySchema();
    const cliBead = (id: string) => {
      const rows = JSON.parse(bd('--readonly', 'show', id, '--json'));
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    const root = 'schema65-mol-root';
    const first = 'schema65-mol-first';
    const second = 'schema65-mol-second';
    await writes.insertMoleculeRoot({ id: root, formulaName: 'compatibility', title: 'Schema compatibility', metadata: { preserved: true } });
    expect(await client.getBead(root)).toMatchObject({ issue_type: 'molecule_root', status: 'open', metadata: { preserved: true, exec: { formula: 'compatibility' } } });
    expect(cliBead(root)).toMatchObject({ issue_type: 'molecule_root', status: 'open' });
    await writes.insertMoleculeStep({ id: first, parentRootId: root, stepName: 'first', title: 'First', inputPayload: { input: 1 } });
    await writes.insertMoleculeStep({ id: second, parentRootId: root, stepName: 'second', title: 'Second', dependsOnStepIds: [first] });
    expect(await client.getBeadDependencies(second)).toEqual(expect.arrayContaining([
      { issue_id: second, depends_on_id: root, type: 'parent-child' },
      { issue_id: second, depends_on_id: first, type: 'blocks' },
    ]));
    expect(cliBead(second).dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first, dependency_type: 'blocks' }),
      expect.objectContaining({ id: root, dependency_type: 'parent-child' }),
    ]));
    const edgeRows = () => JSON.parse(bd('--readonly', 'sql',
      `SELECT id, type FROM dependencies WHERE issue_id = '${second}' AND depends_on_issue_id = '${first}'`, '--json'));
    const originalEdge = edgeRows();
    expect(originalEdge).toHaveLength(1);
    expect(originalEdge[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    bd('dep', 'remove', second, first);
    bd('dep', 'add', second, first, '--type=blocks');
    expect(edgeRows()).toEqual(originalEdge); // CLI independently derives the same ID.
    bd('dep', 'add', second, first, '--type=blocks');
    expect(edgeRows()).toEqual(originalEdge); // No duplicate logical edge.
    await expect(writes.insertMoleculeStep({ id: 'schema65-duplicate', parentRootId: root,
      stepName: 'duplicate', title: 'Duplicate', dependsOnStepIds: [first, first] })).rejects.toThrow();
    expect(await client.getBead('schema65-duplicate')).toBeNull();
    expect(await client.getBeadDependencies('schema65-duplicate')).toEqual([]);
    expect((await client.findReadyStepsForMolecule(root)).map(b => b.id)).toEqual([first]);
    await writes.markStepRunning(first);
    expect((await client.findRunningStepsForMolecule(root)).map(b => b.id)).toEqual([first]);
    expect(cliBead(first).status).toBe('in_progress');
    await writes.recordStepTask(first, { taskId: 'task-1', providerKind: 'test-provider', sessionId: 'session-1', conversationId: 'conversation-1' });
    await writes.recordStepAttempt(first, 2);
    await writes.markStepDone(first, { result: 'ok' });
    const completed = await client.getBead(first);
    expect(completed).toMatchObject({ status: 'closed', metadata: { exec: {
      task_id: 'task-1', provider_kind: 'test-provider', session_id: 'session-1',
      conversation_id: 'conversation-1', attempts: 2, output_payload: { result: 'ok' }, input_payload: { input: 1 },
    } } });
    expect(completed?.closed_at).toBeInstanceOf(Date);
    expect(cliBead(first)).toMatchObject({ status: 'closed', metadata: completed!.metadata });
    expect((await client.findReadyStepsForMolecule(root)).map(b => b.id)).toEqual([second]);
    expect(await client.findRunningStepsForMolecule(root)).toEqual([]);
    await writes.markStepFailed(second, 'simulated failure');
    expect(await client.getBead(second)).toMatchObject({ status: 'closed', metadata: { exec: { error_trace: 'simulated failure' } } });
    expect(cliBead(second)).toMatchObject({ status: 'closed', close_reason: 'step failed: simulated failure', metadata: { exec: { error_trace: 'simulated failure' } } });
    expect(await client.findReadyStepsForMolecule(root)).toEqual([]);
    await writes.appendNoteToBead(root, 'First writeback');
    await writes.appendNoteToBead(root, 'Second writeback');
    expect(await writes.recordMoleculeWriteback(root, 'completed')).toBeUndefined();
    expect(await writes.recordMoleculeWriteback(root, 'failed')).toBe('completed');
    await writes.markMoleculeRootStatus(root, 'closed', 'failed');
    expect(cliBead(root)).toMatchObject({ status: 'closed', notes: 'First writeback\n\nSecond writeback', metadata: { preserved: true, exec: { formula: 'compatibility', writeback_status: 'failed', outcome: 'failed' } } });
    expect((await client.listMoleculeRoots({ statuses: ['closed'], limit: 1 })).map(b => b.id)).toEqual([root]);
    expect(await client.listMoleculeRoots({ statuses: ['open'] })).toEqual([]);
    expect(await client.getBead('schema65-missing')).toBeNull();
    await expect(writes.appendNoteToBead('schema65-missing', 'not written')).rejects.toThrow('not found');
  }, 120_000);

  it('rejects unverified drift rather than accepting arbitrary schema65 variants', async () => {
    const { bd, root, port, database } = store!;
    bd('sql', 'ALTER TABLE issues ADD COLUMN unverified_probe int');
    const candidate = new DoltClient({ beadsRoot: root, host: '127.0.0.1', port, database });
    try {
      await candidate.verifyFingerprint();
      await expect(candidate.verifySchema()).rejects.toBeInstanceOf(WrongBdSchemaError);
    } finally {
      await candidate.close();
    }
  }, 120_000);
});
