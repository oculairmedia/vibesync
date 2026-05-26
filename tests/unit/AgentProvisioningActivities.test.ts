import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDatabase {
  getProjectLettaInfo: ReturnType<typeof vi.fn>;
  setProjectLettaAgent: ReturnType<typeof vi.fn>;
  setProjectLettaSyncAt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const {
  mockDb,
  mockCreateSyncDatabase,
  mockLettaAgentsList,
  mockLettaClientConstructor,
}: {
  mockDb: MockDatabase;
  mockCreateSyncDatabase: ReturnType<typeof vi.fn>;
  mockLettaAgentsList: ReturnType<typeof vi.fn>;
  mockLettaClientConstructor: ReturnType<typeof vi.fn>;
} = vi.hoisted(() => {
  const hoistedMockDb: MockDatabase = {
    getProjectLettaInfo: vi.fn(),
    setProjectLettaAgent: vi.fn(),
    setProjectLettaSyncAt: vi.fn(),
    close: vi.fn(),
  };
  const hoistedMockCreateSyncDatabase = vi.fn(() => hoistedMockDb);
  const hoistedMockLettaAgentsList = vi.fn();
  const hoistedMockLettaClientConstructor = vi.fn(function MockLettaClient() {
    return {
      agents: {
        list: hoistedMockLettaAgentsList,
      },
    };
  });

  return {
    mockDb: hoistedMockDb,
    mockCreateSyncDatabase: hoistedMockCreateSyncDatabase,
    mockLettaAgentsList: hoistedMockLettaAgentsList,
    mockLettaClientConstructor: hoistedMockLettaClientConstructor,
  };
});

vi.mock('../../src/database.js', () => ({
  createSyncDatabase: mockCreateSyncDatabase,
}));

vi.mock('@letta-ai/letta-client', () => ({
  LettaClient: mockLettaClientConstructor,
}));

import { checkAgentExists, updateProjectAgent } from '../../temporal/activities/agent-provisioning';

describe('Agent Provisioning Activities (real implementation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DB_PATH = '/tmp/vibesync-test.db';

    mockCreateSyncDatabase.mockReturnValue(mockDb);
    mockDb.getProjectLettaInfo.mockReturnValue(undefined);
    mockDb.setProjectLettaAgent.mockReturnValue(undefined);
    mockDb.setProjectLettaSyncAt.mockReturnValue(undefined);
    mockDb.close.mockReturnValue(undefined);
    mockLettaAgentsList.mockResolvedValue([]);
  });

  describe('checkAgentExists (real implementation)', () => {
    it('returns agent from database when found in DB', async () => {
      mockDb.getProjectLettaInfo.mockReturnValue({ letta_agent_id: 'agent-db-123' });

      const result = await checkAgentExists({ projectIdentifier: 'HVSYN' });

      expect(result).toEqual({
        exists: true,
        agentId: 'agent-db-123',
        source: 'database',
      });
      expect(mockDb.getProjectLettaInfo).toHaveBeenCalledWith('HVSYN');
      expect(mockLettaAgentsList).not.toHaveBeenCalled();
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('falls back to Letta when not found in DB and returns agent', async () => {
      mockDb.getProjectLettaInfo.mockReturnValue(undefined);
      mockLettaAgentsList.mockResolvedValue([{ id: 'agent-letta-456' }]);

      const result = await checkAgentExists({ projectIdentifier: 'HVSYN' });

      expect(result).toEqual({
        exists: true,
        agentId: 'agent-letta-456',
        source: 'letta',
      });
      expect(mockLettaAgentsList).toHaveBeenCalledWith({
        tags: ['vibesync', 'project:HVSYN'],
        matchAllTags: true,
        limit: 10,
      });
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('returns exists false when not found in DB or Letta', async () => {
      mockDb.getProjectLettaInfo.mockReturnValue(undefined);
      mockLettaAgentsList.mockResolvedValue([]);

      const result = await checkAgentExists({ projectIdentifier: 'HVSYN' });

      expect(result).toEqual({ exists: false });
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('returns exists false when DB throws', async () => {
      mockDb.getProjectLettaInfo.mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      const result = await checkAgentExists({ projectIdentifier: 'HVSYN' });

      expect(result).toEqual({ exists: false });
      expect(mockLettaAgentsList).not.toHaveBeenCalled();
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('returns exists false when Letta API throws', async () => {
      mockDb.getProjectLettaInfo.mockReturnValue(undefined);
      mockLettaAgentsList.mockRejectedValue(new Error('Letta unavailable'));

      const result = await checkAgentExists({ projectIdentifier: 'HVSYN' });

      expect(result).toEqual({ exists: false });
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('closes database after each call', async () => {
      await checkAgentExists({ projectIdentifier: 'ONE' });
      await checkAgentExists({ projectIdentifier: 'TWO' });

      expect(mockDb.close).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateProjectAgent (real implementation)', () => {
    it('updates database and returns success true', async () => {
      const result = await updateProjectAgent({
        projectIdentifier: 'HVSYN',
        agentId: 'agent-789',
      });

      expect(result).toEqual({ success: true });
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('calls setProjectLettaAgent with correct args', async () => {
      await updateProjectAgent({
        projectIdentifier: 'HVSYN',
        agentId: 'agent-789',
      });

      expect(mockDb.setProjectLettaAgent).toHaveBeenCalledWith('HVSYN', {
        agentId: 'agent-789',
      });
    });

    it('calls setProjectLettaSyncAt with timestamp', async () => {
      await updateProjectAgent({
        projectIdentifier: 'HVSYN',
        agentId: 'agent-789',
      });

      expect(mockDb.setProjectLettaSyncAt).toHaveBeenCalledWith('HVSYN', expect.any(Number));
    });

    it('returns success false with error when DB throws', async () => {
      mockDb.setProjectLettaAgent.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = await updateProjectAgent({
        projectIdentifier: 'HVSYN',
        agentId: 'agent-789',
      });

      expect(result).toEqual({ success: false, error: 'Write failed' });
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    it('closes database after each call', async () => {
      await updateProjectAgent({
        projectIdentifier: 'ONE',
        agentId: 'agent-one',
      });
      await updateProjectAgent({
        projectIdentifier: 'TWO',
        agentId: 'agent-two',
      });

      expect(mockDb.close).toHaveBeenCalledTimes(2);
    });
  });
});
