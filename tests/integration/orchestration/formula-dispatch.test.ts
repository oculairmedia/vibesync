import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DoltClient } from '../../../src/orchestration/store/index.js';
import { MoleculeWalker } from '../../../src/orchestration/molecule/index.js';
import { loadPack } from '../../../src/orchestration/packs/index.js';

/**
 * huly-vibe-sync-k6h acceptance: "`vibesync dispatch --formula
 * code-review --context PR#123` runs end-to-end". This integration test
 * runs the formula → molecule pipeline programmatically (no CLI yet)
 * and confirms the dispatched molecule has the same structure the
 * formula declared.
 */

const BEADS_ROOT = process.cwd();
const PORT_FILE = join(BEADS_ROOT, '.beads', 'dolt-server.port');
const RUN = existsSync(PORT_FILE);

describe.skipIf(!RUN)('formula → molecule dispatch (integration)', () => {
  let store: DoltClient;
  let walker: MoleculeWalker;
  let rootId: string;

  beforeAll(() => {
    store = new DoltClient({ beadsRoot: BEADS_ROOT });
    walker = new MoleculeWalker(store);
  });

  afterAll(async () => {
    if (store && rootId) {
      try {
        const pool = (store as unknown as {
          pool: { execute: (q: string, p: unknown[]) => Promise<unknown> };
        }).pool;
        await pool.execute(
          'DELETE FROM dependencies WHERE issue_id LIKE ? OR depends_on_id LIKE ?',
          [`${rootId}%`, `${rootId}%`],
        );
        await pool.execute('DELETE FROM issues WHERE id LIKE ?', [`${rootId}%`]);
      } catch {
        // cleanup best-effort
      }
      await store.close();
    }
  });

  it('dispatches the code-review formula end-to-end', async () => {
    // Formula source moved from formulas/ to packs/gastown/formulas/ in 1689d44
    // (chore(formulas): remove orphan top-level code-review formula). Load via
    // the gastown pack so the path tracks the canonical pack scope. (vibesync-bec)
    const pack = loadPack(join(BEADS_ROOT, 'packs', 'gastown'), 'project');
    const codeReview = pack.formulas.find((f) => f.name === 'code-review');
    expect(codeReview).toBeDefined();

    const view = await walker.dispatch({
      prefix: 'huly-vibe-sync',
      formulaName: codeReview!.name,
      title: '[formula:code-review] integration smoke',
      steps: codeReview!.steps,
    });
    rootId = view.rootId;

    // Root + 3 steps materialized; dep edges match the formula.
    expect(view.root.issue_type).toBe('molecule_root');
    expect(view.steps).toHaveLength(3);
    expect(view.byName.has('reviewer')).toBe(true);
    expect(view.byName.has('coder')).toBe(true);
    expect(view.byName.has('tester')).toBe(true);

    // Only the reviewer is ready (coder blocks on reviewer; tester blocks on coder).
    const ready = await walker.findReady(rootId);
    const readyNames = ready.map(
      (s) => (s.metadata as { exec?: { step?: string } })?.exec?.step,
    );
    expect(readyNames).toEqual(['reviewer']);
  });
});
