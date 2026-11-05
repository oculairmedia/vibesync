import { describe, expect, it } from 'vitest';

import {
  buildProviderResolver,
  StaleProviderRoutingError,
  wrapWithParentAgentId,
  type ProjectProviderRoutingStore,
} from '../../../src/engine/boot.js';
import type {
  ContentBlock,
  IrohWrapperProvider,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from '../../../src/engine/runtime/index.js';
import type { DispatchInput } from '../../../src/engine/dispatcher/index.js';

/**
 * Per-project routing (vibesync-f5g / vibesync-8hk, vibesync-9lzk.29).
 *
 *   buildProviderResolver: reads projects.provider_kind and returns null
 *     (use the default provider) or the shared Iroh provider wrapped with
 *     the project's PM parent agent id. letta-code-iroh is the only kind:
 *     any other stored value throws StaleProviderRoutingError, never a
 *     silent fallback.
 *
 *   wrapWithParentAgentId: injects extra.parentAgentId into start().
 */

function fakeStore(routings: Record<string, {
  readonly providerKind: string | null;
  readonly parentAgentId?: string | null;
} | null>): ProjectProviderRoutingStore {
  return {
    getProjectProviderRouting(projectIdentifier) {
      const v = routings[projectIdentifier];
      return v === undefined ? null : v;
    },
  };
}

/** A stand-in Iroh provider: the resolver only wraps it, never dials. */
function fakeIroh(): { readonly provider: IrohWrapperProvider; readonly specs: SessionSpec[] } {
  const specs: SessionSpec[] = [];
  const provider = {
    kind: 'letta-code-iroh',
    async start(spec: SessionSpec): Promise<SessionHandle> {
      specs.push(spec);
      return { id: 'iroh:1', providerKind: 'letta-code-iroh' };
    },
    async stop(): Promise<void> {},
    async prompt(): Promise<PromptResult> { return {}; },
    async nudge(): Promise<void> {},
    async *observe(): AsyncIterable<SessionEvent> { /* no events */ },
  } as unknown as IrohWrapperProvider;
  return { provider, specs };
}

function inputFor(projectIdentifier: string | undefined): DispatchInput {
  return {
    formula: { name: 'noop', description: '', whenToUse: '', steps: [] },
    pack: { manifest: { name: 'gastown', version: '0' }, root: '/', scope: 'global', roles: [], formulas: [] },
    input: '',
    ...(projectIdentifier ? { projectIdentifier } : {}),
  };
}

describe('buildProviderResolver', () => {
  it('returns null when the dispatch has no projectIdentifier', async () => {
    const resolver = buildProviderResolver({ store: fakeStore({}) });
    expect(await resolver.resolve(inputFor(undefined))).toBeNull();
  });

  it('returns null when the project has no routing row', async () => {
    const resolver = buildProviderResolver({ store: fakeStore({}) });
    expect(await resolver.resolve(inputFor('unknown'))).toBeNull();
  });

  it('returns null when the row exists but provider_kind is unset (use default)', async () => {
    const resolver = buildProviderResolver({ store: fakeStore({ vibesync: { providerKind: null } }) });
    expect(await resolver.resolve(inputFor('vibesync'))).toBeNull();
  });

  it('routes letta-code-iroh to the shared Iroh provider with the project PM as parent', async () => {
    const iroh = fakeIroh();
    const resolver = buildProviderResolver({
      store: fakeStore({ vibesync: { providerKind: 'letta-code-iroh', parentAgentId: 'agent-pm' } }),
      irohProvider: () => iroh.provider,
    });
    const provider = await resolver.resolve(inputFor('vibesync'));
    expect(provider?.kind).toBe('letta-code-iroh');
    await provider!.start({ role: 'coder' });
    expect(iroh.specs[0]?.extra?.['parentAgentId']).toBe('agent-pm');
  });

  it('builds the shared Iroh provider once across projects and resolves', async () => {
    let built = 0;
    const iroh = fakeIroh();
    const resolver = buildProviderResolver({
      store: fakeStore({
        a: { providerKind: 'letta-code-iroh', parentAgentId: 'agent-pm-a' },
        b: { providerKind: 'letta-code-iroh', parentAgentId: 'agent-pm-b' },
      }),
      irohProvider: () => { built += 1; return iroh.provider; },
    });
    await resolver.resolve(inputFor('a'));
    await resolver.resolve(inputFor('b'));
    await resolver.resolve(inputFor('a'));
    expect(built).toBe(1);
  });

  it('uses the static parentAgentIds map when the routing row has no parent id', async () => {
    const iroh = fakeIroh();
    const resolver = buildProviderResolver({
      store: fakeStore({ vibesync: { providerKind: 'letta-code-iroh' } }),
      parentAgentIds: { vibesync: 'agent-pm' },
      irohProvider: () => iroh.provider,
    });
    const provider = await resolver.resolve(inputFor('vibesync'));
    await provider!.start({ role: 'coder' });
    expect(iroh.specs[0]?.extra?.['parentAgentId']).toBe('agent-pm');
  });

  it('uses the default provider when an Iroh row has no parent agent id', async () => {
    const resolver = buildProviderResolver({
      store: fakeStore({ vibesync: { providerKind: 'letta-code-iroh' } }),
      irohProvider: () => fakeIroh().provider,
    });
    expect(await resolver.resolve(inputFor('vibesync'))).toBeNull();
  });

  // vibesync-9lzk.29: the production registry still held these rows
  // (letta-mobile, letta-code-parallel -> letta-code-subagent at the dead
  // :8291 shim). They must fail loudly, naming the project and the kind.
  for (const staleKind of ['letta-code-subagent', 'letta-teams', 'mystery-runtime']) {
    it(`a stale provider_kind='${staleKind}' row throws instead of falling back`, async () => {
      const resolver = buildProviderResolver({
        store: fakeStore({ 'letta-mobile': { providerKind: staleKind, parentAgentId: 'agent-pm' } }),
        irohProvider: () => fakeIroh().provider,
      });
      expect(() => resolver.resolve(inputFor('letta-mobile'))).toThrow(StaleProviderRoutingError);
      expect(() => resolver.resolve(inputFor('letta-mobile'))).toThrow(
        `project letta-mobile routes to provider_kind='${staleKind}', which was removed`,
      );
    });
  }
});

describe('wrapWithParentAgentId', () => {
  function fakeProviderRecorder() {
    const specs: SessionSpec[] = [];
    const stops: SessionHandle[] = [];
    const prompts: { handle: SessionHandle; content: readonly ContentBlock[] }[] = [];
    const nudges: SessionHandle[] = [];
    const provider: RuntimeProvider = {
      kind: 'fake',
      async start(spec: SessionSpec): Promise<SessionHandle> {
        specs.push(spec);
        return { id: `fake:${spec.role}`, providerKind: 'fake' };
      },
      async stop(handle: SessionHandle): Promise<void> { stops.push(handle); },
      async prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult> {
        prompts.push({ handle, content });
        return { taskId: 'task-1' };
      },
      async nudge(handle: SessionHandle): Promise<void> { nudges.push(handle); },
      async *observe(_: SessionHandle): AsyncIterable<SessionEvent> {
        yield { kind: 'started', ts: 'x' };
        yield { kind: 'turn-done', ts: 'x' };
      },
    };
    return { provider, specs, stops, prompts, nudges };
  }

  it('injects extra.parentAgentId into start() without disturbing other keys', async () => {
    const inner = fakeProviderRecorder();
    const wrapped = wrapWithParentAgentId(inner.provider, 'agent-pm-9');
    await wrapped.start({
      role: 'reviewer',
      extra: { moleculeId: 'mol-1', stepName: 'reviewer' },
    });
    expect(inner.specs).toHaveLength(1);
    const ext = inner.specs[0]!.extra as Record<string, unknown>;
    expect(ext['parentAgentId']).toBe('agent-pm-9');
    expect(ext['moleculeId']).toBe('mol-1');
    expect(ext['stepName']).toBe('reviewer');
  });

  it('injects parentAgentId when no extra is supplied at all', async () => {
    const inner = fakeProviderRecorder();
    const wrapped = wrapWithParentAgentId(inner.provider, 'agent-pm-9');
    await wrapped.start({ role: 'reviewer' });
    const ext = inner.specs[0]!.extra as Record<string, unknown>;
    expect(ext['parentAgentId']).toBe('agent-pm-9');
  });

  it('caller-supplied parentAgentId on extra is overridden by the wrapper', async () => {
    const inner = fakeProviderRecorder();
    const wrapped = wrapWithParentAgentId(inner.provider, 'agent-pm-new');
    await wrapped.start({
      role: 'reviewer',
      extra: { parentAgentId: 'agent-pm-old' },
    });
    const ext = inner.specs[0]!.extra as Record<string, unknown>;
    expect(ext['parentAgentId']).toBe('agent-pm-new');
  });

  it('delegates stop/prompt/nudge/observe verbatim to the inner provider', async () => {
    const inner = fakeProviderRecorder();
    const wrapped = wrapWithParentAgentId(inner.provider, 'agent-pm-9');
    const handle = await wrapped.start({ role: 'reviewer' });
    await wrapped.prompt(handle, [{ type: 'text', text: 'hi' }]);
    await wrapped.nudge(handle);
    const events: SessionEvent[] = [];
    for await (const ev of wrapped.observe(handle)) events.push(ev);
    await wrapped.stop(handle);

    expect(inner.prompts).toHaveLength(1);
    expect(inner.nudges).toHaveLength(1);
    expect(inner.stops).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual(['started', 'turn-done']);
  });

  it('preserves the inner provider kind on the wrapper', () => {
    const inner = fakeProviderRecorder();
    const wrapped = wrapWithParentAgentId(inner.provider, 'agent-pm-9');
    expect(wrapped.kind).toBe('fake');
  });
});
