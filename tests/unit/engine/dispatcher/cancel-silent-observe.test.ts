import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EventBus } from '../../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const formula: Formula = { name: 'silent', description: '', whenToUse: '', steps: [{ name: 'worker', role: 'worker', promptTemplate: 'prompts/worker.md', waitFor: 'completion' }] };
function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'silent-observe-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts/worker.md'), 'Run ${input}');
  return { manifest: { name: 'test', version: '1.0.0' }, root, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }], formulas: [] };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}

it('settles a cancelled silent observation even when stop never settles', async () => {
  let observing = false;
  const base = newFakeProvider({ script: () => ({ [Symbol.asyncIterator]: () => ({ next: () => { observing = true; return new Promise(() => undefined); } }) }) });
  const provider = { ...base, stop: () => new Promise<void>(() => undefined) };
  const store = new InMemoryDoltClient();
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), attemptStopTimeoutMs: 30, cancelUnwindMs: 300 });
  let id = '';
  const pending = dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
  const told = pending.then(() => 'resolved', (error: Error) => error.message);
  await until(() => observing);
  await dispatcher.cancel(id);
  const result = await Promise.race([told, new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 1000))]);
  expect(result).toContain('was cancelled');
  expect(dispatcher.liveMoleculeIds()).not.toContain(id);
});

it('settles cancellation when iterator closure never resolves', async () => {
  let closing = false;
  const base = newFakeProvider({ script: () => ({ [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: false as const, value: { kind: 'turn-done' as const, ts: new Date().toISOString() } }),
    return: () => { closing = true; return new Promise<IteratorResult<never>>(() => undefined); },
  }) }) });
  const provider = { ...base, stop: () => new Promise<void>(() => undefined) };
  const store = new InMemoryDoltClient();
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), attemptStopTimeoutMs: 100, cancelUnwindMs: 300 });
  let id = '';
  const pending = dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
  const told = pending.then(() => 'resolved', (error: Error) => error.message);
  await until(() => closing);
  await dispatcher.cancel(id);
  const result = await Promise.race([told, new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 1000))]);
  expect(result).toContain('was cancelled');
  expect(dispatcher.liveMoleculeIds()).not.toContain(id);
});

it('finishes a slow stream and removes the abort listener before a late abort', async () => {
  const controllers: AbortController[] = [];
  const Original = globalThis.AbortController;
  vi.stubGlobal('AbortController', class extends Original {
    constructor() { super(); controllers.push(this); }
  });
  try {
    const provider = newFakeProvider({ script: () => (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { kind: 'message-delta' as const, ts: new Date().toISOString(), text: 'done' };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { kind: 'turn-done' as const, ts: new Date().toISOString() };
    })() });
    const store = new InMemoryDoltClient();
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    await dispatcher.run({ formula, pack: pack(), input: 'go' });
    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.signal.aborted).toBe(false);
    expect(getEventListeners(controllers[0]!.signal, 'abort')).toHaveLength(0);
    controllers[0]!.abort();
    expect(dispatcher.liveMoleculeIds()).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});
