import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoltHubProvisioningService,
  normalizeDoltHubRepoName,
} from '../../src/DoltHubProvisioningService.js';

interface TestProjectRecord {
  identifier: string;
  filesystem_path: string;
}

interface TestDb {
  projects: {
    setProjectBeadsRemote: Mock<(identifier: string, data: Record<string, unknown>) => void>;
    setProjectBeadsRemoteError: Mock<(identifier: string, error: string) => void>;
    getAllProjects: Mock<() => TestProjectRecord[]>;
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
}

type TestCommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

type TestFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function responseStub(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('DoltHubProvisioningService', () => {
  let db: TestDb;
  let fetchImpl: Mock<TestFetchImpl>;
  let commandRunner: Mock<TestCommandRunner>;
  let service: DoltHubProvisioningService;

  beforeEach(() => {
    db = {
      projects: {
        setProjectBeadsRemote: vi.fn(),
        setProjectBeadsRemoteError: vi.fn(),
        getAllProjects: vi.fn(() => []),
      },
    };
    fetchImpl = vi.fn().mockResolvedValue(responseStub(201, '{"ok":true}'));
    let listCalls = 0;
    commandRunner = vi.fn(async (_command, args) => {
      if (args.join(' ') === 'dolt remote list') {
        listCalls += 1;
        return {
          stdout:
            listCalls === 1
              ? ''
              : 'origin https://doltremoteapi.dolthub.com/oulair/letta_mobile\n',
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    });
    service = new DoltHubProvisioningService({
      config: {
        enabled: true,
        dryRun: false,
        apiUrl: 'https://www.dolthub.com/api/v1alpha1',
        apiToken: 'secret-api-token',
        owner: 'oulair',
        defaultVisibility: 'private',
        remoteName: 'origin',
      },
      db,
      logger: { error: vi.fn() },
      fetchImpl,
      commandRunner,
    });
  });

  it('normalizes project paths into DoltHub-safe database names', () => {
    expect(normalizeDoltHubRepoName('letta-mobile')).toBe('letta_mobile');
    expect(normalizeDoltHubRepoName('Matrix Tuwunel Deploy!!')).toBe('matrix_tuwunel_deploy');
  });

  it('creates a private DoltHub database using the raw authorization token header', async () => {
    const result = await service.provisionProject({
      identifier: 'LETTA',
      name: 'Letta Mobile',
      filesystem_path: '/tmp/letta-mobile',
    });

    expect(result.remote_url).toBe('https://doltremoteapi.dolthub.com/oulair/letta_mobile');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.dolthub.com/api/v1alpha1/database',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'secret-api-token' }),
        body: JSON.stringify({
          ownerName: 'oulair',
          repoName: 'letta_mobile',
          description: 'Beads issue database for Letta Mobile',
          visibility: 'private',
        }),
      }),
    );
    expect(db.projects.setProjectBeadsRemote).toHaveBeenCalledWith(
      'LETTA',
      expect.objectContaining({ repo: 'letta_mobile', status: 'provisioned' }),
    );
  });

  it('treats an already-existing DoltHub database as idempotent success', async () => {
    fetchImpl.mockResolvedValueOnce(
      responseStub(409, '{"message":"database already exists"}'),
    );

    const result = await service.provisionProject({
      identifier: 'LETTA',
      name: 'Letta Mobile',
      filesystem_path: '/tmp/letta-mobile',
    });

    expect(result.database_already_exists).toBe(true);
    expect(result.status).toBe('provisioned');
  });

  it('replaces an existing local file remote before adding and pushing the DoltHub remote', async () => {
    let listCalls = 0;
    commandRunner.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'dolt remote list') {
        listCalls += 1;
        return {
          stdout:
            listCalls === 1
              ? 'origin file:///tmp/beads-backup\n'
              : 'origin https://doltremoteapi.dolthub.com/oulair/letta_mobile\n',
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    });

    const result = await service.provisionProject({
      identifier: 'LETTA',
      name: 'Letta Mobile',
      filesystem_path: '/tmp/letta-mobile',
    });

    expect(result.commands).toEqual([
      'bd config get federation.remote',
      'bd config get sync.remote',
      'bd dolt remote list',
      'bd config set federation.remote https://doltremoteapi.dolthub.com/oulair/letta_mobile',
      'bd dolt remote remove origin',
      'bd dolt remote add origin https://doltremoteapi.dolthub.com/oulair/letta_mobile',
      'bd dolt remote list',
      'bd dolt push origin main',
    ]);
    expect(result.remote_changed).toBe(true);
    expect(result.pushed).toBe(true);
  });

  it('declares federation.remote and removes matching legacy sync.remote during provisioning', async () => {
    commandRunner.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'config get federation.remote') {
        return { stdout: 'federation.remote (not set in config.yaml)', stderr: '' };
      }
      if (args.join(' ') === 'config get sync.remote') {
        return { stdout: 'sync.remote = https://doltremoteapi.dolthub.com/oulair/letta_mobile', stderr: '' };
      }
      if (args.join(' ') === 'dolt remote list') {
        return { stdout: 'origin https://doltremoteapi.dolthub.com/oulair/letta_mobile\n', stderr: '' };
      }
      return { stdout: 'ok', stderr: '' };
    });

    const result = await service.provisionProject({
      identifier: 'LETTA',
      name: 'Letta Mobile',
      filesystem_path: '/tmp/letta-mobile',
    });

    expect(result.commands).toEqual([
      'bd config get federation.remote',
      'bd config get sync.remote',
      'bd dolt remote list',
      'bd config set federation.remote https://doltremoteapi.dolthub.com/oulair/letta_mobile',
      'bd config unset sync.remote',
      'bd dolt remote list',
      'bd dolt push origin main',
    ]);
    expect(commandRunner).toHaveBeenCalledWith(
      'bd',
      ['config', 'set', 'federation.remote', 'https://doltremoteapi.dolthub.com/oulair/letta_mobile'],
      expect.objectContaining({ cwd: '/tmp/letta-mobile' }),
    );
    expect(commandRunner).toHaveBeenCalledWith(
      'bd',
      ['config', 'unset', 'sync.remote'],
      expect.objectContaining({ cwd: '/tmp/letta-mobile' }),
    );
    expect(result.remote_changed).toBe(true);
  });

  it('supports dry runs without calling DoltHub or executing bd commands', async () => {
    service = new DoltHubProvisioningService({
      config: {
        enabled: false,
        dryRun: true,
        apiUrl: 'https://www.dolthub.com/api/v1alpha1',
        owner: 'oulair',
        defaultVisibility: 'private',
        remoteName: 'origin',
      },
      db,
      logger: { error: vi.fn() },
      fetchImpl,
      commandRunner,
    });

    const result = await service.provisionProject({
      identifier: 'LETTA',
      name: 'Letta Mobile',
      filesystem_path: '/tmp/letta-mobile',
    });

    expect(result.status).toBe('dry_run');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(result.commands).toContain(
      'bd dolt remote add origin https://doltremoteapi.dolthub.com/oulair/letta_mobile',
    );
  });

  it('moves duplicated project ports into the centralized fleet range before provisioning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vibesync-dolthub-'));
    const target = join(root, 'letta-mobile');
    const other = join(root, 'other');
    for (const projectPath of [target, other]) {
      mkdirSync(join(projectPath, '.beads', 'dolt'), { recursive: true });
      writeFileSync(join(projectPath, '.beads', 'dolt-server.port'), '42709\n');
    }
    db.projects.getAllProjects.mockReturnValue([
      { identifier: 'TARGET', filesystem_path: target },
      { identifier: 'OTHER', filesystem_path: other },
    ]);

    const result = await service.provisionProject({
      identifier: 'TARGET',
      name: 'Target Project',
      filesystem_path: target,
    });

    expect(result.commands.slice(0, 2)).toEqual([
      'bd dolt set port 32000',
      'bd dolt start',
    ]);
    expect(commandRunner).toHaveBeenNthCalledWith(
      1,
      'bd',
      ['dolt', 'set', 'port', '32000'],
      expect.objectContaining({ cwd: target }),
    );
  });
});
