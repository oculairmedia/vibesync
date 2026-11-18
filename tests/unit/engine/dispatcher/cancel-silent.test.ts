import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const formula: Formula = { name: 'silent', description: '', whenToUse: '', steps: [{ name: 'worker', role: 'worker', promptTemplate: 'prompts/worker.md', waitFor: 'completion' }] };
function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'silent-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts/worker.md'), 'Run ${input}');
  return { manifest: { name: 'test', version: '1.0.0' }, root, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }], formulas: [] };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 1)); }
  throw new Error('condition not reached');
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('interrupting a silent observation', () => {
  it('settles the run and releases its slot even when observation and stop never resolve', async () => {
    let observing = false;
    const base = newFakeProvider({ script: () => (async function* (): AsyncIterable<SessionEvent> {
      observing = true;
      await new Promise<void>(() => undefined);
    })() });
    const provider = { ...base, stop: () => new Promise<void>(() => undefined) };
    const store = new InMemoryDoltClient();
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), attemptStopTimeoutMs: 25, cancelUnwindMs: 100 });
    let id = '';
    const run = dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
    const outcome = run.then(() => 'resolved', (error: Error) => error.message);
    await until(() => observing);
    const cancel = dispatcher.cancel(id);
    const result = await Promise.race([outcome, delay(500).then(() => 'still pending')]);
    expect(result).toMatch(/cancel/i);
    await cancel;
    expect((dispatcher as unknown as { live: Map<string, unknown> }).live.has(id)).toBe(false);
  });

  it('completes a slow stream without retaining an abort listener, and late cancellation has no effect', async () => {
    const provider = newFakeProvider({ script: () => (async function* (): AsyncIterable<SessionEvent> {
      await delay(10);
      yield { kind: 'message-delta', ts: new Date().toISOString(), text: 'done' };
      await delay(10);
      yield { kind: 'turn-done', ts: new Date().toISOString() };
    })() });
    const store = new InMemoryDoltClient();
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    let id = '';
    const pending = dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
    await until(() => id !== '');
    const controller = (dispatcher as unknown as { live: Map<string, { cancelController: AbortController }> }).live.get(id)!.cancelController;
    const result = await pending;
    expect(result.outputs.worker).toBe('done');
    expect(controller.signal.aborted).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(result.outputs.worker).toBe('done');
  });
});
