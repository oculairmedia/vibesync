/**
 * Test Environment Setup
 *
 * Configures the testing environment for Vitest tests.
 * - Sets up environment variables
 * - Configures test database
 * - Provides global test utilities
 */

import { vi } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Declare global test utilities and console spies
declare global {
  // eslint-disable-next-line no-var
  var consoleInfo: string[];
  // eslint-disable-next-line no-var
  var consoleErrors: string[];
  // eslint-disable-next-line no-var
  var consoleWarns: string[];
  // eslint-disable-next-line no-var
  var testUtils: {
    resetConsoleSpies: () => void;
    getConsoleLogs: () => {
      info: string[];
      errors: string[];
      warns: string[];
    };
    cleanTestDb: () => Promise<void>;
    cleanAllTestData: () => void;
    wait: (ms: number) => Promise<void>;
    createMockHulyProject: (overrides?: Record<string, unknown>) => Record<string, unknown>;
    createMockHulyIssue: (overrides?: Record<string, unknown>) => Record<string, unknown>;
    createMockVibeTask: (overrides?: Record<string, unknown>) => Record<string, unknown>;
    createMockLettaAgent: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  };
}

// Set up test environment variables
process.env.NODE_ENV = 'test';

// Override environment variables for testing
process.env.HULY_API_URL = process.env.TEST_HULY_API_URL ?? 'http://localhost:3458';
process.env.HULY_USE_REST = 'true';
process.env.VIBE_MCP_URL = process.env.TEST_VIBE_MCP_URL ?? 'http://localhost:9717/mcp';
process.env.VIBE_API_URL = process.env.TEST_VIBE_API_URL ?? 'http://localhost:3105/api';
process.env.LETTA_BASE_URL = process.env.TEST_LETTA_BASE_URL ?? 'http://localhost:8289';
process.env.LETTA_PASSWORD = process.env.TEST_LETTA_PASSWORD ?? 'test-password';
process.env.LETTA_MODEL = 'anthropic/sonnet-4-5';
process.env.LETTA_EMBEDDING = 'letta/letta-free';

// Sync configuration for tests (faster for tests)
process.env.SYNC_INTERVAL = '1000'; // 1 second for tests
process.env.INCREMENTAL_SYNC = 'false';
process.env.PARALLEL_SYNC = 'false';
process.env.SKIP_EMPTY_PROJECTS = 'false';
process.env.DRY_RUN = 'true'; // Default to dry run in tests

// Letta feature flags
process.env.LETTA_ATTACH_REPO_DOCS = 'false'; // Disable for tests
process.env.LETTA_UPLOAD_PROJECT_FILES = 'false'; // Disable for tests
process.env.LETTA_SYNC_TOOLS_FROM_CONTROL = 'false'; // Disable for tests
process.env.LETTA_CONTROL_AGENT = 'Test-Control-Agent';

// Test database configuration
const TEST_DB_DIR = join(__dirname, '..', '.test-data');
process.env.DB_PATH = join(TEST_DB_DIR, 'test.db');
process.env.STACKS_DIR = join(TEST_DB_DIR, 'stacks');

// Create test data directory
if (!existsSync(TEST_DB_DIR)) {
  mkdirSync(TEST_DB_DIR, { recursive: true });
}

// Create test stacks directory
if (!existsSync(process.env.STACKS_DIR)) {
  mkdirSync(process.env.STACKS_DIR, { recursive: true });
}

// Console spy setup (to capture logs in tests)
global.consoleInfo = [];
global.consoleErrors = [];
global.consoleWarns = [];

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  error: console.error,
  warn: console.warn,
};

// Quiet mode for tests (only show errors by default)
if (!process.env.VERBOSE_TESTS) {
  console.log = vi.fn((...args: unknown[]) => global.consoleInfo.push(args.join(' '))) as typeof console.log;
  console.info = vi.fn((...args: unknown[]) => global.consoleInfo.push(args.join(' '))) as typeof console.info;
  console.warn = vi.fn((...args: unknown[]) => global.consoleWarns.push(args.join(' '))) as typeof console.warn;
  console.error = vi.fn((...args: unknown[]) => {
    global.consoleErrors.push(args.join(' '));
    originalConsole.error(...args); // Still show errors
  }) as typeof console.error;
}

// Global test utilities
global.testUtils = {
  // Reset console spies
  resetConsoleSpies: () => {
    global.consoleInfo = [];
    global.consoleErrors = [];
    global.consoleWarns = [];
  },

  // Get captured console output
  getConsoleLogs: () => ({
    info: global.consoleInfo,
    errors: global.consoleErrors,
    warns: global.consoleWarns,
  }),

  // Clean up test database
  cleanTestDb: async () => {
    const dbPath = process.env.DB_PATH;
    if (dbPath && existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  },

  // Clean up all test data
  cleanAllTestData: () => {
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DB_DIR, { recursive: true });
      if (process.env.STACKS_DIR) {
        mkdirSync(process.env.STACKS_DIR, { recursive: true });
      }
    }
  },

  // Wait helper for async operations
  wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),

  // Create mock Huly project
  createMockHulyProject: (overrides: Record<string, unknown> = {}) => ({
    _id: 'test-project-id',
    identifier: 'TEST',
    name: 'Test Project',
    description: 'Test project description',
    private: false,
    archived: false,
    owners: [],
    members: [],
    ...overrides,
  }),

  // Create mock Huly issue
  createMockHulyIssue: (overrides: Record<string, unknown> = {}) => ({
    _id: 'test-issue-id',
    identifier: 'TEST-1',
    title: 'Test Issue',
    description: 'Test issue description',
    status: 'Todo',
    priority: 'Medium',
    assignee: null,
    project: 'test-project-id',
    space: 'test-space-id',
    createdBy: 'test-user-id',
    modifiedBy: 'test-user-id',
    createdOn: Date.now(),
    modifiedOn: Date.now(),
    ...overrides,
  }),

  // Create mock Vibe task
  createMockVibeTask: (overrides: Record<string, unknown> = {}) => ({
    id: 'test-task-id',
    title: 'Test Task',
    description: 'Test task description',
    status: 'todo',
    project_id: 'test-project-id',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }),

  // Create mock Letta agent
  createMockLettaAgent: (overrides: Record<string, unknown> = {}) => ({
    id: 'test-agent-id',
    name: 'Test-Agent',
    description: 'Test agent description',
    system: 'Test system prompt',
    tools: [],
    sources: [],
    metadata: {},
    ...overrides,
  }),
};

// Global test hooks
export const beforeAll = () => {
  // Runs once before all tests
  global.testUtils.cleanAllTestData();
};

export const beforeEach = () => {
  // Runs before each test
  global.testUtils.resetConsoleSpies();
  vi.clearAllMocks();
};

export const afterEach = () => {
  // Runs after each test
  vi.restoreAllMocks();
};

export const afterAll = () => {
  // Runs once after all tests
  global.testUtils.cleanAllTestData();
};

// Export test utilities for convenience
export const {
  resetConsoleSpies,
  getConsoleLogs,
  cleanTestDb,
  cleanAllTestData,
  wait,
  createMockHulyProject,
  createMockHulyIssue,
  createMockVibeTask,
  createMockLettaAgent,
} = global.testUtils;
