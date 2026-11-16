/**
 * vibesync-6zos.3 - cancelling a run while a step's turn is in flight, on REAL bd
 * (>= 1.3.2) against a disposable isolated repo:
 *   VIBESYNC_TEST_BD=/usr/local/bin/bd node node_modules/vitest/vitest.mjs run tests/integration/engine/cancel-race.test.ts
 *
 * The unit suite (tests/unit/engine/dispatcher/cancel-race.test.ts) drives the
 * same sequences against an in-memory stand-in for the tracker. That stand-in
 * has been wrong before on exactly this ground (it left a cancelled run's
 * unstarted steps open, which real bd does not), and real bd accepts a second
 * write on a closed bead, so the overwrite this guards against is a property of
 * the real tracker. Until this file, no real-bd test cancelled a formula run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../../src/engine/events/index.js';
import type { Formula } from '../../../src/engine/formula/index.js';
import { MoleculeWalker, newMoleculeStepId, type StepSpec } from '../../../src/engine/molecule/index.js';
import type { Pack } from '../../../src/engine/packs/index.js';
import type { SessionEvent } from '../../../src/engine/runtime/index.js';
import { newFakeProvider, type FakeProvider } from '../../_fixtures/fake-provider.js';
import { newDriven } from '../../_fixtures/step-driver.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './isolated-beads.js';

type Isolated = Awaited<ReturnType<typeof provisionIsolatedBeads>>;
/** What `bd show --json` returns for a bead, as far as these tests read it. */
interface BdBead {
  readonly status?: string;
  readonly close_reason?: string;
  readonly metadata?: {
    readonly exec?: { readonly session_id?: unknown; readonly error_trace?: unknown; readonly output_payload?: unknown; readonly outcome?: unknown };
    readonly 'gc.retry_attempt'?: unknown;
  };
}
type Ending = 'error' | 'reply';

const step = (name: string, extra: Partial<StepSpec> = {}): StepSpec => ({ name, role: name, promptTemplate: 'prompts/p.md', ...extra });
const formula = (...steps: StepSpec[]): Formula => ({ name: 'cancel-it', description: 'cancel-it', whenToUse: '', steps });

function pack(...roles: string[]): Pack {
  const root = mkdtempSync(join(tmpdir(), 'cancel-it-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: roles.map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met within ${timeoutMs} ms: ${what}`);
}

describe.skipIf(!RUN_ISOLATED_BEADS)('cancel while a turn is in flight, on real bd (isolated repo)', () => {
  let h: Isolated;
  beforeAll(async () => { h = await provisionIsolatedBeads('fresh'); }, 120_000);
  afterAll(async () => { await h?.close(); }, 120_000);

  const show = (id: string): BdBead => (JSON.parse(h.bd('show', id, '--json')) as BdBead[])[0]!;

  /** A provider whose turns wait for `release`; with `releaseOnStop` they return the moment the session is stopped. */
  function gated(ending: Ending, opts: { readonly releaseOnStop?: boolean } = {}): { provider: FakeProvider; release: () => void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = newFakeProvider({
      kind: 'fake-runtime',
      script: (): AsyncIterable<SessionEvent> => (async function* () {
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        await gate;
        if (ending === 'error') yield { kind: 'error', ts, code: 'fake-error', message: 'session stopped' };
        else yield { kind: 'message-delta', ts, text: 'done' };
        yield { kind: 'turn-done', ts };
      })(),
    });
    const provider: FakeProvider = opts.releaseOnStop ? { ...base, stop: async (handle) => { await base.stop(handle); release(); } } : base;
    return { provider, release };
  }

  function driven(provider: FakeProvider, cancelUnwindMs?: number) {
    return newDriven(h.store, {
      idPrefix: 'schema65', provider, walker: new MoleculeWalker(h.store), eventBus: new EventBus({ noPersist: true }),
      ...(cancelUnwindMs !== undefined ? { cancelUnwindMs } : {}),
    });
  }

  /** What bd says about a cancelled step: closed, with the cancel's record and no result. */
  function expectCancelledOnBd(stepId: string, when: string): void {
    const bead = show(stepId);
    expect(bead.status, `${when}: status`).toBe('closed');
    expect(bead.metadata?.exec?.error_trace, `${when}: error_trace`).toBe('cancelled');
    expect(bead.metadata?.exec?.output_payload, `${when}: output_payload`).toBeUndefined();
    expect(String(bead.close_reason ?? ''), `${when}: close_reason`).toBe('step failed: cancelled');
  }

  it.each([
    ['an error, under a retry policy', 'error' as const, { retry: { maxAttempts: 3, onExhausted: 'fail' as const, backoffMs: 0 } }],
    ['a normal reply', 'reply' as const, {}],
  ])('the stopped turn returns the moment its session is stopped, with %s: bd keeps the step cancelled and nothing is left open', async (_name, ending, extra) => {
    const { provider } = gated(ending, { releaseOnStop: true });
    const dispatcher = driven(provider);
    let moleculeId = '';
    const pending = dispatcher.run({ formula: formula(step('worker', extra), step('after', { dependsOn: ['worker'] })), pack: pack('worker', 'after'), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const worker = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => moleculeId !== '' && typeof show(worker()).metadata?.exec?.session_id === 'string', 'worker running with a session recorded on bd');

    const result = await dispatcher.cancel(moleculeId);
    await pending.catch(() => undefined);
    // Let any late write land: a bd write takes about 0.2 s.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    expectCancelledOnBd(worker(), 'after cancel and the turn');
    expect(show(worker()).metadata?.['gc.retry_attempt'] ?? 1, 'not reopened for a retry').toBe(1);
    const root = show(moleculeId);
    expect(root.status).toBe('closed');
    expect(root.metadata?.exec?.outcome).toBe('cancelled');
    // The dependent never started; a cancelled run closes it with the run (vibesync-9lzk.60).
    const after = show(newMoleculeStepId(moleculeId, 'after'));
    expect(after.status).toBe('closed');
    expect(String(after.close_reason ?? '')).toBe('run cancelled');
    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['worker']);
  }, 90_000);

  it('a turn that returns only after cancel() gave up waiting still writes nothing over the cancelled record', async () => {
    const { provider, release } = gated('reply');
    const dispatcher = driven(provider, 300);
    let moleculeId = '';
    const pending = dispatcher.run({ formula: formula(step('worker')), pack: pack('worker'), input: 'go', onStarted: (id) => { moleculeId = id; } });
    pending.catch(() => undefined);
    const worker = () => newMoleculeStepId(moleculeId, 'worker');
    await until(() => moleculeId !== '' && show(worker()).status === 'in_progress', 'worker in progress on bd');

    const result = await dispatcher.cancel(moleculeId);
    expect(result).toEqual({ moleculeId, cancelledStepCount: 1 });
    expectCancelledOnBd(worker(), 'after the wait ran out');
    expect(show(moleculeId).status).toBe('closed');

    release(); // the turn comes back long after
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expectCancelledOnBd(worker(), 'after the late turn');
    expect(show(moleculeId).metadata?.exec?.outcome).toBe('cancelled');
  }, 90_000);
});
