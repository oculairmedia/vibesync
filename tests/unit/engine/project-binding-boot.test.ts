/**
 * vibesync-9lzk.55.1: the resolver boot builds from the registry. The
 * dispatcher-level tests (dispatcher/project-binding.test.ts) inject their own
 * resolver; these drive the real one, so the registry lookup, the home-checkout
 * check, the per-project cache and the unknown-project rule are pinned.
 */
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { bootOrchestrationPlane, type OrchestrationHandle } from '../../../src/engine/boot.js';
import { createCheckoutGhRunner } from '../../../src/engine/beads/index.js';
import { FormulaDispatchError, FormulaEscalationError, type DeliveryVerifier, type StepReplyJudge } from '../../../src/engine/dispatcher/index.js';
import { registryProjectRoot } from '../../../src/engine/dispatcher/project-binding.js';
import type { Formula } from '../../../src/engine/formula/index.js';
import type { Pack } from '../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';

const BEAD = 'work-1';
const HOME_PR = 'https://github.com/acme/home/pull/3';
const OTHER_PR = 'https://github.com/acme/other/pull/7';

type FakeGh = ((args: readonly string[]) => Promise<string>) & { readonly calls: string[][] };

/** A gh bound to one repository: answers `repo view`, and `pr view` only for that repository's open PRs. */
function repoGh(repository: string, openPrs: readonly string[] = []): FakeGh {
  const calls: string[][] = [];
  const gh = (async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: repository });
    if (args[0] === 'pr' && args[1] === 'view') {
      const url = args[2]!;
      if (!openPrs.includes(url)) {
        throw new Error(`gh pr view ${url} failed: GraphQL: Could not resolve to a PullRequest with the number of ${url.split('/').pop()}. (repository.pullRequest)`);
      }
      const now = new Date().toISOString();
      return JSON.stringify({
        state: 'OPEN', url, createdAt: now, headRefName: `fix/${BEAD}`, title: `fix: work (${BEAD})`, body: '',
        commits: [{ oid: 'abc', committedDate: now }],
      });
    }
    if (args[0] === 'pr' && args[1] === 'list') return '[]';
    if (args[0] === 'pr' && args[1] === 'checks') return JSON.stringify(['typecheck', 'test (20.x)', 'boot'].map((name) => ({ name, bucket: 'pass' })));
    throw new Error(`fake gh: unexpected call ${args.join(' ')}`);
  }) as FakeGh;
  (gh as { calls: string[][] }).calls = calls;
  return gh;
}

const prViews = (gh: FakeGh): string[] => gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'view').map((c) => c[2]!);
const prChecks = (gh: FakeGh): string[] => gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'checks').map((c) => c[2]!);
const repoViews = (gh: FakeGh): number => gh.calls.filter((c) => c[0] === 'repo' && c[1] === 'view').length;

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-binding-boot-pack-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'tester', 'mayor'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const ship: Formula = {
  name: 'ship', description: 'ship', whenToUse: '', delivers: 'pull_request',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'tester', role: 'tester', promptTemplate: 'prompts/p.md', dependsOn: ['coder'] },
  ],
};

/** No declared delivery: the final step's CI read is the only repository check this run gets. */
const review: Formula = { name: 'review', description: 'review', whenToUse: '', steps: ship.steps };
const plan: Formula = {
  name: 'plan', description: 'plan', whenToUse: '',
  steps: [
    { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md', planOnly: true },
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['mayor'] },
  ],
};
/** Reads the final reply as an approval that still has to be confirmed against the PR's checks. */
const approvingJudge: StepReplyJudge = {
  async judge() { return { answers: { asks_change: 0.02, blocks_only_on_pending_ci: 0.05, reports_all_gates_passed: 0.5, reports_unverified_check: 0.04 }, model: 'test', inputTokens: 1 }; },
};

const handles: OrchestrationHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
});

interface BootArgs {
  /** The PR URL the coder step reports. */
  readonly prUrl: string;
  readonly homePrs?: readonly string[];
  readonly otherPrs?: readonly string[];
  /** project -> checkout path; `false` boots without any registry lookup. */
  readonly registry?: ((roots: { homeRoot: string; otherRoot: string }) => Record<string, string>) | false;
  readonly homeVerifier?: DeliveryVerifier;
  readonly judge?: StepReplyJudge;
  /** The path the engine is given for its own checkout; defaults to the real one. */
  readonly engineRoot?: (homeRoot: string) => string;
}

async function boot(args: BootArgs) {
  const homeRoot = mkdtempSync(join(tmpdir(), 'vibesync-binding-home-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'vibesync-binding-other-'));
  const homeGh = repoGh('acme/home', args.homePrs);
  const otherGh = repoGh('acme/other', args.otherPrs);
  const ghRoots: string[] = [];
  const engineRoot = args.engineRoot?.(homeRoot) ?? homeRoot;
  const store = Object.assign(new InMemoryDoltClient(), { beadsRoot: engineRoot });
  const registry = args.registry === false ? null : (args.registry ?? (({ homeRoot: h, otherRoot: o }) => ({ home: h, other: o })))({ homeRoot, otherRoot });
  const provider = newFakeProvider({ kind: 'fake', script: (spec: SessionSpec) => reply(spec.role === 'coder' ? `PR ${args.prUrl}` : spec.role === 'mayor' ? 'planned' : 'PASS') });
  const handle = await bootOrchestrationPlane({
    dolt: store as never,
    beadsStore: store as never,
    provider,
    persistEvents: false,
    runDriftAuditOnBoot: false,
    stepTickIntervalMs: 10,
    projectGh: (root) => { ghRoots.push(root); return root === homeRoot || root === engineRoot ? homeGh : otherGh; },
    ...(registry ? { projectRoot: (id: string) => registry[id] ?? null } : {}),
    ...(args.homeVerifier ? { deliveryVerifier: args.homeVerifier } : {}),
    ...(args.judge ? { stepJudge: args.judge } : {}),
  });
  handles.push(handle);
  const run = (projectIdentifier?: string, formula: Formula = ship) => handle.dispatcher.run({
    formula, pack: pack(), input: 'go', motivatingBeadId: BEAD, ...(projectIdentifier ? { projectIdentifier } : {}),
  });
  const roles = (): string[] => provider.recorder.starts.map((start) => start.role);
  return { run, roles, registry, homeRoot, engineRoot, otherRoot, homeGh, otherGh, ghRoots };
}

describe('project bindings built at boot (vibesync-9lzk.55.1)', () => {
  it('a run for another registered project is verified through gh in that project\'s checkout', async () => {
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR] });
    await expect(h.run('other')).resolves.toBeDefined();
    expect(h.ghRoots).toEqual([h.homeRoot, h.otherRoot]);
    expect(prViews(h.otherGh)).toEqual([OTHER_PR]);
    expect(prViews(h.homeGh)).toEqual([]);
  });

  it('another project\'s pull request does not deliver a run of the home project', async () => {
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR] });
    const error = await h.run('home').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect(String((error as Error).message)).toContain('acme/home');
    // The home project never caused a binding to be built for the other checkout.
    expect(h.ghRoots).toEqual([h.homeRoot]);
    expect(prViews(h.otherGh)).toEqual([]);
  });

  it('a project the registry does not know fails closed and never asks the home repository', async () => {
    // HOME_PR is a real open PR in the home repository: a fallback to home would deliver this run.
    const h = await boot({ prUrl: HOME_PR, homePrs: [HOME_PR], registry: ({ homeRoot }) => ({ home: homeRoot }) });
    const error = await h.run('ghost').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect(String((error as Error).message)).toContain('ghost');
    expect(prViews(h.homeGh)).toEqual([]);
    expect(h.ghRoots).toEqual([h.homeRoot]);
  });

  it('a run with no project is verified in the home repository', async () => {
    const h = await boot({ prUrl: HOME_PR, homePrs: [HOME_PR] });
    await expect(h.run()).resolves.toBeDefined();
    expect(prViews(h.homeGh)).toEqual([HOME_PR]);
    expect(h.ghRoots).toEqual([h.homeRoot]);
  });

  it('without a registry lookup every run uses the home repository (embedders and tests that pass none)', async () => {
    const h = await boot({ prUrl: HOME_PR, homePrs: [HOME_PR], registry: false });
    await expect(h.run('other')).resolves.toBeDefined();
    expect(prViews(h.homeGh)).toEqual([HOME_PR]);
    expect(h.ghRoots).toEqual([h.homeRoot]);
  });

  it('a project\'s binding is built once and reused', async () => {
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR] });
    await expect(h.run('other')).resolves.toBeDefined();
    await expect(h.run('other')).resolves.toBeDefined();
    expect(h.ghRoots.filter((root) => root === h.otherRoot)).toHaveLength(1);
    expect(repoViews(h.otherGh)).toBe(1);
    expect(prViews(h.otherGh)).toEqual([OTHER_PR, OTHER_PR]);
  });

  it('a delivery verifier passed to boot applies to the home project only', async () => {
    let homeVerifierCalls = 0;
    const homeVerifier: DeliveryVerifier = {
      verify: async () => { homeVerifierCalls += 1; return { ok: true, artifact: 'the home verifier says yes' }; },
    };
    // The other repository has no such PR: only the home verifier could approve this run.
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [], homeVerifier });
    const error = await h.run('other').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect(homeVerifierCalls).toBe(0);
    expect(prViews(h.otherGh)).toEqual([OTHER_PR]);
  });

  it('the home checkout registered under another path is still the home project', async () => {
    const h = await boot({
      prUrl: HOME_PR,
      homePrs: [HOME_PR],
      registry: ({ homeRoot, otherRoot }) => {
        const link = join(mkdtempSync(join(tmpdir(), 'vibesync-binding-link-')), 'home-link');
        symlinkSync(homeRoot, link);
        return { home: link, other: otherRoot };
      },
    });
    await expect(h.run('home')).resolves.toBeDefined();
    expect(prViews(h.homeGh)).toEqual([HOME_PR]);
    // No second gh was built for the link path.
    expect(h.ghRoots).toEqual([h.homeRoot]);
  });

  it('an engine started through a symlinked path still recognises its own checkout in the registry', async () => {
    // The verifier passed to boot belongs to the home project. If the engine failed to recognise the
    // registry's real path as its own checkout, this run would get a separate binding and bypass it.
    let homeVerifierCalls = 0;
    const homeVerifier: DeliveryVerifier = {
      verify: async () => { homeVerifierCalls += 1; return { ok: true, artifact: HOME_PR }; },
    };
    const h = await boot({
      prUrl: HOME_PR,
      homePrs: [HOME_PR],
      homeVerifier,
      engineRoot: (homeRoot) => {
        const link = join(mkdtempSync(join(tmpdir(), 'vibesync-binding-engine-link-')), 'engine-link');
        symlinkSync(homeRoot, link);
        return link;
      },
    });
    expect(h.engineRoot).not.toBe(h.homeRoot);
    await expect(h.run('home')).resolves.toBeDefined();
    expect(homeVerifierCalls).toBe(1);
    // Only the engine's own gh was built: no second binding for the same checkout.
    expect(h.ghRoots).toEqual([h.engineRoot]);
  });

  it('a project whose registered checkout changes gets a binding for the new checkout', async () => {
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR] });
    await expect(h.run('other')).resolves.toBeDefined();
    // The registry row now points at a third checkout (PATCH /api/registry/projects/other).
    const moved = mkdtempSync(join(tmpdir(), 'vibesync-binding-moved-'));
    h.registry!['other'] = moved;
    await expect(h.run('other')).resolves.toBeDefined();
    expect(h.ghRoots).toEqual([h.homeRoot, h.otherRoot, moved]);
  });

  it('a registered checkout that does not exist is an unknown project, not the home project', async () => {
    const h = await boot({ prUrl: HOME_PR, homePrs: [HOME_PR], registry: ({ homeRoot }) => ({ home: homeRoot, gone: '/nonexistent/vibesync-binding-gone' }) });
    const error = await h.run('gone').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaDispatchError);
    expect(String((error as Error).message)).toContain('gone');
    expect(prViews(h.homeGh)).toEqual([]);
  });

  it('the final step does not read CI from a pull request in another repository', async () => {
    // The reply names a PR that exists and is green, but in the OTHER repository; this run is the home project's.
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR], judge: approvingJudge });
    const error = await h.run('home', review).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaEscalationError);
    expect(String((error as Error).message)).toContain('is not in the project repository acme/home');
    expect(prChecks(h.homeGh)).toEqual([]);
    expect(prChecks(h.otherGh)).toEqual([]);
  });

  it('the final step reads CI for a pull request in the run\'s own repository', async () => {
    const h = await boot({ prUrl: OTHER_PR, otherPrs: [OTHER_PR], judge: approvingJudge });
    await expect(h.run('other', review)).resolves.toBeDefined();
    expect(prChecks(h.otherGh)).toEqual([OTHER_PR]);
    expect(prChecks(h.homeGh)).toEqual([]);
  });

  it('a plan-only step of a project the registry does not know is blocked; the coder never starts', async () => {
    const h = await boot({ prUrl: HOME_PR, registry: ({ homeRoot }) => ({ home: homeRoot }) });
    const error = await h.run('ghost', plan).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaEscalationError);
    expect(String((error as Error).message)).toContain('ghost');
    expect(h.roles()).toEqual(['mayor']);
  });
});

describe('gh bound to a checkout (vibesync-9lzk.55.1)', () => {
  it('runs in the checkout and never inherits GH_REPO', async () => {
    // A stand-in `gh` on PATH that reports the environment and directory it was started with.
    const bin = mkdtempSync(join(tmpdir(), 'vibesync-fake-gh-'));
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf \'%s|%s\' "${GH_REPO-unset}" "$(pwd -P)"\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const checkout = mkdtempSync(join(tmpdir(), 'vibesync-fake-gh-cwd-'));
    const realCheckout = execFileSync('/bin/sh', ['-c', 'pwd -P'], { cwd: checkout, encoding: 'utf8' }).trim();
    const before = { path: process.env['PATH'], repo: process.env['GH_REPO'] };
    process.env['PATH'] = `${bin}:${before.path ?? ''}`;
    process.env['GH_REPO'] = 'someone/else';
    try {
      expect(await createCheckoutGhRunner(checkout)(['repo', 'view'])).toBe(`unset|${realCheckout}`);
    } finally {
      process.env['PATH'] = before.path;
      if (before.repo === undefined) delete process.env['GH_REPO'];
      else process.env['GH_REPO'] = before.repo;
    }
  });
});

describe('registry lookup for a project checkout (vibesync-9lzk.55.1)', () => {
  it('returns the registered path, and null for an unknown project or one with no path', () => {
    const rows: Record<string, { filesystem_path?: string | null }> = {
      known: { filesystem_path: '/srv/known' }, pathless: { filesystem_path: null }, blank: { filesystem_path: '' },
    };
    const lookup = registryProjectRoot({ getProject: (id) => rows[id] ?? null });
    expect(lookup('known')).toBe('/srv/known');
    expect(lookup('missing')).toBeNull();
    expect(lookup('pathless')).toBeNull();
    expect(lookup('blank')).toBeNull();
  });
});
