import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FormulaDispatcher } from '../../../src/orchestration/dispatcher/index.js';
import { EventBus, type Event } from '../../../src/orchestration/events/index.js';
import { MoleculeWalker } from '../../../src/orchestration/molecule/index.js';
import { buildProviderResolver, buildRoleAgentContextResolver } from '../../../src/orchestration/boot.js';
import { LettaTeamsProvider } from '../../../src/orchestration/runtime/index.js';
import {
  RoleAgentBootstrapper,
  encodeAgentIdBase64Url,
  type RoleAgentSdkAdapter,
} from '../../../src/letta/RoleAgentBootstrapper.js';
import type { PersonaLoader } from '../../../src/orchestration/runtime/index.js';
import type { Formula } from '../../../src/orchestration/formula/index.js';
import type { Pack } from '../../../src/orchestration/packs/index.js';
import type {
  ProjectRoleAgentRecord,
  ProjectRoleAgentRepository,
} from '../../../src/database/repositories/ProjectRoleAgentRepository.js';
import type { CreateAgentOptions } from '@letta-ai/letta-code-sdk';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';

/**
 * Hermetic end-to-end integration test for the persistent role-agent
 * path (vibesync-mcz Phase F).
 *
 * Composes the real production wiring — FormulaDispatcher,
 * MoleculeWalker, EventBus, buildProviderResolver,
 * buildRoleAgentContextResolver, the real RoleAgentBootstrapper
 * writing to a tmp dir — against:
 *
 *   - InMemoryDoltClient for bead persistence.
 *   - InMemoryRoleAgentRepo standing in for ProjectRoleAgentRepository
 *     (avoids spinning up SQLite — the Phase A repo is its own
 *     unit-tested concern, this test focuses on the bootstrap +
 *     dispatch + provider wire).
 *   - A stubbed global fetch simulating the local-backend shim's
 *     conversations API.
 *   - A LettaTeamsProvider as the default — never touched on
 *     vibesync dispatches (any teams call would throw, no daemon
 *     wired). This is the proof routing is real.
 *
 * Asserts (the bead's three Phase F acceptance criteria):
 *   1. First dispatch creates a persistent-agent JSON file on disk
 *      AND a project_role_agents row.
 *   2. Second dispatch reuses the same agent_id; no new JSON file
 *      written.
 *   3. The provider's puppet message on the second dispatch carries
 *      `agent_id:` and does NOT include the persona block — the
 *      Phase C agent_id dispatch path is live end-to-end.
 *
 * Plus the per-step conversation_id isolation from Phase D (each
 * step gets a fresh conversation_id, persisted on the molecule step
 * bead).
 */

const PROJECT = 'vibesync';
const SHIM_URL = 'http://localhost:8291';

// ──────────────────────────────────────────────────────────────────────
// In-memory ProjectRoleAgentRepository stand-in
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory stand-in for ProjectRoleAgentRepository (Phase A).
 * Mirrors the subset of the repository surface the bootstrapper
 * touches — getRoleAgent + upsertRoleAgent — and tracks call counts
 * so the test can assert "the row was created once, reused on the
 * second dispatch".
 */
class InMemoryRoleAgentRepo
  implements Pick<ProjectRoleAgentRepository, 'getRoleAgent' | 'upsertRoleAgent'> {
  readonly rows = new Map<string, ProjectRoleAgentRecord>();
  upsertCount = 0;
  getCount = 0;

  private key(project: string, role: string): string {
    return `${project}::${role}`;
  }

  getRoleAgent(project: string, role: string): ProjectRoleAgentRecord | null {
    this.getCount += 1;
    return this.rows.get(this.key(project, role)) ?? null;
  }

  upsertRoleAgent(
    project: string,
    role: string,
    agentId: string,
    lettaBaseUrl: string,
    now: number = Date.now(),
  ): ProjectRoleAgentRecord {
    this.upsertCount += 1;
    const k = this.key(project, role);
    const existing = this.rows.get(k);
    const rec: ProjectRoleAgentRecord = {
      projectIdentifier: project,
      roleName: role,
      agentId,
      lettaBaseUrl,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    this.rows.set(k, rec);
    return rec;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Shim fetch stub
// ──────────────────────────────────────────────────────────────────────

interface ShimRecord {
  url: string;
  method: string;
  body: string;
}

function ssePayload(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function makeShimFetch(opts: {
  readonly conversationIds: readonly string[];
  readonly stepOutput: (stepIndex: number) => string;
}): { fetchImpl: typeof fetch; calls: ShimRecord[] } {
  const calls: ShimRecord[] = [];
  let convIndex = 0;
  let stepIndex = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    if (url.endsWith('/v1/conversations')) {
      const id = opts.conversationIds[convIndex] ?? `conv-extra-${convIndex}`;
      convIndex += 1;
      return new Response(JSON.stringify({ id }), {
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

// ──────────────────────────────────────────────────────────────────────
// Pack / formula fixtures
// ──────────────────────────────────────────────────────────────────────

interface PackPaths {
  readonly packDir: string;
  readonly storageDir: string;
  readonly pack: Pack;
}

/**
 * Build a real on-disk pack (with prompt templates AND
 * .letta/agents/<role>.md persona files the bootstrapper reads) plus
 * a fresh storage dir where role-agent JSON files will land.
 */
function makePackOnDisk(): PackPaths {
  const packDir = mkdtempSync(join(tmpdir(), 'vs-mcz-pack-'));
  const storageDir = mkdtempSync(join(tmpdir(), 'vs-mcz-storage-'));
  mkdirSync(join(packDir, 'prompts'), { recursive: true });
  writeFileSync(join(packDir, 'prompts', 'review.md'), 'Review ${input}');
  mkdirSync(join(packDir, '.letta', 'agents'), { recursive: true });
  writeFileSync(
    join(packDir, '.letta', 'agents', 'reviewer.md'),
    '---\nname: reviewer\n---\n\n# Reviewer\nYou are the reviewer. Be skeptical.\n',
  );
  const pack: Pack = {
    manifest: { name: 'gastown', version: '0' },
    root: packDir,
    scope: 'global',
    roles: [{ name: 'reviewer', tools: [] }],
    formulas: [],
  };
  return { packDir, storageDir, pack };
}

// ──────────────────────────────────────────────────────────────────────
// SDK stub
// ──────────────────────────────────────────────────────────────────────

/**
 * Fake SDK adapter that mimics @letta-ai/letta-code-sdk's createAgent
 * by writing the on-disk JSON file the real letta-code subprocess
 * would write. We do this in the TEST so the existing disk-shape
 * post-condition assertions (`agents/<b64url(id)>.json` exists, only
 * one file after second dispatch) remain meaningful — they're now
 * proving "the SDK contract produces the shim-readable file the
 * bootstrapper expects".
 *
 * In production the real SDK + letta-code subprocess write the file.
 * In the test we don't want a real subprocess, so the stub stands in.
 */
function makeFakeSdk(opts: {
  readonly storageDir: string;
  readonly idGenerator: () => string;
}): RoleAgentSdkAdapter & {
  readonly calls: CreateAgentOptions[];
  readonly knownAgents: Set<string>;
} {
  const calls: CreateAgentOptions[] = [];
  const knownAgents = new Set<string>();
  return {
    calls,
    knownAgents,
    async createAgent(options) {
      calls.push(options);
      const id = opts.idGenerator();
      knownAgents.add(id);
      // Mirror the on-disk shape the shim reads. We don't need the
      // full schema — just enough that filename + presence assert
      // correctly, which is what the shim cares about for listing.
      const agentsDir = join(opts.storageDir, 'agents');
      await fsMkdir(agentsDir, { recursive: true });
      const filename = `${encodeAgentIdBase64Url(id)}.json`;
      const payload = {
        id,
        system: typeof options.systemPrompt === 'string' ? options.systemPrompt : '',
        model: options.model,
        tags: options.tags ?? [],
      };
      await fsWriteFile(join(agentsDir, filename), JSON.stringify(payload, null, 2), 'utf8');
      return id;
    },
    async agentExists(agentId: string) {
      return knownAgents.has(agentId);
    },
  };
}

function makeFormula(): Formula {
  return {
    name: 'single-review',
    description: 'Hermetic single-step persistent-agent smoke',
    whenToUse: 'integration test',
    steps: [{ name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/review.md', waitFor: 'completion' }],
  };
}

function fakePersonaLoader(): PersonaLoader {
  return {
    async load(role: string): Promise<string> {
      // Should NOT be reached on the persistent path — assert it's
      // not called by failing loud if it is.
      throw new Error(`fakePersonaLoader: unexpected load() for role=${role}`);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────

interface Harness {
  readonly dispatcher: FormulaDispatcher;
  readonly walker: MoleculeWalker;
  readonly bus: EventBus;
  readonly events: Event[];
  readonly repo: InMemoryRoleAgentRepo;
  readonly bootstrapper: RoleAgentBootstrapper;
  readonly packPaths: PackPaths;
  readonly calls: ShimRecord[];
  cleanup(): void;
}

function buildHarness(opts: {
  readonly fetchImpl: typeof fetch;
  readonly calls: ShimRecord[];
  readonly idGenerator?: () => string;
}): Harness {
  const dolt = new InMemoryDoltClient();
  const repo = new InMemoryRoleAgentRepo();
  const packPaths = makePackOnDisk();
  // SDK stub: deterministic ids + writes the on-disk JSON the shim
  // would read. envBackendDir is injected (not via process.env) so
  // the test doesn't leak env state into other suites running in
  // the same vitest worker.
  const sdk = makeFakeSdk({
    storageDir: packPaths.storageDir,
    idGenerator: opts.idGenerator ?? (() => 'agent-stub-1'),
  });
  const bootstrapper = new RoleAgentBootstrapper({
    repo,
    sdk,
    envBackendDir: () => packPaths.storageDir,
  });

  const routingStore = {
    getProjectProviderRouting(projectIdentifier: string) {
      if (projectIdentifier === PROJECT) {
        return { providerKind: 'letta-code-subagent', lettaBaseUrl: SHIM_URL };
      }
      return null;
    },
  };

  // fakePersonaLoader THROWS if called — proves the agent_id path
  // bypasses the persona loader entirely on the persistent path.
  const providerResolver = buildProviderResolver({
    store: routingStore,
    personaLoader: fakePersonaLoader(),
    parentAgentIds: { [PROJECT]: 'agent-pm-vibesync' },
  });

  const roleAgentContextResolver = buildRoleAgentContextResolver({
    store: routingStore,
    roleAgentBootstrapper: bootstrapper,
    packDirsByProject: { [PROJECT]: packPaths.packDir },
    storageDirsByProject: { [PROJECT]: packPaths.storageDir },
  });

  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((event) => events.push(event));

  const walker = new MoleculeWalker(dolt as never);
  const dispatcher = new FormulaDispatcher({
    provider: new LettaTeamsProvider(),
    walker,
    eventBus: bus,
    providerResolver,
    roleAgentContextResolver,
    // Deterministic conversation_ids let us pin the per-step IDs in
    // assertions below.
    conversationIdGenerator: (() => {
      let n = 0;
      return { next: () => `conv-test-${++n}` };
    })(),
  });

  void opts.fetchImpl;
  return {
    dispatcher,
    walker,
    bus,
    events,
    repo,
    bootstrapper,
    packPaths,
    calls: opts.calls,
    cleanup() {
      // Nothing to do — tmp dirs leak by design (OS cleans /tmp).
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('persistent role-agent routing — hermetic e2e (vibesync-mcz Phase F)', () => {
  it('first dispatch bootstraps; second dispatch reuses the same agent_id and skips persona inlining', async () => {
    const { fetchImpl, calls } = makeShimFetch({
      // 6 conversation creates expected: 2 dispatches × (1 puppet
      // conversation for the parent PM agent's send). The shim's
      // POST /v1/conversations is hit once per session (once per
      // step) — we have 1 step × 2 dispatches = 2.
      conversationIds: ['conv-shim-1', 'conv-shim-2', 'conv-shim-3', 'conv-shim-4'],
      stepOutput: (idx) => `verdict-${idx + 1}: LGTM`,
    });

    let mintedIds = 0;
    const idGenerator = (): string => `agent-reviewer-vibesync-${++mintedIds}`;

    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const h = buildHarness({ fetchImpl, calls, idGenerator });

      // ── First dispatch ────────────────────────────────────────
      const first = await h.dispatcher.run({
        formula: makeFormula(),
        pack: h.packPaths.pack,
        input: 'review HEAD',
        projectIdentifier: PROJECT,
      });

      // Acceptance #1: a persistent-agent JSON file exists on disk.
      expect(h.repo.upsertCount).toBe(1);
      const row = h.repo.rows.get(`${PROJECT}::reviewer`);
      expect(row).toBeDefined();
      expect(row!.agentId).toBe('agent-reviewer-vibesync-1');
      expect(row!.lettaBaseUrl).toBe(SHIM_URL);

      const agentsDir = join(h.packPaths.storageDir, 'agents');
      const filesAfterFirst = readdirSync(agentsDir);
      expect(filesAfterFirst).toHaveLength(1);
      const expectedFilename = `${encodeAgentIdBase64Url(row!.agentId)}.json`;
      expect(filesAfterFirst[0]).toBe(expectedFilename);
      expect(existsSync(join(agentsDir, expectedFilename))).toBe(true);

      // First dispatch's puppet ALSO went through the agent_id path
      // (bootstrapper runs before provider.start; provider sees
      // extra.agentId from the first call too). Verify the puppet
      // body of the first dispatch has agent_id and NOT a persona
      // block. The shim POST body is { role, content }; the puppet
      // text we want to assert against lives in .content (unescaped
      // once you parse the envelope).
      const firstMessagePost = h.calls.find((c) => c.url.includes('/messages'))!;
      const firstPuppet = (JSON.parse(firstMessagePost.body) as { content: string }).content;
      expect(firstPuppet).toContain('agent_id: "agent-reviewer-vibesync-1"');
      expect(firstPuppet).not.toContain('# Role: reviewer');
      expect(firstPuppet).toContain('NOT inline persona');

      // Step output came through end-to-end.
      expect(first.outputs.reviewer).toBe('verdict-1: LGTM');

      // Conversation_id was minted by the dispatcher and persisted on
      // the step bead (Phase D persistence contract).
      const firstView = await h.walker.load(first.moleculeId);
      const firstStep = firstView!.steps[0]!;
      const firstExec = firstStep.metadata['exec'] as Record<string, unknown>;
      expect(firstExec['conversation_id']).toBe('conv-test-1');

      const callsAfterFirst = h.calls.length;

      // ── Second dispatch ───────────────────────────────────────
      const second = await h.dispatcher.run({
        formula: makeFormula(),
        pack: h.packPaths.pack,
        input: 'review HEAD~1',
        projectIdentifier: PROJECT,
      });

      // Acceptance #2: same agent_id, no new JSON file.
      expect(h.repo.upsertCount).toBe(1); // still 1 — bootstrapper short-circuits on cache hit
      const filesAfterSecond = readdirSync(agentsDir);
      expect(filesAfterSecond).toHaveLength(1);
      expect(filesAfterSecond[0]).toBe(expectedFilename);
      expect(mintedIds).toBe(1); // idGenerator was NOT consulted again

      // Repo lookup happened (proves cache-hit path was exercised).
      expect(h.repo.getCount).toBeGreaterThanOrEqual(2);

      // Acceptance #3: second-dispatch puppet body still carries
      // agent_id and skips persona inlining. The persona loader is
      // configured to THROW if called — if persona had been inlined
      // we'd have died with that error, not reached this point.
      const newPosts = h.calls.slice(callsAfterFirst).filter((c) => c.url.includes('/messages'));
      expect(newPosts).toHaveLength(1);
      const secondPuppet = (JSON.parse(newPosts[0]!.body) as { content: string }).content;
      expect(secondPuppet).toContain('agent_id: "agent-reviewer-vibesync-1"');
      expect(secondPuppet).not.toContain('# Role: reviewer');
      expect(secondPuppet).not.toContain('You are the reviewer. Be skeptical.');

      // Per-dispatch conversation isolation: second step got a fresh
      // conversation_id.
      const secondView = await h.walker.load(second.moleculeId);
      const secondStep = secondView!.steps[0]!;
      const secondExec = secondStep.metadata['exec'] as Record<string, unknown>;
      expect(secondExec['conversation_id']).toBe('conv-test-2');
      expect(secondExec['conversation_id']).not.toBe(firstExec['conversation_id']);

      // Second dispatch output came through.
      expect(second.outputs.reviewer).toBe('verdict-2: LGTM');

      // The dispatcher emitted role_agent_bootstrapped on BOTH
      // dispatches (the event fires whenever the bootstrap context
      // resolves, regardless of cache hit vs miss inside the
      // bootstrapper).
      const bootstrappedEvents = h.events.filter(
        (e) => e.kind === 'dispatcher/step.role_agent_bootstrapped',
      );
      expect(bootstrappedEvents).toHaveLength(2);
      for (const ev of bootstrappedEvents) {
        expect(ev.payload?.agentId).toBe('agent-reviewer-vibesync-1');
        expect(ev.payload?.role).toBe('reviewer');
        expect(ev.payload?.projectIdentifier).toBe(PROJECT);
      }

      h.cleanup();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('non-vibesync project never bootstraps a persistent agent (context resolver returns null)', async () => {
    const { fetchImpl, calls } = makeShimFetch({
      conversationIds: ['conv-unused'],
      stepOutput: () => 'unreachable',
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const h = buildHarness({ fetchImpl, calls });

      // We never call run() with a vibesync projectIdentifier in this
      // test; we just verify the context resolver flat-out refuses
      // to opt other-projects in. Directly probe the dispatcher's
      // resolveRoleAgentContext.
      const result = await h.dispatcher.resolveRoleAgentContext({
        formula: makeFormula(),
        pack: h.packPaths.pack,
        input: 'noop',
        projectIdentifier: 'some-other-project',
      });
      expect(result).toBeNull();
      // And no agents directory got created (storage path is the
      // bootstrapper's responsibility, only invoked when the
      // resolver yields a context).
      const agentsDir = join(h.packPaths.storageDir, 'agents');
      expect(existsSync(agentsDir)).toBe(false);
      expect(h.repo.upsertCount).toBe(0);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
