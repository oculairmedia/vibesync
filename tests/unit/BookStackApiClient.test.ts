import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/http.js', () => ({
  fetchWithPool: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../src/HealthService.js', () => ({
  recordApiLatency: vi.fn(),
}));

const { BookStackApiClient } = await import('../../src/BookStackApiClient.js');
const { fetchWithPool } = await import('../../lib/http.js');
const { recordApiLatency } = await import('../../src/HealthService.js');

function createTestConfig(overrides = {}) {
  return {
    url: 'https://docs.test.com/',
    tokenId: 'test-token-id',
    tokenSecret: 'test-token-secret',
    ...overrides,
  };
}

function createMockResponse(data, ok = true, contentType = 'application/json') {
  return {
    ok,
    status: ok ? 200 : 400,
    headers: {
      get: name => (name === 'content-type' ? contentType : null),
    },
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

describe('BookStackApiClient - Write Methods', () => {
  let client;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    client = new BookStackApiClient(config);
  });

  describe('createPage', () => {
    it('sends POST request to /api/pages with page data', async () => {
      const pageData = {
        book_id: 1,
        name: 'Test Page',
        markdown: '# Test Page\nContent here',
      };
      const responseData = { id: 123, ...pageData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.createPage(pageData);

      expect(fetchWithPool).toHaveBeenCalledWith('https://docs.test.com/api/pages', {
        method: 'POST',
        headers: {
          Authorization: 'Token test-token-id:test-token-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pageData),
      });
      expect(result).toEqual(responseData);
      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'pages', expect.any(Number));
    });

    it('includes chapter_id when provided', async () => {
      const pageData = {
        chapter_id: 5,
        name: 'Nested Page',
        markdown: '# Nested',
      };
      const responseData = { id: 124, ...pageData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createPage(pageData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual(pageData);
    });

    it('returns created page object with id', async () => {
      const responseData = {
        id: 999,
        book_id: 1,
        name: 'Created Page',
        markdown: '# Created',
        created_at: '2026-01-29T10:00:00Z',
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.createPage({
        book_id: 1,
        name: 'Created Page',
        markdown: '# Created',
      });

      expect(result.id).toBe(999);
      expect(result.name).toBe('Created Page');
    });

    it('throws error when API returns error response', async () => {
      const mockResponse = createMockResponse({ error: 'Invalid data' }, false, 'application/json');
      mockResponse.status = 422;
      fetchWithPool.mockResolvedValue(mockResponse);

      await expect(
        client.createPage({
          book_id: 1,
          name: 'Test',
          markdown: '# Test',
        })
      ).rejects.toThrow('BookStack API 422');
    });

    it('records API latency for createPage', async () => {
      const mockResponse = createMockResponse({ id: 123 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createPage({
        book_id: 1,
        name: 'Test',
        markdown: '# Test',
      });

      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'pages', expect.any(Number));
    });
  });

  describe('updatePage', () => {
    it('sends PUT request to /api/pages/{id} with updated data', async () => {
      const pageId = 123;
      const updateData = {
        markdown: '# Updated Content',
        name: 'Updated Title',
      };
      const responseData = { id: pageId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.updatePage(pageId, updateData);

      expect(fetchWithPool).toHaveBeenCalledWith('https://docs.test.com/api/pages/123', {
        method: 'PUT',
        headers: {
          Authorization: 'Token test-token-id:test-token-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateData),
      });
      expect(result).toEqual(responseData);
    });

    it('updates only markdown when name is not provided', async () => {
      const pageId = 456;
      const updateData = { markdown: '# New Markdown' };
      const responseData = { id: pageId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updatePage(pageId, updateData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual({ markdown: '# New Markdown' });
    });

    it('updates only name when markdown is not provided', async () => {
      const pageId = 789;
      const updateData = { name: 'New Title' };
      const responseData = { id: pageId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updatePage(pageId, updateData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual({ name: 'New Title' });
    });

    it('returns updated page object', async () => {
      const responseData = {
        id: 123,
        name: 'Updated Page',
        markdown: '# Updated',
        updated_at: '2026-01-29T11:00:00Z',
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.updatePage(123, {
        name: 'Updated Page',
        markdown: '# Updated',
      });

      expect(result.id).toBe(123);
      expect(result.name).toBe('Updated Page');
    });

    it('throws error when API returns error response', async () => {
      const mockResponse = createMockResponse(
        { error: 'Page not found' },
        false,
        'application/json'
      );
      mockResponse.status = 404;
      fetchWithPool.mockResolvedValue(mockResponse);

      await expect(
        client.updatePage(999, {
          markdown: '# Test',
        })
      ).rejects.toThrow('BookStack API 404');
    });

    it('records API latency for updatePage', async () => {
      const mockResponse = createMockResponse({ id: 123 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updatePage(123, { markdown: '# Updated' });

      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'pages', expect.any(Number));
    });
  });

  describe('createChapter', () => {
    it('sends POST request to /api/chapters with chapter data', async () => {
      const chapterData = {
        book_id: 1,
        name: 'Chapter 1',
        description: 'First chapter',
      };
      const responseData = { id: 456, ...chapterData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.createChapter(chapterData);

      expect(fetchWithPool).toHaveBeenCalledWith('https://docs.test.com/api/chapters', {
        method: 'POST',
        headers: {
          Authorization: 'Token test-token-id:test-token-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chapterData),
      });
      expect(result).toEqual(responseData);
    });

    it('creates chapter without description', async () => {
      const chapterData = {
        book_id: 2,
        name: 'Chapter 2',
      };
      const responseData = { id: 457, ...chapterData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.createChapter(chapterData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual(chapterData);
      expect(result.id).toBe(457);
    });

    it('returns created chapter object with id', async () => {
      const responseData = {
        id: 888,
        book_id: 1,
        name: 'New Chapter',
        description: 'Description',
        created_at: '2026-01-29T10:00:00Z',
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.createChapter({
        book_id: 1,
        name: 'New Chapter',
        description: 'Description',
      });

      expect(result.id).toBe(888);
      expect(result.name).toBe('New Chapter');
    });

    it('throws error when API returns error response', async () => {
      const mockResponse = createMockResponse(
        { error: 'Book not found' },
        false,
        'application/json'
      );
      mockResponse.status = 404;
      fetchWithPool.mockResolvedValue(mockResponse);

      await expect(
        client.createChapter({
          book_id: 999,
          name: 'Test Chapter',
        })
      ).rejects.toThrow('BookStack API 404');
    });

    it('records API latency for createChapter', async () => {
      const mockResponse = createMockResponse({ id: 456 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createChapter({
        book_id: 1,
        name: 'Chapter',
      });

      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'chapters', expect.any(Number));
    });
  });

  describe('updateChapter', () => {
    it('sends PUT request to /api/chapters/{id} with updated data', async () => {
      const chapterId = 456;
      const updateData = {
        name: 'Updated Chapter',
        description: 'Updated description',
      };
      const responseData = { id: chapterId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.updateChapter(chapterId, updateData);

      expect(fetchWithPool).toHaveBeenCalledWith('https://docs.test.com/api/chapters/456', {
        method: 'PUT',
        headers: {
          Authorization: 'Token test-token-id:test-token-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateData),
      });
      expect(result).toEqual(responseData);
    });

    it('updates only name when description is not provided', async () => {
      const chapterId = 789;
      const updateData = { name: 'New Chapter Name' };
      const responseData = { id: chapterId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updateChapter(chapterId, updateData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual({ name: 'New Chapter Name' });
    });

    it('updates only description when name is not provided', async () => {
      const chapterId = 101;
      const updateData = { description: 'New description' };
      const responseData = { id: chapterId, ...updateData };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updateChapter(chapterId, updateData);

      const callArgs = fetchWithPool.mock.calls[0];
      expect(JSON.parse(callArgs[1].body)).toEqual({ description: 'New description' });
    });

    it('returns updated chapter object', async () => {
      const responseData = {
        id: 456,
        name: 'Updated Chapter',
        description: 'Updated',
        updated_at: '2026-01-29T11:00:00Z',
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.updateChapter(456, {
        name: 'Updated Chapter',
        description: 'Updated',
      });

      expect(result.id).toBe(456);
      expect(result.name).toBe('Updated Chapter');
    });

    it('throws error when API returns error response', async () => {
      const mockResponse = createMockResponse(
        { error: 'Chapter not found' },
        false,
        'application/json'
      );
      mockResponse.status = 404;
      fetchWithPool.mockResolvedValue(mockResponse);

      await expect(
        client.updateChapter(999, {
          name: 'Test',
        })
      ).rejects.toThrow('BookStack API 404');
    });

    it('records API latency for updateChapter', async () => {
      const mockResponse = createMockResponse({ id: 456 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.updateChapter(456, { name: 'Updated' });

      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'chapters', expect.any(Number));
    });
  });

  describe('listPagesByBook', () => {
    it('sends GET request to /api/pages with book_id filter', async () => {
      const bookId = 5;
      const responseData = {
        data: [
          { id: 101, name: 'Page 1', book_id: 5 },
          { id: 102, name: 'Page 2', book_id: 5 },
        ],
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.listPagesByBook(bookId);

      const callUrl = fetchWithPool.mock.calls[0][0];
      expect(callUrl).toContain('https://docs.test.com/api/pages');
      expect(callUrl).toContain('filter%5Bbook_id%5D=5');
    });

    it('includes updated_at filter when updatedAfter is provided', async () => {
      const bookId = 5;
      const updatedAfter = '2026-01-29T10:00:00Z';
      const responseData = { data: [{ id: 101, name: 'Page 1' }] };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.listPagesByBook(bookId, { updatedAfter });

      const callUrl = fetchWithPool.mock.calls[0][0];
      expect(callUrl).toContain('filter%5Bupdated_at%3Agte%5D=2026-01-29T10%3A00%3A00Z');
    });

    it('returns array of pages from response.data', async () => {
      const responseData = {
        data: [
          { id: 101, name: 'Page 1', book_id: 5 },
          { id: 102, name: 'Page 2', book_id: 5 },
          { id: 103, name: 'Page 3', book_id: 5 },
        ],
      };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.listPagesByBook(5);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe(101);
      expect(result[1].name).toBe('Page 2');
    });

    it('uses default count of 500 when not specified', async () => {
      const responseData = { data: [] };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.listPagesByBook(5);

      const callUrl = fetchWithPool.mock.calls[0][0];
      expect(callUrl).toContain('count=500');
    });

    it('uses custom count when specified', async () => {
      const responseData = { data: [] };
      const mockResponse = createMockResponse(responseData);
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.listPagesByBook(5, { count: 100 });

      const callUrl = fetchWithPool.mock.calls[0][0];
      expect(callUrl).toContain('count=100');
    });

    it('returns empty array when response.data is undefined', async () => {
      const mockResponse = createMockResponse({});
      fetchWithPool.mockResolvedValue(mockResponse);

      const result = await client.listPagesByBook(5);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('request method - shared behavior', () => {
    it('includes authorization header with token credentials', async () => {
      const mockResponse = createMockResponse({ id: 1 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createPage({
        book_id: 1,
        name: 'Test',
        markdown: '# Test',
      });

      const callArgs = fetchWithPool.mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe('Token test-token-id:test-token-secret');
    });

    it('sets Content-Type to application/json', async () => {
      const mockResponse = createMockResponse({ id: 1 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createPage({
        book_id: 1,
        name: 'Test',
        markdown: '# Test',
      });

      const callArgs = fetchWithPool.mock.calls[0];
      expect(callArgs[1].headers['Content-Type']).toBe('application/json');
    });

    it('constructs correct URL with base URL and endpoint', async () => {
      const mockResponse = createMockResponse({ id: 1 });
      fetchWithPool.mockResolvedValue(mockResponse);

      await client.createPage({
        book_id: 1,
        name: 'Test',
        markdown: '# Test',
      });

      const callArgs = fetchWithPool.mock.calls[0];
      expect(callArgs[0]).toBe('https://docs.test.com/api/pages');
    });

    it('removes trailing slash from base URL', () => {
      const clientWithSlash = new BookStackApiClient(
        createTestConfig({ url: 'https://docs.test.com/' })
      );
      expect(clientWithSlash.baseUrl).toBe('https://docs.test.com');
    });

    it('handles error response with status code and message', async () => {
      const errorText = 'Validation failed: Invalid book_id';
      const mockResponse = createMockResponse(null, false, 'text/plain');
      mockResponse.status = 422;
      mockResponse.text.mockResolvedValue(errorText);
      fetchWithPool.mockResolvedValue(mockResponse);

      await expect(
        client.createPage({
          book_id: 999,
          name: 'Test',
          markdown: '# Test',
        })
      ).rejects.toThrow('BookStack API 422');
    });

    it('truncates long error messages to 200 characters', async () => {
      const longError = 'x'.repeat(300);
      const mockResponse = createMockResponse(null, false, 'text/plain');
      mockResponse.status = 500;
      mockResponse.text.mockResolvedValue(longError);
      fetchWithPool.mockResolvedValue(mockResponse);

      try {
        await client.updatePage(1, { markdown: '# Test' });
      } catch (error) {
        expect(error.message).toContain('BookStack API 500');
        expect(error.message.length).toBeLessThan(250);
      }
    });
  });
});
