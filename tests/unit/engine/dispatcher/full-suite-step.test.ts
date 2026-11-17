/**
 * vibesync-6zos.7, through the real dispatcher: a step with `requiresFullSuite` must prove a full-suite run with the report,
 * not its reply. Soak run 4: the coder ran only the files it touched and a change it made broke 9 tests in a file it never ran.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FormulaDispatchError } from '../../../../src/engine/dispatcher/index.js';
import type { VitestReport } from '../../../../src/engine/dispatcher/full-suite-evidence.js';
import { EventBus } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const BEAD = 'vibesync-x.1';
const FILES = ['tests/unit/a.test.ts', 'tests/unit/config.test.ts', 'tests/integration/opt-in.test.ts'];

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-full-suite-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: [{ name: 'coder', memoryBlocks: [] }], formulas: [] };
}

const coderOnly = (requiresFullSuite: boolean): Formula => ({
  name: 'code', description: 'd', whenToUse: '',
  steps: [{ name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', ...(requiresFullSuite ? { requiresFullSuite: true } : {}) }],
});

const entry = (file: string, tests: Array<{ status: string; fullName?: string }>) => ({ name: `/work/${file}`, status: 'passed', assertionResults: tests });
/** A report written "now": during the step. */
const reportOf = (files: Array<ReturnType<typeof entry>>, failed = 0): (() => VitestReport) => () => ({ startTime: Date.now(), numFailedTests: failed, testResults: files });

function harness(report: () => VitestReport | null, requiresFullSuite = true, opts: { readThrows?: boolean } = {}) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake', script: () => reply('Done. Ran the tests, all green. STEP OUTCOME: DONE') });
  const reads: string[] = [];
  const bus = new EventBus({ noPersist: true });
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.kind));
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
    fullSuiteEvidence: {
      // The coder writes its report DURING its turn; read it lazily so its startTime falls inside the step.
      async readReport(bead) { reads.push(bead); if (opts.readThrows) throw new Error('EACCES: permission denied'); return report(); },
      async listTestFiles() { return FILES; },
    },
  });
  const run = (where: { bead?: boolean; workdir?: boolean } = { bead: true, workdir: true }) => dispatcher.run({
    formula: coderOnly(requiresFullSuite), pack: pack(), input: 'go',
    ...(where.bead ? { motivatingBeadId: BEAD } : {}), ...(where.workdir ? { workdir: '/work' } : {}),
  });
  return { store, run, reads, events };
}

async function stepTrace(store: InMemoryDoltClient, err: unknown): Promise<string> {
  const id = (err as FormulaDispatchError).moleculeId;
  const step = await store.getBead(`${id}-coder`);
  return String((step?.metadata?.['exec'] as Record<string, unknown> | undefined)?.['error_trace'] ?? '');
}

describe('requires_full_suite steps (vibesync-6zos.7)', () => {
  it('a coder that ran only named files (soak run 4) fails with "full suite not run", whatever its reply says', async () => {
    const h = harness(reportOf([entry('tests/unit/a.test.ts', [{ status: 'passed' }])]));
    const thrown = await h.run().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(await stepTrace(h.store, thrown)).toMatch(/full suite not run: 2 of 3 test files are not in the report/);
    expect(h.reads).toEqual([BEAD]);
  });

  it("a report showing a failure fails the step with that failure's file and test name", async () => {
    const h = harness(reportOf([
      entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
      entry('tests/unit/config.test.ts', [{ status: 'failed', fullName: 'config schema requires the new field' }]),
      entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
    ], 1));
    const thrown = await h.run().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(await stepTrace(h.store, thrown)).toContain('tests/unit/config.test.ts: config schema requires the new field');
  });

  it('a complete, passing report lets the step proceed', async () => {
    const h = harness(reportOf([
      entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
      entry('tests/unit/config.test.ts', [{ status: 'passed' }]),
      entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
    ]));
    await expect(h.run()).resolves.toMatchObject({ outputs: { coder: expect.any(String) } });
  });

  it('a report from before the step (a previous run) does not count', async () => {
    const stale = () => ({ ...reportOf([
      entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
      entry('tests/unit/config.test.ts', [{ status: 'passed' }]),
      entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
    ])(), startTime: Date.now() - 3_600_000 });
    const h = harness(stale);
    const thrown = await h.run().catch((e: unknown) => e);
    expect(await stepTrace(h.store, thrown)).toMatch(/older than the step/);
  });

  it('no report at all fails closed', async () => {
    const h = harness(() => null);
    const thrown = await h.run().catch((e: unknown) => e);
    expect(await stepTrace(h.store, thrown)).toMatch(/no test report was written/);
  });

  it('a step without the setting is not checked', async () => {
    const h = harness(() => null, false);
    await expect(h.run()).resolves.toBeDefined();
    expect(h.reads).toEqual([]);
  });

  it('a run with no work bead and no workdir (POST /formulas/:name/run) is not checked, and says so in an event', async () => {
    const h = harness(() => null);
    await expect(h.run({})).resolves.toBeDefined();
    expect(h.reads, 'no report is read: there is nothing to prove against').toEqual([]);
    expect(h.events).toContain('dispatcher/full-suite.not_checked');
  });

  it('a run with a work bead but no workdir is broken wiring: it fails closed', async () => {
    const h = harness(() => null);
    const thrown = await h.run({ bead: true }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(await stepTrace(h.store, thrown)).toMatch(/work bead but no workdir/);
  });

  it('an evidence read that throws fails the step closed, naming the error', async () => {
    const h = harness(() => null, true, { readThrows: true });
    const thrown = await h.run().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(await stepTrace(h.store, thrown)).toMatch(/evidence could not be read \(EACCES: permission denied\)/);
  });
});
