import { describe, expect, it } from 'vitest';

import {
  ACPProvider,
  A2UIProvider,
  type RuntimeProvider,
  type SessionEvent,
  type SessionHandle,
  type SessionSpec,
} from '../../../../src/orchestration/runtime/index.js';

/**
 * Smoke tests for the SKELETON providers (0tw / oq4). Verify
 * constructor shape, handle-routing discipline, and provider-specific
 * spec validation. Full integration (real A2UI client, real ACP
 * agent) is deferred to follow-up beads once the consumer side
 * stabilizes.
 */

describe('A2UIProvider', () => {
  it('requires inner SessionSpec', async () => {
    const fakeInner: RuntimeProvider = makeFakeProvider('inner');
    const provider = new A2UIProvider(fakeInner);
    await expect(provider.start({ role: 'r' })).rejects.toThrow(/spec.extra.inner/);
  });

  it('start delegates to the inner provider and wraps the handle', async () => {
    const fakeInner: RuntimeProvider = makeFakeProvider('inner');
    const provider = new A2UIProvider(fakeInner);
    const handle = await provider.start({
      role: 'r',
      extra: { inner: { role: 'r-inner' } },
    });
    expect(handle.providerKind).toBe('a2ui');
    expect(handle.id).toBe('a2ui:inner:r-inner-1');
  });

  it('prompt forwards content to the inner provider', async () => {
    const calls: ContentEventLog[] = [];
    const fakeInner: RuntimeProvider = makeFakeProvider('inner', { onPrompt: (h, c) => calls.push({ id: h.id, c: c.length }) });
    const provider = new A2UIProvider(fakeInner);
    const handle = await provider.start({ role: 'r', extra: { inner: { role: 'r-inner' } } });
    await provider.prompt(handle, [{ type: 'text', text: 'hi' }]);
    expect(calls).toEqual([{ id: 'inner:r-inner-1', c: 1 }]);
  });

  it('observe passes inner events through', async () => {
    const fakeInner: RuntimeProvider = makeFakeProvider('inner');
    const provider = new A2UIProvider(fakeInner);
    const handle = await provider.start({ role: 'r', extra: { inner: { role: 'r-inner' } } });
    const kinds: string[] = [];
    for await (const ev of provider.observe(handle)) kinds.push(ev.kind);
    expect(kinds).toEqual(['started', 'turn-done']);
  });
});

describe('ACPProvider', () => {
  it('requires extra.command', async () => {
    const provider = new ACPProvider();
    await expect(provider.start({ role: 'r' })).rejects.toThrow(/spec.extra.command is required/);
  });
});

interface ContentEventLog {
  readonly id: string;
  readonly c: number;
}

function makeFakeProvider(
  kind: string,
  hooks: { onPrompt?: (h: SessionHandle, c: readonly unknown[]) => void } = {},
): RuntimeProvider {
  let n = 0;
  return {
    kind,
    async start(spec: SessionSpec): Promise<SessionHandle> {
      n++;
      return { id: `${kind}:${spec.role}-${n}`, providerKind: kind };
    },
    async stop(): Promise<void> {},
    async prompt(h, c): Promise<void> {
      hooks.onPrompt?.(h, c);
    },
    async nudge(): Promise<void> {},
    observe(): AsyncIterable<SessionEvent> {
      const ts = new Date().toISOString();
      // eslint-disable-next-line require-yield
      return (async function* () {
        yield { kind: 'started', ts };
        yield { kind: 'turn-done', ts };
      })();
    },
  };
}
