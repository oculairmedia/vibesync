import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../lib/HealthService.js', () => ({
  getHealthMetrics: vi.fn(() => ({ status: 'healthy' })),
  updateSystemMetrics: vi.fn(),
  getMetricsRegistry: vi.fn(() => ({
    contentType: 'text/plain',
    metrics: vi.fn().mockResolvedValue('metrics'),
  })),
}));

import { createApiServer } from '../../src/ApiServer.js';

function getRandomPort() {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeRequest(port, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('project registry API routes', () => {
  let server;
  let port;
  let mockProjectRegistry;
  let mockDb;
  let mockDoltHubProvisioner;
  let mockBeadsIssueService;
  let mockBeadsAdapter;
  let tempRoot;
  let beadsProjectPath;
  let nonBeadsProjectPath;

  beforeAll(async () => {
    port = getRandomPort();
    process.env.HEALTH_PORT = String(port);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hvsyn-project-routes-'));
    beadsProjectPath = path.join(tempRoot, 'my-project');
    nonBeadsProjectPath = path.join(tempRoot, 'no-beads-project');
    fs.mkdirSync(path.join(beadsProjectPath, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(beadsProjectPath, '.beads', 'config.yaml'), 'database: dolt\n');
    fs.writeFileSync(path.join(beadsProjectPath, '.beads', 'metadata.json'), '{"backend":"dolt"}\n');
    fs.mkdirSync(path.join(beadsProjectPath, '.beads', 'dolt'), { recursive: true });
    fs.mkdirSync(nonBeadsProjectPath, { recursive: true });

    mockProjectRegistry = {
      registerProject: vi.fn((path) => ({
        identifier: 'NEWPROJ',
        name: 'New Project',
        filesystem_path: path,
        tech_stack: 'node',
      })),
      updateProject: vi.fn((identifier, updates) => {
        if (identifier === 'PROJ-A') {
          return {
            identifier: 'PROJ-A',
            name: 'Project A',
            status: updates.status || 'active',
            tech_stack: 'node',
            issue_count: 5,
            filesystem_path: updates.filesystem_path || beadsProjectPath,
            git_url: updates.git_url || 'https://github.com/oulairmedia/project-a.git',
          };
        }
        if (identifier === 'NEWPROJ') {
          return {
            identifier: 'NEWPROJ',
            name: updates.name || 'New Project',
            status: 'active',
            tech_stack: 'node',
            issue_count: 0,
            filesystem_path: '/opt/stacks/new-project',
            git_url: updates.git_url || 'https://github.com/oulairmedia/new-project.git',
          };
        }
        return null;
      }),
      deleteProject: vi.fn((identifier) => identifier === 'PROJ-A'),
      getProjects: vi.fn(() => [
        {
          identifier: 'PROJ-A',
          name: 'Project A',
          status: 'active',
          tech_stack: 'node',
          issue_count: 5,
          filesystem_path: beadsProjectPath,
        },
        {
          identifier: 'PROJ-B',
          name: 'Project B',
          status: 'active',
          tech_stack: 'python',
          issue_count: 0,
          filesystem_path: nonBeadsProjectPath,
        },
      ]),
      getProject: vi.fn((id) => {
        if (id === 'PROJ-A') {
          return {
            identifier: 'PROJ-A',
            name: 'Project A',
            status: 'active',
            tech_stack: 'node',
            issue_count: 5,
            filesystem_path: beadsProjectPath,
          };
        }
        return null;
      }),
      scanProjects: vi.fn(() => ({ discovered: 10, updated: 8, errors: [] })),
    };

    mockDb = {
      getStats: vi.fn(() => ({ tables: 0, total_rows: 0 })),
      getAllProjects: vi.fn(() => [
        {
          identifier: 'HVSYN',
          name: 'Vibesync Service',
          status: 'active',
          tech_stack: 'node',
          issue_count: 2,
          filesystem_path: beadsProjectPath,
          git_url: 'https://github.com/oulairmedia/vibesync.git',
          last_sync_at: 1700000000000,
          last_checked_at: 1700000100000,
          updated_at: 1700000200000,
        },
        {
          identifier: 'PROJ-A',
          name: 'Project A',
          status: 'active',
          tech_stack: 'node',
          issue_count: 2,
          filesystem_path: beadsProjectPath,
          git_url: 'https://github.com/oulairmedia/project-a.git',
          letta_agent_id: 'agent-project-a',
          letta_folder_id: 'folder-project-a',
          letta_source_id: 'source-project-a',
          letta_last_sync_at: 1700000000000,
          last_sync_at: 1700000000000,
          last_checked_at: 1700000100000,
          updated_at: 1700000200000,
        },
      ]),
      getProject: vi.fn((identifier) => {
        if (identifier === 'HVSYN') {
          return {
            identifier: 'HVSYN',
            name: 'Vibesync Service',
            status: 'active',
            tech_stack: 'node',
            issue_count: 2,
            filesystem_path: beadsProjectPath,
            git_url: 'https://github.com/oulairmedia/vibesync.git',
            last_sync_at: 1700000000000,
            last_checked_at: 1700000100000,
            updated_at: 1700000200000,
          };
        }
        if (identifier !== 'PROJ-A') return null;
        return {
          identifier: 'PROJ-A',
          name: 'Project A',
          status: 'active',
          tech_stack: 'node',
          issue_count: 2,
          filesystem_path: beadsProjectPath,
          git_url: 'https://github.com/oulairmedia/project-a.git',
          letta_agent_id: 'agent-project-a',
          letta_folder_id: 'folder-project-a',
          letta_source_id: 'source-project-a',
          letta_last_sync_at: 1700000000000,
          last_sync_at: 1700000000000,
          last_checked_at: 1700000100000,
          updated_at: 1700000200000,
        };
      }),
      getProjectSummary: vi.fn(() => []),
      getProjectIssues: vi.fn((identifier) => {
        if (identifier === 'HVSYN') {
          return [
            {
              identifier: 'HVSYN-1',
              project_identifier: 'HVSYN',
              title: 'Slug-addressed ready task',
              status: 'todo',
              priority: 'high',
              created_at: 1700000000000,
              updated_at: 1700000200000,
              last_sync_at: 1700000200000,
            },
          ];
        }
        if (identifier !== 'PROJ-A') return [];
        return [
          {
            identifier: 'PROJ-A-1',
            project_identifier: 'PROJ-A',
            title: 'Ready task',
            status: 'todo',
            priority: 'high',
            description: 'Short list-safe summary\n\nFull description body.',
            issue_type: 'task',
            assignee: null,
            acceptance_criteria: 'Criterion one\nCriterion two',
            labels: 'android,project-workspace',
            huly_id: 'huly-parent-1',
            vibe_task_id: 101,
            created_at: 1700000000000,
            updated_at: 1700000200000,
            last_sync_at: 1700000200000,
            sub_issue_count: 1,
            deleted_from_vibe: 0,
          },
          {
            identifier: 'PROJ-A-2',
            project_identifier: 'PROJ-A',
            title: 'Done task',
            status: 'done',
            priority: 'medium',
            vibe_task_id: 102,
            created_at: 1700000000000,
            updated_at: 1700000300000,
            last_sync_at: 1700000300000,
            sub_issue_count: 0,
            deleted_from_vibe: 0,
          },
          {
            identifier: 'PROJ-A-3',
            project_identifier: 'PROJ-A',
            title: 'Blocked child task',
            status: 'blocked',
            priority: 'low',
            parent_huly_id: 'huly-parent-1',
            created_at: 1700000000000,
            updated_at: 1700000400000,
            last_sync_at: 1700000400000,
            sub_issue_count: 0,
            deleted_from_vibe: 0,
          },
        ];
      }),
      getIssue: vi.fn((identifier) => {
        if (identifier !== 'PROJ-A-1') return null;
        return {
          identifier: 'PROJ-A-1',
          project_identifier: 'PROJ-A',
          title: 'Ready task',
          status: 'todo',
          priority: 'high',
          description: 'Short list-safe summary\n\nFull description body.',
          issue_type: 'task',
          acceptance_criteria: 'Criterion one\nCriterion two',
          labels: 'android,project-workspace',
          huly_id: 'huly-parent-1',
          vibe_task_id: 101,
          created_at: 1700000000000,
          updated_at: 1700000200000,
          last_sync_at: 1700000200000,
          sub_issue_count: 1,
          deleted_from_vibe: 0,
        };
      }),
      getProjectFilesystemPath: vi.fn(() => null),
      updateProjectActivity: vi.fn(),
      resolveProjectIdentifier: vi.fn((identifier) => {
        if (identifier === 'vibesync') return 'HVSYN';
        if (identifier === 'PROJ-A' || identifier === 'HVSYN') return identifier;
        return null;
      }),
      getProjectFiles: vi.fn(() => []),
      getOrphanedFiles: vi.fn(() => []),
      getRecentSyncs: vi.fn(() => [
        {
          id: 1,
          started_at: 1700000000000,
          completed_at: 1700000050000,
          projects_processed: 1,
          projects_failed: 0,
          issues_synced: 2,
          duration_ms: 50000,
        },
      ]),
      projects: {
        getProjectLettaInfo: vi.fn(() => ({
          letta_agent_id: 'agent-project-a',
          letta_folder_id: 'folder-project-a',
          letta_source_id: 'source-project-a',
          letta_last_sync_at: 1700000000000,
        })),
        getProjectsNeedingBeadsRemote: vi.fn(() => [
          {
            identifier: 'PROJ-A',
            name: 'Project A',
            status: 'active',
            filesystem_path: beadsProjectPath,
            beads_remote_status: null,
            beads_remote_url: null,
          },
        ]),
      },
    };

    mockDoltHubProvisioner = {
      provisionProject: vi.fn(async () => ({
        status: 'provisioned',
        dry_run: false,
        project_identifier: 'PROJ-A',
        owner: 'oulair',
        repo: 'my_project',
        remote_name: 'origin',
        remote_url: 'https://doltremoteapi.dolthub.com/oulair/my_project',
        visibility: 'private',
        database_created: true,
        database_already_exists: false,
        remote_changed: true,
        pushed: true,
        commands: ['bd dolt remote add origin https://doltremoteapi.dolthub.com/oulair/my_project'],
      })),
    };

    mockBeadsIssueService = {
      mutateIssue: vi.fn(async ({ action }) => ({
        applied: true,
        command: `bd ${action}`,
      })),
    };

    mockBeadsAdapter = {
      listIssues: vi.fn(async () => ({
        items: [
          {
            id: 'PROJ-A-BEADS-1',
            title: 'Fallback Beads task',
            status: 'open',
            priority: 'high',
            type: 'bug',
            description: 'Hydrated from project Beads store',
            labels: ['fallback'],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z',
          },
        ],
      })),
    };

    server = createApiServer({
      config: {
        vibeKanban: { apiUrl: 'http://localhost:9717' },
        sync: { interval: 10000 },
        stacks: { baseDir: '/opt/stacks' },
        letta: { enabled: false },
      },
      healthStats: {},
      db: mockDb,
      onSyncTrigger: vi.fn().mockResolvedValue(undefined),
      onConfigUpdate: vi.fn(),
      projectRegistry: mockProjectRegistry,
      doltHubProvisioner: mockDoltHubProvisioner,
      beadsIssueService: mockBeadsIssueService,
      beadsAdapter: mockBeadsAdapter,
    });

    await new Promise((resolve) => {
      if (server.listening) resolve();
      else server.on('listening', resolve);
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('GET /api/registry/projects', () => {
    it('should return all projects from registry', async () => {
      const res = await makeRequest(port, 'GET', '/api/registry/projects');
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.projects).toHaveLength(2);
      expect(res.body.projects[0].identifier).toBe('PROJ-A');
      expect(res.body.timestamp).toBeDefined();
    });

    it('should pass query filters to getProjects', async () => {
      mockProjectRegistry.getProjects.mockClear();
      await makeRequest(port, 'GET', '/api/registry/projects?status=active&tech_stack=node');
      expect(mockProjectRegistry.getProjects).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', tech_stack: 'node' }),
      );
    });
  });

  describe('GET /api/projects', () => {
    it('should return Android-friendly project summaries', async () => {
      mockDb.getProjectIssues.mockClear();
      const res = await makeRequest(port, 'GET', '/api/projects');

      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(2);
      const project = res.body.projects.find(({ id }) => id === 'PROJ-A');
      expect(project).toEqual(
        expect.objectContaining({
          id: 'PROJ-A',
          identifier: 'PROJ-A',
          name: 'Project A',
          last_activity_at: '2023-11-14T22:13:20.000Z',
          updated_at: '2023-11-14T22:16:40.000Z',
        }),
      );
      expect(project.repo.remote_url).toBe(
        'https://github.com/oulairmedia/project-a.git',
      );
      expect(project.agents.default_agent_id).toBe('agent-project-a');
      expect(project.tracker.provider).toBe('beads');
      expect(project.tracker.capabilities.work_items).toBe(true);
      expect(project.tracker.summary.total_known).toBe(2);
      expect(project.tracker.data_freshness).toEqual(
        expect.objectContaining({
          status: 'available',
          last_sync_at: '2023-11-14T22:13:20.000Z',
          error: null,
          is_stale: true,
          stale_threshold_ms: expect.any(Number),
        }),
      );
      expect(project.etag).toBe('PROJ-A:1700000200000');
      expect(project.work_items).toBeUndefined();
      expect(project.full_agents).toBeUndefined();
      expect(res.body.projects[0].full_conversations).toBeUndefined();
      expect(mockDb.getProjectIssues).not.toHaveBeenCalled();
    });

    it('should honor limit for bounded capability probes', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects?limit=1');

      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.page).toEqual(
        expect.objectContaining({
          has_more: true,
          total_known: 2,
          next_cursor: expect.any(String),
        }),
      );
    });

    it('should advance to the next page using the emitted cursor', async () => {
      const first = await makeRequest(port, 'GET', '/api/projects?limit=1');
      const second = await makeRequest(
        port,
        'GET',
        `/api/projects?limit=1&cursor=${encodeURIComponent(first.body.page.next_cursor)}`,
      );

      expect(first.body.projects[0].id).toBe('HVSYN');
      expect(second.body.projects[0].id).toBe('PROJ-A');
      expect(second.body.page.has_more).toBe(false);
    });

    it('should apply project filters before pagination', async () => {
      const originalGetAllProjects = mockDb.getAllProjects;
      mockDb.getAllProjects = vi.fn(() => [
        ...originalGetAllProjects(),
        {
          identifier: 'ARCHIVED-RUST',
          name: 'Archived Rust Project',
          status: 'archived',
          tech_stack: 'rust',
          mcp_enabled: 0,
          issue_count: 0,
        },
      ]);

      try {
        const res = await makeRequest(port, 'GET', '/api/projects?status=archived&tech_stack=rust&mcp_enabled=false');

        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.projects.map(({ id }) => id)).toEqual(['ARCHIVED-RUST']);
      } finally {
        mockDb.getAllProjects = originalGetAllProjects;
      }
    });

    it('should preserve project metadata when using summary fallback', async () => {
      const originalGetAllProjects = mockDb.getAllProjects;
      mockDb.getAllProjects = undefined;
      mockDb.getProjectSummary.mockReturnValueOnce([
        {
          identifier: 'BEADS-PROJ',
          name: 'Beads Project',
          status: 'active',
          tech_stack: 'node',
          issue_count: 7,
          filesystem_path: '/opt/stacks/beads-project',
          git_url: 'https://github.com/oulairmedia/beads-project.git',
          letta_agent_id: 'agent-beads-project',
          letta_folder_id: 'folder-beads-project',
          letta_source_id: 'source-beads-project',
          letta_last_sync_at: 1700000000000,
          last_sync_at: 1700000000000,
          last_checked_at: 1700000100000,
          updated_at: 1700000200000,
        },
      ]);

      try {
        const res = await makeRequest(port, 'GET', '/api/projects');

        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.projects[0]).toEqual(
          expect.objectContaining({
            id: 'BEADS-PROJ',
            identifier: 'BEADS-PROJ',
            tech_stack: 'node',
          }),
        );
        expect(res.body.projects[0].repo.remote_url).toBe(
          'https://github.com/oulairmedia/beads-project.git',
        );
        expect(res.body.projects[0].agents.default_agent_id).toBe('agent-beads-project');
        expect(res.body.projects[0].tracker.summary.total_known).toBe(7);
      } finally {
        mockDb.getAllProjects = originalGetAllProjects;
      }
    });
  });

  describe('GET /api/projects/:id', () => {
    it('should return project detail summary without nested raw issue data', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A');

      expect(res.statusCode).toBe(200);
      expect(res.body.project.identifier).toBe('PROJ-A');
      expect(res.body.project.tracker.summary.ready).toBe(1);
      expect(res.body.project.tracker.summary.closed_recent).toBe(1);
      expect(res.body.project.work_items).toBeUndefined();
    });

    it('should resolve folder slugs to canonical project identifiers for detail', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/vibesync');

      expect(res.statusCode).toBe(200);
      expect(res.body.project.identifier).toBe('HVSYN');
      expect(res.body.project.tracker.summary.total_known).toBe(1);
      expect(mockDb.getProject).toHaveBeenCalledWith('HVSYN');
      expect(mockDb.getProjectIssues).toHaveBeenCalledWith('HVSYN');
    });

    it('should keep project detail available when tracker hydration fails', async () => {
      mockDb.getProjectIssues.mockImplementationOnce(() => {
        throw new Error('database password leaked in stack trace');
      });

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A');

      expect(res.statusCode).toBe(200);
      expect(res.body.project.identifier).toBe('PROJ-A');
      expect(res.body.project.etag).toBe('PROJ-A:1700000200000');
      expect(res.body.project.tracker.status).toBe('error');
      expect(res.body.project.tracker.data_freshness).toEqual(
        expect.objectContaining({
          status: 'error',
          error: 'Tracker data is temporarily unavailable',
        }),
      );
      expect(res.body.project.tracker.data_freshness.error).not.toContain('password');
      expect(res.body.project.work_items).toBeUndefined();
    });

    it('should return 404 for missing project detail', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/MISSING');

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Project not found');
    });
  });

  describe('GET /api/projects/:id/beads-remote', () => {
    it('should return project-scoped Beads remote status', async () => {
      mockDb.getProject.mockImplementationOnce(() => ({
        identifier: 'PROJ-A',
        name: 'Project A',
        filesystem_path: beadsProjectPath,
        beads_remote_owner: 'oulair',
        beads_remote_repo: 'my_project',
        beads_remote_url: 'https://doltremoteapi.dolthub.com/oulair/my_project',
        beads_remote_name: 'origin',
        beads_remote_status: 'provisioned',
        beads_remote_visibility: 'private',
        beads_remote_provisioned_at: 1700000400000,
        beads_remote_last_push_at: 1700000500000,
      }));

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/beads-remote');

      expect(res.statusCode).toBe(200);
      expect(res.body.beads_remote).toEqual(
        expect.objectContaining({
          owner: 'oulair',
          repo: 'my_project',
          url: 'https://doltremoteapi.dolthub.com/oulair/my_project',
          status: 'provisioned',
          last_push_at: '2023-11-14T22:21:40.000Z',
        }),
      );
    });
  });

  describe('GET /api/projects/beads-remote', () => {
    it('should list projects needing Beads remote provisioning', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/beads-remote');

      expect(res.statusCode).toBe(200);
      expect(res.body.schema_version).toBe(1);
      expect(res.body.total).toBe(1);
      expect(res.body.projects[0]).toEqual(
        expect.objectContaining({
          identifier: 'PROJ-A',
          filesystem_path: beadsProjectPath,
        }),
      );
      expect(mockDb.projects.getProjectsNeedingBeadsRemote).toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/beads-remote/provision', () => {
    it('should provision missing project Beads remotes through the API', async () => {
      mockDoltHubProvisioner.provisionProject.mockClear();

      const res = await makeRequest(port, 'POST', '/api/projects/beads-remote/provision', {
        push: true,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.summary).toEqual(expect.objectContaining({ succeeded: 1, failed: 0 }));
      expect(res.body.results[0].identifier).toBe('PROJ-A');
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'PROJ-A' }),
        { push: true },
      );
    });

    it('should correct all existing filesystem projects when available, not only missing remotes', async () => {
      mockDoltHubProvisioner.provisionProject.mockClear();
      mockDb.getProjectsWithFilesystemPath = vi.fn(() => [
        {
          identifier: 'PROVISIONED',
          name: 'Already Provisioned',
          status: 'active',
          filesystem_path: beadsProjectPath,
          beads_remote_status: 'provisioned',
          beads_remote_url: 'https://doltremoteapi.dolthub.com/oulair/already_provisioned',
        },
        {
          identifier: 'MISSING',
          name: 'Missing Remote',
          status: 'active',
          filesystem_path: beadsProjectPath,
          beads_remote_status: null,
          beads_remote_url: null,
        },
      ]);

      const res = await makeRequest(port, 'POST', '/api/projects/beads-remote/provision', {
        push: false,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.summary).toEqual(expect.objectContaining({ succeeded: 2, failed: 0 }));
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'PROVISIONED' }),
        { push: false },
      );
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'MISSING' }),
        { push: false },
      );
      delete mockDb.getProjectsWithFilesystemPath;
    });

    it('should skip projects without an accessible Beads database', async () => {
      mockDoltHubProvisioner.provisionProject.mockClear();
      mockDb.projects.getProjectsNeedingBeadsRemote.mockReturnValueOnce([
        {
          identifier: 'PROJ-A',
          name: 'Project A',
          status: 'active',
          filesystem_path: beadsProjectPath,
          beads_remote_status: null,
          beads_remote_url: null,
        },
        {
          identifier: 'NO-BEADS',
          name: 'No Beads Project',
          status: 'active',
          filesystem_path: nonBeadsProjectPath,
          beads_remote_status: null,
          beads_remote_url: null,
        },
      ]);

      const res = await makeRequest(port, 'POST', '/api/projects/beads-remote/provision', {
        push: true,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.summary).toEqual(
        expect.objectContaining({ succeeded: 1, failed: 0, skipped: 1 }),
      );
      expect(res.body.skipped[0]).toEqual(
        expect.objectContaining({
          identifier: 'NO-BEADS',
          status: 'skipped',
          reason: 'no_accessible_beads_database',
        }),
      );
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledTimes(1);
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'PROJ-A' }),
        { push: true },
      );
    });

    it('should skip locally unusable Beads databases instead of failing the batch', async () => {
      mockDoltHubProvisioner.provisionProject.mockClear();
      mockDoltHubProvisioner.provisionProject.mockRejectedValueOnce(
        new Error('Command failed: bd dolt remote list\nError: no beads database found'),
      );

      const res = await makeRequest(port, 'POST', '/api/projects/beads-remote/provision', {
        push: true,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.summary).toEqual(
        expect.objectContaining({ succeeded: 0, failed: 0, skipped: 1 }),
      );
      expect(res.body.skipped[0]).toEqual(
        expect.objectContaining({
          identifier: 'PROJ-A',
          status: 'skipped',
          reason: 'unusable_beads_database',
        }),
      );
    });

    it('should support explicitly targeted project identifiers', async () => {
      mockDoltHubProvisioner.provisionProject.mockClear();

      const res = await makeRequest(port, 'POST', '/api/projects/beads-remote/provision', {
        identifiers: ['vibesync'],
        push: false,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.results[0].identifier).toBe('HVSYN');
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'HVSYN' }),
        { push: false },
      );
    });
  });

  describe('POST /api/projects/:id/beads-remote/provision', () => {
    it('should invoke the DoltHub provisioner with sanitized project context', async () => {
      const res = await makeRequest(port, 'POST', '/api/projects/PROJ-A/beads-remote/provision', {
        push: false,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Beads remote provisioned');
      expect(res.body.provisioning.remote_url).toBe(
        'https://doltremoteapi.dolthub.com/oulair/my_project',
      );
      expect(mockDoltHubProvisioner.provisionProject).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: 'PROJ-A',
          filesystem_path: beadsProjectPath,
        }),
        { push: false },
      );
    });

    it('should return a UI-safe provisioning error', async () => {
      mockDoltHubProvisioner.provisionProject.mockRejectedValueOnce(
        new Error('DoltHub database creation failed'),
      );

      const res = await makeRequest(port, 'POST', '/api/projects/PROJ-A/beads-remote/provision');

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Failed to provision Beads remote');
      expect(res.body.details.error).toBe('DoltHub database creation failed');
    });
  });

  describe('GET /api/projects/:id/agents', () => {
    it('should return paginated project agents', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/agents?limit=1');

      expect(res.statusCode).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].id).toBe('agent-project-a');
      expect(res.body.data_freshness).toEqual(
        expect.objectContaining({
          status: 'available',
          last_sync_at: '2023-11-14T22:13:20.000Z',
          error: null,
          is_stale: true,
        }),
      );
      expect(res.body.etag).toBe('PROJ-A:agents:2023-11-14T22:13:20.000Z');
      expect(res.body.page).toEqual(
        expect.objectContaining({ limit: 1, has_more: false, total_known: 1 }),
      );
    });
  });

  describe('GET /api/projects/:id/conversations', () => {
    it('should return empty paginated conversations when conversations are not tracked', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/conversations');

      expect(res.statusCode).toBe(200);
      expect(res.body.conversations).toEqual([]);
      expect(res.body.page.has_more).toBe(false);
      expect(res.body.tracker.status).toBe('not_tracked');
      expect(res.body.etag).toBe('PROJ-A:conversations:2023-11-14T22:16:40.000Z');
      expect(res.body.data_freshness).toEqual(
        expect.objectContaining({
          status: 'unavailable',
          last_sync_at: null,
          error: null,
          is_stale: false,
        }),
      );
    });
  });

  describe('GET /api/projects/:id/work-items', () => {
    it('should return generic paginated work items', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items?limit=1');

      expect(res.statusCode).toBe(200);
      expect(res.body.provider).toBe('beads');
      expect(res.body.work_items).toHaveLength(1);
      expect(res.body.work_items[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-1',
          provider: 'beads',
          title: 'Ready task',
          priority: 'high',
          dependency_count: 0,
          cursor: expect.any(String),
        }),
      );
      expect(res.body.page.has_more).toBe(true);
      expect(res.body.page.next_cursor).toEqual(expect.any(String));
      expect(res.body.data_freshness).toEqual(
        expect.objectContaining({
          status: 'available',
          last_sync_at: '2023-11-14T22:13:20.000Z',
          error: null,
          is_stale: true,
        }),
      );
      expect(res.body.etag).toBe('PROJ-A:work-items:2023-11-14T22:13:20.000Z');
    });

    it('should return a sanitized freshness error when work item hydration fails', async () => {
      mockDb.getProjectIssues.mockImplementationOnce(() => {
        throw new Error('raw sql stack with secret token');
      });

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items');

      expect(res.statusCode).toBe(200);
      expect(res.body.project_identifier).toBe('PROJ-A');
      expect(res.body.work_items).toEqual([]);
      expect(res.body.page.total_known).toBe(0);
      expect(res.body.etag).toBe('PROJ-A:work-items:2023-11-14T22:13:20.000Z');
      expect(res.body.data_freshness).toEqual(
        expect.objectContaining({
          status: 'error',
          error: 'Work item data is temporarily unavailable',
        }),
      );
      expect(res.body.data_freshness.error).not.toContain('secret');
    });

    it('should filter work items by status', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items?status=done');

      expect(res.statusCode).toBe(200);
      expect(res.body.work_items).toHaveLength(1);
      expect(res.body.work_items[0].id).toBe('PROJ-A-2');
      expect(res.body.page.total_known).toBe(1);
    });

    it('should match canonical closed status aliases for work items', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items?status=closed');

      expect(res.statusCode).toBe(200);
      expect(res.body.work_items).toHaveLength(1);
      expect(res.body.work_items[0].id).toBe('PROJ-A-2');
      expect(res.body.page.total_known).toBe(1);
    });

    it('should fall back to the project Beads store when cached work items are empty', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([]);
      mockBeadsAdapter.listIssues.mockClear();

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items');

      expect(res.statusCode).toBe(200);
      expect(mockBeadsAdapter.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'PROJ-A', filesystem_path: beadsProjectPath }),
        {},
        { forceRefresh: true },
      );
      expect(res.body.work_items).toHaveLength(1);
      expect(res.body.work_items[0]).toEqual(
        expect.objectContaining({ id: 'PROJ-A-BEADS-1', title: 'Fallback Beads task' }),
      );
      expect(res.body.data_freshness).toEqual(expect.objectContaining({ source: 'beads' }));
      expect(mockDb.updateProjectActivity).toHaveBeenCalledWith('PROJ-A', 1);
    });

    it('should return closed work items from Beads fallback when cached rows are empty', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([]);
      mockBeadsAdapter.listIssues.mockResolvedValueOnce({
        items: [
          {
            id: 'PROJ-A-BEADS-OPEN',
            title: 'Open fallback task',
            status: 'open',
            priority: 'high',
            updatedAt: '2026-05-02T00:00:00.000Z',
          },
          {
            id: 'PROJ-A-BEADS-DONE',
            title: 'Closed fallback task',
            status: 'done',
            priority: 'medium',
            closedAt: '2026-05-03T00:00:00.000Z',
            updatedAt: '2026-05-03T00:00:00.000Z',
          },
        ],
      });

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/work-items?status=closed');

      expect(res.statusCode).toBe(200);
      expect(mockBeadsAdapter.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'PROJ-A', filesystem_path: beadsProjectPath }),
        { status: 'closed' },
        { forceRefresh: true },
      );
      expect(res.body.work_items).toHaveLength(1);
      expect(res.body.work_items[0]).toEqual(
        expect.objectContaining({ id: 'PROJ-A-BEADS-DONE', title: 'Closed fallback task' }),
      );
      expect(res.body.page.total_known).toBe(1);
      expect(res.body.data_freshness).toEqual(expect.objectContaining({ source: 'beads' }));
    });
  });

  describe('GET /api/projects/:id/issues', () => {
    it('should return Android-facing compact issue summaries', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/issues?ready=true');

      expect(res.statusCode).toBe(200);
      expect(res.body.schema_version).toBe(1);
      expect(res.body.projectId).toBe('PROJ-A');
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-1',
          projectId: 'PROJ-A',
          provider: 'beads',
          title: 'Ready task',
          type: 'task',
          priority: 'high',
          status: 'open',
          ready: true,
          blockedBy: [],
          labels: ['android', 'project-workspace'],
          acceptanceCriteria: ['Criterion one', 'Criterion two'],
        }),
      );
      expect(res.body.issues[0].blocks).toEqual([
        expect.objectContaining({ id: 'PROJ-A-3', status: 'blocked' }),
      ]);
      expect(res.body.issues[0].description).toBeUndefined();
    });

    it('should resolve folder slugs before listing Android issue summaries', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/vibesync/issues');

      expect(res.statusCode).toBe(200);
      expect(res.body.projectId).toBe('HVSYN');
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'HVSYN-1',
          projectId: 'HVSYN',
          title: 'Slug-addressed ready task',
        }),
      );
      expect(mockDb.getProjectIssues).toHaveBeenCalledWith('HVSYN');
    });

    it('should support incremental updatedSince filtering', async () => {
      const res = await makeRequest(
        port,
        'GET',
        '/api/projects/PROJ-A/issues?updatedSince=2023-11-14T22:17:00.000Z&sort=updated',
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.issues.map((issue) => issue.id)).toEqual(['PROJ-A-3', 'PROJ-A-2']);
    });

    it('should fall back to the project Beads store when cached issue rows are empty', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([]);
      mockBeadsAdapter.listIssues.mockClear();

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/issues');

      expect(res.statusCode).toBe(200);
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-BEADS-1',
          projectId: 'PROJ-A',
          title: 'Fallback Beads task',
          type: 'bug',
          status: 'open',
          labels: ['fallback'],
        }),
      );
      expect(res.body.data_freshness).toEqual(expect.objectContaining({ source: 'beads' }));
    });

    it('should return closed Android issues from Beads fallback when cached rows are empty', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([]);
      mockBeadsAdapter.listIssues.mockResolvedValueOnce({
        items: [
          {
            id: 'PROJ-A-BEADS-OPEN',
            title: 'Open fallback task',
            status: 'open',
            priority: 'high',
            type: 'task',
            updatedAt: '2026-05-02T00:00:00.000Z',
          },
          {
            id: 'PROJ-A-BEADS-DONE',
            title: 'Closed fallback task',
            status: 'done',
            priority: 'medium',
            type: 'task',
            closedAt: '2026-05-03T00:00:00.000Z',
            updatedAt: '2026-05-03T00:00:00.000Z',
          },
        ],
      });

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/issues?status=closed');

      expect(res.statusCode).toBe(200);
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-BEADS-DONE',
          projectId: 'PROJ-A',
          title: 'Closed fallback task',
          status: 'closed',
        }),
      );
      expect(res.body.data_freshness).toEqual(expect.objectContaining({ source: 'beads' }));
    });

    it('should prefer fresh Beads issues over stale cached rows for Beads-backed projects', async () => {
      mockDb.getProject.mockReturnValueOnce({
        identifier: 'PROJ-A',
        name: 'Project A',
        status: 'active',
        tech_stack: 'node',
        issue_count: 57,
        filesystem_path: beadsProjectPath,
        beads_remote_status: 'error',
        beads_remote_url: null,
        last_sync_at: 1700000000000,
      });
      mockDb.getProjectIssues.mockReturnValueOnce([
        {
          identifier: 'PROJ-A-STALE',
          project_identifier: 'PROJ-A',
          title: 'Stale cached task',
          status: 'Backlog',
          priority: 'medium',
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:00.000Z',
        },
      ]);
      mockBeadsAdapter.listIssues.mockResolvedValueOnce({
        items: [
          {
            id: 'PROJ-A-BEADS-CLOSED',
            title: 'Fresh closed Beads task',
            status: 'closed',
            priority: 'high',
            type: 'task',
            closedAt: '2026-05-11T16:45:42.000Z',
            updatedAt: '2026-05-11T16:45:42.000Z',
          },
        ],
      });

      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/issues?status=closed');

      expect(res.statusCode).toBe(200);
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-BEADS-CLOSED',
          title: 'Fresh closed Beads task',
          status: 'closed',
        }),
      );
      expect(res.body.data_freshness).toEqual(expect.objectContaining({ source: 'beads' }));
    });
  });

  describe('GET /api/projects/:id/issue-analytics', () => {
    it('should return timezone-aware created and completed issue analytics', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([
        {
          identifier: 'PROJ-A-OPEN',
          project_identifier: 'PROJ-A',
          title: 'Open analytics task',
          status: 'todo',
          priority: 'high',
          issue_type: 'bug',
          assignee: 'emmanuel',
          labels: 'android,project-api',
          created_at: '2026-05-01T14:00:00.000Z',
          updated_at: '2026-05-01T14:30:00.000Z',
        },
        {
          identifier: 'PROJ-A-DONE-1',
          project_identifier: 'PROJ-A',
          title: 'Closed before local midnight',
          status: 'done',
          priority: 'high',
          issue_type: 'feature',
          assignee: 'emmanuel',
          owner: 'emmanuel',
          labels: 'android,project-api',
          close_reason: 'done',
          created_at: '2026-05-01T16:00:00.000Z',
          closed_at: '2026-05-02T03:30:00.000Z',
          updated_at: '2026-05-10T18:24:11.000Z',
        },
        {
          identifier: 'PROJ-A-DONE-2',
          project_identifier: 'PROJ-A',
          title: 'Closed later',
          status: 'closed',
          priority: 'low',
          issue_type: 'task',
          assignee: 'mira',
          labels: 'backend',
          close_reason: 'fixed',
          created_at: '2026-05-03T12:00:00.000Z',
          closed_at: '2026-05-03T15:00:00.000Z',
          updated_at: '2026-05-03T16:00:00.000Z',
        },
      ]);

      const res = await makeRequest(
        port,
        'GET',
        '/api/projects/PROJ-A/issue-analytics?rangeStart=2026-05-01T00:00:00-04:00&rangeEnd=2026-05-04T00:00:00-04:00&granularity=day&timezone=America/Toronto&timelineLimit=1',
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          projectId: 'PROJ-A',
          rangeStart: '2026-05-01T00:00:00-04:00',
          rangeEnd: '2026-05-04T00:00:00-04:00',
          granularity: 'day',
          timezone: 'America/Toronto',
          isPartial: true,
          completionSource: 'issue_close_metadata',
          nextTimelineCursor: expect.any(String),
        }),
      );
      expect(res.body.createdBuckets.map((bucket) => bucket.createdCount)).toEqual([2, 0, 1]);
      expect(res.body.completedBuckets.map((bucket) => bucket.completedCount)).toEqual([1, 0, 1]);
      expect(res.body.createdBuckets[0]).toEqual(
        expect.objectContaining({
          bucketStart: '2026-05-01T00:00:00-04:00',
          bucketEnd: '2026-05-02T00:00:00-04:00',
          label: 'May 1',
        }),
      );
      expect(res.body.summary).toEqual(
        expect.objectContaining({
          openCount: 1,
          inProgressCount: 0,
          completedCount: 2,
          blockedCount: 0,
          readyCount: 1,
          totalCreatedInRange: 3,
          totalCompletedInRange: 2,
        }),
      );
      expect(res.body.completedTimeline).toHaveLength(1);
      expect(res.body.completedTimeline[0]).toEqual(
        expect.objectContaining({
          issueId: 'PROJ-A-DONE-2',
          title: 'Closed later',
          status: 'closed',
          statusLabel: 'closed',
          completedAt: '2026-05-03T15:00:00.000Z',
          completedBy: 'mira',
          completionReason: 'fixed',
        }),
      );
    });

    it('should apply analytics filters consistently', async () => {
      mockDb.getProjectIssues.mockReturnValueOnce([
        {
          identifier: 'PROJ-A-OPEN',
          project_identifier: 'PROJ-A',
          title: 'Open analytics task',
          status: 'todo',
          priority: 'high',
          issue_type: 'bug',
          assignee: 'emmanuel',
          labels: 'android,project-api',
          created_at: '2026-05-01T14:00:00.000Z',
        },
        {
          identifier: 'PROJ-A-DONE-1',
          project_identifier: 'PROJ-A',
          title: 'Closed android task',
          status: 'done',
          priority: 'high',
          issue_type: 'feature',
          assignee: 'emmanuel',
          labels: 'android,project-api',
          created_at: '2026-05-01T16:00:00.000Z',
          closed_at: '2026-05-02T03:30:00.000Z',
        },
        {
          identifier: 'PROJ-A-DONE-2',
          project_identifier: 'PROJ-A',
          title: 'Closed backend task',
          status: 'closed',
          priority: 'low',
          issue_type: 'task',
          assignee: 'mira',
          labels: 'backend',
          created_at: '2026-05-03T12:00:00.000Z',
          closed_at: '2026-05-03T15:00:00.000Z',
        },
      ]);

      const res = await makeRequest(
        port,
        'GET',
        '/api/projects/PROJ-A/issue-analytics?rangeStart=2026-05-01T00:00:00-04:00&rangeEnd=2026-05-04T00:00:00-04:00&granularity=day&timezone=America/Toronto&priorityFilter=high&labelFilter=android&assigneeFilter=emmanuel',
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.createdBuckets.map((bucket) => bucket.createdCount)).toEqual([2, 0, 0]);
      expect(res.body.completedBuckets.map((bucket) => bucket.completedCount)).toEqual([1, 0, 0]);
      expect(res.body.summary).toEqual(
        expect.objectContaining({
          openCount: 1,
          completedCount: 1,
          totalCreatedInRange: 2,
          totalCompletedInRange: 1,
        }),
      );
      expect(res.body.completedTimeline.map((item) => item.issueId)).toEqual(['PROJ-A-DONE-1']);
    });
  });

  describe('GET /api/projects/:id/ready-work', () => {
    it('should return first-class ready work without client-side reconstruction', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/ready-work');

      expect(res.statusCode).toBe(200);
      expect(res.body.readyWork).toHaveLength(1);
      expect(res.body.readyWork[0]).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-1',
          ready: true,
          isBlocked: false,
          status: 'open',
        }),
      );
    });
  });

  describe('GET /api/issues/:id', () => {
    it('should return full Android-facing issue detail by stable ID', async () => {
      const res = await makeRequest(port, 'GET', '/api/issues/PROJ-A-1');

      expect(res.statusCode).toBe(200);
      expect(res.body.schema_version).toBe(1);
      expect(res.body.issue).toEqual(
        expect.objectContaining({
          id: 'PROJ-A-1',
          projectId: 'PROJ-A',
          title: 'Ready task',
          description: 'Short list-safe summary\n\nFull description body.',
          acceptanceCriteria: ['Criterion one', 'Criterion two'],
          labels: ['android', 'project-workspace'],
          ready: true,
        }),
      );
      expect(res.body.issue.timestamps).toEqual(
        expect.objectContaining({
          created_at: '2023-11-14T22:13:20.000Z',
          updated_at: '2023-11-14T22:16:40.000Z',
        }),
      );
      expect(res.body.issue.metadata.vibe_task_id).toBe(101);
    });
  });

  describe('POST /api/issues/:id mutation endpoints', () => {
    it('should claim an issue with idempotency and conflict metadata', async () => {
      const res = await makeRequest(port, 'POST', '/api/issues/PROJ-A-1/claim', {
        assignee: 'mobile-user',
        idempotency_key: 'claim-1',
        if_match: 'PROJ-A-1:1700000200000',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.mutation).toEqual(
        expect.objectContaining({
          action: 'claim',
          idempotency_key: 'claim-1',
          applied: true,
        }),
      );
      expect(mockBeadsIssueService.mutateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'claim',
          idempotencyKey: 'claim-1',
          body: expect.objectContaining({ assignee: 'mobile-user' }),
        }),
      );
    });

    it('should reject stale mutations with structured conflict responses', async () => {
      const res = await makeRequest(port, 'POST', '/api/issues/PROJ-A-1/close', {
        reason: 'done',
        if_match: 'PROJ-A-1:stale',
      });

      expect(res.statusCode).toBe(409);
      expect(res.body.conflict).toEqual(
        expect.objectContaining({
          reason: 'etag_mismatch',
          expected: 'PROJ-A-1:stale',
          current: 'PROJ-A-1:1700000200000',
        }),
      );
    });
  });

  describe('GET /api/projects/:id/activity', () => {
    it('should return cursor-paginated activity items', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/PROJ-A/activity');

      expect(res.statusCode).toBe(200);
      expect(res.body.activity).toHaveLength(1);
      expect(res.body.activity[0]).toEqual(
        expect.objectContaining({
          id: '1',
          type: 'sync',
          project_identifier: 'PROJ-A',
          occurred_at: '2023-11-14T22:14:10.000Z',
        }),
      );
      expect(res.body.page.total_known).toBe(1);
      expect(res.body.data_freshness).toEqual(
        expect.objectContaining({
          status: 'available',
          last_sync_at: '2023-11-14T22:14:10.000Z',
          error: null,
          is_stale: true,
        }),
      );
      expect(res.body.etag).toBe('PROJ-A:activity:2023-11-14T22:14:10.000Z');
    });
  });

  describe('POST /api/registry/projects', () => {
    it('should register a project from filesystem path', async () => {
      const res = await makeRequest(port, 'POST', '/api/registry/projects', {
        filesystem_path: '/opt/stacks/new-project',
        git_url: 'https://github.com/oulairmedia/new-project.git',
      });

      expect(res.statusCode).toBe(201);
      expect(res.body.project.identifier).toBe('NEWPROJ');
      expect(mockProjectRegistry.registerProject).toHaveBeenCalledWith('/opt/stacks/new-project');
      expect(mockProjectRegistry.updateProject).toHaveBeenCalledWith(
        'NEWPROJ',
        expect.objectContaining({ git_url: 'https://github.com/oulairmedia/new-project.git' }),
      );
    });

    it('should validate missing project path', async () => {
      const res = await makeRequest(port, 'POST', '/api/registry/projects', {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('filesystem_path is required');
    });

    it('should reject non-absolute project path', async () => {
      const res = await makeRequest(port, 'POST', '/api/registry/projects', {
        filesystem_path: 'relative/path',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('filesystem_path must be an absolute path');
    });
  });

  describe('PATCH /api/registry/projects/:id', () => {
    it('should update filesystem_path and git_url', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/registry/projects/PROJ-A', {
        filesystem_path: '/opt/stacks/project-a-renamed',
        git_url: 'https://github.com/oulairmedia/project-a-renamed.git',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.project.identifier).toBe('PROJ-A');
      expect(res.body.project.filesystem_path).toBe('/opt/stacks/project-a-renamed');
    });

    it('should return 404 for nonexistent project', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/registry/projects/NONEXISTENT', {
        git_url: 'https://github.com/oulairmedia/none.git',
      });

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Project not found');
    });

    it('should archive a project via status update', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/registry/projects/PROJ-A', {
        status: 'archived',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.project.status).toBe('archived');
      expect(mockProjectRegistry.updateProject).toHaveBeenCalledWith(
        'PROJ-A',
        expect.objectContaining({ status: 'archived' }),
      );
    });

    it('should reject invalid status values', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/registry/projects/PROJ-A', {
        status: 'deleted',
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('status must be one of: active, archived');
    });
  });

  describe('DELETE /api/registry/projects/:id', () => {
    it('should delete an existing project', async () => {
      const res = await makeRequest(port, 'DELETE', '/api/registry/projects/PROJ-A');

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Project deleted');
      expect(res.body.identifier).toBe('PROJ-A');
      expect(mockProjectRegistry.deleteProject).toHaveBeenCalledWith('PROJ-A');
    });

    it('should return 404 for a missing project delete', async () => {
      const res = await makeRequest(port, 'DELETE', '/api/registry/projects/NONEXISTENT');

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Project not found');
    });
  });

  describe('GET /api/registry/projects/:id', () => {
    it('should return a single project', async () => {
      const res = await makeRequest(port, 'GET', '/api/registry/projects/PROJ-A');
      expect(res.statusCode).toBe(200);
      expect(res.body.identifier).toBe('PROJ-A');
      expect(res.body.issue_count).toBe(5);
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/registry/projects/:id/scan', () => {
    it('should trigger scan and return refreshed project', async () => {
      const res = await makeRequest(port, 'POST', '/api/registry/projects/PROJ-A/scan');
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Scan complete');
      expect(res.body.scan.discovered).toBe(10);
      expect(res.body.project.identifier).toBe('PROJ-A');
    });
  });
});
