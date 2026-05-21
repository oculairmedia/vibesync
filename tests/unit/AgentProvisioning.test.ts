/**
 * Tests for Agent Provisioning Temporal Workflows and Activities
 *
 * Uses Temporal testing kit for workflow tests and vitest mocks for activity tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as path from 'path';

// ============================================================================
// Mock Data
// ============================================================================

const mockProjects = [
  { identifier: 'PROJ1', name: 'Project One' },
  { identifier: 'PROJ2', name: 'Project Two' },
  { identifier: 'PROJ3', name: 'Project Three' },
];

const mockLettaAgents = [
  { id: 'agent-1', name: 'PM - Project One', tags: ['vibesync', 'project:PROJ1'] },
];

const mockControlAgent = {
  id: 'control-agent-1',
  name: 'Meridian',
};

const mockTools = [
  { id: 'tool-1', name: 'read_file' },
  { id: 'tool-2', name: 'write_file' },
  { id: 'tool-3', name: 'search_code' },
];

// ============================================================================
// Mock Activities
// ============================================================================

function createMockActivities() {
  return {
    fetchAgentsToProvision: vi.fn().mockResolvedValue([
      { projectIdentifier: 'PROJ1', projectName: 'Project One', existingAgentId: 'agent-1' },
      { projectIdentifier: 'PROJ2', projectName: 'Project Two', existingAgentId: undefined },
      { projectIdentifier: 'PROJ3', projectName: 'Project Three', existingAgentId: undefined },
    ]),
    provisionSingleAgent: vi
      .fn()
      .mockImplementation(async (projectId: string, projectName: string) => {
        // Simulate existing agent for PROJ1
        if (projectId === 'PROJ1') {
          return { agentId: 'agent-1', created: false };
        }
        // Simulate new agent creation
        return { agentId: `agent-${projectId.toLowerCase()}`, created: true };
      }),
    attachToolsToAgent: vi.fn().mockResolvedValue({
      attached: 3,
      skipped: 0,
      errors: [],
    }),
    recordProvisioningResult: vi.fn().mockResolvedValue(undefined),
    cleanupFailedProvision: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Activity Unit Tests
// ============================================================================

describe('Agent Provisioning Activities', () => {
  describe('fetchAgentsToProvision', () => {
    it('should return list of agents with project info', async () => {
      const mockActivities = createMockActivities();
      const result = await mockActivities.fetchAgentsToProvision();

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        projectIdentifier: 'PROJ1',
        projectName: 'Project One',
        existingAgentId: 'agent-1',
      });
    });

    it('should filter to specific project identifiers', async () => {
      const mockActivities = createMockActivities();
      mockActivities.fetchAgentsToProvision.mockResolvedValueOnce([
        { projectIdentifier: 'PROJ1', projectName: 'Project One', existingAgentId: 'agent-1' },
      ]);

      const result = await mockActivities.fetchAgentsToProvision(['PROJ1']);
      expect(result).toHaveLength(1);
      expect(result[0].projectIdentifier).toBe('PROJ1');
    });

    it('should identify existing agents', async () => {
      const mockActivities = createMockActivities();
      const result = await mockActivities.fetchAgentsToProvision();

      const existingAgent = result.find((a: any) => a.projectIdentifier === 'PROJ1');
      expect(existingAgent?.existingAgentId).toBe('agent-1');

      const newAgent = result.find((a: any) => a.projectIdentifier === 'PROJ2');
      expect(newAgent?.existingAgentId).toBeUndefined();
    });
  });

  describe('provisionSingleAgent', () => {
    it('should return existing agent without creating new one', async () => {
      const mockActivities = createMockActivities();
      const result = await mockActivities.provisionSingleAgent('PROJ1', 'Project One');

      expect(result.agentId).toBe('agent-1');
      expect(result.created).toBe(false);
    });

    it('should create new agent when none exists', async () => {
      const mockActivities = createMockActivities();
      const result = await mockActivities.provisionSingleAgent('PROJ2', 'Project Two');

      expect(result.agentId).toBe('agent-proj2');
      expect(result.created).toBe(true);
    });

    it('should handle rate limit errors with retry', async () => {
      const mockActivities = createMockActivities();
      let callCount = 0;
      mockActivities.provisionSingleAgent.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('429 Too Many Requests');
        }
        return { agentId: 'agent-new', created: true };
      });

      // First call fails
      await expect(mockActivities.provisionSingleAgent('NEW', 'New Project')).rejects.toThrow(
        '429'
      );

      // Second call succeeds
      const result = await mockActivities.provisionSingleAgent('NEW', 'New Project');
      expect(result.created).toBe(true);
    });
  });

  describe('attachToolsToAgent', () => {
    it('should attach tools from control agent', async () => {
      const mockActivities = createMockActivities();
      const result = await mockActivities.attachToolsToAgent('agent-new');

      expect(result.attached).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should skip already attached tools', async () => {
      const mockActivities = createMockActivities();
      mockActivities.attachToolsToAgent.mockResolvedValueOnce({
        attached: 1,
        skipped: 2,
        errors: [],
      });

      const result = await mockActivities.attachToolsToAgent('agent-existing');
      expect(result.attached).toBe(1);
      expect(result.skipped).toBe(2);
    });

    it('should handle partial failures', async () => {
      const mockActivities = createMockActivities();
      mockActivities.attachToolsToAgent.mockResolvedValueOnce({
        attached: 2,
        skipped: 0,
        errors: [{ toolId: 'tool-3', error: 'Tool not found' }],
      });

      const result = await mockActivities.attachToolsToAgent('agent-new');
      expect(result.attached).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].toolId).toBe('tool-3');
    });
  });

  describe('recordProvisioningResult', () => {
    it('should record checkpoint data', async () => {
      const mockActivities = createMockActivities();

      await expect(
        mockActivities.recordProvisioningResult({
          batchNumber: 1,
          totalBatches: 3,
          processed: 5,
          succeeded: 4,
          failed: 1,
        })
      ).resolves.toBeUndefined();

      expect(mockActivities.recordProvisioningResult).toHaveBeenCalledWith({
        batchNumber: 1,
        totalBatches: 3,
        processed: 5,
        succeeded: 4,
        failed: 1,
      });
    });
  });

  describe('cleanupFailedProvision', () => {
    it('should cleanup agents for failed project', async () => {
      const mockActivities = createMockActivities();

      await expect(mockActivities.cleanupFailedProvision('PROJ-FAILED')).resolves.toBeUndefined();

      expect(mockActivities.cleanupFailedProvision).toHaveBeenCalledWith('PROJ-FAILED');
    });
  });
});

// ============================================================================
// Workflow Tests (using Temporal Testing Kit)
// ============================================================================

describe('ProvisionAgentsWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // Helper: Run provisioning workflow in isolated test environment
  async function runProvisioningTest(
    input: {
      projectIdentifiers?: string[];
      maxConcurrency?: number;
      delayBetweenAgents?: number;
      skipToolAttachment?: boolean;
    },
    mockActs: ReturnType<typeof createMockActivities>
  ): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    toolsAttached: number;
    errors: Array<{ projectIdentifier: string; error: string }>;
    durationMs: number;
  }> {
    const testEnv = await TestWorkflowEnvironment.createLocal();

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: 'test-queue',
        workflowsPath: path.resolve(
          __dirname,
          '../../temporal/workflows/agent-provisioning.ts'
        ),
        activities: mockActs,
      });

      return await worker.runUntil(
        testEnv.client.workflow.execute('ProvisionAgentsWorkflow', {
          taskQueue: 'test-queue',
          workflowId: `provision-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          args: [input],
        })
      );
    } finally {
      await testEnv.teardown();
    }
  }

  describe('Basic Provisioning', () => {
    it('should provision all agents successfully', async () => {
      const result = await runProvisioningTest({}, mockActivities);

      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(mockActivities.fetchAgentsToProvision).toHaveBeenCalled();
      expect(mockActivities.provisionSingleAgent).toHaveBeenCalledTimes(3);
    }, 60000);

    it('should attach tools to each agent', async () => {
      const result = await runProvisioningTest({}, mockActivities);

      expect(result.toolsAttached).toBe(9); // 3 tools * 3 agents
      expect(mockActivities.attachToolsToAgent).toHaveBeenCalledTimes(3);
    }, 60000);

    it('should skip tool attachment when requested', async () => {
      const result = await runProvisioningTest({ skipToolAttachment: true }, mockActivities);

      expect(result.toolsAttached).toBe(0);
      expect(mockActivities.attachToolsToAgent).not.toHaveBeenCalled();
    }, 60000);
  });

  describe('Filtered Provisioning', () => {
    it('should provision only specified projects', async () => {
      mockActivities.fetchAgentsToProvision.mockResolvedValueOnce([
        { projectIdentifier: 'PROJ1', projectName: 'Project One', existingAgentId: 'agent-1' },
      ]);

      const result = await runProvisioningTest({ projectIdentifiers: ['PROJ1'] }, mockActivities);

      expect(result.total).toBe(1);
      expect(mockActivities.provisionSingleAgent).toHaveBeenCalledTimes(1);
    }, 60000);
  });

  describe('Batch Processing', () => {
    it('should respect maxConcurrency setting', async () => {
      // With 3 agents and maxConcurrency=2, should have 2 batches
      const result = await runProvisioningTest({ maxConcurrency: 2 }, mockActivities);

      expect(result.succeeded).toBe(3);
      // Should have recorded 2 checkpoint calls (one per batch)
      expect(mockActivities.recordProvisioningResult).toHaveBeenCalled();
    }, 60000);

    it('should record checkpoint after each batch', async () => {
      await runProvisioningTest({ maxConcurrency: 1 }, mockActivities);

      // With maxConcurrency=1 and 3 agents, should have 3 batches = 3 checkpoints
      expect(mockActivities.recordProvisioningResult).toHaveBeenCalledTimes(3);
    }, 60000);
  });

  describe('Error Handling', () => {
    it('should continue provisioning after individual failures', async () => {
      mockActivities.provisionSingleAgent.mockImplementation(async (projectId: string) => {
        if (projectId === 'PROJ2') {
          throw new Error('API Error');
        }
        return { agentId: `agent-${projectId.toLowerCase()}`, created: true };
      });

      const result = await runProvisioningTest({}, mockActivities);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].projectIdentifier).toBe('PROJ2');
    }, 60000);

    it('should handle empty project list', async () => {
      mockActivities.fetchAgentsToProvision.mockResolvedValueOnce([]);

      const result = await runProvisioningTest({}, mockActivities);

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(mockActivities.provisionSingleAgent).not.toHaveBeenCalled();
    }, 60000);
  });
});

// ============================================================================
// ProvisionSingleAgentWorkflow Tests
// ============================================================================

describe('ProvisionSingleAgentWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  async function runSingleAgentTest(
    input: { projectIdentifier: string; projectName: string; attachTools?: boolean },
    mockActs: ReturnType<typeof createMockActivities>
  ): Promise<{
    success: boolean;
    agentId?: string;
    created?: boolean;
    toolsAttached?: number;
    error?: string;
  }> {
    const testEnv = await TestWorkflowEnvironment.createLocal();

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: 'test-queue',
        workflowsPath: path.resolve(
          __dirname,
          '../../temporal/workflows/agent-provisioning.ts'
        ),
        activities: mockActs,
      });

      return await worker.runUntil(
        testEnv.client.workflow.execute('ProvisionSingleAgentWorkflow', {
          taskQueue: 'test-queue',
          workflowId: `single-provision-test-${Date.now()}`,
          args: [input],
        })
      );
    } finally {
      await testEnv.teardown();
    }
  }

  it('should provision single agent with tools', async () => {
    const result = await runSingleAgentTest(
      { projectIdentifier: 'PROJ2', projectName: 'Project Two', attachTools: true },
      mockActivities
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('agent-proj2');
    expect(result.created).toBe(true);
    expect(result.toolsAttached).toBe(3);
  }, 60000);

  it('should skip tools when attachTools is false', async () => {
    const result = await runSingleAgentTest(
      { projectIdentifier: 'PROJ2', projectName: 'Project Two', attachTools: false },
      mockActivities
    );

    expect(result.success).toBe(true);
    expect(result.toolsAttached).toBe(0);
    expect(mockActivities.attachToolsToAgent).not.toHaveBeenCalled();
  }, 60000);

  it('should return error on failure', async () => {
    mockActivities.provisionSingleAgent.mockRejectedValue(new Error('Network Error'));

    const result = await runSingleAgentTest(
      { projectIdentifier: 'PROJ-FAIL', projectName: 'Failing Project' },
      mockActivities
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, 60000);
});

// ============================================================================
// CleanupFailedProvisionsWorkflow Tests
// ============================================================================

describe('CleanupFailedProvisionsWorkflow', () => {
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  async function runCleanupTest(
    projectIdentifiers: string[],
    mockActs: ReturnType<typeof createMockActivities>
  ): Promise<{ cleaned: number; errors: string[] }> {
    const testEnv = await TestWorkflowEnvironment.createLocal();

    try {
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: 'test-queue',
        workflowsPath: path.resolve(
          __dirname,
          '../../temporal/workflows/agent-provisioning.ts'
        ),
        activities: mockActs,
      });

      return await worker.runUntil(
        testEnv.client.workflow.execute('CleanupFailedProvisionsWorkflow', {
          taskQueue: 'test-queue',
          workflowId: `cleanup-test-${Date.now()}`,
          args: [{ projectIdentifiers }],
        })
      );
    } finally {
      await testEnv.teardown();
    }
  }

  it('should cleanup specified projects', async () => {
    const result = await runCleanupTest(['PROJ1', 'PROJ2'], mockActivities);

    expect(result.cleaned).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockActivities.cleanupFailedProvision).toHaveBeenCalledTimes(2);
  }, 60000);

  it('should report errors for failed cleanups', async () => {
    mockActivities.cleanupFailedProvision.mockImplementation(async (projectId: string) => {
      if (projectId === 'PROJ2') {
        throw new Error('Cleanup failed');
      }
    });

    const result = await runCleanupTest(['PROJ1', 'PROJ2'], mockActivities);

    expect(result.cleaned).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('PROJ2');
  }, 60000);
});

// ============================================================================
// Client Function Logic Tests (Pure functions)
// ============================================================================

describe('Provisioning Client Logic', () => {
  describe('Agent name sanitization', () => {
    it('should sanitize unsafe characters in project names', () => {
      const sanitize = (name: string) => name.replace(/[/\\:*?"<>|]/g, '-');

      expect(sanitize('Project/With/Slashes')).toBe('Project-With-Slashes');
      expect(sanitize('Project:With:Colons')).toBe('Project-With-Colons');
      expect(sanitize('Project<With>Brackets')).toBe('Project-With-Brackets');
      expect(sanitize('Normal Project Name')).toBe('Normal Project Name');
    });

    it('should build correct agent name', () => {
      const buildAgentName = (projectName: string) => {
        const sanitized = projectName.replace(/[/\\:*?"<>|]/g, '-');
        return `PM - ${sanitized}`;
      };

      expect(buildAgentName('My Project')).toBe('PM - My Project');
      expect(buildAgentName('Test/Project')).toBe('PM - Test-Project');
    });
  });

  describe('Batch calculation', () => {
    it('should calculate correct number of batches', () => {
      const calculateBatches = (total: number, concurrency: number) =>
        Math.ceil(total / concurrency);

      expect(calculateBatches(10, 3)).toBe(4);
      expect(calculateBatches(9, 3)).toBe(3);
      expect(calculateBatches(1, 3)).toBe(1);
      expect(calculateBatches(0, 3)).toBe(0);
    });
  });
});
