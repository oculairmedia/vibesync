import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DoltClient } from '../../../src/orchestration/store/index.js';

/**
 * Integration: roundtrip a tiny molecule (root + 2 dependent steps) through
 * the direct-SQL client, then verify bd's CLI view sees the same data.
 *
 * Marked `.skipIf(...)` so CI without a running bd/dolt server skips
 * silently. Locally, run from the repository root with bd already initialized.
 *
 * huly-vibe-sync-w5z acceptance: "daemon inserts a molecule root, queries
 * it back via the bd CLI to confirm bd sees the same data". The bd CLI
 * confirmation is left as a manual smoke step; the test confirms the SQL
 * side.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BEADS_ROOT = process.cwd();
const PORT_FILE = join(BEADS_ROOT, '.beads', 'dolt-server.port');
const RUN = existsSync(PORT_FILE);

describe.skipIf(!RUN)('DoltClient (integration)', () => {
  let client: DoltClient;
  const testRoot = `${Math.random().toString(36).slice(2, 8)}-mol-root`;
  const testStep1 = `${testRoot}-step-1`;
  const testStep2 = `${testRoot}-step-2`;

  beforeAll(() => {
    client = new DoltClient({ beadsRoot: BEADS_ROOT });
  });

  afterAll(async () => {
    // Cleanup test rows we created (best-effort)
    if (client) {
      try {
        const pool = (client as unknown as {
          pool: { execute: (q: string, p: unknown[]) => Promise<unknown> };
        }).pool;
        await pool.execute(
          'DELETE FROM dependencies WHERE issue_id IN (?, ?, ?) OR depends_on_id IN (?, ?, ?)',
          [testRoot, testStep1, testStep2, testRoot, testStep1, testStep2],
        );
        await pool.execute('DELETE FROM issues WHERE id IN (?, ?, ?)', [
          testRoot,
          testStep1,
          testStep2,
        ]);
      } catch {
        // cleanup is best-effort; manual sweep covers leakage if needed
      }
      await client.close();
    }
  });

  it('inserts a molecule root and reads it back with metadata', async () => {
    await client.insertMoleculeRoot({
      id: testRoot,
      formulaName: 'integration-test',
      title: '[formula:integration-test] dolt-client smoke',
      metadata: { extra: 'value' },
    });
    const row = await client.getBead(testRoot);
    expect(row).not.toBeNull();
    expect(row!.issue_type).toBe('molecule_root');
    expect(row!.status).toBe('open');
    expect((row!.metadata as Record<string, unknown>)['exec']).toMatchObject({
      formula: 'integration-test',
    });
  });

  it('inserts dependent steps with parent-child + blocks edges', async () => {
    await client.insertMoleculeStep({
      id: testStep1,
      parentRootId: testRoot,
      stepName: 'first',
      title: '[formula:integration-test/step:first] first',
    });
    await client.insertMoleculeStep({
      id: testStep2,
      parentRootId: testRoot,
      stepName: 'second',
      title: '[formula:integration-test/step:second] second',
      dependsOnStepIds: [testStep1],
    });

    const deps2 = await client.getBeadDependencies(testStep2);
    const parentEdge = deps2.find((d) => d.type === 'parent-child');
    const blocksEdge = deps2.find((d) => d.type === 'blocks');
    expect(parentEdge?.depends_on_id).toBe(testRoot);
    expect(blocksEdge?.depends_on_id).toBe(testStep1);
  });

  it('findReadyStepsForMolecule returns only steps with satisfied deps', async () => {
    // Initially: step1 has no blockers → ready. step2 blocks on step1 → not ready.
    const beforeClose = await client.findReadyStepsForMolecule(testRoot);
    const beforeIds = beforeClose.map((b) => b.id);
    expect(beforeIds).toContain(testStep1);
    expect(beforeIds).not.toContain(testStep2);

    // Close step1 → step2 becomes ready.
    await client.markStepDone(testStep1, { result: 'ok' });
    const afterClose = await client.findReadyStepsForMolecule(testRoot);
    const afterIds = afterClose.map((b) => b.id);
    expect(afterIds).not.toContain(testStep1); // closed
    expect(afterIds).toContain(testStep2);

    // Step1's metadata carries the output payload.
    const step1 = await client.getBead(testStep1);
    expect(step1?.status).toBe('closed');
    expect((step1?.metadata as Record<string, unknown>)['exec']).toMatchObject({
      output_payload: { result: 'ok' },
    });
  });

  it('markStepFailed records error_trace and closes the step', async () => {
    await client.markStepFailed(testStep2, 'simulated failure');
    const step2 = await client.getBead(testStep2);
    expect(step2?.status).toBe('closed');
    expect((step2?.metadata as Record<string, unknown>)['exec']).toMatchObject({
      error_trace: 'simulated failure',
    });
  });
});
