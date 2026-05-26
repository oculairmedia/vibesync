import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DoltClient } from '../../../src/orchestration/store/index.js';
import { MoleculeWalker } from '../../../src/orchestration/molecule/index.js';

/**
 * End-to-end: dispatch a 3-step molecule via the walker, drive it to
 * completion by closing steps in dep order, and confirm the
 * dependency-satisfaction logic gates dispatch correctly.
 *
 * Verifies huly-vibe-sync-uxx acceptance: "Orchestration daemon
 * executes a two-step formula end-to-end via direct-SQL (e.g. reviewer
 * → coder)".
 */

const BEADS_ROOT = process.cwd();
const PORT_FILE = join(BEADS_ROOT, '.beads', 'dolt-server.port');
const RUN = existsSync(PORT_FILE);

describe.skipIf(!RUN)('MoleculeWalker (integration)', () => {
  let store: DoltClient;
  let walker: MoleculeWalker;
  let rootId: string;

  beforeAll(() => {
    store = new DoltClient({ beadsRoot: BEADS_ROOT });
    walker = new MoleculeWalker(store);
  });

  afterAll(async () => {
    if (store) {
      try {
        const pool = (store as unknown as {
          pool: { execute: (q: string, p: unknown[]) => Promise<unknown> };
        }).pool;
        // Sweep the happy-path molecule
        if (rootId) {
          await pool.execute(
            'DELETE FROM dependencies WHERE issue_id LIKE ? OR depends_on_id LIKE ?',
            [`${rootId}%`, `${rootId}%`],
          );
          await pool.execute('DELETE FROM issues WHERE id LIKE ?', [`${rootId}%`]);
        }
        // Sweep any forward-ref-test orphans (root created before throw)
        await pool.execute(
          "DELETE FROM issues WHERE issue_type = 'molecule_root' AND title = ?",
          ['bad dep order'],
        );
      } catch {
        // best-effort cleanup
      }
      await store.close();
    }
  });

  it('dispatch creates root + 3 steps with correct dep edges', async () => {
    const view = await walker.dispatch({
      prefix: 'huly-vibe-sync',
      formulaName: 'integration-walker',
      title: '[formula:integration-walker] walker test',
      steps: [
        { name: 'reviewer', role: 'reviewer' },
        { name: 'coder', role: 'coder', dependsOn: ['reviewer'] },
        { name: 'tester', role: 'tester', dependsOn: ['coder'] },
      ],
    });
    rootId = view.rootId;
    expect(view.root.issue_type).toBe('molecule_root');
    expect(view.steps).toHaveLength(3);
    expect(view.byName.has('reviewer')).toBe(true);
    expect(view.byName.has('coder')).toBe(true);
    expect(view.byName.has('tester')).toBe(true);

    // Edges: root has 3 parent-child children; coder blocks on reviewer;
    // tester blocks on coder.
    const parentChildren = view.edges.filter(
      (e) => e.type === 'parent-child' && e.depends_on_id === rootId,
    );
    expect(parentChildren).toHaveLength(3);
    const blocksEdges = view.edges.filter((e) => e.type === 'blocks');
    expect(blocksEdges).toHaveLength(2);
  });

  it('walks ready steps in dep order: reviewer first, then coder, then tester', async () => {
    // Initial: only reviewer is ready.
    let ready = await walker.findReady(rootId);
    let readyNames = new Set(
      ready.map((s) => (s.metadata as { exec?: { step?: string } })?.exec?.step),
    );
    expect(readyNames).toEqual(new Set(['reviewer']));

    // Run + finish reviewer → coder becomes ready.
    const reviewerView = await walker.load(rootId);
    const reviewerId = reviewerView!.byName.get('reviewer')!.id;
    await walker.startStep(reviewerId);
    await walker.finishStep(reviewerId, { verdict: 'lgtm' });

    ready = await walker.findReady(rootId);
    readyNames = new Set(
      ready.map((s) => (s.metadata as { exec?: { step?: string } })?.exec?.step),
    );
    expect(readyNames).toEqual(new Set(['coder']));

    // Run + finish coder → tester becomes ready.
    const coderView = await walker.load(rootId);
    const coderId = coderView!.byName.get('coder')!.id;
    await walker.startStep(coderId);
    await walker.finishStep(coderId, { diff: '...' });

    ready = await walker.findReady(rootId);
    readyNames = new Set(
      ready.map((s) => (s.metadata as { exec?: { step?: string } })?.exec?.step),
    );
    expect(readyNames).toEqual(new Set(['tester']));

    // Close tester.
    const testerView = await walker.load(rootId);
    const testerId = testerView!.byName.get('tester')!.id;
    await walker.startStep(testerId);
    await walker.finishStep(testerId, { passed: true });

    // No more ready steps; molecule is complete.
    ready = await walker.findReady(rootId);
    expect(ready).toHaveLength(0);
    const complete = await walker.isComplete(rootId);
    expect(complete).toBe(true);
  });

  it('dispatch rejects a forward reference in depends_on', async () => {
    await expect(
      walker.dispatch({
        prefix: 'huly-vibe-sync',
        formulaName: 'integration-walker-bad',
        title: 'bad dep order',
        steps: [
          { name: 'a', role: 'r1', dependsOn: ['b'] }, // forward ref
          { name: 'b', role: 'r2' },
        ],
      }),
    ).rejects.toThrow(/depends_on "b" which is not defined before/);
  });
});
