/**
 * vibesync-efee — formula steps are beads linked by `needs`; the bead graph
 * (not an in-process loop) decides what is runnable.
 *
 * REAL bd (>= 1.3.2) against a disposable, isolated repo. Opt in with
 *   VIBESYNC_TEST_BD=/usr/local/bin/bd bunx vitest run tests/integration/orchestration/steps-as-beads.test.ts
 * Nothing here touches the production Dolt/bd data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootOrchestrationPlane } from '../../../src/orchestration/boot.js';
import { MoleculeWalker, newMoleculeStepId, type StepSpec } from '../../../src/orchestration/molecule/index.js';
import { StoreReadyStepSource, type ReadyStep, type ReadyStepSource } from '../../../src/orchestration/scheduler/step-dispatcher.js';
import { newFakeProvider } from '../../_fixtures/fake-provider.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './isolated-beads.js';

type Isolated = Awaited<ReturnType<typeof provisionIsolatedBeads>>;
type BdJson = Record<string, any>;

const step = (name: string, ...needs: string[]): StepSpec => ({ name, role: 'worker', ...(needs.length ? { dependsOn: needs } : {}) });

/** Names of the molecule STEPS `bd ready --mol <root>` lists as open (it also lists the root and in_progress steps). */
function bdReadyOpenSteps(bd: Isolated['bd'], rootId: string): string[] {
  const out = JSON.parse(bd('ready', '--mol', rootId, '--json')) as { steps: Array<{ issue: BdJson }> | null }; // null once nothing is ready
  return (out.steps ?? [])
    .map((s) => s.issue)
    .filter((i) => i['issue_type'] === 'molecule_step' && i['status'] === 'open')
    .map((i) => i['metadata'].exec.step as string)
    .sort();
}

const names = (steps: readonly { step: { metadata: Record<string, unknown> } }[]): string[] =>
  steps.map((s) => (s.step.metadata['exec'] as { step: string }).step).sort();

describe.skipIf(!RUN_ISOLATED_BEADS)('steps are beads (real bd, isolated repo)', () => {
  let h: Isolated;
  let walker: MoleculeWalker;

  beforeAll(async () => {
    h = await provisionIsolatedBeads('fresh');
    walker = new MoleculeWalker(h.client);
  }, 120_000);
  afterAll(async () => { await h?.close(); }, 120_000);

  const cook = (steps: StepSpec[], formulaName = 'f') =>
    walker.dispatch({ prefix: 'schema65', formulaName, title: `[formula:${formulaName}]`, steps });

  it('1. a three-step formula cooks into step beads with the right edges; bd ready --mol lists only step 1, closing it readies step 2', async () => {
    const view = await cook([step('one'), step('two', 'one'), step('three', 'two')], 'linear');
    const id = (n: string) => newMoleculeStepId(view.rootId, n);

    const show = (n: string) => (JSON.parse(h.bd('show', id(n), '--json')) as BdJson[])[0]!;
    const edges = (n: string) =>
      (show(n)['dependencies'] as BdJson[]).map((d) => `${d['dependency_type']}:${d['id']}`).sort();
    expect(edges('one')).toEqual([`parent-child:${view.rootId}`]);
    expect(edges('two')).toEqual([`blocks:${id('one')}`, `parent-child:${view.rootId}`].sort());
    expect(edges('three')).toEqual([`blocks:${id('two')}`, `parent-child:${view.rootId}`].sort());
    expect(show('two')['issue_type']).toBe('molecule_step');

    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['one']);
    await walker.finishStep(id('one'), { ok: true });
    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['two']);
    await walker.finishStep(id('two'), { ok: true });
    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['three']);
  });

  it('2. fan-out projection: B and C need A (ready together once A closes); D needs B and C', async () => {
    const view = await cook([step('A'), step('B', 'A'), step('C', 'A'), step('D', 'B', 'C')], 'fan');
    const id = (n: string) => newMoleculeStepId(view.rootId, n);

    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['A']);
    await walker.finishStep(id('A'), {});
    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['B', 'C']);
    await walker.finishStep(id('B'), {});
    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['C']); // D still waits on C
    await walker.finishStep(id('C'), {});
    expect(bdReadyOpenSteps(h.bd, view.rootId)).toEqual(['D']);
  });

  it('contract: the hot-path SQL (findReadyStepsForMolecule) agrees with `bd ready --mol` on every state', async () => {
    const view = await cook([step('A'), step('B', 'A'), step('C', 'A'), step('D', 'B', 'C')], 'contract');
    const id = (n: string) => newMoleculeStepId(view.rootId, n);
    const sql = async () => names((await h.client.findReadyStepsForMolecule(view.rootId)).map((step) => ({ step })));
    const agree = async (label: string) => expect({ label, sql: await sql() }).toEqual({ label, sql: bdReadyOpenSteps(h.bd, view.rootId) });

    await agree('fresh');
    await h.client.markStepRunning(id('A'));
    // bd --mol lists a running step as "ready"; the SQL deliberately does not (never re-dispatch a running step).
    // Compared on OPEN steps only (bdReadyOpenSteps) - that is the shared predicate.
    await agree('A running');
    await walker.finishStep(id('A'), {});
    await agree('A done');
    await h.client.markStepRunning(id('B'));
    await agree('B running');
    await walker.failStep(id('B'), 'boom'); // a failed step is closed: it unblocks like a finished one
    await agree('B failed');
    await walker.finishStep(id('C'), {});
    await agree('C done');
    h.bd('close', id('D')); // closed through bd itself, not through our store
    await agree('D closed via bd');
    expect(await sql()).toEqual([]);
  });

  describe('3. dispatch candidates come from the molecule-scoped query, never plain `bd ready`', () => {
    /** The WRONG implementation Meridian warned about: plain `bd ready` filtered to molecule steps. */
    function plainBdReadySource(): ReadyStepSource {
      return {
        async readySteps(): Promise<readonly ReadyStep[]> {
          const rows = JSON.parse(h.bd('ready', '--json', '--limit', '0')) as BdJson[];
          const steps = rows.filter((r) => r['issue_type'] === 'molecule_step');
          return steps.map((r) => ({
            moleculeId: r['metadata'].exec.molecule as string,
            step: { id: r['id'], title: r['title'], description: '', status: r['status'], priority: 2, issue_type: 'molecule_step', created_at: new Date(), updated_at: new Date(), closed_at: null, metadata: r['metadata'] },
          }));
        },
      };
    }

    async function twoOpenMolecules() {
      const m1 = await cook([step('a'), step('b', 'a')], 'm1');
      const m2 = await cook([step('x'), step('y', 'x')], 'm2'); // "a SECOND open molecule with a blocked step"
      return { m1, m2, live: [m1.rootId, m2.rootId] };
    }

    /** The assertion under test: only dependency-satisfied steps are candidates, blocked ones never. */
    async function assertOnlyUnblockedCandidates(source: ReadyStepSource, m1: string, m2: string): Promise<void> {
      const got = (await source.readySteps()).map((r) => r.step.id).sort();
      expect(got).toEqual([newMoleculeStepId(m1, 'a'), newMoleculeStepId(m2, 'x')].sort());
      expect(got).not.toContain(newMoleculeStepId(m1, 'b'));
      expect(got).not.toContain(newMoleculeStepId(m2, 'y'));
    }

    it('the production source lists only the unblocked steps of both molecules', async () => {
      const { m1, m2, live } = await twoOpenMolecules();
      await assertOnlyUnblockedCandidates(new StoreReadyStepSource(h.client, () => live), m1.rootId, m2.rootId);
    });

    it('FAIL-PROOF: the same assertion rejects a source built on plain `bd ready` (it returns the blocked steps)', async () => {
      const { m1, m2 } = await twoOpenMolecules();
      const leaked = (await plainBdReadySource().readySteps()).map((r) => r.step.id);
      expect(leaked).toContain(newMoleculeStepId(m2.rootId, 'y')); // the trap is real on bd 1.3.2
      await expect(assertOnlyUnblockedCandidates(plainBdReadySource(), m1.rootId, m2.rootId)).rejects.toThrow();
    });

    it('a closed molecule is not a candidate even if its id is still tracked', async () => {
      const { m1, m2, live } = await twoOpenMolecules();
      await walker.finishStep(newMoleculeStepId(m1.rootId, 'a'), {});
      await walker.finishStep(newMoleculeStepId(m1.rootId, 'b'), {});
      await walker.markMoleculeRootStatus(m1.rootId, 'closed', 'completed');
      const got = (await new StoreReadyStepSource(h.client, () => live).readySteps()).map((r) => r.step.id);
      expect(got).toEqual([newMoleculeStepId(m2.rootId, 'x')]);
    });
  });

  it('end to end on real bd: a formula run through boot completes all three steps; bd sees every step and the root closed', async () => {
    process.env['VIBESYNC_WORK_ACTIVITY_REPORT'] = '0';
    const packRoot = mkdtempSync(join(tmpdir(), 'efee-e2e-'));
    mkdirSync(join(packRoot, 'prompts'));
    writeFileSync(join(packRoot, 'prompts', 'p.md'), 'Do ${input}');
    const provider = newFakeProvider({ kind: 'fake' });
    const handle = await bootOrchestrationPlane({
      dolt: h.client, provider, persistEvents: false, runDriftAuditOnBoot: false, stepTickIntervalMs: 20,
      bdVersion: async () => h.bd('--version'),
    });
    try {
      const result = await handle.dispatcher.run({
        formula: { name: 'e2e', description: 'e2e', whenToUse: '', steps: [
          { name: 'one', role: 'worker', promptTemplate: 'prompts/p.md' },
          { name: 'two', role: 'worker', promptTemplate: 'prompts/p.md', dependsOn: ['one'] },
          { name: 'three', role: 'worker', promptTemplate: 'prompts/p.md', dependsOn: ['two'] },
        ] },
        pack: { manifest: { name: 'p', version: '1' }, root: packRoot, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }], formulas: [] },
        input: 'go',
      });
      expect(provider.recorder.starts).toHaveLength(3);
      for (const n of ['one', 'two', 'three']) {
        expect((JSON.parse(h.bd('show', newMoleculeStepId(result.moleculeId, n), '--json')) as BdJson[])[0]!['status']).toBe('closed');
      }
      expect((JSON.parse(h.bd('show', result.moleculeId, '--json')) as BdJson[])[0]!['status']).toBe('closed');
      expect(bdReadyOpenSteps(h.bd, result.moleculeId)).toEqual([]);
    } finally {
      await handle.shutdown();
    }
  }, 60_000);
});
