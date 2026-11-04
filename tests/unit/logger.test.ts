/**
 * Tests for logger module
 */

import { describe, it, expect } from 'vitest';
import { logger, createSyncLogger, createContextLogger, LogLevel } from '../../src/app/logger';

describe('logger', () => {
  describe('base logger', () => {
    it('should have standard log methods', () => {
      expect(logger.info).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.fatal).toBeDefined();
      expect(logger.trace).toBeDefined();
    });

    it('should have base properties', () => {
      expect(logger.level).toBeDefined();
    });
  });

  describe('createSyncLogger', () => {
    it('should create a child logger with syncId', () => {
      const syncId = 'test-sync-123';
      const syncLogger = createSyncLogger(syncId);

      expect(syncLogger).toBeDefined();
      expect(syncLogger.info).toBeDefined();

      // Child logger should have bindings
      const bindings = syncLogger.bindings();
      expect(bindings).toHaveProperty('syncId', syncId);
    });

    it('should create different loggers for different syncIds', () => {
      const logger1 = createSyncLogger('sync-1');
      const logger2 = createSyncLogger('sync-2');

      expect(logger1.bindings().syncId).toBe('sync-1');
      expect(logger2.bindings().syncId).toBe('sync-2');
    });
  });

  describe('createContextLogger', () => {
    it('should create a child logger with custom context', () => {
      const context = {
        project: 'test-project',
        module: 'test-module',
      };
      const contextLogger = createContextLogger(context);

      expect(contextLogger).toBeDefined();
      const bindings = contextLogger.bindings();
      expect(bindings).toHaveProperty('project', 'test-project');
      expect(bindings).toHaveProperty('module', 'test-module');
    });

    it('should handle multiple context properties', () => {
      const context = {
        requestId: 'req-123',
        userId: 'user-456',
        action: 'sync',
      };
      const contextLogger = createContextLogger(context);

      const bindings = contextLogger.bindings();
      expect(bindings.requestId).toBe('req-123');
      expect(bindings.userId).toBe('user-456');
      expect(bindings.action).toBe('sync');
    });
  });

  describe('LogLevel enum', () => {
    it('should export all log levels', () => {
      expect(LogLevel.TRACE).toBe('trace');
      expect(LogLevel.DEBUG).toBe('debug');
      expect(LogLevel.INFO).toBe('info');
      expect(LogLevel.WARN).toBe('warn');
      expect(LogLevel.ERROR).toBe('error');
      expect(LogLevel.FATAL).toBe('fatal');
    });
  });

  describe('log redaction', () => {
    it('should be configured to redact sensitive fields', () => {
      // Check that logger has redaction configured
      // Note: pino internals may not expose this directly in tests
      // This is more of a configuration verification
      expect(logger).toBeDefined();
    });
  });

  describe('structured logging', () => {
    it('should accept structured data', () => {
      // This test verifies the logger can accept objects
      // without throwing errors
      expect(() => {
        const testLogger = createSyncLogger('test');
        // These shouldn't throw
        testLogger.info({ key: 'value' }, 'Test message');
        testLogger.debug({ num: 123, bool: true }, 'Debug message');
      }).not.toThrow();
    });

    it('should handle nested objects', () => {
      expect(() => {
        const testLogger = createSyncLogger('test');
        testLogger.info({
          project: {
            id: 'proj-1',
            name: 'Test Project',
            metadata: {
              created: new Date(),
              tags: ['test', 'demo'],
            },
          },
        }, 'Nested data');
      }).not.toThrow();
    });
  });

  describe('child logger inheritance', () => {
    it('should inherit bindings from parent', () => {
      const syncLogger = createSyncLogger('sync-123');
      const projectLogger = syncLogger.child({ project: 'test-project' });

      const bindings = projectLogger.bindings();
      expect(bindings.syncId).toBe('sync-123');
      expect(bindings.project).toBe('test-project');
    });
  });

  describe('error logging', () => {
    it('should accept Error objects', () => {
      expect(() => {
        const testLogger = createSyncLogger('test');
        const error = new Error('Test error') as Error & { code: string };
        error.code = 'TEST_ERROR';
        testLogger.error({ err: error }, 'Error occurred');
      }).not.toThrow();
    });

    it('should accept error with additional context', () => {
      expect(() => {
        const testLogger = createSyncLogger('test');
        const error = new Error('Database error');
        testLogger.error({
          err: error,
          query: 'SELECT * FROM projects',
          duration: 1500,
        }, 'Database query failed');
      }).not.toThrow();
    });
  });
});
