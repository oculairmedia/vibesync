/**
 * vibesync-ynmp: per-step retry policy. The attempt counter lives on the STEP
 * BEAD (gc.retry_attempt), the agent declares a retryable failure by writing
 * failure_class on that bead, and infra failures do not burn an attempt.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { FormulaDispatchError, FormulaEscalationError } from '../../../../src/engine/dispatcher/index.js';
import { GitTurnLimitPreserver } from '../../../../src/engine/dispatcher/turn-limit.js';
import { MoleculeWalker, newMoleculeStepId, type StepSpec } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import { INFRA_RETRY_CAP } from '../../../../src/engine/retry/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import type { SchedulerContextStore } from '../../../../src/engine/scheduler/index.js';
import { createEscalationNotifier } from '../../../../src/engine/scheduler/escalation-notify.js';
import type { SlingContextRecord } from '../../../../src/engine/scheduler/sling-context.js';
import { EscalatedRunError, SchedulerLoop } from '../../../../src/engine/scheduler/scheduler-loop.js';
import { createBdProjectBeadStore } from '../../../../src/engine/beads/project-bead-store.js';
import { BdMoleculeWriter } from '../../../../src/engine/beads/molecule-writer.js';

const worker = (retry?: StepSpec['retry']): StepSpec => ({ name: 'worker', role: 'worker', promptTemplate: 'prompts/p.md', waitFor: 'completion', ...(retry ? { retry } : {}) });
const after: StepSpec = { name: 'after', role: 'after', promptTemplate: 'prompts/p.md', dependsOn: ['worker'], waitFor: 'completion' };
const formula = (...steps: StepSpec[]): Formula => ({ name: 'f', description: 'f', whenToUse: '', steps });

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'ynmp-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}. Prior: ${prior_outputs}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }, { name: 'after', memoryBlocks: [] }], formulas: [] };
}

function makeGitRepo(): { root: string; repo: string; bare: string; initialHead: string } {
  const root = mkdtempSync(join(tmpdir(), 'turn-limit-e2e-'));
  const repo = join(root, 'repo');
  const bare = join(root, 'remote.git');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'work', repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'clean');
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', repo, 'push', '-qu', 'origin', 'work']);
  const initialHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root, repo, bare, initialHead };
}

type Turn = { readonly kind: 'ok'; readonly text?: string } | { readonly kind: 'agent-fail'; readonly failureClass: string } | { readonly kind: 'error'; readonly code: string; readonly text?: string };

/** `turns[n]` is what the (n+1)-th START of the role does; the last turn repeats. */
function harness(turnsByRole: Record<string, readonly Turn[]>) {
  const store = new InMemoryDoltClient();
  const startsByRole = new Map<string, number>();
  const seen: Array<{ role: string; attempt: unknown; infraRetries: unknown }> = [];
  const script = (spec: SessionSpec): AsyncIterable<SessionEvent> => {
    const n = startsByRole.get(spec.role) ?? 0;
    startsByRole.set(spec.role, n + 1);
    seen.push({ role: spec.role, attempt: spec.extra?.['attempt'], infraRetries: spec.extra?.['infraRetries'] });
    const turns = turnsByRole[spec.role] ?? [{ kind: 'ok' as const }];
    const turn = turns[Math.min(n, turns.length - 1)]!;
    const stepId = String(spec.extra?.['stepId']);
    return (async function* () {
      const ts = new Date().toISOString();
      yield { kind: 'started', ts };
      if (turn.kind === 'agent-fail') {
        // What the agent does: `bd update <step> --set-metadata failure_class=...`.
        store.setStepMetadata(stepId, { failure_class: turn.failureClass });
        yield { kind: 'message-delta', ts, text: `attempt failed: ${turn.failureClass}` };
      } else if (turn.kind === 'error') {
        if (turn.text) yield { kind: 'message-delta', ts, text: turn.text };
        yield { kind: 'error', ts, code: turn.code, message: turn.code === 'turn_timeout' ? 'turn did not finish within 1000ms' : `boom ${turn.code}` };
      } else {
        yield { kind: 'message-delta', ts, text: turn.text ?? `${spec.role} ok` };
      }
      yield { kind: 'turn-done', ts };
    })();
  };
  const provider = newFakeProvider({ kind: 'fake-runtime', script });
  const eventBus = new EventBus({ noPersist: true });
  const events: Event[] = [];
  eventBus.subscribe((e) => events.push(e));
  const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus });
  return { dispatcher, store, provider, events, seen, starts: (role: string) => startsByRole.get(role) ?? 0 };
}

const meta = async (store: InMemoryDoltClient, rootId: string, name: string) => (await store.getBead(newMoleculeStepId(rootId, name)))!;

describe('per-step retry policy on the bead (vibesync-ynmp)', () => {
  it('turn timeout preserves work through dispatch and closes scheduler context without retrying', async () => {
    const { repo, bare, initialHead } = makeGitRepo();
    const store = new InMemoryDoltClient();
    store.beads.set('work-1', {
      id: 'work-1', title: 'work', description: '', status: 'open', priority: 2, issue_type: 'task',
      created_at: new Date(), updated_at: new Date(), closed_at: null, metadata: {},
    });
    const provider = newFakeProvider({ kind: 'fake-runtime', script: () => (async function* () {
      writeFileSync(join(repo, 'partial.txt'), 'unfinished partial.txt');
      const ts = new Date().toISOString();
      yield { kind: 'started', ts };
      yield { kind: 'error', ts, code: 'turn_timeout', message: 'turn did not finish within 1000ms' };
      yield { kind: 'turn-done', ts };
    })() });
    const driven = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      turnLimitPreserver: new GitTurnLimitPreserver(), turnLimitRecordStore: {
        appendNoteToBead: (id, note) => store.appendNoteToBead(id, note),
        async addCommentToBead(id, comment) { beadComments.push(`${id}: ${comment}`); },
      },
    });
    const contexts: SlingContextRecord[] = [{ id: 'ctx-work-1', status: 'open', params: {
      version: 1, work_bead_id: 'work-1', target_project: 'vibesync', formula: 'f', args: '', vars: '',
      enqueued_at: new Date().toISOString(), merge: 'direct', convoy: '', dispatch_failures: 0, last_failure: '',
    } }];
    const closed: string[] = [];
    const comments: string[] = [];
    const beadComments: string[] = [];
    const wakes: string[] = [];
    const contextStore: SchedulerContextStore = {
      async queryPending() { return contexts.filter((c) => c.status === 'open'); },
      async closeContext(id, reason) { closed.push(reason); const context = contexts.find((c) => c.id === id); if (context) (context as { status: string }).status = 'closed'; },
      async recordDispatchFailure() { throw new Error('escalation must not count as dispatch failure'); },
    };
    const notifier = createEscalationNotifier({ wakePm: (_id, detail) => { wakes.push(detail); }, commentOnBead: async (_id, text) => { comments.push(text); } });
    let starts = 0;
    const scheduler = new SchedulerLoop({
      config: () => ({ poolSize: 2, batchSize: 1, paused: false }), capacity: { activeCount: 0 }, contextStore,
      readyWork: { async readyWorkBeadIds() { return new Set(['work-1']); } },
      candidateMetadata: { async metadataFor() { return { priority: 2, unblockCount: 0, files: [] }; } },
      executor: { async execute() {
        starts += 1;
        const settled = driven.run({ formula: formula(worker()), pack: pack(), input: 'go', motivatingBeadId: 'work-1', workdir: repo })
          .then(() => undefined, (error: unknown) => {
            if (error instanceof FormulaEscalationError) throw new EscalatedRunError(error.message);
            throw error;
          });
        return { settled };
      } },
      onRunEscalated: async ({ workBeadId, contextId, reason }) => notifier({ workBeadId, contextId, reason }),
    });

    const dispatched = await scheduler.runTick();
    expect(dispatched.dispatched).toEqual(['work-1']);
    await scheduler.drainRuns();
    await scheduler.runTick();

    expect(starts).toBe(1);
    expect(closed).toEqual(['escalated']);
    expect(contexts[0]!.params.dispatch_failures).toBe(0);
    expect(comments.join('\n')).toContain('partial.txt');
    expect(comments.join('\n')).toContain('WIP branch');
    expect(beadComments.join('\n')).toContain('partial.txt');
    expect(beadComments.join('\n')).toContain('WIP branch wip/work-1/');
    expect(wakes.join('\n')).toContain('WIP branch');
    // The worktree stays on its work branch with its files as they were; the WIP is a branch beside it.
    expect(execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('work');
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('partial.txt');
    const wipBranch = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/wip/work-1/'], { encoding: 'utf8' }).trim();
    expect(wipBranch).toMatch(/^wip\/work-1\//);
    expect(execFileSync('git', ['--git-dir', bare, 'show', `${wipBranch}:partial.txt`], { encoding: 'utf8' })).toBe('unfinished partial.txt');
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'work'], { encoding: 'utf8' }).trim()).toBe(initialHead);
  });

  it('posts the full large turn-limit file record as a bead comment', async () => {
    const { repo } = makeGitRepo();
    const store = new InMemoryDoltClient();
    store.beads.set('work-large', {
      id: 'work-large', title: 'work', description: '', status: 'open', priority: 2, issue_type: 'task',
      created_at: new Date(), updated_at: new Date(), closed_at: null, metadata: {},
    });
    const comments: string[] = [];
    const files = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
    const preserver = { async preserve() { return `WIP branch wip/work-large/mol-large; changed files:\n${files.join('\n')}`; } };
    const driven = newDriven(store, {
      idPrefix: 'mol', provider: newFakeProvider({ kind: 'fake-runtime', script: () => (async function* () {
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        yield { kind: 'error', ts, code: 'turn_timeout', message: 'timeout' };
        yield { kind: 'turn-done', ts };
      })() }), walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      turnLimitPreserver: preserver,
      turnLimitRecordStore: {
        appendNoteToBead: (id, note) => store.appendNoteToBead(id, note),
        async addCommentToBead(_id, comment) { comments.push(comment); },
      },
    });
    await expect(driven.run({ formula: formula(worker()), pack: pack(), input: 'go', motivatingBeadId: 'work-large', workdir: repo }))
      .rejects.toBeInstanceOf(FormulaEscalationError);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('src/file-499.ts');
    expect(comments[0]).toContain('WIP branch wip/work-large/mol-large');
  });

  it('the WIP record goes to the run\'s own project tracker, not the engine\'s', async () => {
    const { repo } = makeGitRepo();
    const store = new InMemoryDoltClient();
    const engineComments: string[] = [];
    const projectComments: string[] = [];
    store.addCommentToBead = async (id: string, comment: string) => { engineComments.push(`${id}: ${comment}`); };
    const projectStore = {
      async getBead() { return null; },
      async appendNoteToBead() {},
      async addCommentToBead(id: string, comment: string) { projectComments.push(`${id}: ${comment}`); },
    };
    const homeBinding = { workBeads: null, deliveryVerifier: null, shippedWorkProbe: null, prChecks: null };
    const driven = newDriven(store, {
      idPrefix: 'mol', provider: newFakeProvider({ kind: 'fake-runtime', script: () => (async function* () {
        writeFileSync(join(repo, 'partial.txt'), 'unfinished');
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        yield { kind: 'error', ts, code: 'turn_timeout', message: 'timeout' };
        yield { kind: 'turn-done', ts };
      })() }), walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      turnLimitPreserver: new GitTurnLimitPreserver(),
      projectBindings: (project) => (project === 'other' ? { ...homeBinding, workBeads: projectStore } : homeBinding),
    });
    await expect(driven.run({ formula: formula(worker()), pack: pack(), input: 'go', motivatingBeadId: 'other-1', workdir: repo, projectIdentifier: 'other' }))
      .rejects.toBeInstanceOf(FormulaEscalationError);
    expect(projectComments.join('\n')).toContain('other-1: TURN-LIMIT WIP RECORD');
    expect(projectComments.join('\n')).toContain('partial.txt');
    expect(engineComments).toEqual([]);
  });

  it('a failed WIP comment still escalates the run and names the failure', async () => {
    const { repo } = makeGitRepo();
    const store = new InMemoryDoltClient();
    const driven = newDriven(store, {
      idPrefix: 'mol', provider: newFakeProvider({ kind: 'fake-runtime', script: () => (async function* () {
        writeFileSync(join(repo, 'partial.txt'), 'unfinished');
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        yield { kind: 'error', ts, code: 'turn_timeout', message: 'timeout' };
        yield { kind: 'turn-done', ts };
      })() }), walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      turnLimitPreserver: new GitTurnLimitPreserver(),
      turnLimitRecordStore: { async appendNoteToBead() {}, async addCommentToBead() { throw new Error('bd comments add: database is locked'); } },
    });
    const error = await driven.run({ formula: formula(worker()), pack: pack(), input: 'go', motivatingBeadId: 'work-x', workdir: repo })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormulaEscalationError);
    expect(String((error as Error).message)).toContain('WIP branch wip/work-x/');
    expect(String((error as Error).message)).toContain('posting the WIP record on work-x failed: bd comments add: database is locked');
  });

  it('a push to a remote that never answers is cut off; the WIP stays committed locally and the step still escalates', async () => {
    const { repo } = makeGitRepo();
    // A remote whose transport hangs forever (an unresponsive host, a credential prompt).
    const hang = join(repo, '..', 'hang.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'ext::' + hang]);
    execFileSync('git', ['-C', repo, 'config', 'protocol.ext.allow', 'always']);
    writeFileSync(join(repo, 'partial.txt'), 'unfinished');
    const started = Date.now();
    const details = await new GitTurnLimitPreserver({ gitTimeoutMs: 2_000 }).preserve({ workdir: repo, workBeadId: 'hang', moleculeId: 'mol-h' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(details).toContain('WIP branch wip/hang/mol-h committed locally; push failed');
    expect(execFileSync('git', ['-C', repo, 'rev-parse', '--verify', 'wip/hang/mol-h'], { encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/);
    // Nothing the push started is left running.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const bracketed = hang.replace(/hang\.sh$/, '[h]ang.sh');
    expect(execFileSync('sh', ['-c', `pgrep -f '${bracketed}' || true`], { encoding: 'utf8' }).trim()).toBe('');
  }, 30_000);

  it('both production bead stores post the WIP record with the real bd comment command', async () => {
    const record = 'TURN-LIMIT WIP RECORD (mol-1):\nWIP branch wip/w/mol-1; changed files:\na.ts';
    const projectCalls: string[][] = [];
    await createBdProjectBeadStore(async (args) => { projectCalls.push([...args]); return ''; }).addCommentToBead('proj-7', record);
    expect(projectCalls).toEqual([['comments', 'add', 'proj-7', record]]);
    const engineCalls: string[][] = [];
    await new BdMoleculeWriter(async (args) => { engineCalls.push([...args]); return ''; }, { getBead: async () => null } as never).addCommentToBead('vibesync-9', record);
    expect(engineCalls).toEqual([['comments', 'add', 'vibesync-9', record]]);
  });

  it('a staged-only edit is in the WIP branch (staged, then the working copy restored)', async () => {
    const { repo, bare } = makeGitRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'staged edit');
    execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
    writeFileSync(join(repo, 'tracked.txt'), 'clean'); // working copy back to HEAD; the edit lives only in the index
    const details = await new GitTurnLimitPreserver().preserve({ workdir: repo, workBeadId: 'staged', moleculeId: 'mol-s' });
    expect(details).toContain('tracked.txt');
    const log = execFileSync('git', ['--git-dir', bare, 'log', '--format=%s', 'wip/staged/mol-s'], { encoding: 'utf8' });
    expect(log).toContain('(staged)');
    const stagedCommit = execFileSync('git', ['--git-dir', bare, 'log', '--format=%H', '--grep=(staged)', '--fixed-strings', 'wip/staged/mol-s'], { encoding: 'utf8' }).trim();
    expect(execFileSync('git', ['--git-dir', bare, 'show', `${stagedCommit}:tracked.txt`], { encoding: 'utf8' })).toBe('staged edit');
    expect(execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()).toBe('tracked.txt'); // the real index is untouched
  });

  it('clean turn timeout escalates through the scheduler without a WIP branch', async () => {
    const { repo, bare } = makeGitRepo();
    const store = new InMemoryDoltClient();
    const scriptProvider = newFakeProvider({ kind: 'fake-runtime', script: () => (async function* () {
      const ts = new Date().toISOString();
      yield { kind: 'started', ts };
      yield { kind: 'error', ts, code: 'turn_timeout', message: 'turn did not finish within 1000ms' };
      yield { kind: 'turn-done', ts };
    })() });
    const driven = newDriven(store, { idPrefix: 'mol', provider: scriptProvider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    const context = { id: 'ctx-clean', status: 'open', params: {
      version: 1 as const, work_bead_id: 'clean', target_project: 'vibesync', formula: 'f', args: '', vars: '', enqueued_at: new Date().toISOString(),
      merge: 'direct', convoy: '', dispatch_failures: 0, last_failure: '',
    } } satisfies SlingContextRecord;
    let closeReason = '';
    let failures = 0;
    let starts = 0;
    const scheduler = new SchedulerLoop({
      config: () => ({ poolSize: 1, batchSize: 1, paused: false }), capacity: { activeCount: 0 },
      contextStore: {
        async queryPending() { return context.status === 'open' ? [context] : []; },
        async closeContext(_id, reason) { closeReason = reason; (context as { status: string }).status = 'closed'; },
        async recordDispatchFailure() { failures += 1; return failures; },
      },
      readyWork: { async readyWorkBeadIds() { return new Set(['clean']); } },
      candidateMetadata: { async metadataFor() { return { priority: 1, unblockCount: 0, files: [] }; } },
      executor: { async execute() { starts += 1; return { settled: driven.run({ formula: formula(worker()), pack: pack(), input: 'go', motivatingBeadId: 'clean', workdir: repo }).then(() => undefined).catch((e: unknown) => {
        if (e instanceof FormulaEscalationError) throw new EscalatedRunError(e.message);
        throw e;
      }) }; } },
    });
    await scheduler.runTick();
    await scheduler.drainRuns();
    await scheduler.runTick();
    expect(closeReason).toBe('escalated');
    expect(failures).toBe(0);
    expect(starts).toBe(1);
    expect(execFileSync('git', ['--git-dir', bare, 'branch', '--list', 'wip/clean/*'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('turn limit commits and pushes dirty work to a WIP branch then escalates without retrying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turn-limit-'));
    const repo = join(root, 'repo');
    const bare = join(root, 'remote.git');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'work', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test']);
    writeFileSync(join(repo, 'initial.txt'), 'initial');
    execFileSync('git', ['-C', repo, 'add', 'initial.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
    execFileSync('git', ['-C', repo, 'push', '-qu', 'origin', 'work']);
    writeFileSync(join(repo, 'partial.txt'), 'unfinished');
    const preserver = new GitTurnLimitPreserver();
    const details = await preserver.preserve({ workdir: repo, workBeadId: 'bead-1', moleculeId: 'mol-1' });
    expect(details).toContain('wip/bead-1/mol-1');
    expect(details).toContain('partial.txt');
    expect(execFileSync('git', ['--git-dir', bare, 'show-ref', '--verify', 'refs/heads/wip/bead-1/mol-1'], { encoding: 'utf8' })).toContain('refs/heads/wip/bead-1/mol-1');
    expect(execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('work');
    expect(execFileSync('git', ['--git-dir', bare, 'show', 'wip/bead-1/mol-1:partial.txt'], { encoding: 'utf8' })).toBe('unfinished');
    // The checkout was not moved, so the work is still uncommitted there: a second timeout on the
    // same worktree saves it again, to that run's own WIP branch.
    expect(await preserver.preserve({ workdir: repo, workBeadId: 'bead-1', moleculeId: 'mol-2' })).toContain('wip/bead-1/mol-2');
    expect(execFileSync('git', ['--git-dir', bare, 'show', 'wip/bead-1/mol-2:partial.txt'], { encoding: 'utf8' })).toBe('unfinished');
  });

  it('a clean turn-limit worktree has no WIP branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turn-limit-clean-'));
    const repo = join(root, 'repo');
    const bare = join(root, 'remote.git');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'work', repo]);
    writeFileSync(join(repo, 'tracked.txt'), 'clean');
    execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
    execFileSync('git', ['-C', repo, 'push', '-qu', 'origin', 'work']);
    expect(await new GitTurnLimitPreserver().preserve({ workdir: repo, workBeadId: 'bead-2', moleculeId: 'mol-2' })).toBe('no uncommitted work');
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', 'wip/bead-2/mol-2'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('1. fails twice (agent failure_class) then passes: bead gc.retry_attempt == 3, step closed, molecule continues', async () => {
    const h = harness({ worker: [{ kind: 'agent-fail', failureClass: 'flaky' }, { kind: 'agent-fail', failureClass: 'flaky' }, { kind: 'ok', text: 'finally' }] });
    const result = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 }), after), pack: pack(), input: 'go' });
    const step = await meta(h.store, result.moleculeId, 'worker');
    expect(step.status).toBe('closed');
    expect(step.metadata['gc.retry_attempt']).toBe(3);
    expect(step.metadata['failure_class']).toBeUndefined(); // a success carries none
    expect(step.metadata['gc.last_failure_class']).toBe('flaky');
    expect(step.metadata['gc.retry_outcome']).toBeUndefined();
    expect(result.outputs['worker']).toBe('finally');
    expect(h.seen.filter((s) => s.role === 'worker').map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(h.starts('after')).toBe(1); // the molecule continued
    expect((await h.store.getBead(result.moleculeId))?.status).toBe('closed');
    expect((await h.store.getBead(result.moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
    expect(h.events.filter((e) => e.kind === 'dispatcher/step.retry').map((e) => [e.payload['attempt'], e.payload['nextAttempt'], e.payload['failureClass']])).toEqual([[1, 2, 'flaky'], [2, 3, 'flaky']]);
  });

  it('2a. an infra failure (provider error before the agent ran) then a pass leaves the attempt at 1', async () => {
    const h = harness({ worker: [{ kind: 'error', code: 'stream_error' }, { kind: 'ok' }] });
    const result = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 })), pack: pack(), input: 'go' });
    const step = await meta(h.store, result.moleculeId, 'worker');
    expect(step.status).toBe('closed');
    expect(step.metadata['gc.retry_attempt']).toBe(1);
    expect(step.metadata['gc.infra_retries']).toBe(1);
    expect(h.starts('worker')).toBe(2);
    expect(h.seen.map((s) => [s.attempt, s.infraRetries])).toEqual([[1, 0], [1, 1]]);
  });

  it.each([
    ['iroh_error', 'infra'], ['IrohRefusedError', 'infra'], ['IrohTimeoutError', 'infra'], ['sse_read_error', 'infra'],
    ['stop_reason', 'infra'],       // no output yet: the agent never ran
    ['empty_output', 'agent'], ['something_new', 'agent'],     // unclassified burns an attempt (bounded by max_attempts)
  ])('2b. classification from the error code: %s -> %s', async (code, kind) => {
    const h = harness({ worker: [{ kind: 'error', code }, { kind: 'ok' }] });
    const result = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 })), pack: pack(), input: 'go' });
    const step = await meta(h.store, result.moleculeId, 'worker');
    expect(step.metadata['gc.retry_attempt']).toBe(kind === 'infra' ? 1 : 2);
    expect(step.metadata['gc.infra_retries'] ?? 0).toBe(kind === 'infra' ? 1 : 0);
  });

  it('2c. a turn that died AFTER the agent produced output is an agent failure (burns an attempt)', async () => {
    const h = harness({ worker: [{ kind: 'error', code: 'turn_failed', text: 'partial work' }, { kind: 'ok' }] });
    const result = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 })), pack: pack(), input: 'go' });
    expect((await meta(h.store, result.moleculeId, 'worker')).metadata['gc.retry_attempt']).toBe(2);
  });

  it(`2d. infra failures beyond the cap (${INFRA_RETRY_CAP}) fail the step: no infinite loop, attempt never burned`, async () => {
    const h = harness({ worker: [{ kind: 'error', code: 'iroh_error' }] }); // forever
    const thrown = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 5, onExhausted: 'soft_fail', backoffMs: 0 }), after), pack: pack(), input: 'go' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    const rootId = (thrown as FormulaDispatchError).moleculeId;
    const step = await meta(h.store, rootId, 'worker');
    expect(h.starts('worker')).toBe(INFRA_RETRY_CAP + 1);
    expect(step.status).toBe('closed');
    expect(step.metadata['gc.retry_attempt']).toBe(1);
    expect(step.metadata['gc.infra_retries']).toBe(INFRA_RETRY_CAP);
    expect(step.metadata['gc.retry_outcome']).toBe('infra_exhausted');
    expect(h.starts('after')).toBe(0); // infra exhaustion aborts even under soft_fail: the agent never ran
    expect((await h.store.getBead(rootId))?.metadata).toMatchObject({ exec: { outcome: 'failed' } });
  });

  it('2g. (CodeRabbit #59) a store error AFTER a successful agent turn never re-runs the agent', async () => {
    const h = harness({ worker: [{ kind: 'ok', text: 'did the work once' }, { kind: 'ok', text: 'did the work AGAIN' }] });
    // The agent's turn succeeds; persisting its result then fails transiently.
    const realDone = h.store.markStepDone.bind(h.store);
    let failed = false;
    h.store.markStepDone = (async (...args: Parameters<typeof realDone>) => {
      if (!failed) { failed = true; throw new Error('transient store error after success'); }
      return realDone(...args);
    }) as typeof h.store.markStepDone;
    await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 })), pack: pack(), input: 'go' }).catch(() => undefined);
    // Re-running a completed turn can repeat side effects (a second commit). It must run exactly once.
    expect(h.starts('worker')).toBe(1);
  });

  it('2e. a formula WITHOUT retry fails on the first error, infra included (behaviour unchanged)', async () => {
    const h = harness({ worker: [{ kind: 'error', code: 'iroh_error' }, { kind: 'ok' }] });
    await expect(h.dispatcher.run({ formula: formula(worker()), pack: pack(), input: 'go' })).rejects.toBeInstanceOf(FormulaDispatchError);
    expect(h.starts('worker')).toBe(1);
  });

  it('2f. cancel/requires_approval-class failures are never retried', async () => {
    const h = harness({ worker: [{ kind: 'error', code: 'requires_approval' }, { kind: 'ok' }] });
    await expect(h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 })), pack: pack(), input: 'go' })).rejects.toBeInstanceOf(FormulaDispatchError);
    expect(h.starts('worker')).toBe(1);
  });

  it('3. soft_fail on exhaustion: the step is closed FAILED, its dependents still run, the molecule completes', async () => {
    const h = harness({ worker: [{ kind: 'agent-fail', failureClass: 'lint' }] }); // forever
    const result = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 2, onExhausted: 'soft_fail', backoffMs: 0 }), after), pack: pack(), input: 'go' });
    const step = await meta(h.store, result.moleculeId, 'worker');
    expect(step.status).toBe('closed');
    expect(step.metadata['gc.retry_attempt']).toBe(2);
    expect(step.metadata['gc.retry_outcome']).toBe('soft_failed');
    expect(step.metadata['failure_class']).toBe('lint'); // the final failure stays on the bead
    expect(h.starts('worker')).toBe(2);
    expect(h.starts('after')).toBe(1); // a closed blocker unblocks its dependent (bd semantics)
    const afterPrompt = h.provider.recorder.prompts.at(-1)!.content[0]!;
    expect(afterPrompt.type === 'text' ? afterPrompt.text : '').toContain('soft-failed');
    expect((await h.store.getBead(result.moleculeId))?.metadata).toMatchObject({ exec: { outcome: 'completed' } });
    expect(h.events.find((e) => e.kind === 'dispatcher/step.failed')?.payload).toMatchObject({ softFail: true, retryOutcome: 'soft_failed', failureClass: 'lint' });
  });

  it('4. fail on exhaustion aborts the molecule: root closed failed, dependents never start', async () => {
    const h = harness({ worker: [{ kind: 'agent-fail', failureClass: 'lint' }] });
    const thrown = await h.dispatcher.run({ formula: formula(worker({ maxAttempts: 3, onExhausted: 'fail', backoffMs: 0 }), after), pack: pack(), input: 'go' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormulaDispatchError);
    const rootId = (thrown as FormulaDispatchError).moleculeId;
    const step = await meta(h.store, rootId, 'worker');
    expect(step.metadata['gc.retry_attempt']).toBe(3);
    expect(step.metadata['gc.retry_outcome']).toBe('exhausted');
    expect(h.starts('worker')).toBe(3);
    expect(h.starts('after')).toBe(0);
    const root = await h.store.getBead(rootId);
    expect(root?.status).toBe('closed');
    expect(root?.metadata).toMatchObject({ exec: { outcome: 'failed' } });
    expect((await meta(h.store, rootId, 'after')).status).toBe('open');
  });

  it('an agent that CLOSES its step with a failure_class does not release dependents before the policy rules (live race)', async () => {
    const store = new InMemoryDoltClient();
    let afterStartedDuringTurn = -1;
    let turn = 0;
    const steps: { current?: { tick(): Promise<unknown> } } = {};
    const provider = newFakeProvider({
      kind: 'fake-runtime',
      script: (spec) => (async function* () {
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        if (spec.role === 'worker' && turn++ === 0) {
          // The agent closes its own step, declaring a failure, and the scheduler ticks while that is on the bead.
          store.setStepMetadata(String(spec.extra?.['stepId']), { failure_class: 'bad' });
          await store.markStepDone(String(spec.extra?.['stepId']), { output: 'closed by agent' });
          await steps.current!.tick();
          afterStartedDuringTurn = provider.recorder.starts.filter((st) => st.role === 'after').length;
        }
        yield { kind: 'message-delta', ts, text: `${spec.role} ok` };
        yield { kind: 'turn-done', ts };
      })(),
    });
    const driven = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    steps.current = driven.steps;
    const result = await driven.run({ formula: formula(worker({ maxAttempts: 2, onExhausted: 'fail', backoffMs: 0 }), after), pack: pack(), input: 'go' });
    expect(afterStartedDuringTurn).toBe(0); // the closed-but-unruled blocker held its dependent back
    const step = await meta(store, result.moleculeId, 'worker');
    expect(step.metadata['gc.retry_attempt']).toBe(2); // the failure was ruled a retry: reopened, run again
    expect(provider.recorder.starts.filter((st) => st.role === 'after')).toHaveLength(1);
  });

  it('the deprecated `retries` alias behaves as max_attempts = retries + 1, on_exhausted = fail, and writes the same bead counter', async () => {
    const h = harness({ worker: [{ kind: 'agent-fail', failureClass: 'a' }, { kind: 'agent-fail', failureClass: 'a' }, { kind: 'ok' }] });
    const legacy: StepSpec = { name: 'worker', role: 'worker', promptTemplate: 'prompts/p.md', waitFor: 'completion', retries: 2, retryBackoffMs: 0 };
    const result = await h.dispatcher.run({ formula: formula(legacy), pack: pack(), input: 'go' });
    expect((await meta(h.store, result.moleculeId, 'worker')).metadata['gc.retry_attempt']).toBe(3);
  });
});
