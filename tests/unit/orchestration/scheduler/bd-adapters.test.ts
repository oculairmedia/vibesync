import { describe, expect, it } from 'vitest';

import {
  BdCommentEscalationStore,
  BdFormulaResolver,
  BdLivenessProbe,
  BdReadyBeadSource,
  BdSlingContextStore,
  GhCliGitHubPort,
  parseJsonOutput,
} from '../../../../src/orchestration/scheduler/bd-adapters.js';
import { serializeParams, SLING_CONTEXT_LABEL, SLING_CONTEXT_VERSION } from '../../../../src/orchestration/scheduler/sling-context.js';

function runner(responses: (args: readonly string[]) => string) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      return responses(args);
    },
  };
}

const params = (id: string) => serializeParams({
  version: SLING_CONTEXT_VERSION, work_bead_id: id, target_project: 'p', formula: 'f', args: '', vars: '',
  enqueued_at: 't', merge: 'direct', convoy: '', dispatch_failures: 0, last_failure: '',
});

describe('parseJsonOutput', () => {
  it('skips leading warning noise and rejects non-JSON', () => {
    expect(parseJsonOutput('warning: x\n[{"id":"a"}]', 'ctx')).toEqual([{ id: 'a' }]);
    expect(() => parseJsonOutput('nope', 'ctx')).toThrow('no JSON');
  });
});

describe('BdReadyBeadSource', () => {
  it('runs bd ready with filters, drops terminal beads, exposes priority/unblock metadata', async () => {
    const bd = runner(() => JSON.stringify([
      { id: 'a', priority: 0, dependent_count: 3 },
      { id: 'b', priority: 3 },
      { id: 'done', priority: 1 },
    ]));
    const src = new BdReadyBeadSource({ bd: bd.run, readyLabel: 'lbl', excludeWorkBeadIds: async () => new Set(['done']) });
    expect([...(await src.readyWorkBeadIds())].sort()).toEqual(['a', 'b']);
    expect(bd.calls[0]).toEqual(expect.arrayContaining(['ready', '--json', '--label', 'lbl', '--exclude-label', SLING_CONTEXT_LABEL]));
    expect(await src.metadataFor('a')).toEqual({ priority: 0, unblockCount: 3, files: [] });
    expect(await src.metadataFor('b')).toMatchObject({ priority: 3, unblockCount: 0 });
  });

  it('omits --label when readyLabel is empty', async () => {
    const bd = runner(() => '[]');
    await new BdReadyBeadSource({ bd: bd.run, readyLabel: '', excludeWorkBeadIds: async () => new Set() }).readyWorkBeadIds();
    expect(bd.calls[0]).not.toContain('--label');
  });

  it('propagates bd failures (the daemon logs them)', async () => {
    const src = new BdReadyBeadSource({ bd: async () => { throw new Error('boom'); }, readyLabel: '', excludeWorkBeadIds: async () => new Set() });
    await expect(src.readyWorkBeadIds()).rejects.toThrow('boom');
  });
});

describe('BdSlingContextStore', () => {
  it('creates an ephemeral labelled bead tracking the work bead and returns its id', async () => {
    const bd = runner(() => 'ctx-9\n');
    const id = await new BdSlingContextStore(bd.run).createSlingContext({ label: 'L', title: 'T', description: 'D', tracksWorkBeadId: 'w' });
    expect(id).toBe('ctx-9');
    expect(bd.calls[0]).toEqual(expect.arrayContaining(['create', '--ephemeral', '--silent', '-l', 'L', '--deps', 'tracks:w']));
  });

  it('rejects a garbage create response instead of storing a bogus id', async () => {
    await expect(new BdSlingContextStore(async () => 'Error: nope happened').createSlingContext({ label: 'L', title: 'T', description: 'D', tracksWorkBeadId: 'w' })).rejects.toThrow('unexpected sling-context id');
  });

  it('lists terminal work beads, ignoring cleared and malformed contexts', async () => {
    const bd = runner(() => JSON.stringify([
      { id: 'c1', description: params('w1'), close_reason: 'dispatched' },
      { id: 'c2', description: params('w2'), close_reason: 'cleared' },
      { id: 'c3', description: 'not json', close_reason: 'dispatched' },
    ]));
    expect([...(await new BdSlingContextStore(bd.run).listTerminalWorkBeadIds())]).toEqual(['w1']);
    expect(bd.calls[0]).toEqual(expect.arrayContaining(['--status', 'closed', '--include-ephemeral']));
  });
});

describe('BdFormulaResolver / BdLivenessProbe', () => {
  const pack = { manifest: { name: 'pk', version: '1' }, root: '/x', scope: 'global', roles: [], formulas: [{ name: 'f1', description: '', whenToUse: '', steps: [] }] } as never;

  it('fails fast on an unknown formula and resolves open beads only', async () => {
    expect(() => new BdFormulaResolver({ bd: async () => '[]', pack, formulaName: 'nope', projectIdentifier: 'p' })).toThrow('not found in pack');
    const open = new BdFormulaResolver({ bd: async () => JSON.stringify([{ id: 'w', title: 'Do it', description: 'desc', status: 'open' }]), pack, formulaName: 'f1', projectIdentifier: 'p' });
    expect(await open.resolve('w')).toMatchObject({ projectIdentifier: 'p', input: expect.stringContaining('Do it') });
    const closed = new BdFormulaResolver({ bd: async () => JSON.stringify([{ id: 'w', status: 'closed' }]), pack, formulaName: 'f1', projectIdentifier: 'p' });
    expect(await closed.resolve('w')).toBeNull();
  });

  it('liveness: closed bead => bead-closed, open => alive, bd failure => throws (witness leaves slot alone)', async () => {
    const slot = { slotId: 's', workBeadId: 'w', allocatedAt: new Date() };
    expect(await new BdLivenessProbe(async () => JSON.stringify([{ status: 'closed' }])).probe(slot)).toBe('bead-closed');
    expect(await new BdLivenessProbe(async () => JSON.stringify([{ status: 'in_progress' }])).probe(slot)).toBe('alive');
    await expect(new BdLivenessProbe(async () => { throw new Error('x'); }).probe(slot)).rejects.toThrow('x');
  });
});

describe('BdCommentEscalationStore', () => {
  it('posts the marker comment once per marker and tracks open/close', async () => {
    const posted: string[][] = [];
    const store = new BdCommentEscalationStore(async (args) => {
      if (args[1] === 'add') { posted.push([...args]); return '{}'; }
      return JSON.stringify(posted.map((p) => ({ text: p[3] })));
    });
    const input = { workBeadId: 'w', runId: 'r', severity: 'MEDIUM' as const, summary: 's', marker: 'NEEDS-MERIDIAN-DECISION: s', createdAt: 't' };
    const rec = await store.createEscalation(input);
    await store.createEscalation(input); // same marker already on the bead => no duplicate comment
    expect(posted).toHaveLength(1);
    expect(await store.findOpenForWorkBead('w')).toMatchObject({ id: rec.id });
    await store.closeEscalation(rec.id, 'ruled');
    expect((await store.listOpen()).some((r) => r.id === rec.id)).toBe(false);
  });
});

describe('GhCliGitHubPort', () => {
  it('maps gh output to PrFacts and merges only the verified head sha', async () => {
    const calls: string[][] = [];
    const port = new GhCliGitHubPort(async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'abc123',
          statusCheckRollup: [{ name: 'typecheck', conclusion: 'SUCCESS' }, { name: 'test', conclusion: '', status: 'IN_PROGRESS' }, { name: 'lint', conclusion: 'FAILURE' }],
        });
      }
      if (args[0] === 'api') return '0\n';
      return '';
    });
    const facts = await port.fetchFacts('o/r', 5, ['typecheck', 'test']);
    expect(facts).toEqual({ requiredChecks: { typecheck: 'SUCCESS', test: 'IN_PROGRESS' }, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false });
    expect(await port.merge('o/r', 5)).toBe('abc123');
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['pr', 'merge', '--match-head-commit', 'abc123']));
    await expect(port.merge('o/r', 99)).rejects.toThrow('no verified head sha');
  });
});
