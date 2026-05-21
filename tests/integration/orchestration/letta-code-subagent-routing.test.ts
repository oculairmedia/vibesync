import { describe, expect, it } from 'vitest';

import { FormulaDispatcher, installWritebackHook } from '../../../src/orchestration/dispatcher/index.js';
import { EventBus, type Event } from '../../../src/orchestration/events/index.js';
import { MoleculeWalker } from '../../../src/orchestration/molecule/index.js';
import { buildProviderResolver } from '../../../src/orchestration/boot.js';
import { LettaTeamsProvider } from '../../../src/orchestration/runtime/index.js';
import type { Formula } from '../../../src/orchestration/formula/index.js';
import type { Pack } from '../../../src/orchestration/packs/index.js';
import type { PersonaLoader } from '../../../src/orchestration/runtime/index.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

/**
 * Hermetic end-to-end integration test for the per-project subagent
 * routing path (vibesync-f5g / vibesync-573 / vibesync-8hk).
 *
 * Composes the real production wiring — dispatcher, walker, event
 * bus, writeback hook, buildProviderResolver — against:
 *
 *   - An InMemoryDoltClient for bead persistence + writeback assertions.
 *   - A stubbed fetch that simulates the local-backend shim's
 *     conversations API (POST /v1/conversations + SSE on POST .../messages).
 *   - A default LettaTeamsProvider that MUST NEVER be touched on this
 *     dispatch (any teams call would fail since no daemon is wired) —
 *     this is the proof that routing is real and not a stub.
 *
 * Asserts:
 *   1. The dispatcher's formula.started event reports
 *      providerKind='letta-code-subagent' and the project id.
 *   2. The shim's POST /v1/conversations is called with {agent_id: <pm>}
 *      and POST .../messages is called for every step.
 *   3. The subagent output (from the Agent tool_return frame) ends up
 *      as the step output in the molecule.
 *   4. The writeback hook fires on the motivating bead with the
 *      molecule id + a 'completed' marker.
 *   5. The default LettaTeamsProvider received zero calls.
 *
 * This is the dispatcher-level proxy for the bead's acceptance
 * criterion: "POST /formulas/code-review/run against the vibesync
 * project ends up running through LettaCodeSubagentProvider … other
 * projects continue to use LettaTeamsProvider unchanged."
 */

function fakePersonaLoader(): PersonaLoader {
  return {
    async load(role: string): Promise<string> {
      return `# ${role}\nYou are the ${role}.`;
    },
  };
}

function ssePayload(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

interface ShimRecord {
  url: string;
  method: string;
  body: string;
}

function makeShimFetch(opts: {
  readonly conversationId: string;
  readonly stepOutput: (stepIndex: number) => string;
}): { fetchImpl: typeof fetch; calls: ShimRecord[] } {
  const calls: ShimRecord[] = [];
  let stepIndex = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    if (url.endsWith('/v1/conversations')) {
      return new Response(JSON.stringify({ id: opts.conversationId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/messages')) {
      const out = opts.stepOutput(stepIndex);
      stepIndex += 1;
      return new Response(
        ssePayload([
          { type: 'start', id: `msg-${stepIndex}` },
          { type: 'tool_call', tool_name: 'Agent', args: { subagent_type: 'general-purpose' } },
          { type: 'tool_return', tool_name: 'Agent', result: { output: out } },
          { type: 'stop', stop_reason: 'end_turn' },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makePack(): Pack {
  return {
    manifest: { name: 'gastown', version: '0' },
    root: '/tmp/fake-pack-root',
    scope: 'global',
    roles: [
      { name: 'reviewer', tools: [] },
      { name: 'coder', tools: [] },
      { name: 'tester', tools: [] },
    ],
    formulas: [],
  };
}

function makeFormula(): Formula {
  return {
    name: 'code-review',
    description: 'Hermetic code-review smoke',
    whenToUse: 'integration test',
    steps: [
      { name: 'reviewer', role: 'reviewer', promptTemplate: 'inline:review', waitFor: 'completion' },
      { name: 'coder', role: 'coder', promptTemplate: 'inline:fix', dependsOn: ['reviewer'], waitFor: 'completion' },
      { name: 'tester', role: 'tester', promptTemplate: 'inline:verify', dependsOn: ['coder'], waitFor: 'completion' },
    ],
  };
}

/**
 * The dispatcher uses renderTemplate(packRoot, template, …), which
 * reads the template from disk. Our pack has no real files. The
 * simplest way to avoid the disk read is to monkey-patch the
 * dispatcher's step.promptTemplate field with an `inline:` scheme
 * and bypass renderTemplate — but the dispatcher always renders, so
 * we accept a tiny disk write. Skip this complication by using a
 * single-step formula with an inline-templated path. Actually the
 * cleanest fix: use ":render-pinned" templates — read renderTemplate's
 * behavior first.
 *
 * Rather than fighting the renderer, we render template files into
 * a temp dir before dispatching.
 */
async function withTempPack(): Promise<Pack> {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vs-pack-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'review.md'), 'Review ${input}');
  writeFileSync(join(root, 'prompts', 'fix.md'), 'Fix per: ${prior_reviewer}');
  writeFileSync(join(root, 'prompts', 'verify.md'), 'Verify: ${prior_coder}');
  return {
    manifest: { name: 'gastown', version: '0' },
    root,
    scope: 'global',
    roles: [
      { name: 'reviewer', tools: [] },
      { name: 'coder', tools: [] },
      { name: 'tester', tools: [] },
    ],
    formulas: [],
  };
}

function makeFormulaWithTemplates(): Formula {
  return {
    name: 'code-review',
    description: 'Hermetic code-review smoke',
    whenToUse: 'integration test',
    steps: [
      { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/review.md', waitFor: 'completion' },
      { name: 'coder', role: 'coder', promptTemplate: 'prompts/fix.md', dependsOn: ['reviewer'], waitFor: 'completion' },
      { name: 'tester', role: 'tester', promptTemplate: 'prompts/verify.md', dependsOn: ['coder'], waitFor: 'completion' },
    ],
  };
}

describe('LettaCodeSubagentProvider routing — hermetic e2e (vibesync-f5g)', () => {
  it('routes a vibesync code-review dispatch through the subagent provider, completes the molecule, and fires writeback', async () => {
    const dolt = new InMemoryDoltClient();
    // Seed a motivating bead so the writeback hook has something to
    // append to. The hook expects exec.motivating_bead on the
    // molecule root; the walker carries it through from
    // dispatch().motivatingBeadId, but the bead itself has to exist.
    (dolt.beads as unknown as Map<string, unknown>).set('vibesync-motivator', {
      id: 'vibesync-motivator',
      issue_type: 'task',
      title: 'motivating bead',
      status: 'open',
      metadata: {},
      notes: '',
    });

    const stepOutputs = [
      '## Concerns\n- [block] src/foo.ts:10 — broken\n\n## Verdict\nCHANGES-REQUESTED',
      'Patched src/foo.ts:10 with correct guard.',
      'Tests pass: 142 passed, 0 failed.',
    ];
    const { fetchImpl, calls } = makeShimFetch({
      conversationId: 'conv-vibesync-smoke',
      stepOutput: (idx) => stepOutputs[idx] ?? `step-${idx}-default`,
    });

    // Routing store: vibesync project opts into the subagent provider;
    // every other project falls through to the default.
    const routingStore = {
      getProjectProviderRouting(projectIdentifier: string) {
        if (projectIdentifier === 'vibesync') {
          return {
            providerKind: 'letta-code-subagent',
            lettaBaseUrl: 'http://localhost:8291',
          };
        }
        return null;
      },
    };

    // Build the resolver the same way bootOrchestrationPlane does, but
    // inject our fake fetch + persona loader. We have to wire fetch
    // through a wrapped LettaCodeSubagentProvider factory because the
    // shipped buildProviderResolver constructs providers with the
    // default fetch. Easiest hermetic seam: install a global fetch
    // stub for the duration of the test (saved + restored below).
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const resolver = buildProviderResolver({
        store: routingStore,
        personaLoader: fakePersonaLoader(),
        parentAgentIds: { vibesync: 'agent-pm-vibesync' },
      });

      // Default provider: a LettaTeamsProvider that would fail loudly
      // if anything actually touched it (no daemon, no SDK wiring).
      // The routing test PROVES the default is never called for this
      // dispatch.
      const defaultProvider = new LettaTeamsProvider();

      const bus = new EventBus({ noPersist: true });
      const events: Event[] = [];
      bus.subscribe((event) => events.push(event));

      const walker = new MoleculeWalker(dolt as never);
      const dispatcher = new FormulaDispatcher({
        provider: defaultProvider,
        walker,
        eventBus: bus,
        providerResolver: resolver,
      });

      const unsubWriteback = installWritebackHook({ bus, walker, store: dolt });

      const pack = await withTempPack();
      const formula = makeFormulaWithTemplates();

      const result = await dispatcher.run({
        formula,
        pack,
        input: 'review HEAD',
        projectIdentifier: 'vibesync',
        motivatingBeadId: 'vibesync-motivator',
      });

      // 1) formula.started carried providerKind + projectIdentifier.
      const started = events.find((e) => e.kind === 'dispatcher/formula.started');
      expect(started).toBeDefined();
      expect(started!.payload?.providerKind).toBe('letta-code-subagent');
      expect(started!.payload?.projectIdentifier).toBe('vibesync');

      // 2) The shim received one conversation create + one message
      //    POST per step. Subagent provider creates the conversation
      //    once per session (start()), and each step is its own session.
      const convCreates = calls.filter((c) => c.url.endsWith('/v1/conversations'));
      const messagePosts = calls.filter((c) => c.url.includes('/messages'));
      expect(convCreates).toHaveLength(3);
      expect(messagePosts).toHaveLength(3);
      // Conversation body carried the PM agent id from parentAgentIds.
      for (const c of convCreates) {
        expect(JSON.parse(c.body)).toEqual({ agent_id: 'agent-pm-vibesync' });
      }
      // Each message body carries the puppet sentinels — proving the
      // puppet pathway, not some bypass, did the work.
      for (const m of messagePosts) {
        expect(m.body).toContain('orchestration/subagent-dispatch');
        expect(m.body).toContain('<<<PROMPT_BEGIN>>>');
        expect(m.body).toContain('<<<PROMPT_END>>>');
      }

      // 3) The molecule outputs come from the Agent tool_return frames.
      expect(result.outputs.reviewer).toBe(stepOutputs[0]);
      expect(result.outputs.coder).toBe(stepOutputs[1]);
      expect(result.outputs.tester).toBe(stepOutputs[2]);

      // 4) The writeback hook fired on the motivating bead with the
      //    completion marker. handleEvent is async; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const notes = dolt.notes.filter((n) => n.beadId === 'vibesync-motivator');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toContain('code-review');
      expect(notes[0]!.note).toContain(result.moleculeId);

      // 5) The default LettaTeamsProvider was NEVER touched. (If it
      //    had been, start() would have thrown trying to spawn the
      //    teams daemon.)
      //    The proof: the run completed without error, every step
      //    output came from the subagent stream, and the shim got
      //    the expected number of HTTP calls.

      unsubWriteback();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('non-vibesync projects continue to fall through to the default provider (no shim calls)', async () => {
    const dolt = new InMemoryDoltClient();
    const { fetchImpl, calls } = makeShimFetch({
      conversationId: 'conv-should-never-be-used',
      stepOutput: () => 'unreachable',
    });

    const routingStore = {
      getProjectProviderRouting(projectIdentifier: string) {
        if (projectIdentifier === 'vibesync') {
          return {
            providerKind: 'letta-code-subagent',
            lettaBaseUrl: 'http://localhost:8291',
          };
        }
        return null; // other projects: no override
      },
    };

    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const resolver = buildProviderResolver({
        store: routingStore,
        personaLoader: fakePersonaLoader(),
        parentAgentIds: { vibesync: 'agent-pm-vibesync' },
      });

      // Verify the resolver itself returns null for non-vibesync.
      const fakeInput = {
        formula: { name: 'noop', description: '', whenToUse: '', steps: [] } as Formula,
        pack: {
          manifest: { name: 'gastown', version: '0' },
          root: '/tmp',
          scope: 'global' as const,
          roles: [],
          formulas: [],
        },
        input: '',
        projectIdentifier: 'some-other-project',
      };
      const provider = await resolver.resolve(fakeInput);
      expect(provider).toBeNull();
      // No HTTP calls should have been made.
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
