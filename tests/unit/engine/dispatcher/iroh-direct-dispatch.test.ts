/**
 * vibesync-jni4: the real FormulaDispatcher driving the real IrohWrapperProvider
 * against the precondition-enforcing fake wrapper. Proves, at the level the
 * production run failed at, that every step's RECORDED output is its role
 * agent's own report and that the step trace carries providerKind / sessionId /
 * conversationId (null on the live run mol-mol-wi8ykf4h1vm9).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FormulaDispatcher } from '../../../../src/engine/dispatcher/index.js';
import { EventBus } from '../../../../src/engine/events/index.js';
import type { Formula } from '../../../../src/engine/formula/index.js';
import { MoleculeWalker } from '../../../../src/engine/molecule/index.js';
import type { Pack } from '../../../../src/engine/packs/index.js';
import { IrohConnection } from '../../../../src/engine/runtime/iroh/connection.js';
import { IrohWrapperProvider } from '../../../../src/engine/runtime/iroh-wrapper-provider.js';
import { wrapWithParentAgentId } from '../../../../src/engine/boot.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';
import { newDriven } from '../../../_fixtures/step-driver.js';

const PARENT = 'agent-parent';
const ROLE_AGENTS: Record<string, string> = {
  reviewer: 'agent-0248f563-0fd2-4ff4-8a9e-f77288e731a0',
  coder: 'agent-395ae3a2-6b32-46d1-87ca-e94bb9620fae',
  tester: 'agent-d62899c1-b757-4d81-8048-c7970e0e7b47',
};

let provider: IrohWrapperProvider | null = null;
afterEach(async () => {
  await provider?.close();
  provider = null;
});

function harness(fake: FakeIrohWrapper) {
  const connection = new IrohConnection({ dial: fake.dial, peerName: 't', sleep: async () => undefined, backoff: { initialMs: 1, capMs: 2, maxAttempts: 2 } });
  provider = new IrohWrapperProvider({
    connection,
    turnTimeoutMs: 5_000,
    agentIdResolver: { resolveRoleAgent: async (role) => ROLE_AGENTS[role] ?? null },
    // pre-jni4 constructor required this; the new provider must ignore it (see iroh-wrapper-provider.test.ts).
    ...({ personaLoader: { load: async () => 'PERSONA-TEXT-THAT-MUST-NOT-BE-SENT' } } as object),
  } as ConstructorParameters<typeof IrohWrapperProvider>[0]);
  const store = new InMemoryDoltClient();
  // Since vibesync-efee (#58) the dispatcher only cooks and waits; a step
  // dispatcher drives ready steps from the bead graph, wired as boot wires it.
  const dispatcher = newDriven(store, { idPrefix: 'mol',
    provider: wrapWithParentAgentId(provider, PARENT),
    walker: new MoleculeWalker(store),
    eventBus: new EventBus({ noPersist: true }),
    providerResolver: { resolve: (input) => input.projectIdentifier === 'vibesync' ? wrapWithParentAgentId(provider!, PARENT) : null },
  });
  return { dispatcher, store };
}

describe('FormulaDispatcher + IrohWrapperProvider: direct role dispatch (vibesync-jni4)', () => {
  it('creates each dispatched step with its formula title and existing generic create metadata', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    const { dispatcher } = harness(fake);
    const result = await dispatcher.run({
      formula: formula(['reviewer']),
      pack: pack(['reviewer']),
      input: 'review the issue',
      projectIdentifier: 'vibesync',
      motivatingBeadId: 'vibesync-task-42',
    });

    expect(result.outputs.reviewer).toBe('PONG');
    const create = fake.received.find((frame) => frame['method'] === 'conversation.create');
    expect(create?.['params']).toEqual({
      agent_id: ROLE_AGENTS.reviewer,
      summary: 'code-review · reviewer · vibesync-task-42',
      tags: ['lane:work', 'bead:vibesync-task-42', expect.stringMatching(/^run:mol-/)],
    });
    expect(fake.conversationTags.get('conv-1')).toEqual(['lane:work', 'bead:vibesync-task-42', `run:${result.moleculeId}`]);
    expect(fake.received.findIndex((frame) => frame['method'] === 'conversation.create'))
      .toBeLessThan(fake.received.findIndex((frame) => frame['type'] === 'runtime_start'));
    expect(fake.received.findIndex((frame) => frame['type'] === 'runtime_start'))
      .toBeLessThan(fake.received.findIndex((frame) => frame['type'] === 'input'));
    expect(fake.received.some((frame) => frame['type'] === 'admin_rpc' && frame['method'] === 'agent.message.send')).toBe(false);
    expect(fake.violations).toEqual([]);
  });

  it('retries with a fresh conversation preserving existing title behavior', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    const attempts: string[] = [];
    const origInput = (fake as unknown as { onInput: (link: unknown, frame: Record<string, unknown>) => void }).onInput.bind(fake);
    (fake as unknown as { onInput: unknown }).onInput = (link: unknown, frame: Record<string, unknown>) => {
      const cmid = (((frame['payload'] as { messages: Array<{ client_message_id: string }> }).messages)[0]!).client_message_id;
      attempts.push(cmid);
      fake.script = attempts.length === 1
        ? { stopReason: 'llm_api_error', error: 'retry this step' }
        : { stopReason: 'end_turn', finalText: 'retry succeeded' };
      origInput(link, frame);
    };
    const { dispatcher, store } = harness(fake);
    const baseFormula = formula(['reviewer']);
    const retryFormula: Formula = {
      ...baseFormula,
      steps: [{ ...baseFormula.steps[0]!, retry: { maxAttempts: 2, onExhausted: 'fail', backoffMs: 0 } }],
    };
    const result = await dispatcher.run({
      formula: retryFormula,
      pack: pack(['reviewer']),
      input: 'review the issue',
      projectIdentifier: 'vibesync',
      motivatingBeadId: 'vibesync-task-42',
    });
    expect(result.outputs.reviewer).toBe('retry succeeded');
    const view = await new MoleculeWalker(store).load(result.moleculeId);
    expect(view?.steps[0]?.metadata['gc.retry_attempt']).toBe(1);
    expect(attempts).toHaveLength(2);

    const creates = fake.received.filter((frame) => frame['method'] === 'conversation.create');
    expect(creates).toHaveLength(2);
    const tags = creates.map((frame) => (frame['params'] as { tags: string[] }).tags);
    expect(tags[0]).toEqual(['lane:work', 'bead:vibesync-task-42', expect.stringMatching(/^run:mol-/)]);
    expect(tags[1]).toEqual(tags[0]);
    expect(fake.conversationTags.size).toBe(2);
    expect(attempts[0]).toContain(':reviewer:a1');
    expect(attempts[1]).toContain(':reviewer:a1');
    expect(attempts[1]).not.toBe(attempts[0]);
    expect(attempts[1]?.split(':')[1]).toBe(attempts[0]?.split(':')[1]);
    expect(fake.violations).toEqual([]);
  });

  it('preserves the existing title when no motivating bead is supplied', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    const { dispatcher } = harness(fake);
    const result = await dispatcher.run({ formula: formula(['reviewer']), pack: pack(['reviewer']), input: 'x' });
    expect(result.outputs.reviewer).toBe('PONG');
    expect([...fake.conversationTags.values()]).toEqual([['lane:work', `run:${result.moleculeId}`]]);
    expect(fake.conversationTitles.get('conv-1')).toBe('code-review · reviewer');
  });

  it('resumes a running step through project agent resolution and replays its original turn', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    const { dispatcher, store } = harness(fake);
    fake.seedConversation(ROLE_AGENTS.reviewer!, { id: 'conv-persisted', lastMessageAt: new Date().toISOString() });
    const walker = new MoleculeWalker(store);
    const view = await walker.dispatch({
      prefix: 'mol', formulaName: 'code-review', title: '[formula:code-review] resume',
      steps: [{ name: 'reviewer', role: 'reviewer' }],
      projectIdentifier: 'vibesync',
    } as Parameters<typeof walker.dispatch>[0]);
    const stepId = `${view.rootId}-reviewer`;
    await walker.startStep(stepId);
    await walker.recordStepTask(stepId, {
      providerKind: 'letta-code-iroh',
      sessionId: 'letta-code-iroh:agent-previous:reviewer:1',
      conversationId: 'conv-persisted',
    });
    const result = await dispatcher.resume(view.rootId);
    expect(result.outputs.reviewer).toBe('PONG');
    expect(fake.received.some((frame) => frame['type'] === 'input')).toBe(true);
    expect(fake.received.filter((frame) => frame['type'] === 'runtime_start').at(-1)?.['conversation_id']).toBe('conv-persisted');
    const input = fake.received.filter((frame) => frame['type'] === 'input').at(-1)!;
    const message = ((input['payload'] as { messages: Array<{ client_message_id: string; content: string }> }).messages)[0]!;
    expect(message.client_message_id).toBe(`vibesync:${view.rootId}:reviewer:a1`);
    expect(message.content).toBe('');
  });

  it('records each role agent\'s own report as the step output, threads it into the next step, and fills the trace fields', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    fake.listOrder = 'newest-first';
    // Per turn: an unrelated earlier "Waiting for" message must never be picked.
    const reports: Record<string, string> = { reviewer: 'VERDICT: two findings (A, B)', coder: 'CODER: fixed A and B', tester: 'TESTER: 12 passed' };
    const queue = ['reviewer', 'coder', 'tester'];
    const origInput = (fake as unknown as { onInput: (l: unknown, f: Record<string, unknown>) => void }).onInput.bind(fake);
    (fake as unknown as { onInput: unknown }).onInput = (l: unknown, f: Record<string, unknown>) => {
      const role = queue.shift()!;
      fake.script = {
        runId: `run-${role}`,
        finalText: reports[role],
        earlierAssistant: [{ text: `Waiting for the ${role}'s output.`, runId: 'run-parent-placeholder' }],
      };
      origInput(l, f);
    };
    const { dispatcher, store } = harness(fake);

    const result = await dispatcher.run({ formula: formula(), pack: pack(), input: 'review PR 9', projectIdentifier: 'vibesync' });

    expect(result.outputs).toEqual(reports);
    for (const out of Object.values(result.outputs)) expect(out).not.toContain('Waiting for');

    // each step went to its own role agent, in its own conversation; the parent was never contacted
    expect([...fake.conversationAgent.values()]).toEqual([ROLE_AGENTS.reviewer, ROLE_AGENTS.coder, ROLE_AGENTS.tester]);
    expect(JSON.stringify(fake.received)).not.toContain(PARENT);

    // the coder's input contains the reviewer's output; the tester's contains the coder's
    const inputs = fake.received.filter((f) => f['type'] === 'input').map((f) => (f['payload'] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(inputs[1]).toContain(reports.reviewer);
    expect(inputs[2]).toContain(reports.coder);
    expect(inputs.join('\n')).not.toContain('ORCHESTRATION_SUBAGENT_DISPATCH');
    expect(inputs.join('\n')).not.toContain('PERSONA-TEXT-THAT-MUST-NOT-BE-SENT');

    // trace fields (null on the live run)
    const view = await new MoleculeWalker(store).load(result.moleculeId);
    const steps = view!.steps;
    expect(steps).toHaveLength(3);
    const convs: string[] = [];
    for (const step of steps) {
      const exec = step.metadata['exec'] as Record<string, unknown>;
      expect(exec['provider_kind']).toBe('letta-code-iroh');
      expect(exec['session_id']).toEqual(expect.stringMatching(/^letta-code-iroh:agent-/));
      expect(exec['conversation_id']).toEqual(expect.stringMatching(/^conv-\d+$/));
      convs.push(exec['conversation_id'] as string);
      expect((exec['output_payload'] as { output: string }).output).not.toContain('Waiting for');
    }
    expect(new Set(convs).size).toBe(3);
    expect(fake.violations).toEqual([]);
  });

  it('a step whose role has no project_role_agents row FAILS the molecule loudly; nothing reaches the wrapper', async () => {
    const fake = new FakeIrohWrapper({ scope: [PARENT, ...Object.values(ROLE_AGENTS)] });
    const { dispatcher } = harness(fake);
    await expect(
      dispatcher.run({ formula: formula(['unmapped']), pack: pack(['unmapped']), input: 'x', projectIdentifier: 'vibesync' }),
    ).rejects.toThrow(/step "unmapped" failed/);
    expect(fake.received).toEqual([]);
  });
});

function formula(roles: readonly string[] = ['reviewer', 'coder', 'tester']): Formula {
  return {
    name: 'code-review',
    description: 'Code review',
    whenToUse: '',
    steps: roles.map((role, i) => ({
      name: role,
      role,
      promptTemplate: `prompts/${role}.md`,
      ...(i > 0 ? { dependsOn: [roles[i - 1]!] } : {}),
      waitFor: 'completion' as const,
    })),
  };
}

function pack(roles: readonly string[] = ['reviewer', 'coder', 'tester']): Pack {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-jni4-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  roles.forEach((role, i) => {
    writeFileSync(join(root, 'prompts', `${role}.md`), i === 0 ? 'Task for ${input}' : `Task for ${role}. Prior: \${prior_${roles[i - 1]}}`);
  });
  return {
    manifest: { name: 'test-pack', version: '1.0.0' },
    root,
    scope: 'project',
    roles: roles.map((role) => ({ name: role, memoryBlocks: [] })),
    formulas: [],
  } as unknown as Pack;
}
