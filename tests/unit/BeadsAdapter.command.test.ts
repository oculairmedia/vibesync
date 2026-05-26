import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeadsAdapter as BeadsAdapterType } from '../../src/beads/BeadsAdapter.js';

const execFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync,
}));

describe('BeadsAdapter default command runner', () => {
  let BeadsAdapter: typeof BeadsAdapterType;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ BeadsAdapter } = await import('../../src/beads/BeadsAdapter.js'));
  });

  it('executes bd with argv instead of a shell command string', async () => {
    execFileSync.mockReturnValueOnce(JSON.stringify([]));
    const adapter = new BeadsAdapter({
      actor: 'test-runner',
      beadsDb: '/srv/default/.beads',
      cacheTtlMs: 0,
      commandTimeoutMs: 1234,
      maxBuffer: 5678,
      readonly: true,
    });
    const project = {
      identifier: 'PROJ',
      filesystem_path: '/tmp/project; touch /tmp/pwned',
    };

    await adapter.listIssues(
      project,
      {
        assignee: 'alice $(id)',
        status: 'open; echo pwned',
      },
      { forceRefresh: true },
    );

    expect(execFileSync).toHaveBeenCalledWith(
      'bd',
      [
        'list',
        '--status=open; echo pwned',
        '--assignee=alice $(id)',
        '--limit=0',
        '--json',
      ],
      expect.objectContaining({
        encoding: 'utf-8',
        maxBuffer: 5678,
        timeout: 1234,
        env: expect.objectContaining({
          BEADS_ACTOR: 'test-runner',
          BEADS_DB: '/srv/default/.beads',
          BEADS_DIR: '/tmp/project; touch /tmp/pwned/.beads',
          BEADS_READONLY: '1',
        }),
      }),
    );
  });

  it('uses hardened default process limits for bd execution', async () => {
    execFileSync.mockReturnValueOnce(JSON.stringify([]));
    const adapter = new BeadsAdapter({
      beadsDb: '/srv/default/.beads',
    });

    await adapter.listIssues({ identifier: 'PROJ', filesystem_path: '/tmp/project' }, {}, { forceRefresh: true });

    expect(execFileSync).toHaveBeenCalledWith(
      'bd',
      ['list', '--all', '--limit=0', '--json'],
      expect.objectContaining({
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30_000,
      }),
    );
  });
});
