import { describe, expect, it } from 'vitest';

import {
  Refinery,
  evaluateGates,
  type MergeRequest,
  type PrFacts,
  type GitHubPort,
  type RefineryEscalationSink,
} from '../../../../src/orchestration/scheduler/refinery.js';

const REQUIRED = ['test (18.x)', 'test (20.x)', 'typecheck'];

function facts(over: Partial<PrFacts> = {}): PrFacts {
  return {
    requiredChecks: over.requiredChecks ?? { 'test (18.x)': 'SUCCESS', 'test (20.x)': 'SUCCESS', typecheck: 'SUCCESS' },
    mergeable: over.mergeable ?? 'MERGEABLE',
    deletedFiles: over.deletedFiles ?? 0,
    behindBase: over.behindBase ?? false,
  };
}

function mr(prNumber: number, over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: over.id ?? `mr-${prNumber}`,
    repo: over.repo ?? 'oculairmedia/vibesync',
    prNumber,
    workBeadId: over.workBeadId ?? `w${prNumber}`,
    enqueuedAt: over.enqueuedAt ?? `2026-07-18T00:0${prNumber}:00Z`,
  };
}

/** Fake GitHub port: per-PR facts, records merges. */
function fakeGitHub(factsByPr: Record<number, PrFacts | 'throw'>, opts: { mergeThrows?: Set<number> } = {}) {
  const merged: number[] = [];
  const github: GitHubPort = {
    async fetchFacts(_repo, prNumber) {
      const f = factsByPr[prNumber];
      if (f === 'throw' || f === undefined) throw new Error('gh api 500');
      return f;
    },
    async merge(_repo, prNumber) {
      if (opts.mergeThrows?.has(prNumber)) throw new Error('gh merge 405 not mergeable');
      merged.push(prNumber);
      return `sha-${prNumber}`;
    },
  };
  return { github, merged };
}

function makeRefinery(github: GitHubPort) {
  const isolated: Array<{ prNumber: number; gate: string }> = [];
  const escalation: RefineryEscalationSink = {
    async onIsolated(i) { isolated.push({ prNumber: i.prNumber, gate: i.failure.gate }); },
  };
  const refinery = new Refinery({ github, escalation, requiredCheckNames: () => REQUIRED });
  return { refinery, isolated };
}

describe('evaluateGates (vibesync-63zx.6)', () => {
  it('passes when all required checks green, mergeable, no deletions, not behind', () => {
    expect(evaluateGates(facts(), REQUIRED)).toBeNull();
  });
  it('fails when a required check is not SUCCESS (by NAME, not rollup)', () => {
    const f = facts({ requiredChecks: { 'test (18.x)': 'SUCCESS', 'test (20.x)': 'FAILURE', typecheck: 'SUCCESS' } });
    expect(evaluateGates(f, REQUIRED)?.gate).toBe('required-checks-green');
  });
  it('fails when a required check is absent (stale/skipped)', () => {
    const f = facts({ requiredChecks: { 'test (18.x)': 'SUCCESS' } }); // 20.x + typecheck missing
    expect(evaluateGates(f, REQUIRED)?.gate).toBe('required-checks-green');
  });
  it('fails when not MERGEABLE (CONFLICTING)', () => {
    expect(evaluateGates(facts({ mergeable: 'CONFLICTING' }), REQUIRED)?.gate).toBe('mergeable-clean');
  });
  // Pins the fixed dead-code bug: behind-base must be its OWN reachable gate.
  it('fails when the branch is BEHIND base (stale-branch revert risk) — reachable gate', () => {
    const v = evaluateGates(facts({ behindBase: true }), REQUIRED);
    expect(v?.gate).toBe('not-behind-with-deletions');
  });
  it('behind-base is checked even when there are NO deletions in the current diff', () => {
    const v = evaluateGates(facts({ behindBase: true, deletedFiles: 0 }), REQUIRED);
    expect(v).not.toBeNull(); // previously this was dead code and returned null
  });
  it('fails when the diff deletes files (needs human review)', () => {
    expect(evaluateGates(facts({ deletedFiles: 3 }), REQUIRED)?.gate).toBe('no-deleted-files');
  });
});

describe('Refinery.processQueue (vibesync-63zx.6)', () => {
  it('empty queue → no results', async () => {
    const { github } = fakeGitHub({});
    const { refinery } = makeRefinery(github);
    expect(await refinery.processQueue()).toEqual([]);
  });

  it('all gates pass → merges and reports the merge commit', async () => {
    const { github, merged } = fakeGitHub({ 1: facts() });
    const { refinery } = makeRefinery(github);
    refinery.enqueue(mr(1));
    const res = await refinery.processQueue();
    expect(res).toHaveLength(1);
    expect(res[0]!.state).toBe('merged');
    expect(res[0]!.mergeCommit).toBe('sha-1');
    expect(merged).toEqual([1]);
    expect(refinery.pending()).toBe(0);
  });

  it('gate failure → isolates + escalates, does NOT merge, queue continues', async () => {
    const { github, merged } = fakeGitHub({ 1: facts({ mergeable: 'CONFLICTING' }), 2: facts() });
    const { refinery, isolated } = makeRefinery(github);
    refinery.enqueue(mr(1)); // will be isolated
    refinery.enqueue(mr(2)); // good — must still merge despite pr1 failing
    const res = await refinery.processQueue();
    expect(res.find((r) => r.request.prNumber === 1)!.state).toBe('isolated');
    expect(res.find((r) => r.request.prNumber === 2)!.state).toBe('merged');
    expect(merged).toEqual([2]); // ONLY the good one merged
    expect(isolated).toEqual([{ prNumber: 1, gate: 'mergeable-clean' }]);
  });

  it('a behind-base PR is isolated (not silently reverting sibling work)', async () => {
    const { github, merged } = fakeGitHub({ 1: facts({ behindBase: true }) });
    const { refinery, isolated } = makeRefinery(github);
    refinery.enqueue(mr(1));
    const res = await refinery.processQueue();
    expect(res[0]!.state).toBe('isolated');
    expect(isolated[0]!.gate).toBe('not-behind-with-deletions');
    expect(merged).toEqual([]);
  });

  it('a facts-fetch error isolates the MR (never blocks the queue)', async () => {
    const { github, merged } = fakeGitHub({ 1: 'throw', 2: facts() });
    const { refinery } = makeRefinery(github);
    refinery.enqueue(mr(1));
    refinery.enqueue(mr(2));
    const res = await refinery.processQueue();
    expect(res.find((r) => r.request.prNumber === 1)!.state).toBe('isolated');
    expect(merged).toEqual([2]);
  });

  it('a merge ERROR isolates the MR (does not crash the queue)', async () => {
    const { github, merged } = fakeGitHub({ 1: facts(), 2: facts() }, { mergeThrows: new Set([1]) });
    const { refinery } = makeRefinery(github);
    refinery.enqueue(mr(1)); // merge throws → isolated
    refinery.enqueue(mr(2)); // still merges
    const res = await refinery.processQueue();
    expect(res.find((r) => r.request.prNumber === 1)!.state).toBe('isolated');
    expect(merged).toEqual([2]);
  });

  it('enqueue is idempotent by id', async () => {
    const { github } = fakeGitHub({ 1: facts() });
    const { refinery } = makeRefinery(github);
    refinery.enqueue(mr(1));
    refinery.enqueue(mr(1, { id: 'mr-1' })); // same id
    expect(refinery.pending()).toBe(1);
  });

  it('escalation sink failure never kills the queue', async () => {
    const { github, merged } = fakeGitHub({ 1: facts({ mergeable: 'CONFLICTING' }), 2: facts() });
    const escalation: RefineryEscalationSink = { async onIsolated() { throw new Error('escalation transport down'); } };
    const refinery = new Refinery({ github, escalation, requiredCheckNames: () => REQUIRED });
    refinery.enqueue(mr(1));
    refinery.enqueue(mr(2));
    const res = await refinery.processQueue(); // must not throw
    expect(res.find((r) => r.request.prNumber === 2)!.state).toBe('merged');
    expect(merged).toEqual([2]);
  });
});
