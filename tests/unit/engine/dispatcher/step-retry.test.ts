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
import { FormulaDispatchError } from '../../../../src/engine/dispatcher/index.js';
import { FormulaEscalationError } from '../../../../src/engine/dispatcher/index.js';
import { GitTurnLimitPreserver } from '../../../../src/engine/dispatcher/turn-limit.js';
import { MoleculeWalker, newMoleculeStepId, type StepSpec } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import { INFRA_RETRY_CAP } from '../../../../src/engine/retry/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import { newDriven } from '../../../_fixtures/step-driver.js';

const worker = (retry?: StepSpec['retry']): StepSpec => ({ name: 'worker', role: 'worker', promptTemplate: 'prompts/p.md', waitFor: 'completion', ...(retry ? { retry } : {}) });
const after: StepSpec = { name: 'after', role: 'after', promptTemplate: 'prompts/p.md', dependsOn: ['worker'], waitFor: 'completion' };
const formula = (...steps: StepSpec[]): Formula => ({ name: 'f', description: 'f', whenToUse: '', steps });

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'ynmp-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}. Prior: ${prior_outputs}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: [{ name: 'worker', memoryBlocks: [] }, { name: 'after', memoryBlocks: [] }], formulas: [] };
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
        yield { kind: 'error', ts, code: turn.code, message: `boom ${turn.code}` };
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
    expect(await preserver.preserve({ workdir: repo, workBeadId: 'bead-1', moleculeId: 'mol-2' })).toBe('no uncommitted work');
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
    let steps: { tick(): Promise<unknown> } | undefined;
    const provider = newFakeProvider({
      kind: 'fake-runtime',
      script: (spec) => (async function* () {
        const ts = new Date().toISOString();
        yield { kind: 'started', ts };
        if (spec.role === 'worker' && turn++ === 0) {
          // The agent closes its own step, declaring a failure, and the scheduler ticks while that is on the bead.
          store.setStepMetadata(String(spec.extra?.['stepId']), { failure_class: 'bad' });
          await store.markStepDone(String(spec.extra?.['stepId']), { output: 'closed by agent' });
          await steps!.tick();
          afterStartedDuringTurn = provider.recorder.starts.filter((st) => st.role === 'after').length;
        }
        yield { kind: 'message-delta', ts, text: `${spec.role} ok` };
        yield { kind: 'turn-done', ts };
      })(),
    });
    const driven = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    steps = driven.steps;
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
