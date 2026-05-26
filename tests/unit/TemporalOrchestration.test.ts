/**
 * Unit Tests for Temporal Orchestration Workflows
 *
 * Tests the FullOrchestrationWorkflow and ScheduledSyncWorkflow.
 * Uses Temporal testing kit with a local test server.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'path';

// Import workflow types
import type {
  FullSyncInput,
  FullSyncResult,
} from '../../temporal/workflows/orchestration';

// ============================================================
// MOCK DATA
// ============================================================

const mockRegistryProjects = [
  { identifier: 'TEST1', name: 'Test Project 1', description: 'Filesystem: /opt/stacks/test1' },
  { identifier: 'TEST2', name: 'Test Project 2', description: 'No filesystem path' },
];

// ============================================================
// MOCK ACTIVITIES FACTORY
// ============================================================

const createMockActivities = () => ({
  fetchRegistryProjects: vi.fn().mockResolvedValue(mockRegistryProjects),
  updateLettaMemory: vi.fn().mockResolvedValue({ success: true }),
  recordSyncMetrics: vi.fn().mockResolvedValue(undefined),
  checkAgentExists: vi.fn().mockResolvedValue({ exists: false }),
  updateProjectAgent: vi.fn().mockResolvedValue({ success: true }),
  persistIssueSyncStateBatch: vi.fn().mockResolvedValue(undefined),
});

// ============================================================
// HELPER: Run workflow in isolated environment
// ============================================================

async function runWorkflowTest(
  input: FullSyncInput,
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<FullSyncResult> {
  const workflowInput: FullSyncInput = {
    enableLetta: false,
    ...input,
  };

  const testEnv = await TestWorkflowEnvironment.createLocal();

  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue',
      workflowsPath: path.resolve(__dirname, '../../temporal/workflows/orchestration.ts'),
      activities: mockActivities,
    });

    return await worker.runUntil(
      testEnv.client.workflow.execute('FullOrchestrationWorkflow', {
        taskQueue: 'test-queue',
        workflowId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        args: [workflowInput],
      })
    );
  } finally {
    await testEnv.teardown();
  }
}

// ============================================================
// TEST SUITE: FullOrchestrationWorkflow
// ============================================================

describe('FullOrchestrationWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ============================================================
  // Basic Flow Tests
  // ============================================================
  describe('Basic Flow', () => {
    it('should complete successfully with no projects', async () => {
      mockActivities.fetchRegistryProjects.mockResolvedValue([]);

      const result = await runWorkflowTest({}, mockActivities);

      expect(result.success).toBe(true);
      expect(result.projectsProcessed).toBe(0);
      expect(mockActivities.fetchRegistryProjects).toHaveBeenCalled();
    }, 30000);

    it('should filter to specific project when identifier provided', async () => {
      const result = await runWorkflowTest({ projectIdentifier: 'TEST1' }, mockActivities);

      expect(result.success).toBe(true);
      expect(result.projectsProcessed).toBe(1);
      expect(result.projectResults[0].projectIdentifier).toBe('TEST1');
    }, 30000);
  });

  describe('Project execution', () => {
    it('should run the registry-based pipeline end to end', async () => {
      const result = await runWorkflowTest(
        { projectIdentifier: 'TEST1' },
        mockActivities
      );

      expect(result.success).toBe(true);
      expect(result.projectResults[0].projectIdentifier).toBe('TEST1');
      expect(mockActivities.recordSyncMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ projectsProcessed: 1 })
      );
    }, 30000);
  });
});

// ============================================================
// WORKFLOW LOGIC TESTS (Pure functions - no Temporal runtime)
// ============================================================

describe('Workflow Logic', () => {
  describe('extractGitRepoPath (workflow helper)', () => {
    function extractGitRepoPath(description?: string): string | null {
      if (!description) return null;
      const match = description.match(/Filesystem:\s*([^\n]+)/i);
      if (match) {
        const path = match[1].trim();
        if (path.startsWith('/')) return path;
      }
      return null;
    }

    it('should extract filesystem path from description', () => {
      expect(extractGitRepoPath('Filesystem: /opt/stacks/test')).toBe('/opt/stacks/test');
      expect(extractGitRepoPath('Some\nFilesystem: /path\nMore')).toBe('/path');
    });

    it('should handle case-insensitive matching', () => {
      expect(extractGitRepoPath('FILESYSTEM: /path')).toBe('/path');
      expect(extractGitRepoPath('filesystem: /path')).toBe('/path');
    });

    it('should return null when no path found', () => {
      expect(extractGitRepoPath('No path here')).toBeNull();
      expect(extractGitRepoPath(undefined)).toBeNull();
      expect(extractGitRepoPath('')).toBeNull();
    });

    it('should reject relative paths', () => {
      expect(extractGitRepoPath('Filesystem: relative/path')).toBeNull();
    });
  });

  describe('Huly identifier extraction', () => {
    function extractHulyIdentifier(description?: string): string | null {
      if (!description) return null;
      const match = description.match(/Huly Issue:\s*([A-Z]+-\d+)/i);
      return match ? match[1] : null;
    }

    it('should extract identifier from description', () => {
      expect(extractHulyIdentifier('Huly Issue: TEST-123')).toBe('TEST-123');
      expect(extractHulyIdentifier('Synced from Huly Issue: PROJ-1')).toBe('PROJ-1');
    });

    it('should return null when no identifier', () => {
      expect(extractHulyIdentifier('No link')).toBeNull();
      expect(extractHulyIdentifier(undefined)).toBeNull();
    });
  });
});

// ============================================================
// SCHEDULE MANAGEMENT CLIENT FUNCTIONS (Unit tests)
// ============================================================

describe('Schedule Management Functions', () => {
  describe('Interval Calculation', () => {
    it('should calculate correct interval in minutes', () => {
      // Test the logic used in index.js for interval conversion
      const msToMinutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

      expect(msToMinutes(60000)).toBe(1); // 1 minute
      expect(msToMinutes(120000)).toBe(2); // 2 minutes
      expect(msToMinutes(300000)).toBe(5); // 5 minutes
      expect(msToMinutes(3600000)).toBe(60); // 1 hour
      expect(msToMinutes(30000)).toBe(1); // 30 seconds -> minimum 1 minute
      expect(msToMinutes(0)).toBe(1); // 0 -> minimum 1 minute
    });

    it('should round intervals correctly', () => {
      const msToMinutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

      expect(msToMinutes(90000)).toBe(2); // 1.5 minutes -> 2
      expect(msToMinutes(150000)).toBe(3); // 2.5 minutes -> 3
      expect(msToMinutes(50000)).toBe(1); // ~0.83 minutes -> 1
    });
  });
});
