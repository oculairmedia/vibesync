import { expect, it, vi } from 'vitest';
import { StepAttemptRunner, type StepAttemptDeps } from '../../../../src/engine/dispatcher/step-attempt.js';
import type { StepAttemptArgs } from '../../../../src/engine/dispatcher/types.js';
import type { SessionEvent, SessionHandle } from '../../../../src/engine/runtime/index.js';

const handle: SessionHandle = { id: 'session', providerKind: 'test' };
const event = (kind: 'error' | 'turn-done' | 'started'): SessionEvent => {
  const ts = new Date().toISOString();
  if (kind === 'error') return { kind, ts, code: 'test', message: 'provider error' };
  return { kind, ts };
};

function observe(iterator: AsyncIterator<SessionEvent>, options: { signal?: AbortSignal; cancelled?: () => boolean } = {}) {
  const runner = new StepAttemptRunner({ emitRuntimeSessionEvent: () => undefined } as unknown as StepAttemptDeps);
  const args = {
    provider: { observe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
    cancelSignal: options.signal,
    cancelled: options.cancelled,
  } as unknown as StepAttemptArgs;
  return runner['observeStepAttempt'](args, handle, undefined, undefined);
}

it.each(['error', 'cancelled', 'abort', 'turn-done'] as const)('requests closure once on %s', async (exit) => {
  const controller = new AbortController();
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const next = vi.fn((): Promise<IteratorResult<SessionEvent>> => {
    if (exit === 'abort') return new Promise(() => undefined);
    return Promise.resolve({ done: false, value: event(exit === 'cancelled' ? 'started' : exit) });
  });
  let checks = 0;
  const result = observe({ next, return: close }, {
    signal: controller.signal,
    cancelled: () => exit === 'cancelled' && ++checks === 2,
  });
  if (exit === 'abort') controller.abort();
  if (exit === 'error') await expect(result).rejects.toThrow('provider error');
  else await expect(result).resolves.toBeDefined();
  expect(close).toHaveBeenCalledTimes(1);
});

it('does not request closure after normal exhaustion', async () => {
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  await observe({ next: async () => ({ done: true, value: undefined }), return: close });
  expect(close).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'] as const)('preserves the event error when return %ss', async (failure) => {
  const close = vi.fn((): Promise<IteratorResult<SessionEvent>> => {
    if (failure === 'throw') throw new Error('close failed');
    return Promise.reject(new Error('close failed'));
  });
  await expect(observe({ next: async () => ({ done: false, value: event('error') }), return: close })).rejects.toThrow('provider error');
  expect(close).toHaveBeenCalledTimes(1);
});

it('runs a yielding generator finally on an error event', async () => {
  let closed = false;
  const stream = (async function* () {
    try { yield event('error'); } finally { closed = true; }
  })();
  await expect(observe(stream)).rejects.toThrow('provider error');
  expect(closed).toBe(true);
});
