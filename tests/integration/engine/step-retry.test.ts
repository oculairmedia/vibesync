/**
 * vibesync-ynmp - per-step retry policy, durable on the bead. REAL bd (>= 1.3.2)
 * against a disposable isolated repo:
 *   VIBESYNC_TEST_BD=/usr/local/bin/bd bunx vitest run tests/integration/engine/step-retry.test.ts
 * The restart test is the false-pass guard: a retry counter held in memory
 * cannot survive a fresh dispatcher + store on the same repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../../src/engine/events/index.js';
import { FormulaDispatchError, FormulaDispatcher } from '../../../src/engine/dispatcher/index.js';
import type { Formula } from '../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId, type StepSpec } from '../../../src/engine/molecule/index.js';
import type { Pack } from '../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../src/engine/runtime/index.js';
import { StepDispatcher, StoreReadyStepSource } from '../../../src/engine/scheduler/step-dispatcher.js';
import { BeadsStore } from '../../../src/engine/beads/store.js';
import { DoltClient } from '../../../src/engine/store/dolt-client.js';
import { newFakeProvider } from '../../_fixtures/fake-provider.js';
import { newDriven } from '../../_fixtures/step-driver.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './isolated-beads.js';

type Isolated = Awaited<ReturnType<typeof provisionIsolatedBeads>>;
type BdJson = Record<string, any>;

const worker = (retry?: StepSpec['retry']): StepSpec => ({ name: 'worker', role: 'worker', promptTemplate: 'prompts/p.md', ...(retry ? { retry } : {}) });
const after: StepSpec = { name: 'after', role: 'after', promptTemplate: 'prompts/p.md', dependsOn: ['worker'] };
const formula = (...steps: StepSpec[]): Formula => ({ name: 'retry-it', description: 'retry-it', whenToUse: '', steps });
const retry = (maxAttempts: number, onExhausted: 'fail' | 'soft_fail' = 'fail') => ({ maxAttempts, onExhausted, backoffMs: 0 });

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'ynmp-it-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }, { name: 'after', memoryBlocks: [] }], formulas: [] };
}

describe.skipIf(!RUN_ISOLATED_BEADS)('step retry policy on real bd (isolated repo)', () => {
  let h: Isolated;
  beforeAll(async () => { h = await provisionIsolatedBeads('fresh'); }, 120_000);
  afterAll(async () => { await h?.close(); }, 120_000);

  const show = (id: string): BdJson => (JSON.parse(h.bd('show', id, '--json')) as BdJson[])[0]!;
  const stepId = (root: string, name = 'worker') => newMoleculeStepId(root, name);

  /** A provider whose turn n (per role) is scripted; `fail` = what the agent does with `bd update <step> --set-metadata failure_class=...` through the REAL bd CLI. */
  function scripted(turnsByRole: Record<string, ReadonlyArray<'ok' | 'agent-fail' | 'infra'>>, startsByRole = new Map<string, number>()) {
    const seen: Array<{ role: string; attempt: unknown }> = [];
    const provider = newFakeProvider({
      kind: 'fake-runtime',
      script: (spec: SessionSpec): AsyncIterable<SessionEvent> => {
        const n = startsByRole.get(spec.role) ?? 0;
        startsByRole.set(spec.role, n + 1);
        seen.push({ role: spec.role, attempt: spec.extra?.['attempt'] });
        const turns = turnsByRole[spec.role] ?? ['ok'];
        const turn = turns[Math.min(n, turns.length - 1)]!;
        return (async function* () {
          const ts = new Date().toISOString();
          yield { kind: 'started', ts };
          if (turn === 'infra') {
            yield { kind: 'error', ts, code: 'IrohConnectionLostError', message: 'link dropped' };
          } else if (turn === 'agent-fail') {
            h.bd('update', String(spec.extra?.['stepId']), '--set-metadata', 'failure_class=flaky');
            yield { kind: 'message-delta', ts, text: 'tried and failed' };
          } else {
            yield { kind: 'message-delta', ts, text: `${spec.role} ok` };
          }
          yield { kind: 'turn-done', ts };
        })();
      },
    });
    return { provider, seen, startsByRole };
  }

  it('1. fails twice (agent failure_class via real bd) then passes: bd shows gc.retry_attempt=3, step closed, next step ran', async () => {
    const { provider, seen } = scripted({ worker: ['agent-fail', 'agent-fail', 'ok'] });
    const dispatcher = newDriven(h.store, { idPrefix: 'schema65', provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const result = await dispatcher.run({ formula: formula(worker(retry(3)), after), pack: pack(), input: 'go' });
    const step = show(stepId(result.moleculeId));
    expect(step['status']).toBe('closed');
    expect(step['metadata']['gc.retry_attempt']).toBe(3);
    expect(step['metadata']['failure_class']).toBeUndefined();
    expect(step['metadata']['gc.last_failure_class']).toBe('flaky');
    expect(seen.filter((s) => s.role === 'worker').map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(show(stepId(result.moleculeId, 'after'))['status']).toBe('closed');
    expect(show(result.moleculeId)['status']).toBe('closed');
  }, 60_000);

  it('2. an infra failure then a pass leaves gc.retry_attempt at 1', async () => {
    const { provider } = scripted({ worker: ['infra', 'ok'] });
    const dispatcher = newDriven(h.store, { idPrefix: 'schema65', provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const result = await dispatcher.run({ formula: formula(worker(retry(3))), pack: pack(), input: 'go' });
    const meta = show(stepId(result.moleculeId))['metadata'];
    expect(meta['gc.retry_attempt']).toBe(1);
    expect(meta['gc.infra_retries']).toBe(1);
  }, 60_000);

  it('3. soft_fail on exhaustion closes the step failed (bd close_reason, gc.retry_outcome) and the molecule completes through the dependent', async () => {
    const { provider } = scripted({ worker: ['agent-fail'] });
    const dispatcher = newDriven(h.store, { idPrefix: 'schema65', provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const result = await dispatcher.run({ formula: formula(worker(retry(2, 'soft_fail')), after), pack: pack(), input: 'go' });
    const step = show(stepId(result.moleculeId));
    expect(step['status']).toBe('closed');
    expect(step['metadata']['gc.retry_attempt']).toBe(2);
    expect(step['metadata']['gc.retry_outcome']).toBe('soft_failed');
    expect(String(step['close_reason'] ?? '')).toContain('step failed');
    expect(show(stepId(result.moleculeId, 'after'))['status']).toBe('closed');
    expect(show(result.moleculeId)['metadata'].exec.outcome).toBe('completed');
  }, 60_000);

  it('4. fail on exhaustion aborts the molecule: root closed failed, dependent still open', async () => {
    const { provider } = scripted({ worker: ['agent-fail'] });
    const dispatcher = newDriven(h.store, { idPrefix: 'schema65', provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }) });
    const thrown = await dispatcher.run({ formula: formula(worker(retry(2, 'fail')), after), pack: pack(), input: 'go' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    const rootId = (thrown as FormulaDispatchError).moleculeId;
    expect(show(stepId(rootId))['metadata']['gc.retry_outcome']).toBe('exhausted');
    expect(show(stepId(rootId, 'after'))['status']).toBe('open');
    expect(show(rootId)['status']).toBe('closed');
    expect(show(rootId)['metadata'].exec.outcome).toBe('failed');
  }, 60_000);

  it('6. the bead is the source of truth: an operator `bd update --set-metadata gc.retry_attempt=3` (bd stores it as the value it is given) is what the dispatcher continues from', async () => {
    const walker = new MoleculeWalker(h.store);
    const view = await walker.dispatch({ prefix: 'schema65', formulaName: 'op', title: '[formula:op]', steps: [worker(retry(3))] });
    h.bd('update', stepId(view.rootId), '--set-metadata', 'gc.retry_attempt=3');
    const { provider, seen } = scripted({ worker: ['agent-fail', 'ok'] });
    const dispatcher = new FormulaDispatcher({ idPrefix: 'schema65', provider, walker, eventBus: new EventBus({ noPersist: true }) });
    const steps = new StepDispatcher({ source: new StoreReadyStepSource(h.store, () => dispatcher.liveMoleculeIds()), runner: dispatcher });
    steps.setWake(() => undefined);
    const done = dispatcher.adopt(view.rootId, { formula: formula(worker(retry(3))), pack: pack(), input: 'go' }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    await steps.tick(); await steps.drain();
    expect(seen).toEqual([{ role: 'worker', attempt: 3 }]);      // started at 3, not 1
    expect(await done).toBeInstanceOf(FormulaDispatchError);      // attempt 3 of 3 failed: exhausted
    expect(show(stepId(view.rootId))['metadata']['gc.retry_outcome']).toBe('exhausted');
  }, 60_000);

  it('5. DURABILITY: attempt 1 fails, a FRESH dispatcher + store + provider on the same repo continues at attempt 2, not 1', async () => {
    const input = { formula: formula(worker(retry(3)), after), pack: pack(), input: 'go' };
    let rootId = '';

    // Process A: runs attempt 1 (agent-declared failure), reopens the bead, then "dies" (never ticked again).
    {
      const a = scripted({ worker: ['agent-fail'] });
      let cooked!: () => void;
      const cookedA = new Promise<void>((resolve) => { cooked = resolve; });
      const dispatcherA = new FormulaDispatcher({ idPrefix: 'schema65', provider: a.provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }), onMoleculeCooked: (id) => { rootId = id; cooked(); } });
      const stepsA = new StepDispatcher({ source: new StoreReadyStepSource(h.store, () => dispatcherA.liveMoleculeIds()), runner: dispatcherA });
      stepsA.setWake(() => undefined); // no self-ticking: this process gets exactly one tick, then it is gone
      void dispatcherA.run({ ...input, onStarted: (id) => { rootId = id; } }).catch(() => undefined);
      // Wait for the cook to finish rather than a fixed delay: cooking through
      // bd takes ~0.5 s per step bead, versus milliseconds over raw SQL.
      await Promise.race([cookedA, new Promise((_, reject) => setTimeout(() => reject(new Error('molecule never cooked')), 30_000))]);
      expect(rootId).not.toBe('');
      await stepsA.tick();
      await stepsA.drain();
      expect(a.startsByRole.get('worker')).toBe(1);
      const afterA = show(stepId(rootId));
      expect(afterA['status']).toBe('open'); // reopened: back in the bead graph's ready set
      expect(afterA['metadata']['gc.retry_attempt']).toBe(2);
    }

    // Process B: brand-new client (new pool), walker, dispatcher, provider, step dispatcher. Nothing in memory.
    const freshClient = new DoltClient({ beadsRoot: h.root, host: '127.0.0.1', port: h.port, database: h.database });
    try {
      const b = scripted({ worker: ['agent-fail', 'ok'] }); // B's first worker turn is the second overall try
      // Fresh gateway too: SQL reads on the new pool, writes through bd.
      const freshStore = new BeadsStore(freshClient, async (args) => h.bd(...args));
      const dispatcherB = new FormulaDispatcher({ idPrefix: 'schema65', provider: b.provider, walker: new MoleculeWalker(freshStore), eventBus: new EventBus({ noPersist: true }) });
      const stepsB = new StepDispatcher({ source: new StoreReadyStepSource(freshStore, () => dispatcherB.liveMoleculeIds()), runner: dispatcherB });
      stepsB.setWake(() => undefined);
      const doneB = dispatcherB.adopt(rootId, input);
      await new Promise((r) => setTimeout(r, 100));
      await stepsB.tick(); await stepsB.drain();   // attempt 2 -> fails again -> reopened, attempt 3
      expect(b.seen[0]).toEqual({ role: 'worker', attempt: 2 }); // NOT 1
      expect(show(stepId(rootId))['metadata']['gc.retry_attempt']).toBe(3);
      await stepsB.tick(); await stepsB.drain();   // attempt 3 -> ok
      expect(b.seen.filter((s) => s.role === 'worker').map((s) => s.attempt)).toEqual([2, 3]);
      await stepsB.tick(); await stepsB.drain();   // 'after'
      await doneB;
      const step = show(stepId(rootId));
      expect(step['status']).toBe('closed');
      expect(step['metadata']['gc.retry_attempt']).toBe(3);
      expect(show(rootId)['metadata'].exec.outcome).toBe('completed');
    } finally {
      await freshClient.close();
    }
  }, 90_000);
});
