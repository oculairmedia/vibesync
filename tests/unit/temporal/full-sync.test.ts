/**
 * Unit Tests for Full Sync Workflows (Legacy - Simplified in Phase 4)
 *
 * These workflows are now no-ops. Main sync logic is in ProjectSyncWorkflow.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'path';

import type { SyncIssueInput, SyncIssueResult } from '../../../temporal/workflows/full-sync';

const mockIssue = {
  identifier: 'TEST-1',
  title: 'Test Issue',
  description: 'Test description',
  status: 'Backlog',
  priority: 'Medium',
  modifiedOn: Date.now(),
};

const mockContext = {
  projectIdentifier: 'TEST',
  gitRepoPath: '/opt/stacks/test-repo',
};

const createMockActivities = () => ({});

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  testEnv = await TestWorkflowEnvironment.createLocal();
}, 60000);

afterAll(async () => {
  await testEnv?.teardown();
  vi.restoreAllMocks();
});

async function runSingleIssueWorkflow(
  input: SyncIssueInput,
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<SyncIssueResult> {
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/full-sync.ts'),
    activities: mockActivities,
  });

  return await worker.runUntil(
    testEnv.client.workflow.execute('SyncSingleIssueWorkflow', {
      taskQueue,
      workflowId: `test-single-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [input],
      retry: { maximumAttempts: 1 },
      workflowExecutionTimeout: '10s',
    })
  );
}

async function runProjectWorkflow(
  input: {
    issues: SyncIssueInput[];
    context: typeof mockContext;
    batchSize?: number;
  },
  mockActivities: ReturnType<typeof createMockActivities>
): Promise<{
  success: boolean;
  total: number;
  synced: number;
  failed: number;
  results: SyncIssueResult[];
}> {
  const taskQueue = `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../../../temporal/workflows/full-sync.ts'),
    activities: mockActivities,
  });

  return await worker.runUntil(
    testEnv.client.workflow.execute('SyncProjectWorkflow', {
      taskQueue,
      workflowId: `test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [input],
      retry: { maximumAttempts: 1 },
      workflowExecutionTimeout: '10s',
    })
  );
}

describe('SyncSingleIssueWorkflow (legacy no-op)', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  it('should return success for any input', async () => {
    const input: SyncIssueInput = {
      issue: mockIssue,
      context: mockContext,
    };

    const result = await runSingleIssueWorkflow(input, mockActivities);
    expect(result.success).toBe(true);
  }, 30000);
});

describe('SyncProjectWorkflow (legacy)', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  it('should handle empty issues array', async () => {
    const result = await runProjectWorkflow({ issues: [], context: mockContext }, mockActivities);

    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
    expect(result.synced).toBe(0);
  }, 30000);

  it('should return correct totals', async () => {
    const issues: SyncIssueInput[] = Array.from({ length: 5 }, (_, i) => ({
      issue: { ...mockIssue, identifier: `TEST-${i + 1}` },
      context: mockContext,
    }));

    const result = await runProjectWorkflow({ issues, context: mockContext }, mockActivities);

    expect(result.success).toBe(true);
    expect(result.total).toBe(5);
    expect(result.synced).toBe(5);
    expect(result.failed).toBe(0);
  }, 30000);
});
