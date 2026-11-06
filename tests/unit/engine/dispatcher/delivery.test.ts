/**
 * vibesync-9lzk.21: a formula that declares delivers = "pull_request" only
 * completes once a real, open PR exists. Regression for the engine trial run
 * vibesync-mol-rvut9fq9qv12, which closed "completed" with every edit
 * uncommitted and no PR. The fake gh reproduces real `gh pr view` output and
 * errors (captured 2026-11-04 against oculairmedia/vibesync).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { candidatePullRequests, createGhDeliveryVerifier, FormulaDispatchError, ghRepositoryTarget, type GhRunner } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import { parseFormulasFromToml, type Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

/** A PR as `gh pr view --json state,url,createdAt,headRefName,title,body,commits` prints it. */
interface FakePr { state: 'OPEN' | 'MERGED' | 'CLOSED'; createdAt?: string; headRefName?: string; title?: string; body?: string; commits?: { oid: string; committedDate: string }[] }

/** Mirrors real gh: known PRs print JSON; unknown ones fail with gh's real error. */
function fakeGh(prs: Readonly<Record<string, FakePr | 'OPEN' | 'MERGED' | 'CLOSED'>>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]) => {
    calls.push([...args]);
    const url = args[2]!;
    const raw = prs[url];
    if (!raw) {
      const n = url.split('/').pop();
      throw new Error(`gh ${args.join(' ')} failed: GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
    }
    // Default: opened just now, by this run, naming the bead.
    const pr: FakePr = typeof raw === 'string' ? { state: raw } : raw;
    return JSON.stringify({
      state: pr.state, url,
      createdAt: pr.createdAt ?? new Date().toISOString(),
      headRefName: pr.headRefName ?? 'fix/work-1-thing',
      title: pr.title ?? 'fix: the thing (work-1)',
      body: pr.body ?? '',
      // Real gh prints every commit with its dates; a PR opened "just now" has one fresh commit.
      commits: pr.commits ?? [{ oid: 'abc1234', committedDate: pr.createdAt ?? new Date().toISOString() }],
    });
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const PR = 'https://github.com/oculairmedia/vibesync/pull/123';

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-delivery-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'tester'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const delivering: Formula = {
  name: 'ship', description: 'ship', whenToUse: '', delivers: 'pull_request',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'] },
  ],
};

function harness(script: (spec: SessionSpec) => AsyncIterable<SessionEvent>, gh?: GhRunner) {
  const store = new InMemoryDoltClient();
  const provider = newFakeProvider({ kind: 'fake', script });
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
    ...(gh ? { deliveryVerifier: createGhDeliveryVerifier(gh, async () => ({ repository: 'oculairmedia/vibesync' })) } : {}),
  });
  return { store, events, dispatcher };
}

describe('declared delivery gates completion (vibesync-9lzk.21)', () => {
  it('REGRESSION: all steps finish but no PR exists -> the molecule FAILS, never completes', async () => {
    // The trial: coder reported "Changed: ..." with nothing committed; tester said PASS.
    const h = harness((spec) => reply(spec.role === 'coder' ? '**Changed:** removed HealthPatrol' : '**Result:** PASS'), fakeGh({}));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(String((thrown as Error).message)).toContain('no step output names a pull request URL');
    const root = await h.store.getBead((thrown as FormulaDispatchError).moleculeId);
    expect(root).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'failed' } } });
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it('a claimed PR that does not exist on GitHub fails the run (claims are verified, not trusted)', async () => {
    const h = harness((spec) => reply(spec.role === 'coder' ? `Delivered: ${PR}` : 'PASS'), fakeGh({}));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('Could not resolve to a PullRequest');
  });

  it('a closed-unmerged PR does not count as delivery', async () => {
    const h = harness((spec) => reply(spec.role === 'coder' ? `PR ${PR}` : 'PASS'), fakeGh({ [PR]: 'CLOSED' }));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('is CLOSED');
  });

  it('a verified open PR completes the run and is recorded as the delivered artifact', async () => {
    const gh = fakeGh({ [PR]: 'OPEN' });
    const h = harness((spec) => reply(spec.role === 'coder' ? `**Delivered:** commit abc on b, PR ${PR}` : 'PASS'), gh);
    await expect(h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' })).resolves.toMatchObject({ moleculeId: expect.any(String) });
    expect(gh.calls).toEqual([['pr', 'view', PR, '--json', 'state,url,createdAt,headRefName,title,body,commits']]);
    expect(h.events.find((e) => e.kind === 'dispatcher/formula.delivered')?.payload).toMatchObject({ kind: 'pull_request', artifact: PR });
  });

  it('an unrelated open PR mentioned in output (e.g. quoted from the task) does not count: it predates the run', async () => {
    const old = 'https://github.com/oculairmedia/vibesync/pull/78';
    const h = harness((spec) => reply(spec.role === 'coder' ? `following the approach in ${old}; done` : 'PASS'),
      fakeGh({ [old]: { state: 'MERGED', createdAt: '2026-11-04T18:25:56Z', title: 'refactor: retire HealthPatrol (vibesync-9lzk.12)' } }));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('before this run started');
  });

  // vibesync-9lzk.38: round 9's review round. PR #100 was opened at 02:49 by
  // the previous run; this run pushed 551a7fb to it at 03:11. Real `gh pr view
  // --json commits` shape from that PR.
  it('REGRESSION (round 9): a PR opened BEFORE the run that received a commit DURING it is this run\'s delivery', async () => {
    const existing = 'https://github.com/oculairmedia/vibesync/pull/100';
    const commits = [
      { oid: 'bed3869', committedDate: '2026-11-06T02:49:09Z' },
      { oid: '551a7fb', committedDate: new Date(Date.now() + 5_000).toISOString() },
    ];
    const h = harness((spec) => reply(spec.role === 'coder' ? `pushed 551a7fb to ${existing}` : 'PASS'),
      fakeGh({ [existing]: { state: 'OPEN', createdAt: '2026-11-06T02:49:21Z', title: 'feat(engine): a work bead can set its steps\' time limit (work-1)', commits } }));
    await expect(h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' })).resolves.toBeDefined();
    expect(h.events.find((e) => e.kind === 'dispatcher/formula.delivered')?.payload).toMatchObject({ artifact: existing });
  });

  it('a PR opened before the run with NO commit during it is still not this run\'s delivery', async () => {
    const existing = 'https://github.com/oculairmedia/vibesync/pull/100';
    const commits = [{ oid: 'bed3869', committedDate: '2026-11-06T02:49:09Z' }];
    const h = harness((spec) => reply(spec.role === 'coder' ? `see ${existing}` : 'PASS'),
      fakeGh({ [existing]: { state: 'OPEN', createdAt: '2026-11-06T02:49:21Z', title: 'feat (work-1)', commits } }));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('received no commit during it');
  });

  it('an open PR opened during the run but for a different bead does not count', async () => {
    const h = harness((spec) => reply(spec.role === 'coder' ? `PR ${PR}` : 'PASS'),
      fakeGh({ [PR]: { state: 'OPEN', title: 'fix: something else (work-2)', headRefName: 'fix/work-2', body: '' } }));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('does not name the work bead work-1');
  });

  it('REGRESSION (resume): a resumed molecule that declares delivery and has no PR fails, never completes', async () => {
    const h = harness(() => reply('**Changed:** stuff, nothing committed'), fakeGh({}));
    const view = await new MoleculeWalker(h.store).dispatch({ prefix: 'mol', formulaName: 'ship', title: '[formula:ship]', motivatingBeadId: 'work-1', delivers: 'pull_request', steps: [{ name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' }] });
    const walker = new MoleculeWalker(h.store);
    const stepId = `${view.rootId}-coder`;
    await walker.startStep(stepId);
    await walker.recordStepTask(stepId, { taskId: 'task-1', providerKind: 'fake', sessionId: 'fake:coder-prev' });
    const thrown = await h.dispatcher.resume(view.rootId).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    expect(String((thrown as Error).message)).toContain('no step output names a pull request URL');
    expect(await h.store.getBead(view.rootId)).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'failed', delivers: 'pull_request' } } });
    expect(h.events.some((e) => e.kind === 'dispatcher/formula.completed')).toBe(false);
  });

  it('dispatching a delivering formula records the delivery on the root, so resume can enforce it', async () => {
    const h = harness(() => reply('no PR here'), fakeGh({}));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(await h.store.getBead((thrown as FormulaDispatchError).moleculeId)).toMatchObject({ metadata: { exec: { delivers: 'pull_request' } } });
  });

  it('resume of a molecule WITHOUT a recorded delivery still completes (no gh call)', async () => {
    const gh = fakeGh({});
    const h = harness(() => reply('done'), gh);
    const view = await new MoleculeWalker(h.store).dispatch({ prefix: 'mol', formulaName: 'plain', title: '[formula:plain]', steps: [{ name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' }] });
    const walker = new MoleculeWalker(h.store);
    await walker.startStep(`${view.rootId}-coder`);
    await walker.recordStepTask(`${view.rootId}-coder`, { taskId: 't', providerKind: 'fake', sessionId: 'fake:c' });
    await expect(h.dispatcher.resume(view.rootId)).resolves.toMatchObject({ moleculeId: view.rootId });
    expect(gh.calls).toHaveLength(0);
  });

  it('a PR in ANOTHER repository that names the same bead does not count', async () => {
    const other = 'https://github.com/someone/elsewhere/pull/7';
    const gh = fakeGh({ [other]: { state: 'OPEN', title: 'fix: work-1 lookalike' } });
    const h = harness((spec) => reply(spec.role === 'coder' ? `PR ${other}` : 'PASS'), gh);
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('is not in the project repository oculairmedia/vibesync');
    expect(gh.calls).toHaveLength(0); // rejected before asking gh about it
  });

  it('a run with NO work bead cannot be bound to any PR and fails, even with a recent open PR', async () => {
    const h = harness((spec) => reply(spec.role === 'coder' ? `PR ${PR}` : 'PASS'), fakeGh({ [PR]: 'OPEN' }));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('needs a work bead to bind the pull request to');
  });

  it('an unresolvable project repository fails closed', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply(`PR ${PR}`) });
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      deliveryVerifier: createGhDeliveryVerifier(fakeGh({ [PR]: 'OPEN' }), async () => { throw new Error('failed to run git: fatal: not a git repository'); }),
    });
    const thrown = await dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('could not resolve the project repository');
  });

  it('a declared delivery with no verifier configured fails closed', async () => {
    const h = harness(() => reply(`PR ${PR}`));
    const thrown = await h.dispatcher.run({ formula: delivering, pack: pack(), input: 'go', motivatingBeadId: 'work-1' }).catch((e: unknown) => e);
    expect(String((thrown as Error).message)).toContain('no delivery verifier is configured');
  });

  it('a formula without delivers completes as before (no gh call)', async () => {
    const gh = fakeGh({});
    const h = harness(() => reply('done'), gh);
    const plain: Formula = { ...delivering, delivers: undefined } as Formula;
    delete (plain as { delivers?: unknown }).delivers;
    await expect(h.dispatcher.run({ formula: plain, pack: pack(), input: 'go' })).resolves.toBeDefined();
    expect(gh.calls).toHaveLength(0);
  });
});

describe('formula TOML delivers', () => {
  it('parses delivers = "pull_request" and rejects unknown kinds', () => {
    const base = '[formula.f]\ndescription = "d"\n[[formula.f.steps]]\nrole = "coder"\n';
    expect(parseFormulasFromToml(base.replace('description = "d"', 'description = "d"\ndelivers = "pull_request"'))[0]?.delivers).toBe('pull_request');
    expect(parseFormulasFromToml(base)[0]?.delivers).toBeUndefined();
    expect(() => parseFormulasFromToml(base.replace('description = "d"', 'description = "d"\ndelivers = "a_feeling"'))).toThrow('delivers must be one of pull_request');
  });

  it('the shipped onboard-feature formula declares pull_request delivery', async () => {
    const { loadFormulasFromFile } = await import('../../../../src/engine/formula/index.js');
    const f = loadFormulasFromFile(join(process.cwd(), 'packs/gastown/formulas/onboard-feature.toml'))[0];
    expect(f?.delivers).toBe('pull_request');
  });
});

describe('ghRepositoryTarget', () => {
  it('reads nameWithOwner from gh repo view (real output shape) and caches it', async () => {
    const calls: string[][] = [];
    const target = ghRepositoryTarget(async (args) => { calls.push([...args]); return '{"nameWithOwner":"oculairmedia/vibesync"}\n'; });
    expect(await target()).toEqual({ repository: 'oculairmedia/vibesync' });
    await target();
    expect(calls).toEqual([['repo', 'view', '--json', 'nameWithOwner']]);
  });
});

describe('candidatePullRequests', () => {
  it('finds every PR URL across step outputs, de-duplicated', () => {
    expect(candidatePullRequests({ a: `see ${PR} and again ${PR}`, b: 'https://github.com/o/r/pull/9.' })).toEqual([PR, 'https://github.com/o/r/pull/9']);
  });
});
