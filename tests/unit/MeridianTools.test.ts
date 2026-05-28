import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    })),
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/rig/provisioner.js', () => ({
  auditRigs: vi.fn(() => []),
  summarizeRigHealth: vi.fn(() => ({
    total: 0, healthy: 0, degraded: 0, noRig: 0, degradedProjects: [],
  })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    execFile: vi.fn(),
  };
});

import { registerMeridianTools } from '../../src/mcp/MeridianTools.js';
import { auditRigs, summarizeRigHealth } from '../../src/rig/provisioner.js';
import { execFile } from 'node:child_process';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: toolName, arguments: args });
  await client.close();
  await server.close();
  return result as { content: { type: string; text: string }[]; isError?: boolean };
}

function mockBdOutput(responses: Record<string, unknown[] | string>) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const cwd = opts.cwd;
      const key = `${cwd}::${args.join(' ')}`;
      for (const [pattern, data] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          const stdout = typeof data === 'string' ? data : JSON.stringify(data);
          cb(null, stdout, '');
          return;
        }
      }
      cb(new Error(`no mock for ${key}`), '', 'not found');
    },
  );
}

describe('MeridianTools', () => {
  let tempDir: string;
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'meridian-tools-test-'));
    server = new McpServer({ name: 'test-meridian', version: '1.0.0' });
    registerMeridianTools(server, { stacksDir: tempDir, apiUrl: 'http://test:3099' });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  function createRig(name: string): string {
    const dir = join(tempDir, name);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, '.beads'), { recursive: true });
    return dir;
  }

  describe('vibesync_status', () => {
    it('returns health summary and empty dispatches for empty stacks dir', async () => {
      (auditRigs as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (summarizeRigHealth as ReturnType<typeof vi.fn>).mockReturnValue({
        total: 0, healthy: 0, degraded: 0, noRig: 0, degradedProjects: [],
      });

      const result = await callTool(server, 'vibesync_status', {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.health.total).toBe(0);
      expect(parsed.rigs).toEqual([]);
      expect(parsed.activeDispatches).toEqual([]);
    });

    it('returns rig info when rigs exist', async () => {
      createRig('vibesync');
      createRig('letta-mobile');

      (auditRigs as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: 'vibesync', path: join(tempDir, 'vibesync'), hasRig: true, hasRemote: true, hasGitRemote: true, gitRemote: 'https://github.com/test/vibesync.git', issuePrefix: 'vibesync' },
        { name: 'letta-mobile', path: join(tempDir, 'letta-mobile'), hasRig: true, hasRemote: false, hasGitRemote: true, gitRemote: 'https://github.com/test/letta-mobile.git', issuePrefix: 'lm' },
      ]);
      (summarizeRigHealth as ReturnType<typeof vi.fn>).mockReturnValue({
        total: 2, healthy: 1, degraded: 1, noRig: 0, degradedProjects: ['letta-mobile'],
      });

      mockBdOutput({
        'in_progress': [],
        'open': [],
      });

      const result = await callTool(server, 'vibesync_status', {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.health.total).toBe(2);
      expect(parsed.health.healthy).toBe(1);
      expect(parsed.health.degraded).toBe(1);
      expect(parsed.rigs).toHaveLength(2);
      expect(parsed.rigs[0].name).toBe('vibesync');
    });

    it('filters to a specific rig when rig param is provided', async () => {
      createRig('vibesync');

      (auditRigs as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: 'vibesync', path: join(tempDir, 'vibesync'), hasRig: true, hasRemote: true, hasGitRemote: true, gitRemote: null, issuePrefix: 'vibesync' },
      ]);
      (summarizeRigHealth as ReturnType<typeof vi.fn>).mockReturnValue({
        total: 1, healthy: 1, degraded: 0, noRig: 0, degradedProjects: [],
      });

      mockBdOutput({
        'in_progress': [{ id: 'vibesync-mol-1', title: 'Running dispatch', status: 'in_progress', issue_type: 'molecule_root' }],
        'open': [{ id: 'vibesync-abc', title: 'Some task', status: 'open' }],
      });

      const result = await callTool(server, 'vibesync_status', { rig: 'vibesync' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.rigs).toHaveLength(1);
      expect(parsed.rigs[0].name).toBe('vibesync');
      expect(parsed.activeDispatches).toHaveLength(1);
      expect(parsed.activeDispatches[0].rig).toBe('vibesync');
    });

    it('returns error for non-existent rig name', async () => {
      (auditRigs as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await callTool(server, 'vibesync_status', { rig: 'nonexistent' });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
    });
  });

  describe('vibesync_query_beads', () => {
    it('returns empty results for no rigs', async () => {
      const result = await callTool(server, 'vibesync_query_beads', {});
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('No matching rigs');
    });

    it('returns beads from multiple rigs', async () => {
      createRig('vibesync');
      createRig('letta-mobile');

      mockBdOutput({
        'vibesync::list --json --status=open': [
          { id: 'vs-1', title: 'Bug in vibesync', status: 'open', priority: 1, issue_type: 'bug', labels: ['streaming'] },
        ],
        'vibesync::list --json --status=in_progress': [],
        'letta-mobile::list --json --status=open': [
          { id: 'lm-1', title: 'Feature in letta-mobile', status: 'open', priority: 2, issue_type: 'feature', labels: [] },
        ],
        'letta-mobile::list --json --status=in_progress': [],
      });

      const result = await callTool(server, 'vibesync_query_beads', {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(2);
      expect(parsed.results).toHaveLength(2);
    });

    it('filters by search term', async () => {
      createRig('vibesync');

      mockBdOutput({
        'vibesync::list --json --status=open': [
          { id: 'vs-1', title: 'Streaming bug', status: 'open', priority: 1, issue_type: 'bug', labels: [] },
          { id: 'vs-2', title: 'Auth refactor', status: 'open', priority: 2, issue_type: 'task', labels: [] },
        ],
        'vibesync::list --json --status=in_progress': [],
      });

      const result = await callTool(server, 'vibesync_query_beads', { search: 'streaming' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(1);
      expect(parsed.results[0].beads[0].id).toBe('vs-1');
    });

    it('filters by issue type', async () => {
      createRig('vibesync');

      mockBdOutput({
        'vibesync::list --json --status=open': [
          { id: 'vs-1', title: 'Bug', status: 'open', priority: 1, issue_type: 'bug', labels: [] },
          { id: 'vs-2', title: 'Epic', status: 'open', priority: 1, issue_type: 'epic', labels: [] },
        ],
        'vibesync::list --json --status=in_progress': [],
      });

      const result = await callTool(server, 'vibesync_query_beads', { type: 'epic' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(1);
      expect(parsed.results[0].beads[0].issue_type).toBe('epic');
    });

    it('filters by specific rig names', async () => {
      createRig('vibesync');
      createRig('letta-mobile');
      createRig('beads');

      mockBdOutput({
        'vibesync::list --json --status=open': [{ id: 'vs-1', title: 'A', status: 'open', priority: 1, issue_type: 'task', labels: [] }],
        'vibesync::list --json --status=in_progress': [],
      });

      const result = await callTool(server, 'vibesync_query_beads', { rigs: ['vibesync'] });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].rig).toBe('vibesync');
    });

    it('filters by label via search', async () => {
      createRig('vibesync');

      mockBdOutput({
        'vibesync::list --json --status=open': [
          { id: 'vs-1', title: 'Streaming issue', status: 'open', priority: 1, issue_type: 'bug', labels: ['streaming', 'p1'] },
          { id: 'vs-2', title: 'Auth issue', status: 'open', priority: 2, issue_type: 'bug', labels: ['auth'] },
        ],
        'vibesync::list --json --status=in_progress': [],
      });

      const result = await callTool(server, 'vibesync_query_beads', { search: 'streaming' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(1);
      expect(parsed.results[0].beads[0].id).toBe('vs-1');
    });
  });

  describe('vibesync_show_dispatch', () => {
    it('returns error when dispatch not found', async () => {
      createRig('vibesync');

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          cb(new Error('not found'), '', 'issue not found');
        },
      );

      const result = await callTool(server, 'vibesync_show_dispatch', { dispatch_id: 'vibesync-mol-nonexistent' });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
    });

    it('returns dispatch details with steps for a molecule root', async () => {
      createRig('vibesync');

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          const argStr = args.join(' ');
          if (argStr.includes('show --json vibesync-mol-abc')) {
            cb(null, JSON.stringify([{
              id: 'vibesync-mol-abc',
              title: '[formula:code-review] Review PR #42',
              status: 'in_progress',
              priority: 2,
              issue_type: 'molecule_root',
              created_at: '2026-05-27T10:00:00Z',
              updated_at: '2026-05-27T10:05:00Z',
              closed_at: null,
              metadata: { exec: { formula: 'code-review', motivating_bead: 'vibesync-xyz' } },
            }]), '');
          } else if (argStr.includes('list --json')) {
            cb(null, JSON.stringify([
              {
                id: 'vibesync-mol-abc-s1',
                title: '[code-review/analyze] Analyze PR',
                status: 'closed',
                issue_type: 'molecule_step',
                metadata: {
                  exec: {
                    step: 'analyze',
                    molecule: 'vibesync-mol-abc',
                    provider_kind: 'letta-code-subagent',
                    task_id: 'task-1',
                    session_id: 'sess-1',
                    attempts: 1,
                    output_payload: { output: 'Analysis complete. No issues found.' },
                  },
                },
              },
              {
                id: 'vibesync-mol-abc-s2',
                title: '[code-review/report] Write report',
                status: 'in_progress',
                issue_type: 'molecule_step',
                metadata: {
                  exec: {
                    step: 'report',
                    molecule: 'vibesync-mol-abc',
                    provider_kind: 'letta-code-subagent',
                    task_id: 'task-2',
                    session_id: 'sess-2',
                    attempts: 1,
                  },
                },
              },
            ]), '');
          } else {
            cb(new Error('no mock'), '', '');
          }
        },
      );

      const result = await callTool(server, 'vibesync_show_dispatch', {
        dispatch_id: 'vibesync-mol-abc',
        rig: 'vibesync',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.rig).toBe('vibesync');
      expect(parsed.dispatch.id).toBe('vibesync-mol-abc');
      expect(parsed.dispatch.formula).toBe('code-review');
      expect(parsed.dispatch.motivating_bead).toBe('vibesync-xyz');
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.stepSummary.total).toBe(2);
      expect(parsed.stepSummary.closed).toBe(1);
      expect(parsed.stepSummary.in_progress).toBe(1);
      expect(parsed.steps[0].output_length).toBe('Analysis complete. No issues found.'.length);
    });

    it('searches all rigs when rig is not specified', async () => {
      createRig('vibesync');
      createRig('letta-mobile');

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], { cwd }: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          const argStr = args.join(' ');
          const isLettaMobile = cwd.includes('letta-mobile');

          if (argStr.includes('show --json lm-mol-1') && isLettaMobile) {
            cb(null, JSON.stringify([{
              id: 'lm-mol-1',
              title: '[formula:fix] Fix bug',
              status: 'closed',
              priority: 2,
              issue_type: 'molecule_root',
              created_at: '2026-05-27T10:00:00Z',
              updated_at: '2026-05-27T10:10:00Z',
              closed_at: '2026-05-27T10:10:00Z',
              metadata: { exec: { formula: 'fix' } },
            }]), '');
          } else if (argStr.includes('list --json') && isLettaMobile) {
            cb(null, '[]', '');
          } else {
            cb(new Error('not found'), '', '');
          }
        },
      );

      const result = await callTool(server, 'vibesync_show_dispatch', { dispatch_id: 'lm-mol-1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.rig).toBe('letta-mobile');
      expect(parsed.dispatch.id).toBe('lm-mol-1');
      expect(parsed.dispatch.formula).toBe('fix');
    });
  });

  // ── Tier 2: vibesync_dispatch_molecule ──────────────────────────

  describe('vibesync_dispatch_molecule', () => {
    it('dispatches a formula via the API and returns moleculeId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ moleculeId: 'mol-test-123', formulaName: 'implement', pack: 'gastown' }),
      });

      const result = await callTool(server, 'vibesync_dispatch_molecule', {
        rig: 'vibesync',
        formula: 'implement',
        input: 'Fix the table renderer bug',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.moleculeId).toBe('mol-test-123');
      expect(parsed.formulaName).toBe('implement');
      expect(parsed.rig).toBe('vibesync');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test:3099/formulas/implement/run',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('passes motivating bead and pack to the API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ moleculeId: 'mol-test-456' }),
      });

      await callTool(server, 'vibesync_dispatch_molecule', {
        rig: 'letta-mobile',
        formula: 'code-review',
        input: 'Review streaming fix',
        pack: 'custom-pack',
        motivating_bead: 'lm-bug-789',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.pack).toBe('custom-pack');
      expect(body.motivatingBeadId).toBe('lm-bug-789');
      expect(body.projectIdentifier).toBe('letta-mobile');
    });

    it('returns error when API call fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Formula not found',
      });

      const result = await callTool(server, 'vibesync_dispatch_molecule', {
        rig: 'vibesync',
        formula: 'nonexistent',
        input: 'test',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('HTTP 404');
    });
  });

  // ── Tier 2: vibesync_assign_bead ────────────────────────────────

  describe('vibesync_assign_bead', () => {
    it('assigns and claims a bead via bd update', async () => {
      createRig('vibesync');
      mockBdOutput({
        'update vibesync-bug-1 --assignee Meridian --claim': 'Updated vibesync-bug-1',
        'show --json vibesync-bug-1': [{ id: 'vibesync-bug-1', title: 'Fix bug', status: 'in_progress', assignee: 'Meridian' }],
      });

      const result = await callTool(server, 'vibesync_assign_bead', {
        bead_id: 'vibesync-bug-1',
        rig: 'vibesync',
        assignee: 'Meridian',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.bead_id).toBe('vibesync-bug-1');
      expect(parsed.assignee).toBe('Meridian');
      expect(parsed.claimed).toBe(true);
      expect(parsed.bead.status).toBe('in_progress');
    });

    it('assigns without claiming when claim is false', async () => {
      createRig('vibesync');
      mockBdOutput({
        'update vibesync-task-2 --assignee Claude': 'Updated vibesync-task-2',
        'show --json vibesync-task-2': [{ id: 'vibesync-task-2', title: 'Task', status: 'open', assignee: 'Claude' }],
      });

      const result = await callTool(server, 'vibesync_assign_bead', {
        bead_id: 'vibesync-task-2',
        rig: 'vibesync',
        assignee: 'Claude',
        claim: false,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.claimed).toBe(false);
    });

    it('returns error for non-existent rig', async () => {
      const result = await callTool(server, 'vibesync_assign_bead', {
        bead_id: 'x-1',
        rig: 'nonexistent',
        assignee: 'test',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
    });
  });

  // ── Tier 2: vibesync_review_dispatch ────────────────────────────

  describe('vibesync_review_dispatch', () => {
    it('accepts a dispatch: adds review note and closes it', async () => {
      createRig('vibesync');
      mockBdOutput({
        'show --json mol-abc': [{
          id: 'mol-abc', title: '[formula:fix]', status: 'in_progress',
          issue_type: 'molecule_root', metadata: { exec: { formula: 'fix' } },
        }],
        'list --json': [],
        'update mol-abc --append-notes': 'Updated mol-abc',
        'close mol-abc': 'Closed mol-abc',
      });

      const result = await callTool(server, 'vibesync_review_dispatch', {
        dispatch_id: 'mol-abc',
        rig: 'vibesync',
        decision: 'accept',
        notes: 'Looks good, all tests pass.',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.decision).toBe('accept');
      expect(parsed.dispatch_closed).toBe(true);
      expect(parsed.rig).toBe('vibesync');
    });

    it('rejects a dispatch: adds note but does not close', async () => {
      createRig('vibesync');
      mockBdOutput({
        'show --json mol-def': [{
          id: 'mol-def', title: '[formula:implement]', status: 'in_progress',
          issue_type: 'molecule_root', metadata: { exec: {} },
        }],
        'list --json': [],
        'update mol-def --append-notes': 'Updated mol-def',
      });

      const result = await callTool(server, 'vibesync_review_dispatch', {
        dispatch_id: 'mol-def',
        rig: 'vibesync',
        decision: 'reject',
        notes: 'Missing error handling.',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.decision).toBe('reject');
      expect(parsed.dispatch_closed).toBe(false);
    });

    it('returns error for non-existent dispatch', async () => {
      createRig('vibesync');
      mockBdOutput({});

      const result = await callTool(server, 'vibesync_review_dispatch', {
        dispatch_id: 'nonexistent',
        decision: 'accept',
        notes: 'test',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
    });
  });

  // ── Tier 3: vibesync_verify_pr ──────────────────────────────────

  describe('vibesync_verify_pr', () => {
    it('runs typecheck suite and returns pass result', async () => {
      createRig('myrig');
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[], _opts: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          if (cmd === 'npx' && args[0] === 'tsc') {
            cb(null, '', '');
          } else if (cmd === 'bd') {
            cb(new Error('no mock'), '', '');
          }
        },
      );

      const result = await callTool(server, 'vibesync_verify_pr', {
        rig: 'myrig',
        pr_number: 42,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.passed).toBe(true);
      expect(parsed.suite).toBe('typecheck');
      expect(parsed.exit_code).toBe(0);
      expect(parsed.pr_number).toBe(42);
    });

    it('returns fail result when suite exits non-zero', async () => {
      createRig('myrig');
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, args: string[], _opts: { cwd: string }, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          if (cmd === 'npx' && args[0] === 'vitest') {
            const err: NodeJS.ErrnoException = new Error('test failed');
            err.code = '1' as unknown as string;
            (err as unknown as Record<string, unknown>).code = 1;
            cb(err, 'FAIL src/foo.test.ts', 'Error: assertion failed');
          } else if (cmd === 'bd') {
            cb(new Error('no mock'), '', '');
          }
        },
      );

      const result = await callTool(server, 'vibesync_verify_pr', {
        rig: 'myrig',
        pr_number: 10,
        suite: 'test',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.passed).toBe(false);
      expect(parsed.suite).toBe('test');
      expect(parsed.exit_code).toBe(1);
    });

    it('returns error for unknown suite', async () => {
      createRig('myrig');

      const result = await callTool(server, 'vibesync_verify_pr', {
        rig: 'myrig',
        pr_number: 1,
        suite: 'unknown-suite',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('Unknown suite');
    });
  });

  // ── Tier 3: vibesync_request_merge ──────────────────────────────

  describe('vibesync_request_merge', () => {
    it('creates a merge-request bead for human approval', async () => {
      createRig('vibesync');
      mockBdOutput({
        'create': '✓ Created issue: vibesync-mr99 — [merge-request] PR #15',
      });

      const result = await callTool(server, 'vibesync_request_merge', {
        rig: 'vibesync',
        pr_number: 15,
        justification: 'All tests pass, reviewed by Meridian.',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.status).toBe('queued_for_human_approval');
      expect(parsed.pr_number).toBe(15);
      expect(parsed.rig).toBe('vibesync');
      expect(parsed.merge_request_bead).toBe('vibesync-mr99');
    });

    it('returns error for non-existent rig', async () => {
      const result = await callTool(server, 'vibesync_request_merge', {
        rig: 'nonexistent',
        pr_number: 1,
        justification: 'test',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
    });
  });
});
