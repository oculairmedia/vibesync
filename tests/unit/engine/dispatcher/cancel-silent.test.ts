import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EventBus } from '../../../../src/engine/events/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { SessionEvent } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const formula = { name: 'silent', description: '', whenToUse: '', steps: [{ name: 'worker', role: 'worker', promptTemplate: 'prompts/worker.md', waitFor: 'completion' as const }] };
function pack() {
  const root = mkdtempSync(join(tmpdir(), 'cancel-silent-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts/worker.md'), 'Run ${input}');
  return { manifest: { name: 'test', version: '1.0.0' }, root, scope: 'project' as const, roles: [{ name: 'worker', memoryBlocks: [] }], formulas: [] };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(1); }
  throw new Error('condition not reached');
}
function setup(script: () => AsyncIterable<SessionEvent>, stuckStop = false) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ script });
  if (stuckStop) provider.stop = () => new Promise(() => undefined);
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), attemptStopTimeoutMs: 30, cancelUnwindMs: 100 });
  return { dispatcher, provider };
}
function live(dispatcher: ReturnType<typeof newDriven>, id: string) {
  return (dispatcher as unknown as { live: Map<string, { running: number; cancelController: AbortController }> }).live.get(id)!;
}

it('cancellation releases a silent attempt even when stop never settles', async () => {
  let observing = false;
  const h = setup(() => (async function* () { observing = true; await new Promise(() => undefined); })(), true);
  let id = '';
  const pending = h.dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
  const outcome = pending.then(() => 'resolved', (error: Error) => error.message);
  await until(() => observing);
  const run = live(h.dispatcher, id);
  expect(run.running).toBe(1);
  await h.dispatcher.cancel(id);
  expect(await Promise.race([outcome, delay(400).then(() => 'timeout')])).toMatch(/cancelled/i);
  expect(run.running).toBe(0);
  expect(h.dispatcher.liveMoleculeIds()).not.toContain(id);
}, 3000);

it('slow events complete normally, remove the listener, and ignore a later abort', async () => {
  let observing = false;
  const h = setup(() => (async function* (): AsyncIterable<SessionEvent> {
    observing = true;
    await delay(40);
    yield { kind: 'message-delta', ts: new Date().toISOString(), text: 'done' };
    await delay(40);
    yield { kind: 'turn-done', ts: new Date().toISOString() };
  })());
  let id = '';
  const pending = h.dispatcher.run({ formula, pack: pack(), input: 'go', onStarted: (value) => { id = value; } });
  await until(() => observing);
  const run = live(h.dispatcher, id);
  expect(getEventListeners(run.cancelController.signal, 'abort')).toHaveLength(1);
  await pending;
  expect(run.cancelController.signal.aborted).toBe(false);
  expect(getEventListeners(run.cancelController.signal, 'abort')).toHaveLength(0);
  run.cancelController.abort();
  await delay(10);
  expect(run.running).toBe(0);
  expect(h.dispatcher.liveMoleculeIds()).not.toContain(id);
});
