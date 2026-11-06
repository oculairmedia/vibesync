/**
 * vibesync-9lzk.37: a plan-only step (the onboard-feature mayor) fails when a
 * PR naming the work bead appears during its step. Engine rounds 7 and 8: the
 * mayor wrote, committed and opened the PR itself, so the coder only
 * re-reported it and the reviewer reviewed the planner's code.
 *
 * The fake gh returns `gh pr list --search` output captured 2026-11-05 for
 * "vibesync-9lzk.34": gh's search is fuzzy and also returned PRs for 9lzk.31
 * and 9lzk.29, which must never count.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGhShippedWorkProbe, FormulaDispatchError, type GhRunner, type ShippedWorkProbe } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import { loadFormulasFromFile, parseFormulasFromToml, type Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

const BEAD = 'vibesync-9lzk.34';
const REPO = 'oculairmedia/vibesync';

/** Real `gh pr list --search vibesync-9lzk.34 --json url,title,headRefName,createdAt` output (2026-11-05). */
const fuzzyNeighbours = [
  { createdAt: '2026-11-05T15:57:24Z', headRefName: 'refactor/vibesync-hotspot-boot-scheduler', url: 'https://github.com/oculairmedia/vibesync/pull/92', title: 'refactor(scheduler): split startSchedulerDaemon into named steps (vibesync-9lzk.31)' },
  { createdAt: '2026-11-05T15:05:15Z', headRefName: 'refactor/vibesync-9lzk.29-delete-shim-provider', url: 'https://github.com/oculairmedia/vibesync/pull/89', title: 'refactor(engine): delete the dead shim runtime provider; Iroh is the only dispatch path (vibesync-9lzk.29)' },
];
const prForBead = (createdAt: string) => ({ createdAt, headRefName: 'fix/vibesync-9lzk.34-recheck-before-blocking', url: 'https://github.com/oculairmedia/vibesync/pull/98', title: 'fix(engine): re-check a failing command before reporting a step blocked (vibesync-9lzk.34)' });

function fakeGh(listing: () => object[]): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(listing());
    throw new Error(`unexpected gh ${args.join(' ')}`);
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-plan-only-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['mayor', 'coder'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const planThenCode: Formula = {
  name: 'plan-then-code', description: 'd', whenToUse: '',
  steps: [
    { name: 'mayor', role: 'mayor', promptTemplate: 'prompts/p.md', planOnly: true },
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md', dependsOn: ['mayor'] },
  ],
};

function harness(onMayorTurn: () => void, probe: ShippedWorkProbe | undefined) {
  const store = new InMemoryDoltClient();
  const bus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  bus.subscribe((e) => events.push(e));
  const provider = newFakeProvider({
    kind: 'fake',
    script: (spec: SessionSpec) => {
      if (spec.role === 'mayor') onMayorTurn();
      return reply(spec.role === 'mayor' ? '1. coder: make the change' : 'done');
    },
  });
  const dispatcher = newDriven(store, {
    idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
    ...(probe ? { shippedWorkProbe: probe } : {}),
  });
  return { store, events, provider, dispatcher };
}

const probeOver = (gh: GhRunner) => createGhShippedWorkProbe(gh, async () => ({ repository: REPO }));

describe('plan-only steps (vibesync-9lzk.37)', () => {
  it('REGRESSION (round 8): a mayor that opens the PR for its bead during its step fails, and the coder never runs', async () => {
    let listing: object[] = [...fuzzyNeighbours];
    const gh = fakeGh(() => listing);
    const h = harness(() => { listing = [prForBead(new Date().toISOString()), ...fuzzyNeighbours]; }, probeOver(gh));
    const thrown = await h.dispatcher.run({ formula: planThenCode, pack: pack(), input: 'go', motivatingBeadId: BEAD }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    const root = await h.store.getBead((thrown as FormulaDispatchError).moleculeId);
    expect(root).toMatchObject({ status: 'closed', metadata: { exec: { outcome: 'failed' } } });
    const mayor = await h.store.getBead(`${(thrown as FormulaDispatchError).moleculeId}-mayor`);
    expect(String(mayor?.metadata?.['exec'] && (mayor.metadata['exec'] as Record<string, unknown>)['error_trace'])).toContain('plan-only step shipped work');
    expect(String((mayor?.metadata?.['exec'] as Record<string, unknown>)['error_trace'])).toContain('pull/98');
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['mayor']);
    expect(gh.calls[0]).toEqual(['pr', 'list', '--repo', REPO, '--state', 'all', '--search', BEAD, '--json', 'url,title,headRefName,createdAt', '--limit', '20']);
  });

  it('a mayor that only plans passes, even though gh search fuzzily returns PRs for OTHER beads opened during the step', async () => {
    // Fresh timestamps: only the exact-bead filter can reject these, not the time window.
    const freshNeighbours = () => fuzzyNeighbours.map((pr) => ({ ...pr, createdAt: new Date().toISOString() }));
    const h = harness(() => undefined, probeOver(fakeGh(freshNeighbours)));
    await expect(h.dispatcher.run({ formula: planThenCode, pack: pack(), input: 'go', motivatingBeadId: BEAD })).resolves.toBeDefined();
    expect(h.provider.recorder.starts.map((s) => s.role)).toEqual(['mayor', 'coder']);
  });

  it('a PR for the bead opened BEFORE the step (e.g. a previous attempt) does not fail the mayor', async () => {
    const h = harness(() => undefined, probeOver(fakeGh(() => [prForBead('2026-11-05T10:00:00Z'), ...fuzzyNeighbours])));
    await expect(h.dispatcher.run({ formula: planThenCode, pack: pack(), input: 'go', motivatingBeadId: BEAD })).resolves.toBeDefined();
  });

  it('only plan-only steps are checked: the coder opening the PR is its job', async () => {
    let listing: object[] = [];
    const gh = fakeGh(() => listing);
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({
      kind: 'fake',
      script: (spec: SessionSpec) => { if (spec.role === 'coder') listing = [prForBead(new Date().toISOString())]; return reply('done'); },
    });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }), shippedWorkProbe: probeOver(gh) });
    await expect(dispatcher.run({ formula: planThenCode, pack: pack(), input: 'go', motivatingBeadId: BEAD })).resolves.toBeDefined();
    expect(gh.calls).toHaveLength(1); // the mayor's step only
  });

  it('a gh failure does not fail the step: it is reported as dispatcher/plan-only.check_failed', async () => {
    const failing = (async () => { throw new Error('gh: HTTP 500'); }) as GhRunner;
    const h = harness(() => undefined, probeOver(failing));
    await expect(h.dispatcher.run({ formula: planThenCode, pack: pack(), input: 'go', motivatingBeadId: BEAD })).resolves.toBeDefined();
    const ev = h.events.find((e) => e.kind === 'dispatcher/plan-only.check_failed');
    expect(ev?.payload).toMatchObject({ bead: BEAD, error: expect.stringContaining('HTTP 500') });
  });
});

describe('plan_only in formulas', () => {
  it('parses plan_only = true and rejects non-booleans', () => {
    const base = '[formula.f]\ndescription = "d"\n[[formula.f.steps]]\nrole = "mayor"\n';
    expect(parseFormulasFromToml(base + 'plan_only = true\n')[0]?.steps[0]?.planOnly).toBe(true);
    expect(parseFormulasFromToml(base)[0]?.steps[0]?.planOnly).toBeUndefined();
    expect(() => parseFormulasFromToml(base + 'plan_only = "yes"\n')).toThrow('plan_only must be true or false');
  });

  it('the shipped onboard-feature formula marks the mayor plan-only and nothing else', () => {
    const f = loadFormulasFromFile(join(process.cwd(), 'packs/gastown/formulas/onboard-feature.toml'))[0]!;
    expect(f.steps.filter((s) => s.planOnly).map((s) => s.role)).toEqual(['mayor']);
  });
});
