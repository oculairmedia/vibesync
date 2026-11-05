/**
 * vibesync-9lzk.25: every step prompt carries the project's codebase memories
 * and the instruction to write new ones back. The fake bd returns the real
 * `bd memories --json` shape (a JSON object, key -> content), captured
 * 2026-11-04 from the vibesync tracker.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBdProjectMemorySource, PROJECT_MEMORY_PREFIX, PROJECT_MEMORY_READ_FAILED_EVENT, renderProjectMemory } from '../../../../src/engine/dispatcher/index.js';
import { EventBus, type Event } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import type { SessionEvent, SessionSpec } from '../../../../src/engine/runtime/index.js';
import { newFakeProvider } from '../../../_fixtures/fake-provider.js';
import { newDriven } from '../../../_fixtures/step-driver.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

/** A bd whose `memories --json` prints a key -> content object, like the real one. */
function fakeBd(memories: Record<string, string>) {
  const calls: string[][] = [];
  const bd = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'memories' && args[1] === '--json') return `${JSON.stringify(memories, null, 2)}\n`;
    throw new Error(`unexpected bd ${args.join(' ')}`);
  };
  return Object.assign(bd, { calls });
}

async function* reply(text: string): AsyncIterable<SessionEvent> {
  const ts = new Date().toISOString();
  yield { kind: 'started', ts };
  yield { kind: 'message-delta', ts, text };
  yield { kind: 'turn-done', ts };
}

function pack(): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-memory-'));
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'p.md'), 'Do ${input}');
  return { manifest: { name: 'p', version: '1' }, root, scope: 'project', roles: ['coder', 'reviewer'].map((name) => ({ name, memoryBlocks: [] })), formulas: [] };
}

const twoSteps: Formula = {
  name: 'two', description: 'two', whenToUse: '',
  steps: [
    { name: 'coder', role: 'coder', promptTemplate: 'prompts/p.md' },
    { name: 'reviewer', role: 'reviewer', promptTemplate: 'prompts/p.md', dependsOn: ['coder'] },
  ],
};

function promptTexts(provider: ReturnType<typeof newFakeProvider>): string[] {
  return provider.recorder.prompts.map((p) => p.content.map((c) => ('text' in c ? c.text : '')).join(''));
}

describe('project memory in step prompts (vibesync-9lzk.25)', () => {
  it('every step prompt carries the codebase memories and the write-back instruction', async () => {
    const bd = fakeBd({
      'codebase-registry-scan': 'ProjectRegistry scans one level below baseDir.',
      'codebase-runtime-vs-tests': 'bun:sqlite returns null for a missing row.',
      'rig-session-handoff': 'session notes that must not be injected',
    });
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      projectMemory: createBdProjectMemorySource((p) => (p === 'vibesync' ? bd : null)),
    });
    await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' });

    const prompts = promptTexts(provider);
    expect(prompts).toHaveLength(2);
    for (const text of prompts) {
      expect(text).toContain('codebase-registry-scan: ProjectRegistry scans one level below baseDir.');
      expect(text).toContain('codebase-runtime-vs-tests: bun:sqlite returns null for a missing row.');
      expect(text).not.toContain('session notes that must not be injected');
      expect(text).toContain(`bd remember --key ${PROJECT_MEMORY_PREFIX}<topic>`);
    }
  });

  it('reads memory fresh before EACH step, so a fact written by the coder reaches the reviewer in the same run', async () => {
    const memories: Record<string, string> = {};
    const bd = fakeBd(memories);
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({
      kind: 'fake',
      script: (spec: SessionSpec) => {
        if (spec.role === 'coder') memories['codebase-learned-in-run'] = 'written by the coder step';
        return reply('done');
      },
    });
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      projectMemory: createBdProjectMemorySource((p) => (p === 'vibesync' ? bd : null)),
    });
    await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' });

    const [coderPrompt, reviewerPrompt] = promptTexts(provider);
    expect(coderPrompt).not.toContain('written by the coder step');
    expect(reviewerPrompt).toContain('codebase-learned-in-run: written by the coder step');
    expect(bd.calls.filter((c) => c[0] === 'memories')).toHaveLength(2);
  });

  it('a bd failure never stops a step, and is reported (fail open, not fail silent)', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const failing = () => async () => { throw new Error('bd: Dolt server unreachable'); };
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
      projectMemory: createBdProjectMemorySource(failing),
    });
    await expect(dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' })).resolves.toBeDefined();
    for (const text of promptTexts(provider)) expect(text).toContain('No codebase notes yet.');
    const failures = events.filter((e) => e.kind === PROJECT_MEMORY_READ_FAILED_EVENT);
    expect(failures).toHaveLength(2); // one per step
    expect(failures[0]?.payload).toMatchObject({ projectIdentifier: 'vibesync', stepName: 'coder', error: 'bd: Dolt server unreachable' });
  });

  it('REVIEW: a step for ANOTHER project gets that project\'s memories, never vibesync\'s', async () => {
    const vibesyncBd = fakeBd({ 'codebase-vibesync-only': 'vibesync fact' });
    const otherBd = fakeBd({ 'codebase-other-only': 'other project fact' });
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }),
      projectMemory: createBdProjectMemorySource((p) => ({ vibesync: vibesyncBd, other: otherBd } as Record<string, typeof vibesyncBd>)[p] ?? null),
    });
    await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'other' });
    for (const text of promptTexts(provider)) {
      expect(text).toContain('codebase-other-only: other project fact');
      expect(text).not.toContain('vibesync fact');
    }
  });

  it('REVIEW: a step with no project, or an unknown one, gets no memories at all', async () => {
    const bd = fakeBd({ 'codebase-x': 'must not leak' });
    const src = createBdProjectMemorySource((p) => (p === 'vibesync' ? bd : null));
    expect((await src.read(undefined)).size).toBe(0);
    expect((await src.read('nope')).size).toBe(0);
    expect(bd.calls).toHaveLength(0);
  });

  it('REVIEW: an injected memory source that REJECTS never stops the step, and the warning fires', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
      projectMemory: { read: async () => { throw new Error('memory backend down'); } },
    });
    const result = await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' });
    expect(provider.recorder.starts.map((s) => s.role)).toEqual(['coder', 'reviewer']);
    const failure = events.find((e) => e.kind === PROJECT_MEMORY_READ_FAILED_EVENT);
    expect(failure).toMatchObject({ layer: 'dispatcher', molecule_id: result.moleculeId, payload: { projectIdentifier: 'vibesync', error: 'memory backend down' } });
    expect(typeof failure?.task_id).toBe('string');
  });

  it('a successful read emits no failure event', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const bus = new EventBus({ noPersist: true });
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const dispatcher = newDriven(store, {
      idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: bus,
      projectMemory: createBdProjectMemorySource(() => fakeBd({ 'codebase-a': 'fine' })),
    });
    await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' });
    expect(events.some((e) => e.kind === PROJECT_MEMORY_READ_FAILED_EVENT)).toBe(false);
  });

  it('no project memory configured -> prompts are unchanged (no memory section)', async () => {
    const store = new InMemoryDoltClient();
    const provider = newFakeProvider({ kind: 'fake', script: () => reply('done') });
    const dispatcher = newDriven(store, { idPrefix: 'mol', provider, walker: new MoleculeWalker(store), eventBus: new EventBus({ noPersist: true }) });
    await dispatcher.run({ formula: twoSteps, pack: pack(), input: 'go', projectIdentifier: 'vibesync' });
    for (const text of promptTexts(provider)) expect(text).not.toContain('What this project has learned');
  });
});

describe('renderProjectMemory', () => {
  it('bounds the section and says how many were left out', () => {
    const many = new Map(Array.from({ length: 60 }, (_, i) => [`codebase-k${String(i).padStart(2, '0')}`, 'x'.repeat(300)] as const));
    const text = renderProjectMemory(many);
    expect(text.length).toBeLessThan(10_000);
    const shown = text.split('\n').filter((l) => l.startsWith('- codebase-')).length;
    expect(text).toContain(`(${60 - shown} more not shown`);
  });

  it('REVIEW: tolerates text bd prints before its JSON (a warning line)', async () => {
    const bd = async () => 'Warning: /opt/stacks/vibesync/.beads has permissions 0755 (recommended: 0700)\n{"codebase-a": "still read"}\n';
    expect([...(await createBdProjectMemorySource(() => bd).read('vibesync')).entries()]).toEqual([['codebase-a', 'still read']]);
  });

  it('REVIEW: one oversized memory does not hide the shorter ones after it', () => {
    const text = renderProjectMemory(new Map([['codebase-a-huge', 'x'.repeat(9_000)], ['codebase-b-short', 'fits']]));
    expect(text).toContain('codebase-b-short: fits');
    expect(text).not.toContain('codebase-a-huge');
    expect(text).toContain('(1 more not shown');
  });

  it('the source surfaces bd failures and non-object output as errors (the dispatcher reports them)', async () => {
    await expect(createBdProjectMemorySource(() => async () => { throw new Error('bd exploded'); }).read('vibesync')).rejects.toThrow('bd exploded');
    await expect(createBdProjectMemorySource(() => async () => '[]').read('vibesync')).rejects.toThrow('expected a JSON object');
  });

  it('ignores non-codebase keys and blank values from bd', async () => {
    const src = createBdProjectMemorySource(() => fakeBd({ 'codebase-a': 'kept', 'codebase-b': '   ', other: 'dropped' }));
    expect([...(await src.read('vibesync')).entries()]).toEqual([['codebase-a', 'kept']]);
  });
});
