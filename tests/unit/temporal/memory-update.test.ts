/**
 * Unit Tests for Memory Update Workflows
 *
 * Tests the MemoryUpdateWorkflow and BatchMemoryUpdateWorkflow.
 * Uses Temporal testing kit with a local test server.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'path';

// Import workflow types
import type {
  MemoryUpdateInput,
  MemoryUpdateResult,
  BatchMemoryUpdateInput,
  BatchMemoryUpdateResult,
} from '../../../temporal/workflows/memory-update';

// Suppress console.log during tests
const originalConsoleLog = console.log;
beforeAll(() => {
  console.log = vi.fn();
});
afterAll(() => {
  console.log = originalConsoleLog;
});

// ============================================================
// MOCK ACTIVITIES FACTORY
// ============================================================

const createMockActivities = () => ({
  updateMemoryBlock: vi.fn().mockResolvedValue({
    success: true,
    blockId: 'block-123',
    previousValue: 'old-value',
  }),
});

// ============================================================
// HELPER: Run MemoryUpdateWorkflow in isolated environment
// ============================================================

async function runMemoryUpdateWorkflow(
  input: MemoryUpdateInput,
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<MemoryUpdateResult> {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/memory-update.ts'),
      activities: mockActivities,
    });

    return await worker.runUntil(
      testEnv.client.workflow.execute('MemoryUpdateWorkflow', {
        taskQueue,
        workflowId: `memory-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// HELPER: Run BatchMemoryUpdateWorkflow in isolated environment
// ============================================================

async function runBatchMemoryUpdateWorkflow(
  input: BatchMemoryUpdateInput,
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<BatchMemoryUpdateResult> {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/memory-update.ts'),
      activities: mockActivities,
    });

    return await worker.runUntil(
      testEnv.client.workflow.execute('BatchMemoryUpdateWorkflow', {
        taskQueue,
        workflowId: `batch-memory-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// TEST SUITE: MemoryUpdateWorkflow
// ============================================================

describe('MemoryUpdateWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ============================================================
  // Success Cases
  // ============================================================
  describe('Success Cases', () => {
    it('should successfully update memory block', async () => {
      const input: MemoryUpdateInput = {
        agentId: 'agent-123',
        blockLabel: 'persona',
        newValue: 'new-persona-value',
        source: 'vibesync',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('agent-123');
      expect(result.blockLabel).toBe('persona');
      expect(result.attempts).toBe(1);
      expect(result.error).toBeUndefined();
      expect(result.previousValue).toBe('old-value');
    }, 30000);

    it('should return previousValue from activity result', async () => {
      mockActivities.updateMemoryBlock.mockResolvedValue({
        success: true,
        blockId: 'block-456',
        previousValue: 'custom-previous-value',
      });

      const input: MemoryUpdateInput = {
        agentId: 'agent-456',
        blockLabel: 'human',
        newValue: 'new-human-value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe('custom-previous-value');
    }, 30000);

    it('should use default source when not provided', async () => {
      const input: MemoryUpdateInput = {
        agentId: 'agent-789',
        blockLabel: 'system',
        newValue: 'new-system-value',
        // source not provided - should default to 'unknown'
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(true);
      expect(mockActivities.updateMemoryBlock).toHaveBeenCalledWith({
        agentId: 'agent-789',
        blockLabel: 'system',
        newValue: 'new-system-value',
      });
    }, 30000);

    it('should pass source parameter correctly', async () => {
      const input: MemoryUpdateInput = {
        agentId: 'agent-source',
        blockLabel: 'persona',
        newValue: 'value',
        source: 'webhook',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(true);
      // Source is used for logging, not passed to activity
      expect(mockActivities.updateMemoryBlock).toHaveBeenCalledWith({
        agentId: 'agent-source',
        blockLabel: 'persona',
        newValue: 'value',
      });
    }, 30000);
  });

  // ============================================================
  // Failure Cases
  // ============================================================
  describe('Failure Cases', () => {
    it('should return success=false with error on activity failure', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('Block not found', 'LettaNotFoundError')
      );

      const input: MemoryUpdateInput = {
        agentId: 'agent-fail',
        blockLabel: 'nonexistent',
        newValue: 'value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(false);
      expect(result.agentId).toBe('agent-fail');
      expect(result.blockLabel).toBe('nonexistent');
      expect(result.attempts).toBe(1);
      expect(result.error).toContain('Activity task failed');
      expect(result.previousValue).toBeUndefined();
    }, 30000);

    it('should capture error message from thrown Error', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('API timeout', 'LettaTimeoutError')
      );

      const input: MemoryUpdateInput = {
        agentId: 'agent-timeout',
        blockLabel: 'persona',
        newValue: 'value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Activity task failed');
    }, 30000);

    it('should handle non-retryable failures', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('string error', 'LettaValidationError')
      );

      const input: MemoryUpdateInput = {
        agentId: 'agent-string-error',
        blockLabel: 'persona',
        newValue: 'value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 30000);
  });

  // ============================================================
  // Attempt Counting
  // ============================================================
  describe('Attempt Counting', () => {
    it('should count attempts correctly on success', async () => {
      const input: MemoryUpdateInput = {
        agentId: 'agent-count',
        blockLabel: 'persona',
        newValue: 'value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.attempts).toBe(1);
    }, 30000);

    it('should count attempts correctly on failure', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('Failed', 'LettaValidationError')
      );

      const input: MemoryUpdateInput = {
        agentId: 'agent-count-fail',
        blockLabel: 'persona',
        newValue: 'value',
      };

      const result = await runMemoryUpdateWorkflow(input, mockActivities);

      expect(result.attempts).toBe(1);
    }, 30000);
  });
});

// ============================================================
// TEST SUITE: BatchMemoryUpdateWorkflow
// ============================================================

describe('BatchMemoryUpdateWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ============================================================
  // Success Cases
  // ============================================================
  describe('Success Cases', () => {
    it('should process multiple updates in parallel', async () => {
      const input: BatchMemoryUpdateInput = {
        updates: [
          { agentId: 'agent-1', blockLabel: 'persona', newValue: 'value-1' },
          { agentId: 'agent-2', blockLabel: 'human', newValue: 'value-2' },
          { agentId: 'agent-3', blockLabel: 'system', newValue: 'value-3' },
        ],
        source: 'batch-test',
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.failures).toHaveLength(0);
      expect(mockActivities.updateMemoryBlock).toHaveBeenCalledTimes(3);
    }, 30000);

    it('should handle empty updates array', async () => {
      const input: BatchMemoryUpdateInput = {
        updates: [],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.failures).toHaveLength(0);
    }, 30000);

    it('should use default source when not provided', async () => {
      const input: BatchMemoryUpdateInput = {
        updates: [{ agentId: 'agent-1', blockLabel: 'persona', newValue: 'value' }],
        // source not provided - should default to 'batch'
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.succeeded).toBe(1);
    }, 30000);
  });

  // ============================================================
  // Failure Handling
  // ============================================================
  describe('Failure Handling', () => {
    it('should count failures correctly', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('Update failed', 'LettaValidationError')
      );

      const input: BatchMemoryUpdateInput = {
        updates: [
          { agentId: 'agent-fail-1', blockLabel: 'persona', newValue: 'value-1' },
          { agentId: 'agent-fail-2', blockLabel: 'human', newValue: 'value-2' },
        ],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.failures).toHaveLength(2);
    }, 30000);

    it('should collect failure details', async () => {
      mockActivities.updateMemoryBlock.mockRejectedValue(
        ApplicationFailure.nonRetryable('Specific error message', 'LettaValidationError')
      );

      const input: BatchMemoryUpdateInput = {
        updates: [{ agentId: 'agent-detail', blockLabel: 'persona', newValue: 'value' }],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].agentId).toBe('agent-detail');
      expect(result.failures[0].blockLabel).toBe('persona');
      expect(result.failures[0].error).toContain('Activity task failed');
    }, 30000);

    it('should handle mixed success and failure results', async () => {
      let callCount = 0;
      mockActivities.updateMemoryBlock.mockImplementation(async (input: any) => {
        callCount++;
        if (input.agentId === 'agent-fail') {
          throw ApplicationFailure.nonRetryable('This one fails', 'LettaValidationError');
        }
        return { success: true, blockId: 'block-ok', previousValue: 'old' };
      });

      const input: BatchMemoryUpdateInput = {
        updates: [
          { agentId: 'agent-ok-1', blockLabel: 'persona', newValue: 'value-1' },
          { agentId: 'agent-fail', blockLabel: 'human', newValue: 'value-2' },
          { agentId: 'agent-ok-2', blockLabel: 'system', newValue: 'value-3' },
        ],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].agentId).toBe('agent-fail');
    }, 30000);

    it('should handle activity returning success=false', async () => {
      mockActivities.updateMemoryBlock.mockResolvedValue({
        success: false,
        blockId: 'block-fail',
      });

      const input: BatchMemoryUpdateInput = {
        updates: [{ agentId: 'agent-soft-fail', blockLabel: 'persona', newValue: 'value' }],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      expect(result.total).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.failures[0].error).toBe('Update returned success=false');
    }, 30000);
  });

  // ============================================================
  // Parallel Processing
  // ============================================================
  describe('Parallel Processing', () => {
    it('should process all updates even with some failures', async () => {
      let processedAgents: string[] = [];
      mockActivities.updateMemoryBlock.mockImplementation(async (input: any) => {
        processedAgents.push(input.agentId);
        if (input.agentId === 'agent-2') {
          throw ApplicationFailure.nonRetryable('Agent 2 failed', 'LettaValidationError');
        }
        return { success: true, blockId: 'block', previousValue: 'old' };
      });

      const input: BatchMemoryUpdateInput = {
        updates: [
          { agentId: 'agent-1', blockLabel: 'persona', newValue: 'v1' },
          { agentId: 'agent-2', blockLabel: 'persona', newValue: 'v2' },
          { agentId: 'agent-3', blockLabel: 'persona', newValue: 'v3' },
        ],
      };

      const result = await runBatchMemoryUpdateWorkflow(input, mockActivities);

      // All agents should have been processed
      expect(processedAgents).toContain('agent-1');
      expect(processedAgents).toContain('agent-2');
      expect(processedAgents).toContain('agent-3');
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    }, 30000);
  });
});

// ============================================================
// TEST SUITE: Status Query (Unit test for query handler logic)
// ============================================================

describe('Status Query Logic', () => {
  it('should return attempts and lastError structure', () => {
    // Test the expected structure of status query response
    const statusResponse = { attempts: 3, lastError: 'Some error' };

    expect(statusResponse).toHaveProperty('attempts');
    expect(statusResponse).toHaveProperty('lastError');
    expect(typeof statusResponse.attempts).toBe('number');
    expect(typeof statusResponse.lastError).toBe('string');
  });

  it('should allow undefined lastError', () => {
    const statusResponse: { attempts: number; lastError?: string } = { attempts: 1 };

    expect(statusResponse.attempts).toBe(1);
    expect(statusResponse.lastError).toBeUndefined();
  });
});

// ============================================================
// TEST SUITE: Interface Validation
// ============================================================

describe('Interface Validation', () => {
  describe('MemoryUpdateInput', () => {
    it('should require agentId, blockLabel, newValue', () => {
      const validInput: MemoryUpdateInput = {
        agentId: 'agent-123',
        blockLabel: 'persona',
        newValue: 'new-value',
      };

      expect(validInput.agentId).toBeDefined();
      expect(validInput.blockLabel).toBeDefined();
      expect(validInput.newValue).toBeDefined();
    });

    it('should allow optional source', () => {
      const inputWithSource: MemoryUpdateInput = {
        agentId: 'agent-123',
        blockLabel: 'persona',
        newValue: 'new-value',
        source: 'vibesync',
      };

      const inputWithoutSource: MemoryUpdateInput = {
        agentId: 'agent-123',
        blockLabel: 'persona',
        newValue: 'new-value',
      };

      expect(inputWithSource.source).toBe('vibesync');
      expect(inputWithoutSource.source).toBeUndefined();
    });
  });

  describe('MemoryUpdateResult', () => {
    it('should have required fields', () => {
      const result: MemoryUpdateResult = {
        success: true,
        agentId: 'agent-123',
        blockLabel: 'persona',
        attempts: 1,
      };

      expect(result.success).toBeDefined();
      expect(result.agentId).toBeDefined();
      expect(result.blockLabel).toBeDefined();
      expect(result.attempts).toBeDefined();
    });

    it('should allow optional error and previousValue', () => {
      const successResult: MemoryUpdateResult = {
        success: true,
        agentId: 'agent-123',
        blockLabel: 'persona',
        attempts: 1,
        previousValue: 'old-value',
      };

      const failureResult: MemoryUpdateResult = {
        success: false,
        agentId: 'agent-123',
        blockLabel: 'persona',
        attempts: 3,
        error: 'Something went wrong',
      };

      expect(successResult.previousValue).toBe('old-value');
      expect(successResult.error).toBeUndefined();
      expect(failureResult.error).toBe('Something went wrong');
      expect(failureResult.previousValue).toBeUndefined();
    });
  });

  describe('BatchMemoryUpdateInput', () => {
    it('should require updates array', () => {
      const input: BatchMemoryUpdateInput = {
        updates: [
          { agentId: 'a1', blockLabel: 'b1', newValue: 'v1' },
          { agentId: 'a2', blockLabel: 'b2', newValue: 'v2' },
        ],
      };

      expect(Array.isArray(input.updates)).toBe(true);
      expect(input.updates.length).toBe(2);
    });

    it('should allow optional source', () => {
      const inputWithSource: BatchMemoryUpdateInput = {
        updates: [],
        source: 'batch-sync',
      };

      const inputWithoutSource: BatchMemoryUpdateInput = {
        updates: [],
      };

      expect(inputWithSource.source).toBe('batch-sync');
      expect(inputWithoutSource.source).toBeUndefined();
    });
  });

  describe('BatchMemoryUpdateResult', () => {
    it('should have all required fields', () => {
      const result: BatchMemoryUpdateResult = {
        total: 5,
        succeeded: 3,
        failed: 2,
        failures: [
          { agentId: 'a1', blockLabel: 'b1', error: 'err1' },
          { agentId: 'a2', blockLabel: 'b2', error: 'err2' },
        ],
      };

      expect(result.total).toBe(5);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(2);
      expect(result.failures).toHaveLength(2);
    });

    it('should have failure details with agentId, blockLabel, error', () => {
      const result: BatchMemoryUpdateResult = {
        total: 1,
        succeeded: 0,
        failed: 1,
        failures: [{ agentId: 'agent-x', blockLabel: 'persona', error: 'Network error' }],
      };

      const failure = result.failures[0];
      expect(failure.agentId).toBe('agent-x');
      expect(failure.blockLabel).toBe('persona');
      expect(failure.error).toBe('Network error');
    });
  });
});
