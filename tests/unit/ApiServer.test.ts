/**
 * Unit Tests for ApiServer
 *
 * Comprehensive test coverage for:
 * - SSEManager class (client management, broadcasting, events)
 * - SyncHistoryStore class (event logging, pagination, mappings)
 * - ConfigurationHandler class (config retrieval, updates, validation)
 * - Helper functions (parseJsonBody, sendJson, sendError)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock dependencies before importing the module
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../lib/HealthService.js', () => ({
  getHealthMetrics: vi.fn(() => ({
    status: 'healthy',
    uptime: 1000,
    sync: { lastSync: null },
    memory: { heapUsed: 100 },
    connectionPool: {},
  })),
  updateSystemMetrics: vi.fn(),
  getMetricsRegistry: vi.fn(() => ({
    contentType: 'text/plain',
    metrics: vi.fn().mockResolvedValue('metrics'),
  })),
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (cb) cb(null, '', '');
  }),
  execSync: vi.fn(() => ''),
}));

const temporalClientUrl = vi.hoisted(
  () => new URL('../../temporal/client.ts', import.meta.url).href
);

vi.mock(temporalClientUrl, () => ({
  listSyncWorkflows: vi.fn().mockResolvedValue([{ id: 'wf-1', status: 'completed' }]),
}));

// We need to test the classes directly, so we'll recreate them for testing
// since they're not exported from ApiServer.js

/**
 * SSE Client Manager (recreated for testing)
 */
class SSEManager {
  constructor() {
    this.clients = new Set();
  }

  addClient(res) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.sendEvent(res, 'connected', { clientId, timestamp: new Date().toISOString() });

    const client = { id: clientId, res, connectedAt: Date.now() };
    this.clients.add(client);

    res.on('close', () => {
      this.clients.delete(client);
    });

    return clientId;
  }

  sendEvent(res, eventType, data) {
    try {
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      // Ignore errors
    }
  }

  broadcast(eventType, data) {
    const deadClients = [];

    for (const client of this.clients) {
      try {
        this.sendEvent(client.res, eventType, {
          ...data,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        deadClients.push(client);
      }
    }

    for (const client of deadClients) {
      this.clients.delete(client);
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  closeAll() {
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch (error) {
        // Ignore errors when closing
      }
    }
    this.clients.clear();
  }
}

/**
 * In-memory sync history storage (recreated for testing)
 */
class SyncHistoryStore {
  constructor(maxEntries = 100) {
    this.history = [];
    this.maxEntries = maxEntries;
    this.mappings = new Map();
  }

  addEvent(event) {
    const eventId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const entry = {
      id: eventId,
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.history.unshift(entry);

    if (this.history.length > this.maxEntries) {
      this.history = this.history.slice(0, this.maxEntries);
    }

    return eventId;
  }

  getHistory(limit = 20, offset = 0) {
    const total = this.history.length;
    const entries = this.history.slice(offset, offset + limit);

    return {
      total,
      limit,
      offset,
      entries,
      hasMore: offset + limit < total,
    };
  }

  getEvent(eventId) {
    return this.history.find(e => e.id === eventId) || null;
  }

  addMapping(hulyIdentifier, vibeTaskId, metadata = {}) {
    this.mappings.set(hulyIdentifier, {
      hulyIdentifier,
      vibeTaskId,
      lastSynced: new Date().toISOString(),
      ...metadata,
    });
  }

  getMappings() {
    return Array.from(this.mappings.values());
  }

  getMapping(hulyIdentifier) {
    return this.mappings.get(hulyIdentifier) || null;
  }

  clear() {
    this.history = [];
    this.mappings.clear();
  }
}

/**
 * Configuration Handler (recreated for testing)
 */
class ConfigurationHandler {
  constructor(config, onConfigUpdate) {
    this.config = config;
    this.onConfigUpdate = onConfigUpdate;
  }

  getConfig(req, res) {
    sendJson(res, 200, {
      config: this.getSafeConfig(),
      updatedAt: new Date().toISOString(),
    });
  }

  async updateConfig(req, res) {
    try {
      const updates = await parseJsonBody(req);
      const validatedUpdates = this.validateConfigUpdates(updates);
      this.applyConfigUpdates(validatedUpdates);

      if (this.onConfigUpdate) {
        this.onConfigUpdate(validatedUpdates);
      }

      sendJson(res, 200, {
        message: 'Configuration updated successfully',
        config: this.getSafeConfig(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      sendError(res, 400, 'Failed to update configuration', { error: error.message });
    }
  }

  getSafeConfig() {
    return {
      huly: {
        apiUrl: this.config.huly?.apiUrl,
        useRestApi: this.config.huly?.useRestApi,
      },
      vibeKanban: {
        apiUrl: this.config.vibeKanban?.apiUrl,
        useRestApi: this.config.vibeKanban?.useRestApi,
      },
      sync: {
        interval: this.config.sync?.interval,
        dryRun: this.config.sync?.dryRun,
        incremental: this.config.sync?.incremental,
        parallel: this.config.sync?.parallel,
        maxWorkers: this.config.sync?.maxWorkers,
        skipEmpty: this.config.sync?.skipEmpty,
        apiDelay: this.config.sync?.apiDelay,
      },
      stacks: {
        baseDir: this.config.stacks?.baseDir,
      },
      letta: {
        enabled: this.config.letta?.enabled,
        baseURL: this.config.letta?.baseURL,
      },
    };
  }

  validateConfigUpdates(updates) {
    const validated = {};

    if (updates.syncInterval !== undefined) {
      const interval = parseInt(updates.syncInterval);
      if (isNaN(interval) || interval < 1000) {
        throw new Error('syncInterval must be >= 1000 milliseconds');
      }
      validated.syncInterval = interval;
    }

    if (updates.maxWorkers !== undefined) {
      const workers = parseInt(updates.maxWorkers);
      if (isNaN(workers) || workers < 1 || workers > 20) {
        throw new Error('maxWorkers must be between 1 and 20');
      }
      validated.maxWorkers = workers;
    }

    if (updates.apiDelay !== undefined) {
      const delay = parseInt(updates.apiDelay);
      if (isNaN(delay) || delay < 0 || delay > 10000) {
        throw new Error('apiDelay must be between 0 and 10000 milliseconds');
      }
      validated.apiDelay = delay;
    }

    if (updates.dryRun !== undefined) {
      validated.dryRun = Boolean(updates.dryRun);
    }

    if (updates.incremental !== undefined) {
      validated.incremental = Boolean(updates.incremental);
    }

    if (updates.parallel !== undefined) {
      validated.parallel = Boolean(updates.parallel);
    }

    if (updates.skipEmpty !== undefined) {
      validated.skipEmpty = Boolean(updates.skipEmpty);
    }

    return validated;
  }

  applyConfigUpdates(updates) {
    if (!this.config.sync) {
      this.config.sync = {};
    }

    if (updates.syncInterval !== undefined) {
      this.config.sync.interval = updates.syncInterval;
    }

    if (updates.maxWorkers !== undefined) {
      this.config.sync.maxWorkers = updates.maxWorkers;
    }

    if (updates.apiDelay !== undefined) {
      this.config.sync.apiDelay = updates.apiDelay;
    }

    if (updates.dryRun !== undefined) {
      this.config.sync.dryRun = updates.dryRun;
    }

    if (updates.incremental !== undefined) {
      this.config.sync.incremental = updates.incremental;
    }

    if (updates.parallel !== undefined) {
      this.config.sync.parallel = updates.parallel;
    }

    if (updates.skipEmpty !== undefined) {
      this.config.sync.skipEmpty = updates.skipEmpty;
    }
  }
}

/**
 * Parse JSON body from request (recreated for testing)
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Send JSON response (recreated for testing)
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Send error response (recreated for testing)
 */
function sendError(res, statusCode, message, details = null) {
  const error = {
    error: message,
    statusCode,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    error.details = details;
  }

  sendJson(res, statusCode, error);
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.writeHead = vi.fn();
    this.write = vi.fn();
    this.end = vi.fn();
  }
}

/**
 * Create mock HTTP response
 */
function createMockResponse() {
  return new MockResponse();
}

/**
 * Create mock HTTP request with body
 */
function createMockRequest(body = null) {
  const req = new EventEmitter();
  if (body !== null) {
    setTimeout(() => {
      req.emit('data', JSON.stringify(body));
      req.emit('end');
    }, 0);
  } else {
    setTimeout(() => {
      req.emit('end');
    }, 0);
  }
  return req;
}

describe('ApiServer', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // SSEManager Tests
  // ============================================================
  describe('SSEManager', () => {
    let sseManager;

    beforeEach(() => {
      sseManager = new SSEManager();
    });

    describe('addClient', () => {
      it('should add a client and return client ID', () => {
        const res = createMockResponse();

        const clientId = sseManager.addClient(res);

        expect(clientId).toMatch(/^client_\d+_[a-z0-9]+$/);
        expect(sseManager.getClientCount()).toBe(1);
      });

      it('should set SSE headers on response', () => {
        const res = createMockResponse();

        sseManager.addClient(res);

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
      });

      it('should send connected event to client', () => {
        const res = createMockResponse();

        const clientId = sseManager.addClient(res);

        expect(res.write).toHaveBeenCalledWith('event: connected\n');
        expect(res.write).toHaveBeenCalledWith(
          expect.stringMatching(
            /^data: \{"clientId":"client_\d+_[a-z0-9]+","timestamp":"[^"]+"\}\n\n$/
          )
        );
      });

      it('should remove client on close event', () => {
        const res = createMockResponse();

        sseManager.addClient(res);
        expect(sseManager.getClientCount()).toBe(1);

        res.emit('close');
        expect(sseManager.getClientCount()).toBe(0);
      });

      it('should handle multiple clients', () => {
        const res1 = createMockResponse();
        const res2 = createMockResponse();
        const res3 = createMockResponse();

        sseManager.addClient(res1);
        sseManager.addClient(res2);
        sseManager.addClient(res3);

        expect(sseManager.getClientCount()).toBe(3);
      });
    });

    describe('sendEvent', () => {
      it('should write event type and data to response', () => {
        const res = createMockResponse();
        const data = { message: 'test' };

        sseManager.sendEvent(res, 'test-event', data);

        expect(res.write).toHaveBeenCalledWith('event: test-event\n');
        expect(res.write).toHaveBeenCalledWith('data: {"message":"test"}\n\n');
      });

      it('should handle complex data objects', () => {
        const res = createMockResponse();
        const data = {
          nested: { value: 123 },
          array: [1, 2, 3],
          string: 'hello',
        };

        sseManager.sendEvent(res, 'complex', data);

        expect(res.write).toHaveBeenCalledWith('event: complex\n');
        expect(res.write).toHaveBeenCalledWith(
          'data: {"nested":{"value":123},"array":[1,2,3],"string":"hello"}\n\n'
        );
      });

      it('should not throw on write error', () => {
        const res = createMockResponse();
        res.write.mockImplementation(() => {
          throw new Error('Write failed');
        });

        expect(() => {
          sseManager.sendEvent(res, 'test', { data: 'test' });
        }).not.toThrow();
      });
    });

    describe('broadcast', () => {
      it('should send event to all connected clients', () => {
        const res1 = createMockResponse();
        const res2 = createMockResponse();

        sseManager.addClient(res1);
        sseManager.addClient(res2);

        // Clear previous calls from addClient
        res1.write.mockClear();
        res2.write.mockClear();

        sseManager.broadcast('sync:started', { projectId: 'TEST' });

        expect(res1.write).toHaveBeenCalledWith('event: sync:started\n');
        expect(res2.write).toHaveBeenCalledWith('event: sync:started\n');
      });

      it('should add timestamp to broadcast data', () => {
        const res = createMockResponse();
        sseManager.addClient(res);
        res.write.mockClear();

        sseManager.broadcast('test', { value: 1 });

        const dataCall = res.write.mock.calls.find(call => call[0].startsWith('data:'));
        expect(dataCall[0]).toMatch(/"timestamp":"[^"]+"/);
      });

      it('should remove dead clients during broadcast', () => {
        const res1 = createMockResponse();
        const res2 = createMockResponse();

        sseManager.addClient(res1);
        sseManager.addClient(res2);

        vi.spyOn(sseManager, 'sendEvent').mockImplementation((res, eventType, data) => {
          if (!(res instanceof MockResponse)) {
            throw new Error('Invalid response');
          }
          if (res === res1) {
            throw new Error('Connection closed');
          }
          res.write(`event: ${eventType}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        });

        sseManager.broadcast('test', { data: 'test' });

        expect(sseManager.getClientCount()).toBe(1);
      });

      it('should handle broadcast with no clients', () => {
        expect(() => {
          sseManager.broadcast('test', { data: 'test' });
        }).not.toThrow();
      });
    });

    describe('getClientCount', () => {
      it('should return 0 when no clients', () => {
        expect(sseManager.getClientCount()).toBe(0);
      });

      it('should return correct count after adding clients', () => {
        sseManager.addClient(createMockResponse());
        sseManager.addClient(createMockResponse());

        expect(sseManager.getClientCount()).toBe(2);
      });
    });

    describe('closeAll', () => {
      it('should close all client connections', () => {
        const res1 = createMockResponse();
        const res2 = createMockResponse();

        sseManager.addClient(res1);
        sseManager.addClient(res2);

        sseManager.closeAll();

        expect(res1.end).toHaveBeenCalled();
        expect(res2.end).toHaveBeenCalled();
        expect(sseManager.getClientCount()).toBe(0);
      });

      it('should handle errors when closing clients', () => {
        const res = createMockResponse();
        res.end.mockImplementation(() => {
          throw new Error('Close failed');
        });

        sseManager.addClient(res);

        expect(() => {
          sseManager.closeAll();
        }).not.toThrow();

        expect(sseManager.getClientCount()).toBe(0);
      });

      it('should handle closeAll with no clients', () => {
        expect(() => {
          sseManager.closeAll();
        }).not.toThrow();
      });
    });
  });

  // ============================================================
  // SyncHistoryStore Tests
  // ============================================================
  describe('SyncHistoryStore', () => {
    let store;

    beforeEach(() => {
      store = new SyncHistoryStore(100);
    });

    describe('addEvent', () => {
      it('should add event and return event ID', () => {
        const eventId = store.addEvent({ type: 'sync', projectId: 'TEST' });

        expect(eventId).toMatch(/^sync_\d+_[a-z0-9]+$/);
      });

      it('should add timestamp to event', () => {
        const eventId = store.addEvent({ type: 'sync' });
        const event = store.getEvent(eventId);

        expect(event.timestamp).toBeDefined();
        expect(new Date(event.timestamp)).toBeInstanceOf(Date);
      });

      it('should preserve event data', () => {
        const eventId = store.addEvent({
          type: 'manual_trigger',
          projectId: 'TEST',
          source: 'api',
        });

        const event = store.getEvent(eventId);

        expect(event.type).toBe('manual_trigger');
        expect(event.projectId).toBe('TEST');
        expect(event.source).toBe('api');
      });

      it('should add events to beginning of history', () => {
        store.addEvent({ order: 1 });
        store.addEvent({ order: 2 });
        store.addEvent({ order: 3 });

        const history = store.getHistory();

        expect(history.entries[0].order).toBe(3);
        expect(history.entries[1].order).toBe(2);
        expect(history.entries[2].order).toBe(1);
      });

      it('should trim history when exceeding maxEntries', () => {
        const smallStore = new SyncHistoryStore(3);

        smallStore.addEvent({ order: 1 });
        smallStore.addEvent({ order: 2 });
        smallStore.addEvent({ order: 3 });
        smallStore.addEvent({ order: 4 });

        const history = smallStore.getHistory();

        expect(history.total).toBe(3);
        expect(history.entries[0].order).toBe(4);
        expect(history.entries[2].order).toBe(2);
      });
    });

    describe('getHistory', () => {
      beforeEach(() => {
        for (let i = 1; i <= 50; i++) {
          store.addEvent({ order: i });
        }
      });

      it('should return paginated history with defaults', () => {
        const history = store.getHistory();

        expect(history.total).toBe(50);
        expect(history.limit).toBe(20);
        expect(history.offset).toBe(0);
        expect(history.entries).toHaveLength(20);
        expect(history.hasMore).toBe(true);
      });

      it('should respect limit parameter', () => {
        const history = store.getHistory(10);

        expect(history.entries).toHaveLength(10);
        expect(history.limit).toBe(10);
      });

      it('should respect offset parameter', () => {
        const history = store.getHistory(10, 20);

        expect(history.offset).toBe(20);
        expect(history.entries[0].order).toBe(30); // 50 - 20 = 30
      });

      it('should indicate hasMore correctly', () => {
        const history1 = store.getHistory(20, 0);
        expect(history1.hasMore).toBe(true);

        const history2 = store.getHistory(20, 40);
        expect(history2.hasMore).toBe(false);
      });

      it('should handle empty history', () => {
        const emptyStore = new SyncHistoryStore();
        const history = emptyStore.getHistory();

        expect(history.total).toBe(0);
        expect(history.entries).toHaveLength(0);
        expect(history.hasMore).toBe(false);
      });
    });

    describe('getEvent', () => {
      it('should return event by ID', () => {
        const eventId = store.addEvent({ type: 'test' });
        const event = store.getEvent(eventId);

        expect(event).not.toBeNull();
        expect(event.id).toBe(eventId);
        expect(event.type).toBe('test');
      });

      it('should return null for non-existent event', () => {
        const event = store.getEvent('non_existent_id');

        expect(event).toBeNull();
      });
    });

    describe('addMapping', () => {
      it('should add mapping with required fields', () => {
        store.addMapping('TEST-1', 'vibe-task-123');

        const mapping = store.getMapping('TEST-1');

        expect(mapping.hulyIdentifier).toBe('TEST-1');
        expect(mapping.vibeTaskId).toBe('vibe-task-123');
        expect(mapping.lastSynced).toBeDefined();
      });

      it('should include metadata in mapping', () => {
        store.addMapping('TEST-1', 'vibe-task-123', {
          status: 'synced',
          direction: 'huly-to-vibe',
        });

        const mapping = store.getMapping('TEST-1');

        expect(mapping.status).toBe('synced');
        expect(mapping.direction).toBe('huly-to-vibe');
      });

      it('should update existing mapping', () => {
        store.addMapping('TEST-1', 'vibe-task-123');
        store.addMapping('TEST-1', 'vibe-task-456');

        const mapping = store.getMapping('TEST-1');

        expect(mapping.vibeTaskId).toBe('vibe-task-456');
      });
    });

    describe('getMappings', () => {
      it('should return all mappings as array', () => {
        store.addMapping('TEST-1', 'vibe-1');
        store.addMapping('TEST-2', 'vibe-2');
        store.addMapping('TEST-3', 'vibe-3');

        const mappings = store.getMappings();

        expect(mappings).toHaveLength(3);
        expect(Array.isArray(mappings)).toBe(true);
      });

      it('should return empty array when no mappings', () => {
        const mappings = store.getMappings();

        expect(mappings).toHaveLength(0);
      });
    });

    describe('getMapping', () => {
      it('should return mapping by Huly identifier', () => {
        store.addMapping('TEST-1', 'vibe-1');

        const mapping = store.getMapping('TEST-1');

        expect(mapping).not.toBeNull();
        expect(mapping.hulyIdentifier).toBe('TEST-1');
      });

      it('should return null for non-existent mapping', () => {
        const mapping = store.getMapping('NON-EXISTENT');

        expect(mapping).toBeNull();
      });
    });

    describe('clear', () => {
      it('should clear all history and mappings', () => {
        store.addEvent({ type: 'test' });
        store.addMapping('TEST-1', 'vibe-1');

        store.clear();

        expect(store.getHistory().total).toBe(0);
        expect(store.getMappings()).toHaveLength(0);
      });
    });
  });

  // ============================================================
  // ConfigurationHandler Tests
  // ============================================================
  describe('ConfigurationHandler', () => {
    let handler;
    let mockConfig;
    let mockOnConfigUpdate;

    beforeEach(() => {
      mockConfig = {
        huly: {
          apiUrl: 'http://huly.example.com/api',
          useRestApi: true,
          password: 'secret123', // Should be filtered
        },
        vibeKanban: {
          apiUrl: 'http://vibe.example.com/api',
          useRestApi: true,
        },
        sync: {
          interval: 10000,
          dryRun: false,
          incremental: true,
          parallel: true,
          maxWorkers: 5,
          skipEmpty: true,
          apiDelay: 100,
        },
        stacks: {
          baseDir: '/opt/stacks',
        },
        letta: {
          enabled: true,
          baseURL: 'http://letta.example.com',
          password: 'letta-secret', // Should be filtered
        },
      };
      mockOnConfigUpdate = vi.fn();
      handler = new ConfigurationHandler(mockConfig, mockOnConfigUpdate);
    });

    describe('getConfig', () => {
      it('should send safe config as JSON response', () => {
        const res = createMockResponse();

        handler.getConfig({}, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        expect(res.end).toHaveBeenCalled();

        const responseData = JSON.parse(res.end.mock.calls[0][0]);
        expect(responseData.config).toBeDefined();
        expect(responseData.updatedAt).toBeDefined();
      });
    });

    describe('getSafeConfig', () => {
      it('should return config without sensitive data', () => {
        const safeConfig = handler.getSafeConfig();

        expect(safeConfig.huly.apiUrl).toBe('http://huly.example.com/api');
        expect(safeConfig.huly.password).toBeUndefined();
        expect(safeConfig.letta.password).toBeUndefined();
      });

      it('should include all expected fields', () => {
        const safeConfig = handler.getSafeConfig();

        expect(safeConfig.huly).toBeDefined();
        expect(safeConfig.vibeKanban).toBeDefined();
        expect(safeConfig.sync).toBeDefined();
        expect(safeConfig.stacks).toBeDefined();
        expect(safeConfig.letta).toBeDefined();
      });

      it('should include sync configuration', () => {
        const safeConfig = handler.getSafeConfig();

        expect(safeConfig.sync.interval).toBe(10000);
        expect(safeConfig.sync.dryRun).toBe(false);
        expect(safeConfig.sync.incremental).toBe(true);
        expect(safeConfig.sync.parallel).toBe(true);
        expect(safeConfig.sync.maxWorkers).toBe(5);
        expect(safeConfig.sync.skipEmpty).toBe(true);
        expect(safeConfig.sync.apiDelay).toBe(100);
      });
    });

    describe('validateConfigUpdates', () => {
      it('should validate syncInterval >= 1000', () => {
        expect(() => {
          handler.validateConfigUpdates({ syncInterval: 500 });
        }).toThrow('syncInterval must be >= 1000 milliseconds');

        const valid = handler.validateConfigUpdates({ syncInterval: 5000 });
        expect(valid.syncInterval).toBe(5000);
      });

      it('should validate maxWorkers between 1 and 20', () => {
        expect(() => {
          handler.validateConfigUpdates({ maxWorkers: 0 });
        }).toThrow('maxWorkers must be between 1 and 20');

        expect(() => {
          handler.validateConfigUpdates({ maxWorkers: 25 });
        }).toThrow('maxWorkers must be between 1 and 20');

        const valid = handler.validateConfigUpdates({ maxWorkers: 10 });
        expect(valid.maxWorkers).toBe(10);
      });

      it('should validate apiDelay between 0 and 10000', () => {
        expect(() => {
          handler.validateConfigUpdates({ apiDelay: -1 });
        }).toThrow('apiDelay must be between 0 and 10000 milliseconds');

        expect(() => {
          handler.validateConfigUpdates({ apiDelay: 15000 });
        }).toThrow('apiDelay must be between 0 and 10000 milliseconds');

        const valid = handler.validateConfigUpdates({ apiDelay: 500 });
        expect(valid.apiDelay).toBe(500);
      });

      it('should convert boolean flags', () => {
        const valid = handler.validateConfigUpdates({
          dryRun: 1,
          incremental: 0,
          parallel: 'true',
          skipEmpty: false,
        });

        expect(valid.dryRun).toBe(true);
        expect(valid.incremental).toBe(false);
        expect(valid.parallel).toBe(true);
        expect(valid.skipEmpty).toBe(false);
      });

      it('should handle invalid numeric values', () => {
        expect(() => {
          handler.validateConfigUpdates({ syncInterval: 'invalid' });
        }).toThrow('syncInterval must be >= 1000 milliseconds');

        expect(() => {
          handler.validateConfigUpdates({ maxWorkers: 'abc' });
        }).toThrow('maxWorkers must be between 1 and 20');
      });

      it('should return empty object for no updates', () => {
        const valid = handler.validateConfigUpdates({});
        expect(valid).toEqual({});
      });
    });

    describe('updateConfig', () => {
      it('should update config and call onConfigUpdate', async () => {
        const req = createMockRequest({ syncInterval: 5000, dryRun: true });
        const res = createMockResponse();

        await handler.updateConfig(req, res);

        expect(mockConfig.sync.interval).toBe(5000);
        expect(mockConfig.sync.dryRun).toBe(true);
        expect(mockOnConfigUpdate).toHaveBeenCalledWith({
          syncInterval: 5000,
          dryRun: true,
        });
      });

      it('should send success response', async () => {
        const req = createMockRequest({ maxWorkers: 8 });
        const res = createMockResponse();

        await handler.updateConfig(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        const responseData = JSON.parse(res.end.mock.calls[0][0]);
        expect(responseData.message).toBe('Configuration updated successfully');
      });

      it('should send error response for invalid updates', async () => {
        const req = createMockRequest({ syncInterval: 100 });
        const res = createMockResponse();

        await handler.updateConfig(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        const responseData = JSON.parse(res.end.mock.calls[0][0]);
        expect(responseData.error).toBe('Failed to update configuration');
      });
    });
  });

  // ============================================================
  // Helper Functions Tests
  // ============================================================
  describe('Helper Functions', () => {
    describe('parseJsonBody', () => {
      it('should parse valid JSON body', async () => {
        const req = createMockRequest({ key: 'value', number: 42 });

        const result = await parseJsonBody(req);

        expect(result).toEqual({ key: 'value', number: 42 });
      });

      it('should return empty object for empty body', async () => {
        const req = createMockRequest(null);

        const result = await parseJsonBody(req);

        expect(result).toEqual({});
      });

      it('should reject invalid JSON', async () => {
        const req = new EventEmitter();
        setTimeout(() => {
          req.emit('data', 'not valid json');
          req.emit('end');
        }, 0);

        await expect(parseJsonBody(req)).rejects.toThrow('Invalid JSON body');
      });

      it('should reject on request error', async () => {
        const req = new EventEmitter();
        setTimeout(() => {
          req.emit('error', new Error('Network error'));
        }, 0);

        await expect(parseJsonBody(req)).rejects.toThrow('Network error');
      });

      it('should handle chunked data', async () => {
        const req = new EventEmitter();
        setTimeout(() => {
          req.emit('data', '{"part');
          req.emit('data', '1": "a", "part2"');
          req.emit('data', ': "b"}');
          req.emit('end');
        }, 0);

        const result = await parseJsonBody(req);

        expect(result).toEqual({ part1: 'a', part2: 'b' });
      });
    });

    describe('sendJson', () => {
      it('should set correct headers', () => {
        const res = createMockResponse();

        sendJson(res, 200, { data: 'test' });

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
      });

      it('should send formatted JSON', () => {
        const res = createMockResponse();

        sendJson(res, 200, { key: 'value' });

        const body = res.end.mock.calls[0][0];
        expect(body).toBe('{\n  "key": "value"\n}');
      });

      it('should handle different status codes', () => {
        const res = createMockResponse();

        sendJson(res, 201, { created: true });

        expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
      });
    });

    describe('sendError', () => {
      it('should send error with message and status code', () => {
        const res = createMockResponse();

        sendError(res, 404, 'Not found');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.error).toBe('Not found');
        expect(body.statusCode).toBe(404);
        expect(body.timestamp).toBeDefined();
      });

      it('should include details when provided', () => {
        const res = createMockResponse();

        sendError(res, 400, 'Validation failed', { field: 'email', reason: 'invalid' });

        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.details).toEqual({ field: 'email', reason: 'invalid' });
      });

      it('should not include details when null', () => {
        const res = createMockResponse();

        sendError(res, 500, 'Internal error');

        const body = JSON.parse(res.end.mock.calls[0][0]);
        expect(body.details).toBeUndefined();
      });

      it('should set CORS headers', () => {
        const res = createMockResponse();

        sendError(res, 403, 'Forbidden');

        expect(res.writeHead).toHaveBeenCalledWith(
          403,
          expect.objectContaining({
            'Access-Control-Allow-Origin': '*',
          })
        );
      });
    });
  });
});

// ============================================================
// HTTP Route Tests - createApiServer()
// ============================================================

import http from 'http';
import {
  createApiServer,
  broadcastSyncEvent,
  recordIssueMapping,
  sseManager,
  syncHistory,
} from '../../src/ApiServer.js';

function getRandomPort() {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeRequest(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
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

describe('createApiServer - HTTP Routes', () => {
  let server;
  let port;
  let mockOnSyncTrigger;
  let mockOnConfigUpdate;
  let mockDb;
  let mockWebhookHandler;
  let mockTemporalClient;
  let mockGetTemporalClient;
  let mockCodePerceptionWatcher;
  let mockConfig;

  beforeAll(async () => {
    port = getRandomPort();
    process.env.HEALTH_PORT = String(port);

    mockConfig = {
      huly: { apiUrl: 'http://localhost:3457/api', useRestApi: true },
      vibeKanban: { apiUrl: 'http://localhost:9717', useRestApi: true },
      sync: {
        interval: 10000,
        dryRun: false,
        incremental: true,
        parallel: true,
        maxWorkers: 5,
        skipEmpty: true,
        apiDelay: 100,
      },
      stacks: { baseDir: '/opt/stacks' },
      letta: { enabled: true, baseURL: 'http://localhost:8283', password: 'secret' },
    };

    mockDb = {
      getStats: vi.fn(() => ({ tables: 5, total_rows: 100 })),
      getProjectSummary: vi.fn(() => [{ identifier: 'TEST', name: 'Test Project', issueCount: 5 }]),
      getProject: vi.fn(identifier =>
        identifier === 'TEST'
          ? {
              identifier: 'TEST',
              name: 'Test Project',
              status: 'active',
              issue_count: 1,
              last_sync_at: 1700000000000,
            }
          : null,
      ),
      getProjectIssues: vi.fn(() => [
        {
          identifier: 'issue-1',
          project_identifier: 'TEST',
          title: 'Test Issue',
          status: 'todo',
          priority: 'medium',
          updated_at: 1700000000000,
        },
      ]),
      getProjectFilesystemPath: vi.fn(() => '/opt/stacks/test-project'),
      resolveProjectIdentifier: vi.fn(id => (id === 'testfolder' ? 'TEST' : null)),
      getProjectFiles: vi.fn(() => []),
      getOrphanedFiles: vi.fn(() => []),
    };

    mockOnSyncTrigger = vi.fn().mockResolvedValue(undefined);
    mockOnConfigUpdate = vi.fn();

    mockWebhookHandler = {
      handleWebhook: vi
        .fn()
        .mockResolvedValue({ success: true, processed: 1, skipped: 0, errors: [] }),
      getStats: vi.fn(() => ({ total: 10, processed: 8 })),
      getWatcherStats: vi.fn().mockResolvedValue({ running: true }),
    };

    mockTemporalClient = {
      getActiveScheduledSync: vi.fn().mockResolvedValue(null),
      startScheduledSync: vi.fn().mockResolvedValue({ workflowId: 'wf-1' }),
      stopScheduledSync: vi.fn().mockResolvedValue(true),
      restartScheduledSync: vi.fn().mockResolvedValue({ workflowId: 'wf-2' }),
    };
    mockGetTemporalClient = vi.fn().mockResolvedValue(mockTemporalClient);

    mockCodePerceptionWatcher = {
      astInitialSync: vi.fn().mockResolvedValue({ files: 10, functions: 50 }),
    };

    server = createApiServer({
      config: mockConfig,
      healthStats: {},
      db: mockDb,
      onSyncTrigger: mockOnSyncTrigger,
      onConfigUpdate: mockOnConfigUpdate,
      webhookHandler: mockWebhookHandler,
      getTemporalClient: mockGetTemporalClient,
      codePerceptionWatcher: mockCodePerceptionWatcher,
    });

    await new Promise(resolve => {
      if (server.listening) resolve();
      else server.on('listening', resolve);
    });
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  // --------------------------------------------------------
  // 1. OPTIONS (CORS preflight)
  // --------------------------------------------------------
  describe('OPTIONS (CORS preflight)', () => {
    it('should return 204 for any OPTIONS request', async () => {
      const res = await makeRequest(port, 'OPTIONS', '/api/config');
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('should return 204 for OPTIONS on unknown path', async () => {
      const res = await makeRequest(port, 'OPTIONS', '/unknown');
      expect(res.statusCode).toBe(204);
    });
  });

  // --------------------------------------------------------
  // 2. GET /health
  // --------------------------------------------------------
  describe('GET /health', () => {
    it('should return health metrics', async () => {
      const res = await makeRequest(port, 'GET', '/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.uptime).toBeDefined();
    });
  });

  // --------------------------------------------------------
  // 3. GET /metrics
  // --------------------------------------------------------
  describe('GET /metrics', () => {
    it('should return Prometheus metrics', async () => {
      const res = await makeRequest(port, 'GET', '/metrics');
      expect(res.statusCode).toBe(200);
      // body is Prometheus text, not JSON
      expect(res.body).toContain('# HELP');
    });
  });

  // --------------------------------------------------------
  // 4. GET /api/stats
  // --------------------------------------------------------
  describe('GET /api/stats', () => {
    it('should return statistics with db', async () => {
      const res = await makeRequest(port, 'GET', '/api/stats');
      expect(res.statusCode).toBe(200);
      expect(res.body.uptime).toBeDefined();
      expect(res.body.sync).toBeDefined();
      expect(res.body.sseClients).toBeDefined();
      expect(res.body.database).toEqual({ tables: 5, total_rows: 100 });
    });

    it('should handle db.getStats throwing', async () => {
      mockDb.getStats.mockImplementationOnce(() => {
        throw new Error('DB error');
      });
      const res = await makeRequest(port, 'GET', '/api/stats');
      expect(res.statusCode).toBe(200);
      expect(res.body.database).toEqual({ error: 'Failed to fetch database statistics' });
    });
  });

  // --------------------------------------------------------
  // 5. GET /api/projects
  // --------------------------------------------------------
  describe('GET /api/projects', () => {
    it('should return projects with db', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects');
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.projects[0].identifier).toBe('TEST');
    });

    it('should handle db.getProjectSummary throwing', async () => {
      mockDb.getProjectSummary.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      const res = await makeRequest(port, 'GET', '/api/projects');
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Failed to fetch projects');
    });
  });

  // --------------------------------------------------------
  // 6. GET /api/projects/:id/issues
  // --------------------------------------------------------
  describe('GET /api/projects/:id/issues', () => {
    it('should return project issues', async () => {
      const res = await makeRequest(port, 'GET', '/api/projects/TEST/issues');
      expect(res.statusCode).toBe(200);
      expect(res.body.schema_version).toBe(1);
      expect(res.body.projectId).toBe('TEST');
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.issues[0]).toEqual(
        expect.objectContaining({
          id: 'issue-1',
          projectId: 'TEST',
          provider: 'beads',
          title: 'Test Issue',
          status: 'open',
        }),
      );
    });

    it('should handle db error', async () => {
      mockDb.getProjectIssues.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      const res = await makeRequest(port, 'GET', '/api/projects/TEST/issues');
      expect(res.statusCode).toBe(500);
    });
  });

  // --------------------------------------------------------
  // 7. POST /api/projects/:id/ast-sync
  // --------------------------------------------------------
  describe('POST /api/projects/:id/ast-sync', () => {
    it('should trigger AST sync for a project', async () => {
      const res = await makeRequest(port, 'POST', '/api/projects/TEST/ast-sync', {});
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('complete');
      expect(res.body.files).toBe(10);
    });

    it('should return 404 if project has no filesystem path', async () => {
      mockDb.getProjectFilesystemPath.mockReturnValueOnce(null);
      const res = await makeRequest(port, 'POST', '/api/projects/UNKNOWN/ast-sync', {});
      expect(res.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------
  // 8. GET /api/config
  // --------------------------------------------------------
  describe('GET /api/config', () => {
    it('should return safe config', async () => {
      const res = await makeRequest(port, 'GET', '/api/config');
      expect(res.statusCode).toBe(200);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.huly.apiUrl).toBe('http://localhost:3457/api');
      // password should not be exposed
      expect(res.body.config.letta.password).toBeUndefined();
    });
  });

  // --------------------------------------------------------
  // 9. PATCH /api/config
  // --------------------------------------------------------
  describe('PATCH /api/config', () => {
    it('should update config successfully', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/config', { maxWorkers: 8 });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Configuration updated successfully');
      expect(mockOnConfigUpdate).toHaveBeenCalled();
    });

    it('should return 400 for invalid config', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/config', { syncInterval: 100 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Failed to update configuration');
    });
  });

  // --------------------------------------------------------
  // 10. POST /api/config/reset
  // --------------------------------------------------------
  describe('POST /api/config/reset', () => {
    it('should reset config to defaults', async () => {
      const res = await makeRequest(port, 'POST', '/api/config/reset');
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Configuration reset to defaults');
    });
  });

  // --------------------------------------------------------
  // 11. POST /api/sync/trigger
  // --------------------------------------------------------
  describe('POST /api/sync/trigger', () => {
    it('should trigger full sync without projectId', async () => {
      const res = await makeRequest(port, 'POST', '/api/sync/trigger', {});
      expect(res.statusCode).toBe(202);
      expect(res.body.message).toBe('Full sync triggered');
      expect(res.body.status).toBe('accepted');
    });

    it('should trigger sync for specific project', async () => {
      const res = await makeRequest(port, 'POST', '/api/sync/trigger', { projectId: 'TEST' });
      expect(res.statusCode).toBe(202);
      expect(res.body.message).toContain('TEST');
    });

    it('should resolve folder name to project ID', async () => {
      const res = await makeRequest(port, 'POST', '/api/sync/trigger', { projectId: 'testfolder' });
      expect(res.statusCode).toBe(202);
      expect(mockDb.resolveProjectIdentifier).toHaveBeenCalledWith('testfolder');
    });
  });

  describe('GET /api/sync/history', () => {
    it('should return sync history', async () => {
      const res = await makeRequest(port, 'GET', '/api/sync/history');
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBeDefined();
      expect(res.body.entries).toBeDefined();
    });

    it('should support pagination params', async () => {
      const res = await makeRequest(port, 'GET', '/api/sync/history?limit=5&offset=0');
      expect(res.statusCode).toBe(200);
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(0);
    });
  });

  describe('GET /api/sync/history/:id', () => {
    it('should return 404 for non-existent event', async () => {
      const res = await makeRequest(port, 'GET', '/api/sync/history/nonexistent');
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Sync event not found');
    });

    it('should return event if found', async () => {
      // Add an event to history via the exported syncHistory
      syncHistory.addEvent({ type: 'test_event', detail: 'found' });
      const entries = syncHistory.getHistory(1, 0).entries;
      const eventId = entries[0].id;
      const res = await makeRequest(port, 'GET', `/api/sync/history/${eventId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.type).toBe('test_event');
    });
  });

  describe('GET /api/sync/mappings', () => {
    it('should return all mappings', async () => {
      const res = await makeRequest(port, 'GET', '/api/sync/mappings');
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBeDefined();
      expect(res.body.mappings).toBeDefined();
    });
  });

  // --------------------------------------------------------
  // 16. GET /api/sync/mappings/:id
  // --------------------------------------------------------
  describe('GET /api/sync/mappings/:id', () => {
    it('should return 404 for non-existent mapping', async () => {
      const res = await makeRequest(port, 'GET', '/api/sync/mappings/NONEXISTENT');
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Mapping not found');
    });

    it('should return mapping if found', async () => {
      syncHistory.addMapping('MAP-1', 'vibe-1');
      const res = await makeRequest(port, 'GET', '/api/sync/mappings/MAP-1');
      expect(res.statusCode).toBe(200);
      expect(res.body.hulyIdentifier).toBe('MAP-1');
    });
  });

  // --------------------------------------------------------
  // 17. GET /api/events/stream (SSE)
  // --------------------------------------------------------
  describe('GET /api/events/stream', () => {
    it('should return SSE headers', async () => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: 'localhost', port, path: '/api/events/stream', method: 'GET' },
          res => {
            // Just read the headers and first chunk, then abort
            resolve({ statusCode: res.statusCode, headers: res.headers });
            res.destroy();
          }
        );
        req.on('error', () => {}); // ignore abort error
        req.end();
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    });
  });

  // --------------------------------------------------------
  // 18. POST /api/files/read
  // --------------------------------------------------------
  describe('POST /api/files/read', () => {
    it('should return 400 if file_path missing', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/read', {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('file_path is required');
    });

    it('should return 404 if file does not exist', async () => {
      // fs is not mocked globally so existsSync will run for real.
      // Use a path that definitely doesn't exist.
      const res = await makeRequest(port, 'POST', '/api/files/read', {
        file_path: 'definitely_nonexistent_file_xyz_12345.txt',
      });
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('File not found');
    });
  });

  // --------------------------------------------------------
  // 19. POST /api/files/edit
  // --------------------------------------------------------
  describe('POST /api/files/edit', () => {
    it('should return 400 if file_path missing', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/edit', {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('file_path is required');
    });

    it('should return 400 if start_line/end_line missing', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/edit', { file_path: 'test.js' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('start_line and end_line are required');
    });

    it('should return 400 if new_content missing', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/edit', {
        file_path: 'test.js',
        start_line: 1,
        end_line: 2,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('new_content is required');
    });

    it('should return 404 if file does not exist', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/edit', {
        file_path: 'nonexistent_xyz.txt',
        start_line: 1,
        end_line: 2,
        new_content: 'hello',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------
  // 20. POST /api/files/info
  // --------------------------------------------------------
  describe('POST /api/files/info', () => {
    it('should return 400 if file_path missing', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/info', {});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('file_path is required');
    });

    it('should return exists: false for non-existent file', async () => {
      const res = await makeRequest(port, 'POST', '/api/files/info', {
        file_path: 'nonexistent_xyz.txt',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.exists).toBe(false);
    });
  });

  // --------------------------------------------------------
  // 30. GET /api/temporal/schedule
  // --------------------------------------------------------
  describe('GET /api/temporal/schedule', () => {
    it('should return schedule status', async () => {
      const res = await makeRequest(port, 'GET', '/api/temporal/schedule');
      expect(res.statusCode).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.active).toBe(false);
    });

    it('should handle temporal client returning null', async () => {
      mockGetTemporalClient.mockResolvedValueOnce(null);
      const res = await makeRequest(port, 'GET', '/api/temporal/schedule');
      expect(res.statusCode).toBe(200);
      expect(res.body.available).toBe(false);
    });
  });

  // --------------------------------------------------------
  // 31. POST /api/temporal/schedule/start
  // --------------------------------------------------------
  describe('POST /api/temporal/schedule/start', () => {
    it('should start scheduled sync', async () => {
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/start', {});
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workflowId).toBe('wf-1');
    });

    it('should return already active if schedule exists', async () => {
      mockTemporalClient.getActiveScheduledSync.mockResolvedValueOnce({ workflowId: 'existing' });
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/start', {});
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('already active');
    });

    it('should handle temporal client null', async () => {
      mockGetTemporalClient.mockResolvedValueOnce(null);
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/start', {});
      expect(res.statusCode).toBe(503);
    });
  });

  // --------------------------------------------------------
  // 32. POST /api/temporal/schedule/stop
  // --------------------------------------------------------
  describe('POST /api/temporal/schedule/stop', () => {
    it('should stop scheduled sync', async () => {
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/stop');
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should handle no active schedule', async () => {
      mockTemporalClient.stopScheduledSync.mockResolvedValueOnce(false);
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/stop');
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(false);
    });

    it('should handle temporal client null', async () => {
      mockGetTemporalClient.mockResolvedValueOnce(null);
      const res = await makeRequest(port, 'POST', '/api/temporal/schedule/stop');
      expect(res.statusCode).toBe(503);
    });
  });

  // --------------------------------------------------------
  // 33. PATCH /api/temporal/schedule
  // --------------------------------------------------------
  describe('PATCH /api/temporal/schedule', () => {
    it('should update schedule interval', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/temporal/schedule', {
        intervalMinutes: 5,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workflowId).toBe('wf-2');
    });

    it('should return 400 for invalid interval', async () => {
      const res = await makeRequest(port, 'PATCH', '/api/temporal/schedule', {
        intervalMinutes: 0,
      });
      expect(res.statusCode).toBe(400);
    });

    it('should handle restartScheduledSync returning null', async () => {
      mockTemporalClient.restartScheduledSync.mockResolvedValueOnce(null);
      const res = await makeRequest(port, 'PATCH', '/api/temporal/schedule', {
        intervalMinutes: 5,
      });
      expect(res.statusCode).toBe(500);
    });
  });

  // --------------------------------------------------------
  // 34. GET /api/temporal/workflows
  // --------------------------------------------------------
  describe('GET /api/temporal/workflows', () => {
    it('should list workflows', async () => {
      const res = await makeRequest(port, 'GET', '/api/temporal/workflows');
      expect(res.statusCode).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.workflows).toHaveLength(1);
    });

    it('should handle temporal client null', async () => {
      mockGetTemporalClient.mockResolvedValueOnce(null);
      const res = await makeRequest(port, 'GET', '/api/temporal/workflows');
      expect(res.statusCode).toBe(200);
      expect(res.body.available).toBe(false);
    });
  });

  // --------------------------------------------------------
  // 35. GET / (API documentation)
  // --------------------------------------------------------
  describe('GET / (API documentation)', () => {
    it('should return API documentation text', async () => {
      const res = await makeRequest(port, 'GET', '/');
      expect(res.statusCode).toBe(200);
      // body is plain text, not JSON
      expect(typeof res.body).toBe('string');
      expect(res.body).toContain('Vibesync Service API');
    });
  });

  // --------------------------------------------------------
  // 36. 404 - unknown endpoint
  // --------------------------------------------------------
  describe('404 - unknown endpoint', () => {
    it('should return 404 for unknown path', async () => {
      const res = await makeRequest(port, 'GET', '/api/nonexistent');
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Endpoint not found');
      expect(res.body.details.path).toBe('/api/nonexistent');
    });

    it('should return 404 for wrong method on known path', async () => {
      const res = await makeRequest(port, 'DELETE', '/api/config');
      expect(res.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------
  // 37. broadcastSyncEvent() exported helper
  // --------------------------------------------------------
  describe('broadcastSyncEvent()', () => {
    it('should broadcast via SSE manager', () => {
      const broadcastSpy = vi.spyOn(sseManager, 'broadcast');
      broadcastSyncEvent('sync:started', { projectId: 'TEST' });
      expect(broadcastSpy).toHaveBeenCalledWith('sync:started', { projectId: 'TEST' });
      broadcastSpy.mockRestore();
    });

    it('should add sync events to history', () => {
      const initialTotal = syncHistory.getHistory().total;
      broadcastSyncEvent('sync:completed', { projectId: 'TEST', status: 'success' });
      const newTotal = syncHistory.getHistory().total;
      expect(newTotal).toBeGreaterThan(initialTotal);
    });

    it('should not add non-sync events to history', () => {
      const initialTotal = syncHistory.getHistory().total;
      broadcastSyncEvent('config:updated', { key: 'value' });
      const newTotal = syncHistory.getHistory().total;
      expect(newTotal).toBe(initialTotal);
    });
  });

  // --------------------------------------------------------
  // 38. recordIssueMapping() exported helper
  // --------------------------------------------------------
  describe('recordIssueMapping()', () => {
    it('should record mapping in syncHistory', () => {
      recordIssueMapping('PROJ-999', 'vibe-999', { direction: 'huly-to-vibe' });
      const mapping = syncHistory.getMapping('PROJ-999');
      expect(mapping).not.toBeNull();
      expect(mapping.vibeTaskId).toBe('vibe-999');
      expect(mapping.direction).toBe('huly-to-vibe');
    });
  });
});

// ============================================================
// HTTP Routes - No-dependency server (db=null, no services)
// ============================================================
describe('createApiServer - No dependencies', () => {
  let server;
  let port;

  beforeAll(async () => {
    port = getRandomPort();
    process.env.HEALTH_PORT = String(port);

    server = createApiServer({
      config: {
        huly: { apiUrl: 'http://localhost:3457/api', useRestApi: true },
        vibeKanban: { apiUrl: 'http://localhost:9717', useRestApi: true },
        sync: {
          interval: 10000,
          dryRun: false,
          incremental: true,
          parallel: true,
          maxWorkers: 5,
          skipEmpty: true,
          apiDelay: 100,
        },
        stacks: { baseDir: '/opt/stacks' },
        letta: { enabled: false, baseURL: 'http://localhost:8283' },
      },
      healthStats: {},
      db: null,
      onSyncTrigger: null,
      onConfigUpdate: vi.fn(),
    });

    await new Promise(resolve => {
      if (server.listening) resolve();
      else server.on('listening', resolve);
    });
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('GET /api/projects should return 503 without db', async () => {
    const res = await makeRequest(port, 'GET', '/api/projects');
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('Database not available');
  });

  it('GET /api/projects/:id/issues should return 503 without db', async () => {
    const res = await makeRequest(port, 'GET', '/api/projects/TEST/issues');
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/projects/:id/ast-sync should return 503 without watcher', async () => {
    const res = await makeRequest(port, 'POST', '/api/projects/TEST/ast-sync', {});
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/sync/trigger should return 503 without trigger', async () => {
    const res = await makeRequest(port, 'POST', '/api/sync/trigger', {});
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('Sync trigger not available');
  });

  it('GET /api/temporal/schedule should indicate not configured', async () => {
    const res = await makeRequest(port, 'GET', '/api/temporal/schedule');
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('POST /api/temporal/schedule/start should return 503', async () => {
    const res = await makeRequest(port, 'POST', '/api/temporal/schedule/start', {});
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/temporal/schedule/stop should return 503', async () => {
    const res = await makeRequest(port, 'POST', '/api/temporal/schedule/stop');
    expect(res.statusCode).toBe(503);
  });

  it('PATCH /api/temporal/schedule should return 503', async () => {
    const res = await makeRequest(port, 'PATCH', '/api/temporal/schedule', { intervalMinutes: 5 });
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/temporal/workflows should indicate not configured', async () => {
    const res = await makeRequest(port, 'GET', '/api/temporal/workflows');
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('GET /api/stats should work without db', async () => {
    const res = await makeRequest(port, 'GET', '/api/stats');
    expect(res.statusCode).toBe(200);
    expect(res.body.database).toBeUndefined();
  });
});
