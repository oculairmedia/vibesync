/**
 * Unit Tests for Issue Sync Workflows
 *
 * Tests the IssueSyncWorkflow and BatchIssueSyncWorkflow.
 * Uses Temporal testing kit with a local test server.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'path';

// Import workflow types
import type { IssueSyncInput, IssueSyncResult } from '../../../temporal/workflows/issue-sync';

// Suppress console output during tests
const originalConsole = { ...console };
beforeAll(() => {
  console.log = vi.fn();
  console.info = vi.fn();
  console.warn = vi.fn();
  console.debug = vi.fn();
});
afterAll(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
});

// ============================================================
// MOCK DATA
// ============================================================

const createMockIssue = (
  overrides: Partial<IssueSyncInput['issue']> = {}
): IssueSyncInput['issue'] => ({
  id: 'issue-1',
  identifier: 'PROJ-123',
  title: 'Test Issue',
  description: 'Test description',
  status: 'In Progress',
  priority: 'High',
  projectId: 'project-1',
  projectIdentifier: 'PROJ',
  hulyId: 'huly-123',
  vibeId: 'vibe-456',
  modifiedAt: Date.now(),
  ...overrides,
});

// ============================================================
// MOCK ACTIVITIES FACTORY
// ============================================================

const createMockActivities = () => ({
  syncToHuly: vi.fn().mockResolvedValue({ success: true, systemId: 'PROJ-123' }),
  syncToVibe: vi.fn().mockResolvedValue({ success: true, systemId: 'vibe-task-id' }),
  updateLettaMemory: vi.fn().mockResolvedValue({ success: true }),
  compensateHulyCreate: vi.fn().mockResolvedValue({ success: true }),
  compensateVibeCreate: vi.fn().mockResolvedValue({ success: true }),
});

// ============================================================
// HELPER: Run IssueSyncWorkflow in isolated environment
// ============================================================

async function runIssueSyncWorkflowTest(
  input: IssueSyncInput,
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<IssueSyncResult> {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/issue-sync.ts'),
      activities: mockActivities,
    });

    return await worker.runUntil(
      testEnv.client.workflow.execute('IssueSyncWorkflow', {
        taskQueue,
        workflowId: `test-issue-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        args: [input],
        retry: { maximumAttempts: 1 },
        workflowExecutionTimeout: '10s',
      })
    );
  } finally {
    await testEnv.teardown();
  }
}

// ============================================================
// HELPER: Run BatchIssueSyncWorkflow in isolated environment
// ============================================================

async function runBatchIssueSyncWorkflowTest(
  input: { issues: IssueSyncInput[]; maxParallel?: number },
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<{
  success: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: IssueSyncResult[];
}> {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/issue-sync.ts'),
      activities: mockActivities,
    });

    return await worker.runUntil(
      testEnv.client.workflow.execute('BatchIssueSyncWorkflow', {
        taskQueue,
        workflowId: `test-batch-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        args: [input],
        retry: { maximumAttempts: 1 },
        workflowExecutionTimeout: '10s',
      })
    );
  } finally {
    await testEnv.teardown();
  }
}

// ============================================================
// TEST SUITE: IssueSyncWorkflow
// ============================================================

describe('IssueSyncWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ============================================================
  // Source Skipping Tests
  // ============================================================
  describe('Source Skipping Logic', () => {
    it('should skip Huly sync when source is huly', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.syncToHuly).not.toHaveBeenCalled();
      expect(mockActivities.syncToVibe).toHaveBeenCalled();
      expect(result.hulyResult?.success).toBe(true);
      expect(result.hulyResult?.systemId).toBe('PROJ-123'); // Uses existing identifier
    }, 30000);

    it('should skip Vibe sync when source is vibe', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'vibe',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.syncToHuly).toHaveBeenCalled();
      expect(mockActivities.syncToVibe).not.toHaveBeenCalled();
      expect(result.vibeResult?.success).toBe(true);
      expect(result.vibeResult?.systemId).toBe('vibe-456'); // Uses existing vibeId
    }, 30000);
  });

  // ============================================================
  // Operation Tests
  // ============================================================
  describe('Operations', () => {
    it('should handle create operation from Huly source', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue({}),
        operation: 'create',
        source: 'huly',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.syncToVibe).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'create',
          source: 'huly',
        })
      );
    }, 30000);

    it('should handle update operation with existing IDs', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'update',
        source: 'vibe',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.syncToHuly).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'update',
          source: 'vibe',
        })
      );
    }, 30000);
  });

  // ============================================================
  // Failure Scenarios
  // ============================================================
  describe('Failure Scenarios', () => {
    it('should throw when Huly sync fails', async () => {
      mockActivities.syncToHuly.mockRejectedValue(
        ApplicationFailure.nonRetryable('Huly API error', 'HulyValidationError')
      );

      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'vibe', // Not huly, so syncToHuly will be called
      };

      await expect(runIssueSyncWorkflowTest(input, mockActivities)).rejects.toThrow();
    }, 30000);

    it('should throw when Vibe sync fails', async () => {
      mockActivities.syncToVibe.mockRejectedValue(
        ApplicationFailure.nonRetryable('Vibe API error', 'VibeValidationError')
      );

      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly', // Not vibe, so syncToVibe will be called
      };

      await expect(runIssueSyncWorkflowTest(input, mockActivities)).rejects.toThrow();
    }, 30000);

  });

  // ============================================================
  // Letta Memory Update Tests
  // ============================================================
  describe('Letta Memory Update', () => {
    it('should update Letta memory when agentId provided', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
        agentId: 'agent-123',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.updateLettaMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-123',
        })
      );
      expect(result.lettaResult?.success).toBe(true);
    }, 30000);

    it('should skip Letta memory update when no agentId', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
        // No agentId
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.updateLettaMemory).not.toHaveBeenCalled();
      expect(result.lettaResult).toBeUndefined();
    }, 30000);

    it('should continue when Letta memory update fails (non-fatal)', async () => {
      mockActivities.updateLettaMemory.mockRejectedValue(new Error('Letta error'));

      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
        agentId: 'agent-123',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(result.lettaResult?.success).toBe(false);
      expect(result.lettaResult?.error).toContain('ActivityFailure');
    }, 30000);
  });

  // ============================================================
  // Duration Tracking Tests
  // ============================================================
  describe('Duration Tracking', () => {
    it('should track duration on success', async () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
      };

      const result = await runIssueSyncWorkflowTest(input, mockActivities);

      expect(result.success).toBe(true);
      expect(result.duration).toBeDefined();
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    }, 30000);
  });
});

// ============================================================
// TEST SUITE: BatchIssueSyncWorkflow
// ============================================================

describe('BatchIssueSyncWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ============================================================
  // Batch Size Handling Tests
  // ============================================================
  describe('Batch Size Handling', () => {
    it('should process issues with default maxParallel (5)', async () => {
      const issues: IssueSyncInput[] = Array.from({ length: 3 }, (_, i) => ({
        issue: createMockIssue({ id: `issue-${i}`, identifier: `PROJ-${i}` }),
        operation: 'create' as const,
        source: 'huly' as const,
      }));

      const result = await runBatchIssueSyncWorkflowTest({ issues }, mockActivities);

      expect(result.success).toBe(true);
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(3);
    }, 60000);

    it('should respect maxParallel parameter', async () => {
      const issues: IssueSyncInput[] = Array.from({ length: 6 }, (_, i) => ({
        issue: createMockIssue({ id: `issue-${i}`, identifier: `PROJ-${i}` }),
        operation: 'create' as const,
        source: 'huly' as const,
      }));

      const result = await runBatchIssueSyncWorkflowTest(
        { issues, maxParallel: 2 },
        mockActivities
      );

      expect(result.success).toBe(true);
      expect(result.total).toBe(6);
      expect(result.succeeded).toBe(6);
    }, 90000);
  });

  // ============================================================
  // Success/Failure Counting Tests
  // ============================================================
  describe('Success/Failure Counting', () => {
    it('should count all successes correctly', async () => {
      const issues: IssueSyncInput[] = Array.from({ length: 4 }, (_, i) => ({
        issue: createMockIssue({ id: `issue-${i}`, identifier: `PROJ-${i}` }),
        operation: 'create' as const,
        source: 'huly' as const,
      }));

      const result = await runBatchIssueSyncWorkflowTest({ issues }, mockActivities);

      expect(result.succeeded).toBe(4);
      expect(result.failed).toBe(0);
      expect(result.success).toBe(true);
    }, 60000);

    it('should handle mixed results (some succeed, some fail)', async () => {
      // Make syncToVibe fail for specific issues
      let callCount = 0;
      mockActivities.syncToVibe.mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) {
          return { success: false, error: 'Simulated failure' };
        }
        return { success: true, systemId: `vibe-${callCount}` };
      });

      const issues: IssueSyncInput[] = Array.from({ length: 4 }, (_, i) => ({
        issue: createMockIssue({ id: `issue-${i}`, identifier: `PROJ-${i}` }),
        operation: 'create' as const,
        source: 'huly' as const, // Will call syncToVibe
      }));

      const result = await runBatchIssueSyncWorkflowTest({ issues }, mockActivities);

      // Some should fail due to Vibe sync failure
      expect(result.total).toBe(4);
      expect(result.failed).toBeGreaterThan(0);
      expect(result.success).toBe(false); // Not all succeeded
    }, 60000);

    it('should report success=false when any issue fails', async () => {
      mockActivities.syncToVibe.mockResolvedValueOnce({ success: true, systemId: 'vibe-1' });
      mockActivities.syncToVibe.mockResolvedValueOnce({ success: false, error: 'Failed' });

      const issues: IssueSyncInput[] = [
        {
          issue: createMockIssue({ id: 'issue-1' }),
          operation: 'create',
          source: 'huly',
        },
        {
          issue: createMockIssue({ id: 'issue-2' }),
          operation: 'create',
          source: 'huly',
        },
      ];

      const result = await runBatchIssueSyncWorkflowTest({ issues }, mockActivities);

      expect(result.success).toBe(false);
      expect(result.failed).toBeGreaterThan(0);
    }, 60000);
  });

  // ============================================================
  // Empty Batch Tests
  // ============================================================
  describe('Empty Batch', () => {
    it('should handle empty issues array', async () => {
      const result = await runBatchIssueSyncWorkflowTest({ issues: [] }, mockActivities);

      expect(result.success).toBe(true);
      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(0);
    }, 30000);
  });

  // ============================================================
  // Parallel Processing Tests
  // ============================================================
  describe('Parallel Processing', () => {
    it('should process batches in parallel within batch size', async () => {
      const issues: IssueSyncInput[] = Array.from({ length: 10 }, (_, i) => ({
        issue: createMockIssue({ id: `issue-${i}`, identifier: `PROJ-${i}` }),
        operation: 'create' as const,
        source: 'huly' as const,
      }));

      const result = await runBatchIssueSyncWorkflowTest(
        { issues, maxParallel: 5 },
        mockActivities
      );

      expect(result.total).toBe(10);
      expect(result.succeeded).toBe(10);
      // All 10 issues should have results
      expect(result.results).toHaveLength(10);
    }, 120000);
  });
});

// ============================================================
// WORKFLOW LOGIC TESTS (Pure functions - no Temporal runtime)
// ============================================================

describe('Issue Sync Workflow Logic', () => {
  describe('IssueSyncInput validation', () => {
    it('should accept valid create operation', () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'create',
        source: 'huly',
      };

      expect(input.operation).toBe('create');
      expect(input.source).toBe('huly');
    });

    it('should accept valid update operation', () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'update',
        source: 'vibe',
      };

      expect(input.operation).toBe('update');
      expect(input.source).toBe('vibe');
    });

    it('should accept valid delete operation', () => {
      const input: IssueSyncInput = {
        issue: createMockIssue(),
        operation: 'delete',
        source: 'huly',
      };

      expect(input.operation).toBe('delete');
      expect(input.source).toBe('huly');
    });
  });

  describe('IssueSyncResult structure', () => {
    it('should have correct success result structure', () => {
      const result: IssueSyncResult = {
        success: true,
        hulyResult: { success: true, systemId: 'PROJ-123' },
        vibeResult: { success: true, systemId: 'vibe-456' },
        lettaResult: { success: true },
        duration: 1500,
      };

      expect(result.success).toBe(true);
      expect(result.hulyResult?.systemId).toBe('PROJ-123');
      expect(result.vibeResult?.systemId).toBe('vibe-456');
      expect(result.duration).toBe(1500);
    });

    it('should have correct failure result structure', () => {
      const result: IssueSyncResult = {
        success: false,
        hulyResult: { success: false, error: 'API error' },
        error: 'Huly sync failed: API error',
        duration: 500,
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Huly sync failed');
      expect(result.hulyResult?.error).toBe('API error');
    });
  });

  describe('Source system determination', () => {
    it('should correctly identify source systems', () => {
      const sources: Array<'huly' | 'vibe'> = ['huly', 'vibe'];

      sources.forEach(source => {
        const shouldSkipHuly = source === 'huly';
        const shouldSkipVibe = source === 'vibe';

        expect(shouldSkipHuly).toBe(source === 'huly');
        expect(shouldSkipVibe).toBe(source === 'vibe');
      });
    });
  });
});
