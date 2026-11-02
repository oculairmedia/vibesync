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

import { FormulaDispatcher } from '../../../../src/orchestration/dispatcher/index.js';
import { EventBus } from '../../../../src/orchestration/events/index.js';
import type { Formula } from '../../../../src/orchestration/formula/index.js';
import { MoleculeWalker } from '../../../../src/orchestration/molecule/index.js';
import type { Pack } from '../../../../src/orchestration/packs/index.js';
import { IrohConnection } from '../../../../src/orchestration/runtime/iroh/connection.js';
import { IrohWrapperProvider } from '../../../../src/orchestration/runtime/iroh-wrapper-provider.js';
import { wrapWithParentAgentId } from '../../../../src/orchestration/boot.js';
import { FakeIrohWrapper } from '../../../_fixtures/fake-iroh-wrapper.js';
import { InMemoryDoltClient } from '../../../_fixtures/in-memory-dolt-client.js';

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
  const dispatcher = new FormulaDispatcher({
    provider: wrapWithParentAgentId(provider, PARENT),
    walker: new MoleculeWalker(store),
    eventBus: new EventBus({ noPersist: true }),
  });
  return { dispatcher, store };
}

describe('FormulaDispatcher + IrohWrapperProvider: direct role dispatch (vibesync-jni4)', () => {
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
