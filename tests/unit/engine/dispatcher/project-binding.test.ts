import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createGhDeliveryVerifier,
  FormulaDispatchError,
  FormulaEscalationError,
  UnknownProjectError,
  type GhRunner,
  type ProjectBinding,
  type ShippedWorkProbe,
  type StepReplyJudge,
} from '../../../../src/engine/dispatcher/index.js';
import { EventBus } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import type { PrChecksReader } from '../../../../src/engine/verdict/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const OTHER_PR = 'https://github.com/oculairmedia/other-project/pull/9001';
const HOME_PR = 'https://github.com/oculairmedia/vibesync/pull/123';
const CHECKS = ['typecheck', 'test (20.x)', 'boot'];

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-project-binding-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'tester', 'mayor'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const deliver: Formula = {
  name: 'ship', description: 'ship', whenToUse: '', delivers: 'pull_request',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'] },
  ],
};
const plan: Formula = {
  name: 'plan', description: 'plan', whenToUse: '',
  steps: [
    { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md', planOnly: true },
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['mayor'] },
  ],
};

interface FakePr { readonly state: 'OPEN' | 'MERGED' | 'CLOSED'; readonly title?: string }
function fakeGh(prs: Readonly<Record<string, FakePr>>): GhRunner & { readonly calls: string[][] } {
  const calls: string[][] = [];
  const gh = (async (args: readonly string[]) => {
    calls.push([...args]);
    const url = args[2]!;
    const pr = prs[url];
    if (!pr) throw new Error(`gh ${args.join(' ')} failed: GraphQL: Could not resolve to a PullRequest with the number of ${url.split('/').pop()}. (repository.pullRequest)`);
    return JSON.stringify({
      state: pr.state, url, createdAt: new Date().toISOString(), headRefName: 'fix/vibesync-9lzk.55.1',
      title: pr.title ?? 'fix: work (vibesync-9lzk.55.1)', body: '',
      commits: [{ oid: 'abc', committedDate: new Date().toISOString() }],
    });
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

function harness(args: {
  readonly homeGh?: ReturnType<typeof fakeGh>;
  readonly otherGh?: ReturnType<typeof fakeGh>;
  readonly otherProject?: boolean;
  readonly homeProject?: boolean;
  readonly homeProbe?: ShippedWorkProbe;
  readonly otherProbe?: ShippedWorkProbe;
  readonly homeReader?: PrChecksReader;
  readonly otherReader?: PrChecksReader;
  readonly judge?: StepReplyJudge;
  readonly script?: (spec: SessionSpec) => AsyncIterable<SessionEvent>;
}) {
  const store = new InMemoryDoltClient();
  const homeGh = args.homeGh ?? fakeGh({});
  const otherGh = args.otherGh ?? fakeGh({});
  const homeVerifier = createGhDeliveryVerifier(homeGh, async () => ({ repository: 'oculairmedia/vibesync' }));
  const otherVerifier = createGhDeliveryVerifier(otherGh, async () => ({ repository: 'oculairmedia/other-project' }));
  const homeBinding: ProjectBinding = {
    deliveryVerifier: homeVerifier,
    shippedWorkProbe: args.homeProbe ?? null,
    prChecks: args.homeReader ? { reader: args.homeReader, names: CHECKS, pollMs: 1, maxWaitMs: 10 } : null,
  };
  const otherBinding: ProjectBinding = {
    deliveryVerifier: otherVerifier,
    shippedWorkProbe: args.otherProbe ?? null,
    prChecks: args.otherReader ? { reader: args.otherReader, names: CHECKS, pollMs: 1, maxWaitMs: 10 } : null,
  };
  const resolver = (project: string | undefined): ProjectBinding => {
    if (project === 'other' && args.otherProject !== false) return otherBinding;
    if (project === 'vibesync' && args.homeProject !== false) return homeBinding;
    if (project === undefined) return homeBinding;
    throw new UnknownProjectError(project);
  };
  const provider = newFakeProvider({ kind: 'fake', script: args.script ?? ((spec) => reply(spec.role === 'coder' ? `PR ${OTHER_PR}` : 'PASS')) });
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
    projectBindings: resolver,
    ...(args.judge ? { stepJudge: args.judge } : {}),
  });
  return { store, dispatcher, homeGh, otherGh, homeBinding, otherBinding, homeVerifier };
}

describe('per-project delivery bindings', () => {
  it('T1: verifies a run in the other project repository', async () => {
    const otherGh = fakeGh({ [OTHER_PR]: { state: 'OPEN' } });
    const h = harness({ otherGh });
    await expect(h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', motivatingBeadId: 'vibesync-9lzk.55.1', projectIdentifier: 'other' })).resolves.toBeDefined();
    expect(otherGh.calls).toHaveLength(1);
    expect(h.homeGh.calls).toHaveLength(0);
  });

  it("T2: the other project's PR cannot deliver a home-project run", async () => {
    const otherGh = fakeGh({ [OTHER_PR]: { state: 'OPEN' } });
    const h = harness({ otherGh });
    const error = await h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', motivatingBeadId: 'vibesync-9lzk.55.1', projectIdentifier: 'vibesync' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect(String((error as Error).message)).toContain('not in the project repository oculairmedia/vibesync');
    expect(h.homeGh.calls).toHaveLength(0);
  });

  it('T3: resume verifies delivery against the project recorded on the root', async () => {
    const otherGh = fakeGh({ [OTHER_PR]: { state: 'OPEN' } });
    const h = harness({ otherGh, script: () => reply(`PR ${OTHER_PR}`) });
    const walker = new MoleculeWalker(h.store);
    const view = await walker.dispatch({ prefix: 'mol', formulaName: 'ship', title: '[formula:ship]', motivatingBeadId: 'vibesync-9lzk.55.1', delivers: 'pull_request', projectIdentifier: 'other', steps: [{ name: 'coder', role: 'coder', promptTemplate: 'p.md' }] });
    await walker.startStep(`${view.rootId}-coder`);
    await walker.recordStepTask(`${view.rootId}-coder`, { taskId: 'task', providerKind: 'fake', sessionId: 'fake:coder' });
    await expect(h.dispatcher.resume(view.rootId)).resolves.toBeDefined();
    expect(otherGh.calls).toHaveLength(1);
    expect(h.homeGh.calls).toHaveLength(0);
  });

  it('T4: the plan-only guard probes the other repository', async () => {
    const homeProbeCalls: string[] = [];
    const otherProbeCalls: string[] = [];
    const probe = (calls: string[]): ShippedWorkProbe => ({ async pullRequestsOpenedSince(bead) { calls.push(bead); return []; } });
    const h = harness({ homeProbe: probe(homeProbeCalls), otherProbe: probe(otherProbeCalls), script: () => reply('planned') });
    await expect(h.dispatcher.run({ formula: plan, pack: pack(), input: 'go', motivatingBeadId: 'work-1', projectIdentifier: 'other' })).resolves.toBeDefined();
    expect(otherProbeCalls).toEqual(['work-1']);
    expect(homeProbeCalls).toEqual([]);
  });

  it('T5: final-step CI uses the other project reader', async () => {
    const homeRead = vi.fn(async () => Object.fromEntries(CHECKS.map((name) => [name, 'pending' as const])));
    const otherRead = vi.fn(async (_url: string, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 'pass' as const])));
    const judge: StepReplyJudge = { async judge() { return { answers: { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.5, reports_unverified_check: 0.04 }, model: 'test', inputTokens: 1 }; } };
    const h = harness({ homeReader: { read: homeRead }, otherReader: { read: otherRead }, otherGh: fakeGh({ [OTHER_PR]: { state: 'OPEN' } }), judge, script: (spec) => reply(spec.role === 'coder' ? `PR ${OTHER_PR}` : 'PASS') });
    await expect(h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', motivatingBeadId: 'vibesync-9lzk.55.1', projectIdentifier: 'other' })).resolves.toBeDefined();
    expect(otherRead).toHaveBeenCalledOnce();
    expect(homeRead).not.toHaveBeenCalled();
  });

  it('T6: unknown projects fail delivery closed without asking the home verifier', async () => {
    const h = harness({ homeProject: false });
    const result = await h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', motivatingBeadId: 'vibesync-9lzk.55.1', projectIdentifier: 'missing-project' }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(FormulaDispatchError);
    expect(String((result as Error).message)).toContain('missing-project');
    expect(h.homeGh.calls).toHaveLength(0);
  });

  it('T7: an unknown project at final CI is unsettled, never approved', async () => {
    const judge: StepReplyJudge = { async judge() { return { answers: { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.5, reports_unverified_check: 0.04 }, model: 'test', inputTokens: 1 }; } };
    const h = harness({ homeProject: false, judge, script: (spec) => reply(spec.role === 'coder' ? `PR ${HOME_PR}` : 'PASS') });
    const result = await h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', projectIdentifier: 'missing-project' }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(FormulaEscalationError);
    expect(String((result as Error).message)).toContain('missing-project');
    expect(h.homeGh.calls).toHaveLength(0);
  });

  it('T8: no project and the home project by name use the home binding', async () => {
    for (const projectIdentifier of [undefined, 'vibesync']) {
      const homeGh = fakeGh({ [HOME_PR]: { state: 'OPEN' } });
      const h = harness({ homeGh, script: () => reply(`PR ${HOME_PR}`) });
      await expect(h.dispatcher.run({ formula: deliver, pack: pack(), input: 'go', motivatingBeadId: 'vibesync-9lzk.55.1', ...(projectIdentifier ? { projectIdentifier } : {}) })).resolves.toBeDefined();
      expect(homeGh.calls).toHaveLength(1);
    }
  });
});
