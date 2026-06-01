/**
 * Unit Tests for Database Module
 *
 * Tests SQLite database operations for sync state management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncDatabase } from '../../src/database';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

describe('SyncDatabase', () => {
  let db;
  let testDbPath;

  beforeEach(() => {
    // Create unique test database for each test
    testDbPath = process.env.DB_PATH.replace('.db', `-${process.pid}-${Date.now()}-${randomUUID()}.db`);
    db = new SyncDatabase(testDbPath);
    db.initialize();
  });

  afterEach(() => {
    // Clean up test database
    if (db.db) {
      db.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    // Clean up WAL and SHM files
    ['-wal', '-shm'].forEach(suffix => {
      const file = testDbPath + suffix;
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });

  describe('initialization', () => {
    it('should create database file', () => {
      expect(fs.existsSync(testDbPath)).toBe(true);
    });

    it('should create all required tables', () => {
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('sync_metadata');
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('issues');
      expect(tableNames).toContain('sync_history');
    });

    it('should create indexes', () => {
      const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();

      const indexNames = indexes.map(i => i.name);
      expect(indexNames.length).toBeGreaterThan(0);
      expect(indexNames).toContain('idx_projects_last_sync');
      expect(indexNames).toContain('idx_issues_project');
      expect(indexNames).toContain('idx_issues_vibe_task_id');
      expect(indexNames).toContain('idx_issues_vibe_status');
    });

    it('should enable WAL mode', () => {
      const journalMode = db.db.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');
    });

    it('should enable foreign keys', () => {
      const foreignKeys = db.db.pragma('foreign_keys', { simple: true });
      expect(foreignKeys).toBe(1);
    });
  });

  describe('metadata operations', () => {
    describe('getLastSync', () => {
      it('should return null when no sync has occurred', () => {
        const lastSync = db.getLastSync();
        expect(lastSync).toBeNull();
      });

      it('should return last sync timestamp after setting', () => {
        const timestamp = Date.now();
        db.setLastSync(timestamp);

        const lastSync = db.getLastSync();
        expect(lastSync).toBe(timestamp);
      });
    });

    describe('setLastSync', () => {
      it('should store sync timestamp', () => {
        const timestamp = 1234567890;
        db.setLastSync(timestamp);

        const lastSync = db.getLastSync();
        expect(lastSync).toBe(timestamp);
      });

      it('should update existing timestamp', () => {
        db.setLastSync(1000);
        db.setLastSync(2000);

        const lastSync = db.getLastSync();
        expect(lastSync).toBe(2000);
      });
    });
  });

  describe('project operations', () => {
    describe('computeDescriptionHash', () => {
      it('should compute hash for valid description', () => {
        const hash = SyncDatabase.computeDescriptionHash('Test description');
        expect(hash).toBeTruthy();
        expect(hash).toHaveLength(16); // SHA256 substring
      });

      it('should return null for empty description', () => {
        expect(SyncDatabase.computeDescriptionHash('')).toBeNull();
        expect(SyncDatabase.computeDescriptionHash(null)).toBeNull();
        expect(SyncDatabase.computeDescriptionHash(undefined)).toBeNull();
      });

      it('should produce consistent hashes', () => {
        const hash1 = SyncDatabase.computeDescriptionHash('Test');
        const hash2 = SyncDatabase.computeDescriptionHash('Test');
        expect(hash1).toBe(hash2);
      });

      it('should produce different hashes for different content', () => {
        const hash1 = SyncDatabase.computeDescriptionHash('Test A');
        const hash2 = SyncDatabase.computeDescriptionHash('Test B');
        expect(hash1).not.toBe(hash2);
      });
    });

    describe('upsertProject', () => {
      it('should insert new project', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Project',
          huly_id: 'huly-123',
          vibe_id: 456,
        });

        const project = db.getProject('TEST');
        expect(project).toBeTruthy();
        expect(project.identifier).toBe('TEST');
        expect(project.name).toBe('Test Project');
        expect(project.huly_id).toBe('huly-123');
        expect(project.vibe_id).toBe(456);
      });

      it('should update existing project', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Original Name',
        });

        db.upsertProject({
          identifier: 'TEST',
          name: 'Updated Name',
        });

        const project = db.getProject('TEST');
        expect(project.name).toBe('Updated Name');
      });

      it('should set default values', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Project',
        });

        const project = db.getProject('TEST');
        expect(project.issue_count).toBe(0);
        expect(project.status).toBe('active');
        expect(project.created_at).toBeTruthy();
        expect(project.updated_at).toBeTruthy();
      });

      it('should preserve null values correctly', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          filesystem_path: '/path/to/repo',
        });

        // Update without filesystem_path (should preserve it)
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Updated',
        });

        const project = db.getProject('TEST');
        expect(project.filesystem_path).toBe('/path/to/repo');
      });
    });

    describe('getProject', () => {
      it('should retrieve project by identifier', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Project',
        });

        const project = db.getProject('TEST');
        expect(project.identifier).toBe('TEST');
      });

      it('should return undefined for non-existent project', () => {
        const project = db.getProject('NONEXISTENT');
        expect(project).toBeUndefined();
      });
    });

    describe('updateProject', () => {
      it('should update filesystem_path and git_url while preserving other fields', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Project',
          huly_id: 'huly-123',
          status: 'active',
        });

        const updated = db.updateProject('TEST', {
          filesystem_path: '/opt/stacks/test-project',
          git_url: 'https://github.com/oculairmedia/test-project.git',
        });

        expect(updated.identifier).toBe('TEST');
        expect(updated.name).toBe('Test Project');
        expect(updated.huly_id).toBe('huly-123');
        expect(updated.filesystem_path).toBe('/opt/stacks/test-project');
        expect(updated.git_url).toBe('https://github.com/oculairmedia/test-project.git');
      });

      it('should return null for unknown project', () => {
        expect(db.updateProject('UNKNOWN', { git_url: 'https://example.com/repo.git' })).toBeNull();
      });

      it('should update project status', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test Project',
          status: 'active',
        });

        const updated = db.updateProject('TEST', { status: 'archived' });

        expect(updated.status).toBe('archived');
      });
    });

    describe('archiveProject and deleteProject', () => {
      it('should archive a project', () => {
        db.upsertProject({
          identifier: 'ARCHIVE',
          name: 'Archive Project',
          status: 'active',
        });

        const updated = db.archiveProject('ARCHIVE');

        expect(updated.status).toBe('archived');
        expect(db.getProject('ARCHIVE').status).toBe('archived');
      });

      it('should delete a project and dependent rows', () => {
        const now = Date.now();

        db.upsertProject({
          identifier: 'DELETE',
          name: 'Delete Project',
          status: 'active',
        });
        db.upsertIssue({
          identifier: 'DELETE-1',
          project_identifier: 'DELETE',
          title: 'Delete Issue',
          description: 'Issue tied to project',
          status: 'open',
          priority: 'medium',
          created_at: now,
          updated_at: now,
        });
        db.upsertProjectFile({
          project_identifier: 'DELETE',
          relative_path: 'src/index.js',
          content_hash: 'abc123',
          letta_file_id: 'file-1',
          file_size: 10,
          uploaded_at: now,
        });
        db.upsertBookStackPage({
          bookstack_page_id: 1001,
          bookstack_book_id: 7,
          project_identifier: 'DELETE',
          slug: 'delete-project',
          title: 'Delete Project',
        });

        const deleted = db.deleteProject('DELETE');

        expect(deleted).toBe(true);
        expect(db.getProject('DELETE')).toBeUndefined();
        expect(db.getIssue('DELETE-1')).toBeUndefined();
        expect(db.getProjectFiles('DELETE')).toEqual([]);
        expect(db.getBookStackPages('DELETE')).toEqual([]);
      });

      it('should return false when deleting an unknown project', () => {
        expect(db.deleteProject('UNKNOWN')).toBe(false);
      });
    });

    describe('getAllProjects', () => {
      it('should return empty array when no projects', () => {
        const projects = db.getAllProjects();
        expect(projects).toEqual([]);
      });

      it('should return all projects ordered by name', () => {
        db.upsertProject({ identifier: 'C', name: 'Charlie' });
        db.upsertProject({ identifier: 'A', name: 'Alpha' });
        db.upsertProject({ identifier: 'B', name: 'Bravo' });

        const projects = db.getAllProjects();
        expect(projects).toHaveLength(3);
        expect(projects[0].name).toBe('Alpha');
        expect(projects[1].name).toBe('Bravo');
        expect(projects[2].name).toBe('Charlie');
      });
    });

    describe('getProjectsToSync', () => {
      it('should return projects with issues', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 5,
          last_checked_at: Date.now() - 600000, // 10 minutes ago
        });

        const projects = db.getProjectsToSync(300000); // 5 minute cache
        expect(projects).toHaveLength(1);
        expect(projects[0].identifier).toBe('TEST');
      });

      it('should not return recently checked empty projects', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 0,
          last_checked_at: Date.now(), // Just checked
        });

        const projects = db.getProjectsToSync(300000);
        expect(projects).toHaveLength(0);
      });

      it('should return old empty projects past cache expiry', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 0,
          last_checked_at: Date.now() - 600000, // 10 minutes ago
        });

        const projects = db.getProjectsToSync(300000); // 5 minute cache
        expect(projects).toHaveLength(1);
      });

      it('should return projects with changed descriptions', () => {
        const oldHash = SyncDatabase.computeDescriptionHash('Old description');
        const newHash = SyncDatabase.computeDescriptionHash('New description');

        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 0,
          last_checked_at: Date.now(), // Recently checked
          description_hash: oldHash,
        });

        const projects = db.getProjectsToSync(300000, {
          TEST: newHash, // Description changed
        });

        expect(projects).toHaveLength(1);
      });

      it('should return projects without description hash', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 0,
          last_checked_at: Date.now(),
          description_hash: null,
        });

        const projects = db.getProjectsToSync(300000, {
          TEST: 'some-hash',
        });

        expect(projects).toHaveLength(1);
      });

      it('should filter inactive projects', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 5,
          status: 'archived',
        });

        const projects = db.getProjectsToSync();
        expect(projects).toHaveLength(0);
      });
    });

    describe('getActiveProjects', () => {
      it('should return only projects with issues', () => {
        db.upsertProject({ identifier: 'A', name: 'A', issue_count: 0 });
        db.upsertProject({ identifier: 'B', name: 'B', issue_count: 5 });
        db.upsertProject({ identifier: 'C', name: 'C', issue_count: 10 });

        const projects = db.getActiveProjects();
        expect(projects).toHaveLength(2);
        expect(projects[0].issue_count).toBe(10); // Ordered DESC
        expect(projects[1].issue_count).toBe(5);
      });
    });

    describe('updateProjectActivity', () => {
      it('should update issue count and timestamp', () => {
        db.upsertProject({
          identifier: 'TEST',
          name: 'Test',
          issue_count: 0,
        });

        db.updateProjectActivity('TEST', 10);

        const project = db.getProject('TEST');
        expect(project.issue_count).toBe(10);
        expect(project.last_sync_at).toBeTruthy();
      });
    });
  });

  describe('issue operations', () => {
    beforeEach(() => {
      // Create a project for issues to reference
      db.upsertProject({
        identifier: 'TEST',
        name: 'Test Project',
      });
    });

    describe('upsertIssue', () => {
      it('should insert new issue', () => {
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Test Issue',
          huly_id: 'huly-123',
          vibe_task_id: 456,
          status: 'todo',
          priority: 'high',
        });

        const issue = db.getIssue('TEST-1');
        expect(issue).toBeTruthy();
        expect(issue.identifier).toBe('TEST-1');
        expect(issue.title).toBe('Test Issue');
      });

      it('should update existing issue', () => {
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Original Title',
        });

        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Updated Title',
        });

        const issue = db.getIssue('TEST-1');
        expect(issue.title).toBe('Updated Title');
      });

      it('should set timestamps', () => {
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Test',
        });

        const issue = db.getIssue('TEST-1');
        expect(issue.created_at).toBeTruthy();
        expect(issue.updated_at).toBeTruthy();
      });
    });

    describe('getIssue', () => {
      it('should retrieve issue by identifier', () => {
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Test Issue',
        });

        const issue = db.getIssue('TEST-1');
        expect(issue.identifier).toBe('TEST-1');
      });

      it('should return undefined for non-existent issue', () => {
        const issue = db.getIssue('NONEXISTENT-1');
        expect(issue).toBeUndefined();
      });
    });

    describe('getProjectIssues', () => {
      it('should return all issues for project', () => {
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Issue 1',
        });
        db.upsertIssue({
          identifier: 'TEST-2',
          project_identifier: 'TEST',
          title: 'Issue 2',
        });

        const issues = db.getProjectIssues('TEST');
        expect(issues).toHaveLength(2);
      });

      it('should return empty array for project with no issues', () => {
        const issues = db.getProjectIssues('TEST');
        expect(issues).toEqual([]);
      });

      it('should not return issues from other projects', () => {
        db.upsertProject({ identifier: 'OTHER', name: 'Other' });

        db.upsertIssue({
          identifier: 'OTHER-1',
          project_identifier: 'OTHER',
          title: 'Other Issue',
        });

        const issues = db.getProjectIssues('TEST');
        expect(issues).toHaveLength(0);
      });
    });

    describe('getModifiedIssues', () => {
      it('should return issues modified after timestamp', () => {
        const cutoffTime = Date.now();

        // Create an old issue and manually set its last_sync_at
        db.upsertIssue({
          identifier: 'TEST-1',
          project_identifier: 'TEST',
          title: 'Old Issue',
        });

        // Force old timestamp
        db.db
          .prepare('UPDATE issues SET last_sync_at = ? WHERE identifier = ?')
          .run(cutoffTime - 10000, 'TEST-1');

        // Wait a moment to ensure different timestamp
        const waitMs = 10;
        const endTime = Date.now() + waitMs;
        while (Date.now() < endTime) {
          /* busy wait */
        }

        // Create new issue (will have current last_sync_at)
        db.upsertIssue({
          identifier: 'TEST-2',
          project_identifier: 'TEST',
          title: 'New Issue',
        });

        const modified = db.getModifiedIssues('TEST', cutoffTime);
        expect(modified.length).toBeGreaterThanOrEqual(1);
        expect(modified.some(i => i.identifier === 'TEST-2')).toBe(true);
      });
    });
  });

  describe('sync history', () => {
    describe('startSyncRun', () => {
      it('should create sync record', () => {
        const syncId = db.startSyncRun();
        expect(syncId).toBeGreaterThan(0);

        const syncs = db.getRecentSyncs(1);
        expect(syncs).toHaveLength(1);
        expect(syncs[0].id).toBe(syncId);
      });
    });

    describe('completeSyncRun', () => {
      it('should update sync record with results', () => {
        const syncId = db.startSyncRun();

        db.completeSyncRun(syncId, {
          projectsProcessed: 5,
          projectsFailed: 1,
          issuesSynced: 20,
          errors: ['Error 1'],
          durationMs: 1234,
        });

        const syncs = db.getRecentSyncs(1);
        expect(syncs[0].projects_processed).toBe(5);
        expect(syncs[0].projects_failed).toBe(1);
        expect(syncs[0].issues_synced).toBe(20);
        expect(syncs[0].duration_ms).toBe(1234);
      });
    });

    describe('getRecentSyncs', () => {
      it('should return recent syncs in descending order', () => {
        db.startSyncRun();
        db.startSyncRun();
        db.startSyncRun();

        const syncs = db.getRecentSyncs(2);
        expect(syncs).toHaveLength(2);
        expect(syncs[0].id).toBeGreaterThan(syncs[1].id);
      });
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      db.upsertProject({ identifier: 'A', name: 'A', issue_count: 0 });
      db.upsertProject({ identifier: 'B', name: 'B', issue_count: 5 });

      db.upsertIssue({
        identifier: 'B-1',
        project_identifier: 'B',
        title: 'Issue 1',
      });
      db.upsertIssue({
        identifier: 'B-2',
        project_identifier: 'B',
        title: 'Issue 2',
      });

      db.setLastSync(Date.now());
    });

    describe('getStats', () => {
      it('should return database statistics', () => {
        const stats = db.getStats();

        expect(stats.totalProjects).toBe(2);
        expect(stats.activeProjects).toBe(1); // Only B has issues
        expect(stats.emptyProjects).toBe(1); // A has no issues
        expect(stats.totalIssues).toBe(2);
        expect(stats.lastSync).toBeTruthy();
      });
    });

    describe('getProjectSummary', () => {
      it('should return project summary with all projects', () => {
        const summary = db.getProjectSummary();

        expect(Array.isArray(summary)).toBe(true);
        expect(summary).toHaveLength(2);
        expect(summary[0].identifier).toBe('B'); // Sorted by issue_count DESC
        expect(summary[0].issue_count).toBe(5);
        expect(summary[1].identifier).toBe('A');
        expect(summary[1].issue_count).toBe(0);
      });

      it('should include full project metadata and actual issue counts', () => {
        db.updateProject('B', {
          filesystem_path: '/opt/stacks/bravo',
          git_url: 'https://github.com/oculairmedia/bravo.git',
        });
        db.setProjectLettaAgent('B', {
          agentId: 'agent-bravo',
          folderId: 'folder-bravo',
          sourceId: 'source-bravo',
        });
        db.upsertIssue({
          identifier: 'B-3',
          project_identifier: 'B',
          title: 'Issue 3',
        });
        db.upsertIssue({
          identifier: 'B-4',
          project_identifier: 'B',
          title: 'Issue 4',
        });
        db.upsertIssue({
          identifier: 'B-5',
          project_identifier: 'B',
          title: 'Issue 5',
        });
        db.upsertIssue({
          identifier: 'B-6',
          project_identifier: 'B',
          title: 'Issue 6',
        });

        const summary = db.getProjectSummary();
        const bravo = summary.find((project) => project.identifier === 'B');

        expect(bravo).toEqual(
          expect.objectContaining({
            identifier: 'B',
            filesystem_path: '/opt/stacks/bravo',
            git_url: 'https://github.com/oculairmedia/bravo.git',
            letta_agent_id: 'agent-bravo',
            letta_folder_id: 'folder-bravo',
            letta_source_id: 'source-bravo',
            actual_issue_count: 6,
            issue_count: 6,
          }),
        );
      });
    });
  });

  describe('Letta integration', () => {
    beforeEach(() => {
      db.upsertProject({
        identifier: 'TEST',
        name: 'Test Project',
      });
    });

    describe('getProjectLettaInfo', () => {
      it('should return Letta info for project', () => {
        db.setProjectLettaAgent('TEST', {
          agentId: 'agent-123',
          folderId: 'folder-123',
          sourceId: 'source-123',
        });

        const info = db.getProjectLettaInfo('TEST');
        expect(info.letta_agent_id).toBe('agent-123');
        expect(info.letta_folder_id).toBe('folder-123');
        expect(info.letta_source_id).toBe('source-123');
      });

      it('should return null values for project without Letta', () => {
        const info = db.getProjectLettaInfo('TEST');
        expect(info.letta_agent_id).toBeNull();
      });
    });

    describe('setProjectLettaAgent', () => {
      it('should store Letta agent info', () => {
        db.setProjectLettaAgent('TEST', {
          agentId: 'agent-123',
          folderId: 'folder-123',
          sourceId: 'source-123',
        });

        const project = db.getProject('TEST');
        expect(project.letta_agent_id).toBe('agent-123');
        expect(project.letta_folder_id).toBe('folder-123');
        expect(project.letta_source_id).toBe('source-123');
      });
    });

    describe('setProjectLettaFolderId', () => {
      it('should store folder ID', () => {
        db.setProjectLettaFolderId('TEST', 'folder-123');

        const project = db.getProject('TEST');
        expect(project.letta_folder_id).toBe('folder-123');
      });
    });

    describe('setProjectLettaSourceId', () => {
      it('should store source ID', () => {
        db.setProjectLettaSourceId('TEST', 'source-123');

        const project = db.getProject('TEST');
        expect(project.letta_source_id).toBe('source-123');
      });
    });

    describe('provider routing (vibesync-f5g)', () => {
      it('returns nulls for a project with no override (default routing)', () => {
        const routing = db.getProjectProviderRouting('TEST');
        expect(routing).toEqual({ lettaBaseUrl: null, providerKind: null, parentAgentId: null });
      });

      it('returns null when the project does not exist', () => {
        const routing = db.getProjectProviderRouting('NOPE');
        expect(routing).toBeNull();
      });

      it('round-trips both fields via setProjectProviderRouting', () => {
        const ok = db.setProjectProviderRouting('TEST', {
          lettaBaseUrl: 'http://192.168.50.90:8291',
          providerKind: 'letta-code-subagent',
        });
        expect(ok).toBe(true);

        const routing = db.getProjectProviderRouting('TEST');
        expect(routing).toEqual({
          lettaBaseUrl: 'http://192.168.50.90:8291',
          providerKind: 'letta-code-subagent',
          parentAgentId: null,
        });
      });

      it('reads the project Letta agent id as the provider parent agent id', () => {
        db.setProjectLettaAgent('TEST', {
          agentId: 'agent-routing-parent',
        });
        db.setProjectProviderRouting('TEST', {
          lettaBaseUrl: 'http://localhost:8291',
          providerKind: 'letta-code-subagent',
        });

        const routing = db.getProjectProviderRouting('TEST');
        expect(routing).toEqual({
          lettaBaseUrl: 'http://localhost:8291',
          providerKind: 'letta-code-subagent',
          parentAgentId: 'agent-routing-parent',
        });
      });

      it('returns false when updating a missing project', () => {
        const ok = db.setProjectProviderRouting('NOPE', {
          lettaBaseUrl: 'http://example.test',
          providerKind: 'letta-code-subagent',
        });
        expect(ok).toBe(false);
      });

      it('does not disturb other letta_* columns', () => {
        db.setProjectLettaAgent('TEST', {
          agentId: 'agent-routing',
          folderId: 'folder-routing',
          sourceId: 'source-routing',
        });
        db.setProjectProviderRouting('TEST', {
          lettaBaseUrl: 'http://localhost:8291',
          providerKind: 'letta-code-subagent',
        });

        const project = db.getProject('TEST');
        expect(project.letta_agent_id).toBe('agent-routing');
        expect(project.letta_folder_id).toBe('folder-routing');
        expect(project.letta_source_id).toBe('source-routing');
        expect(project.letta_base_url).toBe('http://localhost:8291');
        expect(project.provider_kind).toBe('letta-code-subagent');
      });

      it('clears overrides when set back to null', () => {
        db.setProjectProviderRouting('TEST', {
          lettaBaseUrl: 'http://localhost:8291',
          providerKind: 'letta-code-subagent',
        });
        db.setProjectProviderRouting('TEST', {
          lettaBaseUrl: null,
          providerKind: null,
        });

        const routing = db.getProjectProviderRouting('TEST');
        expect(routing).toEqual({ lettaBaseUrl: null, providerKind: null, parentAgentId: null });
      });
    });

    describe('role agents (vibesync-mcz Phase A)', () => {
      const BASE = 'http://192.168.50.90:8291';

      it('returns null when no role agent has been bootstrapped', () => {
        expect(db.getRoleAgent('TEST', 'reviewer')).toBeNull();
      });

      it('upserts and returns a role agent record with timestamps', () => {
        const before = Date.now();
        const rec = db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev-1', BASE);
        const after = Date.now();

        expect(rec.projectIdentifier).toBe('TEST');
        expect(rec.roleName).toBe('reviewer');
        expect(rec.agentId).toBe('agent-rev-1');
        expect(rec.lettaBaseUrl).toBe(BASE);
        expect(rec.createdAt).toBeGreaterThanOrEqual(before);
        expect(rec.createdAt).toBeLessThanOrEqual(after);
        expect(rec.lastUsedAt).toBe(rec.createdAt);

        const fetched = db.getRoleAgent('TEST', 'reviewer');
        expect(fetched).toEqual(rec);
      });

      it('isolates rows by role name', () => {
        db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev-1', BASE);
        db.upsertRoleAgent('TEST', 'coder', 'agent-cod-1', BASE);

        const rev = db.getRoleAgent('TEST', 'reviewer');
        const cod = db.getRoleAgent('TEST', 'coder');
        expect(rev?.agentId).toBe('agent-rev-1');
        expect(cod?.agentId).toBe('agent-cod-1');
      });

      it('upsert preserves created_at and bumps last_used_at on re-bootstrap', () => {
        const first = db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev-1', BASE, 1000);
        expect(first.createdAt).toBe(1000);
        expect(first.lastUsedAt).toBe(1000);

        const second = db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev-2', BASE, 5000);
        expect(second.createdAt).toBe(1000); // preserved
        expect(second.lastUsedAt).toBe(5000); // bumped
        expect(second.agentId).toBe('agent-rev-2'); // new agent id wins
      });

      it('touchRoleAgent updates last_used_at without touching created_at or agent_id', () => {
        const rec = db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev-1', BASE, 1000);
        expect(db.touchRoleAgent('TEST', 'reviewer', 7777)).toBe(true);

        const after = db.getRoleAgent('TEST', 'reviewer');
        expect(after?.createdAt).toBe(rec.createdAt);
        expect(after?.lastUsedAt).toBe(7777);
        expect(after?.agentId).toBe('agent-rev-1');
      });

      it('touchRoleAgent returns false for a missing row', () => {
        expect(db.touchRoleAgent('TEST', 'reviewer')).toBe(false);
      });

      it('listRoleAgents returns rows for one project, ordered by role name', () => {
        db.upsertRoleAgent('TEST', 'tester', 'agent-tst', BASE);
        db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev', BASE);
        db.upsertRoleAgent('TEST', 'coder', 'agent-cod', BASE);

        // Second project's rows must not leak in.
        db.upsertProject({ identifier: 'OTHER', name: 'Other' });
        db.upsertRoleAgent('OTHER', 'reviewer', 'agent-other-rev', BASE);

        const rows = db.listRoleAgents('TEST');
        expect(rows.map((r) => r.roleName)).toEqual(['coder', 'reviewer', 'tester']);
        expect(rows.every((r) => r.projectIdentifier === 'TEST')).toBe(true);
      });

      it('deleteRoleAgent removes the row and is idempotent', () => {
        db.upsertRoleAgent('TEST', 'reviewer', 'agent-rev', BASE);
        expect(db.deleteRoleAgent('TEST', 'reviewer')).toBe(true);
        expect(db.getRoleAgent('TEST', 'reviewer')).toBeNull();
        expect(db.deleteRoleAgent('TEST', 'reviewer')).toBe(false);
      });
    });

    describe('Huly sync cursor operations', () => {
      it('should return null when no cursor exists', () => {
        const cursor = db.getHulySyncCursor('TEST');
        expect(cursor).toBeNull();
      });

      it('should store and retrieve sync cursor', () => {
        const timestamp = '2025-01-15T10:30:00.000Z';
        db.setHulySyncCursor('TEST', timestamp);

        const cursor = db.getHulySyncCursor('TEST');
        expect(cursor).toBe(timestamp);
      });

      it('should update existing cursor', () => {
        db.setHulySyncCursor('TEST', '2025-01-01T00:00:00.000Z');
        db.setHulySyncCursor('TEST', '2025-01-15T10:30:00.000Z');

        const cursor = db.getHulySyncCursor('TEST');
        expect(cursor).toBe('2025-01-15T10:30:00.000Z');
      });

      it('should clear sync cursor', () => {
        db.setHulySyncCursor('TEST', '2025-01-15T10:30:00.000Z');
        db.clearHulySyncCursor('TEST');

        const cursor = db.getHulySyncCursor('TEST');
        expect(cursor).toBeNull();
      });

      it('should maintain separate cursors per project', () => {
        db.upsertProject({ identifier: 'PROJ2', name: 'Project 2' });

        db.setHulySyncCursor('TEST', '2025-01-01T00:00:00.000Z');
        db.setHulySyncCursor('PROJ2', '2025-02-01T00:00:00.000Z');

        expect(db.getHulySyncCursor('TEST')).toBe('2025-01-01T00:00:00.000Z');
        expect(db.getHulySyncCursor('PROJ2')).toBe('2025-02-01T00:00:00.000Z');
      });
    });
  });

  describe('database cleanup', () => {
    describe('close', () => {
      it('should close database connection', () => {
        expect(() => db.close()).not.toThrow();
      });

      it('should prevent operations after close', () => {
        db.close();
        expect(() => db.getAllProjects()).toThrow();
      });
    });
  });

  describe('edge cases', () => {
    it('should handle very long project names', () => {
      const longName = 'A'.repeat(1000);
      db.upsertProject({
        identifier: 'TEST',
        name: longName,
      });

      const project = db.getProject('TEST');
      expect(project.name).toBe(longName);
    });

    it('should handle special characters in identifiers', () => {
      db.upsertProject({
        identifier: 'TEST-123_ABC',
        name: 'Test',
      });

      const project = db.getProject('TEST-123_ABC');
      expect(project).toBeTruthy();
    });

    it('should handle concurrent upserts', () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve(
            db.upsertProject({
              identifier: 'TEST',
              name: `Name ${i}`,
            })
          )
        );
      }

      return Promise.all(promises).then(() => {
        const project = db.getProject('TEST');
        expect(project).toBeTruthy();
      });
    });
  });

  describe('content hash', () => {
    describe('computeIssueContentHash', () => {
      it('should compute consistent hash for same content', () => {
        const issue1 = { title: 'Test', description: 'Desc', status: 'Todo', priority: 'High' };
        const issue2 = { title: 'Test', description: 'Desc', status: 'Todo', priority: 'High' };

        const hash1 = SyncDatabase.computeIssueContentHash(issue1);
        const hash2 = SyncDatabase.computeIssueContentHash(issue2);

        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(16);
      });

      it('should compute different hash for different content', () => {
        const issue1 = { title: 'Test', description: 'Desc', status: 'Todo', priority: 'High' };
        const issue2 = {
          title: 'Test Changed',
          description: 'Desc',
          status: 'Todo',
          priority: 'High',
        };

        const hash1 = SyncDatabase.computeIssueContentHash(issue1);
        const hash2 = SyncDatabase.computeIssueContentHash(issue2);

        expect(hash1).not.toBe(hash2);
      });

      it('should handle null/undefined fields', () => {
        const issue = { title: 'Test' };
        const hash = SyncDatabase.computeIssueContentHash(issue);

        expect(hash).toBeTruthy();
        expect(hash).toHaveLength(16);
      });

      it('should return null for null issue', () => {
        expect(SyncDatabase.computeIssueContentHash(null)).toBeNull();
      });

      it('should detect status changes', () => {
        const issue1 = { title: 'Test', status: 'Todo' };
        const issue2 = { title: 'Test', status: 'Done' };

        expect(SyncDatabase.computeIssueContentHash(issue1)).not.toBe(
          SyncDatabase.computeIssueContentHash(issue2)
        );
      });

      it('should detect priority changes', () => {
        const issue1 = { title: 'Test', priority: 'Low' };
        const issue2 = { title: 'Test', priority: 'High' };

        expect(SyncDatabase.computeIssueContentHash(issue1)).not.toBe(
          SyncDatabase.computeIssueContentHash(issue2)
        );
      });

      it('should detect description changes', () => {
        const issue1 = { title: 'Test', description: 'Original' };
        const issue2 = { title: 'Test', description: 'Modified' };

        expect(SyncDatabase.computeIssueContentHash(issue1)).not.toBe(
          SyncDatabase.computeIssueContentHash(issue2)
        );
      });
    });

    describe('hasIssueContentChanged', () => {
      it('should return true when no stored hash', () => {
        const issue = { title: 'Test' };
        expect(SyncDatabase.hasIssueContentChanged(issue, null)).toBe(true);
        expect(SyncDatabase.hasIssueContentChanged(issue, undefined)).toBe(true);
      });

      it('should return false when content matches', () => {
        const issue = { title: 'Test', description: 'Desc', status: 'Todo', priority: 'High' };
        const hash = SyncDatabase.computeIssueContentHash(issue);

        expect(SyncDatabase.hasIssueContentChanged(issue, hash)).toBe(false);
      });

      it('should return true when content differs', () => {
        const issue1 = { title: 'Test', status: 'Todo' };
        const hash = SyncDatabase.computeIssueContentHash(issue1);

        const issue2 = { title: 'Test', status: 'Done' };
        expect(SyncDatabase.hasIssueContentChanged(issue2, hash)).toBe(true);
      });
    });

    describe('database integration', () => {
      it('should store content_hash when upserting issue', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Test Issue',
          description: 'Test description',
          status: 'Todo',
          priority: 'High',
        });

        const issue = db.getIssue('HASH-1');
        expect(issue.content_hash).toBeTruthy();
        expect(issue.content_hash).toHaveLength(16);
      });

      it('should update content_hash when content changes', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Original Title',
          status: 'Todo',
        });

        const hash1 = db.getIssue('HASH-1').content_hash;

        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Changed Title',
          status: 'Todo',
        });

        const hash2 = db.getIssue('HASH-1').content_hash;
        expect(hash1).not.toBe(hash2);
      });

      it('should keep same content_hash when content unchanged', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Same Title',
          status: 'Todo',
        });

        const hash1 = db.getIssue('HASH-1').content_hash;

        // Upsert with same content
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Same Title',
          status: 'Todo',
        });

        const hash2 = db.getIssue('HASH-1').content_hash;
        expect(hash1).toBe(hash2);
      });

      it('should detect changes via hasIssueChanged method', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Original',
          status: 'Todo',
        });

        // Same content - no change
        expect(db.hasIssueChanged('HASH-1', { title: 'Original', status: 'Todo' })).toBe(false);

        // Different content - changed
        expect(db.hasIssueChanged('HASH-1', { title: 'Changed', status: 'Todo' })).toBe(true);
      });

      it('should return true for non-existent issue', () => {
        expect(db.hasIssueChanged('NONEXISTENT-1', { title: 'Test' })).toBe(true);
      });

      it('should store huly_content_hash separately', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });

        const hulyHash = SyncDatabase.computeIssueContentHash({
          title: 'Huly Title',
          status: 'In Progress',
        });

        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Current Title',
          status: 'Todo',
          huly_content_hash: hulyHash,
        });

        const issue = db.getIssue('HASH-1');
        expect(issue.content_hash).toBeTruthy();
        expect(issue.huly_content_hash).toBe(hulyHash);
        expect(issue.content_hash).not.toBe(issue.huly_content_hash);
      });
    });

    describe('getIssuesWithContentMismatch', () => {
      it('should find issues where content differs from huly source', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });

        // Issue 1: content matches huly
        const hulyHash1 = SyncDatabase.computeIssueContentHash({
          title: 'Same',
          status: 'Todo',
        });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Same',
          status: 'Todo',
          huly_content_hash: hulyHash1,
        });

        // Issue 2: content differs from huly (edited locally)
        const hulyHash2 = SyncDatabase.computeIssueContentHash({
          title: 'Original Huly Title',
          status: 'Todo',
        });
        db.upsertIssue({
          identifier: 'HASH-2',
          project_identifier: 'HASH',
          title: 'Locally Edited Title',
          status: 'Done',
          huly_content_hash: hulyHash2,
        });

        const mismatched = db.getIssuesWithContentMismatch('HASH');
        expect(mismatched).toHaveLength(1);
        expect(mismatched[0].identifier).toBe('HASH-2');
      });

      it('should return empty array when no mismatches', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });

        const hash = SyncDatabase.computeIssueContentHash({
          title: 'Test',
          status: 'Todo',
        });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Test',
          status: 'Todo',
          huly_content_hash: hash,
        });

        const mismatched = db.getIssuesWithContentMismatch('HASH');
        expect(mismatched).toHaveLength(0);
      });

      it('should ignore issues without huly_content_hash', () => {
        db.upsertProject({ identifier: 'HASH', name: 'Hash Test' });
        db.upsertIssue({
          identifier: 'HASH-1',
          project_identifier: 'HASH',
          title: 'Test',
          status: 'Todo',
          // No huly_content_hash
        });

        const mismatched = db.getIssuesWithContentMismatch('HASH');
        expect(mismatched).toHaveLength(0);
      });
    });
  });

  describe('deletion protection', () => {
    describe('markDeletedFromHuly', () => {
      it('should mark an issue as deleted from Huly', () => {
        db.upsertProject({ identifier: 'DEL', name: 'Deletion Test' });
        db.upsertIssue({
          identifier: 'DEL-1',
          project_identifier: 'DEL',
          title: 'To be deleted',
        });

        db.markDeletedFromHuly('DEL-1');

        const issue = db.getIssue('DEL-1');
        expect(issue.deleted_from_huly).toBe(1);
      });

      it('should update the updated_at timestamp', () => {
        db.upsertProject({ identifier: 'DEL', name: 'Deletion Test' });
        db.upsertIssue({
          identifier: 'DEL-1',
          project_identifier: 'DEL',
          title: 'To be deleted',
        });

        const before = db.getIssue('DEL-1').updated_at;
        db.markDeletedFromHuly('DEL-1');
        const after = db.getIssue('DEL-1').updated_at;

        expect(after).toBeGreaterThanOrEqual(before);
      });

      it('should not throw for non-existent issue', () => {
        expect(() => db.markDeletedFromHuly('NONEXISTENT-999')).not.toThrow();
      });
    });

    describe('isDeletedFromHuly', () => {
      it('should return true for deleted issue', () => {
        db.upsertProject({ identifier: 'DEL', name: 'Deletion Test' });
        db.upsertIssue({
          identifier: 'DEL-1',
          project_identifier: 'DEL',
          title: 'Deleted issue',
        });
        db.markDeletedFromHuly('DEL-1');

        expect(db.isDeletedFromHuly('DEL-1')).toBe(true);
      });

      it('should return false for non-deleted issue', () => {
        db.upsertProject({ identifier: 'DEL', name: 'Deletion Test' });
        db.upsertIssue({
          identifier: 'DEL-1',
          project_identifier: 'DEL',
          title: 'Active issue',
        });

        expect(db.isDeletedFromHuly('DEL-1')).toBe(false);
      });

      it('should return false for non-existent issue', () => {
        expect(db.isDeletedFromHuly('NONEXISTENT-999')).toBe(false);
      });
    });

    describe('deleted issues in getAllIssues', () => {
      it('should include deleted_from_huly field in results', () => {
        db.upsertProject({ identifier: 'DEL', name: 'Deletion Test' });
        db.upsertIssue({
          identifier: 'DEL-1',
          project_identifier: 'DEL',
          title: 'Deleted',
        });
        db.upsertIssue({
          identifier: 'DEL-2',
          project_identifier: 'DEL',
          title: 'Active',
        });
        db.markDeletedFromHuly('DEL-1');

        const issues = db.getAllIssues();
        const del1 = issues.find(i => i.identifier === 'DEL-1');
        const del2 = issues.find(i => i.identifier === 'DEL-2');

        expect(del1.deleted_from_huly).toBe(1);
        expect(del2.deleted_from_huly).toBe(0);
      });
    });
  });

  describe('parent-child operations', () => {
    beforeEach(() => {
      db.upsertProject({ identifier: 'PC', name: 'Parent-Child Test' });

      // Parent issue with sub_issue_count
      db.upsertIssue({
        identifier: 'PC-1',
        project_identifier: 'PC',
        title: 'Parent Issue',
        sub_issue_count: 2,
        parent_huly_id: null,
      });

      // Child issues
      db.upsertIssue({
        identifier: 'PC-2',
        project_identifier: 'PC',
        title: 'Child Issue 1',
        parent_huly_id: 'PC-1',
      });

      db.upsertIssue({
        identifier: 'PC-3',
        project_identifier: 'PC',
        title: 'Child Issue 2',
        parent_huly_id: 'PC-1',
      });

      // Standalone issue (no parent, no children)
      db.upsertIssue({
        identifier: 'PC-4',
        project_identifier: 'PC',
        title: 'Standalone Issue',
      });
    });

    describe('getChildIssuesByHulyParent', () => {
      it('should return child issues by huly parent id', () => {
        const children = db.getChildIssuesByHulyParent('PC-1');
        expect(children).toHaveLength(2);
        expect(children[0].identifier).toBe('PC-2');
        expect(children[1].identifier).toBe('PC-3');
      });

      it('should return empty array for non-parent issue', () => {
        const children = db.getChildIssuesByHulyParent('PC-4');
        expect(children).toEqual([]);
      });

      it('should return empty array for non-existent parent', () => {
        const children = db.getChildIssuesByHulyParent('NONEXISTENT');
        expect(children).toEqual([]);
      });
    });

    describe('getParentIssues', () => {
      it('should return issues with sub_issue_count > 0', () => {
        const parents = db.getParentIssues('PC');
        expect(parents).toHaveLength(1);
        expect(parents[0].identifier).toBe('PC-1');
        expect(parents[0].sub_issue_count).toBe(2);
      });

      it('should return empty array when no parent issues exist', () => {
        db.upsertProject({ identifier: 'NOCHILD', name: 'No Children' });
        db.upsertIssue({
          identifier: 'NOCHILD-1',
          project_identifier: 'NOCHILD',
          title: 'Leaf Issue',
        });

        const parents = db.getParentIssues('NOCHILD');
        expect(parents).toEqual([]);
      });
    });

    describe('getChildIssues', () => {
      it('should return issues that have a parent_huly_id', () => {
        const children = db.getChildIssues('PC');
        expect(children).toHaveLength(2);
        expect(children.every(c => c.parent_huly_id === 'PC-1')).toBe(true);
      });

      it('should return empty array when no child issues exist', () => {
        db.upsertProject({ identifier: 'NOPAR', name: 'No Parent' });
        db.upsertIssue({
          identifier: 'NOPAR-1',
          project_identifier: 'NOPAR',
          title: 'Root Issue',
        });

        const children = db.getChildIssues('NOPAR');
        expect(children).toEqual([]);
      });
    });

    describe('updateParentChild', () => {
      it('should update parent-child relationship', () => {
        db.updateParentChild('PC-4', 'PC-1');

        const issue = db.getIssue('PC-4');
        expect(issue.parent_huly_id).toBe('PC-1');
      });

      it('should clear parent relationship when set to null', () => {
        db.updateParentChild('PC-2', null);

        const issue = db.getIssue('PC-2');
        expect(issue.parent_huly_id).toBeNull();
      });

      it('should update huly parent without requiring legacy beads fields', () => {
        db.updateParentChild('PC-4', 'PC-1');

        const issue = db.getIssue('PC-4');
        expect(issue.parent_huly_id).toBe('PC-1');
      });
    });

    describe('updateSubIssueCount', () => {
      it('should update sub-issue count', () => {
        db.updateSubIssueCount('PC-1', 5);

        const issue = db.getIssue('PC-1');
        expect(issue.sub_issue_count).toBe(5);
      });

      it('should set count to zero', () => {
        db.updateSubIssueCount('PC-1', 0);

        const issue = db.getIssue('PC-1');
        expect(issue.sub_issue_count).toBe(0);
      });
    });

    describe('parent_vibe_id in upsertIssue', () => {
      it('should store parent_vibe_id when provided', () => {
        db.upsertIssue({
          identifier: 'PC-5',
          project_identifier: 'PC',
          title: 'Issue With Vibe Parent',
          parent_vibe_id: 'vibe-parent-abc',
        });

        const issue = db.getIssue('PC-5');
        expect(issue.parent_vibe_id).toBe('vibe-parent-abc');
      });

      it('should preserve parent_vibe_id on update when not provided', () => {
        db.upsertIssue({
          identifier: 'PC-6',
          project_identifier: 'PC',
          title: 'Issue With Vibe Parent',
          parent_vibe_id: 'vibe-parent-1',
        });

        db.upsertIssue({
          identifier: 'PC-6',
          project_identifier: 'PC',
          title: 'Issue With Vibe Parent Updated',
          parent_vibe_id: null,
        });

        const issue = db.getIssue('PC-6');
        expect(issue.parent_vibe_id).toBe('vibe-parent-1');
      });

      it('should allow clearing parent_vibe_id', () => {
        db.upsertIssue({
          identifier: 'PC-7',
          project_identifier: 'PC',
          title: 'Issue With Vibe Parent',
          parent_vibe_id: 'vibe-parent-1',
        });

        db.upsertIssue({
          identifier: 'PC-7',
          project_identifier: 'PC',
          title: 'Issue With Vibe Parent',
          parent_vibe_id: null,
        });

        const issue = db.getIssue('PC-7');
        expect(issue.parent_vibe_id).toBe('vibe-parent-1');
      });

      it('should store supported parent IDs together', () => {
        db.upsertIssue({
          identifier: 'PC-8',
          project_identifier: 'PC',
          title: 'Issue With All Parents',
          parent_huly_id: 'PC-1',
          parent_vibe_id: 'vibe-parent-xyz',
        });

        const issue = db.getIssue('PC-8');
        expect(issue.parent_huly_id).toBe('PC-1');
        expect(issue.parent_vibe_id).toBe('vibe-parent-xyz');
      });
    });
  });

  describe('file tracking operations', () => {
    beforeEach(() => {
      db.upsertProject({
        identifier: 'FILES',
        name: 'File Test Project',
        filesystem_path: '/opt/projects/files',
      });
    });

    describe('upsertProjectFile', () => {
      it('should insert a new file record', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'src/index.js',
          content_hash: 'abc123',
          letta_file_id: 'letta-file-1',
          file_size: 1024,
        });

        const file = db.getProjectFile('FILES', 'src/index.js');
        expect(file).toBeTruthy();
        expect(file.content_hash).toBe('abc123');
        expect(file.letta_file_id).toBe('letta-file-1');
        expect(file.file_size).toBe(1024);
      });

      it('should update existing file on conflict', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'src/index.js',
          content_hash: 'old-hash',
          file_size: 500,
        });

        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'src/index.js',
          content_hash: 'new-hash',
          file_size: 1000,
        });

        const file = db.getProjectFile('FILES', 'src/index.js');
        expect(file.content_hash).toBe('new-hash');
        expect(file.file_size).toBe(1000);
      });
    });

    describe('getProjectFiles', () => {
      it('should return all files for a project', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'src/a.js',
          content_hash: 'hash-a',
        });
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'src/b.js',
          content_hash: 'hash-b',
        });

        const files = db.getProjectFiles('FILES');
        expect(files).toHaveLength(2);
      });

      it('should return empty array when no files tracked', () => {
        const files = db.getProjectFiles('FILES');
        expect(files).toEqual([]);
      });
    });

    describe('getProjectFile', () => {
      it('should return specific file by path', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'README.md',
          content_hash: 'readme-hash',
        });

        const file = db.getProjectFile('FILES', 'README.md');
        expect(file.relative_path).toBe('README.md');
      });

      it('should return undefined for non-existent file', () => {
        const file = db.getProjectFile('FILES', 'nonexistent.txt');
        expect(file).toBeUndefined();
      });
    });

    describe('deleteProjectFile', () => {
      it('should delete a specific file record', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'to-delete.js',
          content_hash: 'hash',
        });

        db.deleteProjectFile('FILES', 'to-delete.js');

        const file = db.getProjectFile('FILES', 'to-delete.js');
        expect(file).toBeUndefined();
      });

      it('should not throw for non-existent file', () => {
        expect(() => db.deleteProjectFile('FILES', 'nonexistent.js')).not.toThrow();
      });
    });

    describe('deleteAllProjectFiles', () => {
      it('should delete all files for a project', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'a.js',
          content_hash: 'h1',
        });
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'b.js',
          content_hash: 'h2',
        });

        db.deleteAllProjectFiles('FILES');

        const files = db.getProjectFiles('FILES');
        expect(files).toEqual([]);
      });

      it('should not affect other projects', () => {
        db.upsertProject({ identifier: 'OTHER', name: 'Other' });
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'a.js',
          content_hash: 'h1',
        });
        db.upsertProjectFile({
          project_identifier: 'OTHER',
          relative_path: 'b.js',
          content_hash: 'h2',
        });

        db.deleteAllProjectFiles('FILES');

        expect(db.getProjectFiles('FILES')).toEqual([]);
        expect(db.getProjectFiles('OTHER')).toHaveLength(1);
      });
    });

    describe('getOrphanedFiles', () => {
      it('should return files not in current file list', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'kept.js',
          content_hash: 'h1',
        });
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'orphaned.js',
          content_hash: 'h2',
        });

        const orphaned = db.getOrphanedFiles('FILES', ['kept.js']);
        expect(orphaned).toHaveLength(1);
        expect(orphaned[0].relative_path).toBe('orphaned.js');
      });

      it('should return empty array when all files are current', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'a.js',
          content_hash: 'h1',
        });

        const orphaned = db.getOrphanedFiles('FILES', ['a.js']);
        expect(orphaned).toEqual([]);
      });

      it('should return all files when current list is empty', () => {
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'a.js',
          content_hash: 'h1',
        });
        db.upsertProjectFile({
          project_identifier: 'FILES',
          relative_path: 'b.js',
          content_hash: 'h2',
        });

        const orphaned = db.getOrphanedFiles('FILES', []);
        expect(orphaned).toHaveLength(2);
      });
    });

    describe('getProjectsWithLettaFolders', () => {
      it('should return projects with both filesystem_path and letta_folder_id', () => {
        db.setProjectLettaFolderId('FILES', 'folder-abc');

        const projects = db.getProjectsWithLettaFolders();
        expect(projects).toHaveLength(1);
        expect(projects[0].identifier).toBe('FILES');
        expect(projects[0].filesystem_path).toBe('/opt/projects/files');
        expect(projects[0].letta_folder_id).toBe('folder-abc');
      });

      it('should not return projects without filesystem_path', () => {
        db.upsertProject({ identifier: 'NOFS', name: 'No Filesystem' });
        db.setProjectLettaFolderId('NOFS', 'folder-xyz');

        const projects = db.getProjectsWithLettaFolders();
        // FILES has filesystem_path but no folder yet, NOFS has folder but no path
        expect(projects.every(p => p.filesystem_path != null)).toBe(true);
      });

      it('should not return projects without letta_folder_id', () => {
        // FILES has filesystem_path but no letta_folder_id
        const projects = db.getProjectsWithLettaFolders();
        expect(projects).toEqual([]);
      });

      it('should not return inactive projects', () => {
        db.setProjectLettaFolderId('FILES', 'folder-abc');
        db.db.prepare("UPDATE projects SET status = 'archived' WHERE identifier = ?").run('FILES');

        const projects = db.getProjectsWithLettaFolders();
        expect(projects).toEqual([]);
      });
    });
  });

  describe('BookStack operations', () => {
    beforeEach(() => {
      db.upsertProject({ identifier: 'BS', name: 'BookStack Test' });
    });

    describe('getBookStackLastExport', () => {
      it('should return null when no export has occurred', () => {
        const result = db.getBookStackLastExport('BS');
        expect(result).toBeNull();
      });

      it('should return timestamp after setting', () => {
        const ts = Date.now();
        db.setBookStackLastExport('BS', ts);

        const result = db.getBookStackLastExport('BS');
        expect(result).toBe(ts);
      });
    });

    describe('setBookStackLastExport', () => {
      it('should update the export timestamp', () => {
        db.setBookStackLastExport('BS', 1000);
        db.setBookStackLastExport('BS', 2000);

        const result = db.getBookStackLastExport('BS');
        expect(result).toBe(2000);
      });
    });

    describe('upsertBookStackPage', () => {
      it('should insert a new page', () => {
        db.upsertBookStackPage({
          bookstack_page_id: 100,
          bookstack_book_id: 10,
          bookstack_chapter_id: 5,
          project_identifier: 'BS',
          slug: 'test-page',
          title: 'Test Page',
          local_path: '/docs/test-page.md',
          content_hash: 'page-hash',
          bookstack_modified_at: '2025-01-01T00:00:00Z',
          sync_direction: 'export',
        });

        const pages = db.getBookStackPages('BS');
        expect(pages).toHaveLength(1);
        expect(pages[0].title).toBe('Test Page');
        expect(pages[0].slug).toBe('test-page');
        expect(pages[0].bookstack_page_id).toBe(100);
      });

      it('should update existing page on conflict', () => {
        db.upsertBookStackPage({
          bookstack_page_id: 100,
          bookstack_book_id: 10,
          slug: 'test-page',
          title: 'Original Title',
          project_identifier: 'BS',
        });

        db.upsertBookStackPage({
          bookstack_page_id: 100,
          bookstack_book_id: 10,
          slug: 'test-page',
          title: 'Updated Title',
          project_identifier: 'BS',
        });

        const pages = db.getBookStackPages('BS');
        expect(pages).toHaveLength(1);
        expect(pages[0].title).toBe('Updated Title');
      });

      it('should handle optional fields as null', () => {
        db.upsertBookStackPage({
          bookstack_page_id: 200,
          bookstack_book_id: 20,
          slug: 'minimal-page',
          title: 'Minimal Page',
        });

        const page = db.getBookStackPageByPath(null);
        // page with no local_path won't be found by path query
        expect(page).toBeUndefined();
      });
    });

    describe('getBookStackPages', () => {
      it('should return pages for a project', () => {
        db.upsertBookStackPage({
          bookstack_page_id: 1,
          bookstack_book_id: 1,
          slug: 'page-1',
          title: 'Page 1',
          project_identifier: 'BS',
        });
        db.upsertBookStackPage({
          bookstack_page_id: 2,
          bookstack_book_id: 1,
          slug: 'page-2',
          title: 'Page 2',
          project_identifier: 'BS',
        });

        const pages = db.getBookStackPages('BS');
        expect(pages).toHaveLength(2);
      });

      it('should return empty array for project with no pages', () => {
        const pages = db.getBookStackPages('BS');
        expect(pages).toEqual([]);
      });
    });

    describe('getBookStackPageByPath', () => {
      it('should find page by local path', () => {
        db.upsertBookStackPage({
          bookstack_page_id: 1,
          bookstack_book_id: 1,
          slug: 'my-page',
          title: 'My Page',
          local_path: '/docs/bookstack/my-page.md',
          project_identifier: 'BS',
        });

        const page = db.getBookStackPageByPath('/docs/bookstack/my-page.md');
        expect(page).toBeTruthy();
        expect(page.title).toBe('My Page');
      });

      it('should return undefined for non-existent path', () => {
        const page = db.getBookStackPageByPath('/nonexistent/path.md');
        expect(page).toBeUndefined();
      });
    });
  });

  describe('project lookup operations', () => {
    beforeEach(() => {
      db.upsertProject({
        identifier: 'LOOK',
        name: 'Lookup Test',
        filesystem_path: '/opt/stacks/lookup-project',
        vibe_id: 999,
      });
      db.upsertProject({
        identifier: 'NOFS2',
        name: 'No Filesystem 2',
      });
    });

    describe('getProjectsWithFilesystemPath', () => {
      it('should return projects with filesystem_path set', () => {
        const projects = db.getProjectsWithFilesystemPath();
        expect(projects.length).toBeGreaterThanOrEqual(1);
        expect(projects.some(p => p.identifier === 'LOOK')).toBe(true);
      });

      it('should not return projects without filesystem_path', () => {
        const projects = db.getProjectsWithFilesystemPath();
        expect(projects.every(p => p.filesystem_path != null)).toBe(true);
      });
    });

    describe('getProjectFilesystemPath', () => {
      it('should return filesystem path for project', () => {
        const fsPath = db.getProjectFilesystemPath('LOOK');
        expect(fsPath).toBe('/opt/stacks/lookup-project');
      });

      it('should return null for project without path', () => {
        const fsPath = db.getProjectFilesystemPath('NOFS2');
        expect(fsPath).toBeNull();
      });

      it('should return null for non-existent project', () => {
        const fsPath = db.getProjectFilesystemPath('NONEXISTENT');
        expect(fsPath).toBeNull();
      });
    });

    describe('getProjectByFolderName', () => {
      it('should find project by exact filesystem path', () => {
        const id = db.getProjectByFolderName('/opt/stacks/lookup-project');
        expect(id).toBe('LOOK');
      });

      it('should find project by folder name only', () => {
        const id = db.getProjectByFolderName('lookup-project');
        expect(id).toBe('LOOK');
      });

      it('should be case-insensitive for path matching', () => {
        const id = db.getProjectByFolderName('/OPT/STACKS/LOOKUP-PROJECT');
        expect(id).toBe('LOOK');
      });

      it('should return null for empty input', () => {
        expect(db.getProjectByFolderName(null)).toBeNull();
        expect(db.getProjectByFolderName('')).toBeNull();
      });

      it('should return null for non-matching folder', () => {
        const id = db.getProjectByFolderName('nonexistent-folder');
        expect(id).toBeNull();
      });

      it('should handle Windows-style paths', () => {
        db.upsertProject({
          identifier: 'WIN',
          name: 'Windows Project',
          filesystem_path: '/opt/stacks/win-project',
        });

        const id = db.getProjectByFolderName('C:\\projects\\win-project');
        expect(id).toBe('WIN');
      });
    });

    describe('resolveProjectIdentifier', () => {
      it('should resolve direct project identifier', () => {
        const id = db.resolveProjectIdentifier('LOOK');
        expect(id).toBe('LOOK');
      });

      it('should resolve folder name to project identifier', () => {
        const id = db.resolveProjectIdentifier('lookup-project');
        expect(id).toBe('LOOK');
      });

      it('should return null for null input', () => {
        expect(db.resolveProjectIdentifier(null)).toBeNull();
      });

      it('should return null for unresolvable input', () => {
        const id = db.resolveProjectIdentifier('totally-unknown');
        expect(id).toBeNull();
      });
    });

    describe('project issue count summaries', () => {
      it('should report actual issue row counts when stored project activity is stale', () => {
        db.upsertProject({
          identifier: 'STALE',
          name: 'Stale Count Project',
          issue_count: 0,
        });
        db.upsertIssue({ identifier: 'STALE-1', project_identifier: 'STALE' });
        db.upsertIssue({ identifier: 'STALE-2', project_identifier: 'STALE' });

        expect(db.getProject('STALE').issue_count).toBe(2);
        expect(db.getAllProjects().find((project) => project.identifier === 'STALE').issue_count).toBe(
          2,
        );
        expect(
          db.getProjectSummary().find((project) => project.identifier === 'STALE').issue_count,
        ).toBe(2);
      });
    });
  });

  describe('migration operations', () => {
    describe('importFromJSON', () => {
      it('should import lastSync from JSON state', () => {
        db.importFromJSON({ lastSync: 1234567890 });

        expect(db.getLastSync()).toBe(1234567890);
      });

      it('should import projectActivity from JSON state', () => {
        db.importFromJSON({
          projectActivity: {
            PROJ1: { issueCount: 10, lastChecked: 1000000 },
            PROJ2: { issueCount: 5, lastChecked: 2000000 },
          },
        });

        const p1 = db.getProject('PROJ1');
        const p2 = db.getProject('PROJ2');
        expect(p1).toBeTruthy();
        expect(p1.issue_count).toBe(10);
        expect(p2.issue_count).toBe(5);
      });

      it('should import projectTimestamps from JSON state', () => {
        // Create projects first so UPDATE works
        db.upsertProject({ identifier: 'TS1', name: 'TS1' });

        db.importFromJSON({
          projectTimestamps: {
            TS1: 9999999,
          },
        });

        const project = db.getProject('TS1');
        expect(project.last_sync_at).toBe(9999999);
      });

      it('should handle empty JSON state', () => {
        expect(() => db.importFromJSON({})).not.toThrow();
      });

      it('should import all sections together', () => {
        db.importFromJSON({
          lastSync: 5000,
          projectActivity: {
            ALL: { issueCount: 3 },
          },
        });

        expect(db.getLastSync()).toBe(5000);
        expect(db.getProject('ALL')).toBeTruthy();
      });
    });

    describe('migrateFromJSON (exported function)', () => {
      it('should return false if JSON file does not exist', async () => {
        const { migrateFromJSON } = await import('../../src/database');
        const result = migrateFromJSON(db, '/nonexistent/file.json');
        expect(result).toBe(false);
      });

      it('should return false if database already has data', async () => {
        const { migrateFromJSON } = await import('../../src/database');
        db.setLastSync(Date.now());

        // Create a temp JSON file
        const tmpFile = path.join(path.dirname(testDbPath), 'migrate-test.json');
        fs.writeFileSync(tmpFile, JSON.stringify({ lastSync: 1000 }));

        try {
          const result = migrateFromJSON(db, tmpFile);
          expect(result).toBe(false);
        } finally {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
      });

      it('should import data and backup old file', async () => {
        const { migrateFromJSON } = await import('../../src/database');

        const tmpFile = path.join(path.dirname(testDbPath), 'migrate-import.json');
        fs.writeFileSync(
          tmpFile,
          JSON.stringify({
            lastSync: 7777,
            projectActivity: { MIG: { issueCount: 2 } },
          })
        );

        try {
          const result = migrateFromJSON(db, tmpFile);
          expect(result).toBe(true);
          expect(fs.existsSync(tmpFile)).toBe(false); // Original file renamed
          expect(db.getLastSync()).toBe(7777);
          expect(db.getProject('MIG')).toBeTruthy();
        } finally {
          // Clean up backup files
          const dir = path.dirname(testDbPath);
          const backupFiles = fs
            .readdirSync(dir)
            .filter(f => f.startsWith('migrate-import.json.backup'));
          backupFiles.forEach(f => fs.unlinkSync(path.join(dir, f)));
        }
      });

      it('should handle malformed JSON gracefully', async () => {
        const { migrateFromJSON } = await import('../../src/database');

        const tmpFile = path.join(path.dirname(testDbPath), 'bad-json.json');
        fs.writeFileSync(tmpFile, 'NOT VALID JSON {{{');

        try {
          const result = migrateFromJSON(db, tmpFile);
          expect(result).toBe(false);
        } finally {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
      });
    });
  });

  describe('Letta sync timestamp', () => {
    beforeEach(() => {
      db.upsertProject({ identifier: 'LSYNC', name: 'Letta Sync Test' });
    });

    describe('setProjectLettaSyncAt', () => {
      it('should store letta sync timestamp', () => {
        const ts = Date.now();
        db.setProjectLettaSyncAt('LSYNC', ts);

        const info = db.getProjectLettaInfo('LSYNC');
        expect(info.letta_last_sync_at).toBe(ts);
      });

      it('should update existing timestamp', () => {
        db.setProjectLettaSyncAt('LSYNC', 1000);
        db.setProjectLettaSyncAt('LSYNC', 2000);

        const info = db.getProjectLettaInfo('LSYNC');
        expect(info.letta_last_sync_at).toBe(2000);
      });
    });
  });

  describe('getAllIssues', () => {
    it('should return all issues across projects', () => {
      db.upsertProject({ identifier: 'A', name: 'A' });
      db.upsertProject({ identifier: 'B', name: 'B' });
      db.upsertIssue({ identifier: 'A-1', project_identifier: 'A', title: 'A1' });
      db.upsertIssue({ identifier: 'B-1', project_identifier: 'B', title: 'B1' });

      const all = db.getAllIssues();
      expect(all).toHaveLength(2);
      expect(all[0].identifier).toBe('A-1'); // Ordered by identifier
      expect(all[1].identifier).toBe('B-1');
    });

    it('should return empty array when no issues exist', () => {
      const all = db.getAllIssues();
      expect(all).toEqual([]);
    });
  });
});
