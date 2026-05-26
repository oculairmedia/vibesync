import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

vi.mock('fs');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));
vi.mock('../../src/HealthService.js', () => ({
  recordApiLatency: vi.fn(),
}));

const { BookStackExporter } = await import('../../src/BookStackExporter.js');
const { BookStackService } = await import('../../src/BookStackService.js');

function createTestConfig(overrides = {}) {
  return {
    enabled: true,
    url: 'https://docs.test.com',
    tokenId: 'test-token-id',
    tokenSecret: 'test-token-secret',
    syncInterval: 3600000,
    exportFormats: ['markdown'],
    exportImages: true,
    exportAttachments: true,
    exportMeta: true,
    modifyMarkdownLinks: true,
    docsSubdir: 'docs/bookstack',
    projectBookMappings: [{ projectIdentifier: 'HVSYN', bookSlug: 'vibesync-docs' }],
    exporterOutputPath: '/bookstack-exports',
    ...overrides,
  };
}

function createMockDb() {
  return {
    getBookStackLastExport: vi.fn().mockReturnValue(null),
    setBookStackLastExport: vi.fn(),
    upsertBookStackPage: vi.fn(),
    getBookStackPages: vi.fn().mockReturnValue([]),
    getBookStackPageByPath: vi.fn().mockReturnValue(null),
  };
}

describe('BookStackExporter', () => {
  let exporter;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    exporter = new BookStackExporter(config);
  });

  describe('getLatestArchive', () => {
    it('returns null when export dir does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      expect(exporter.getLatestArchive()).toBeNull();
    });

    it('returns null when no archives exist', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
      expect(exporter.getLatestArchive()).toBeNull();
    });

    it('returns latest archive sorted by name', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([
        'bookstack_export_2026-01-27_09-00-00.tgz',
        'bookstack_export_2026-01-28_09-00-00.tgz',
        'bookstack_export_2026-01-26_09-00-00.tgz',
      ]);

      const result = exporter.getLatestArchive();
      expect(result).toBe(
        path.join('/bookstack-exports', 'bookstack_export_2026-01-28_09-00-00.tgz')
      );
    });

    it('ignores non-archive files', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([
        'readme.md',
        'bookstack_export_2026-01-28_09-00-00.tgz',
        'config.yml',
      ]);

      const result = exporter.getLatestArchive();
      expect(result).toContain('bookstack_export_2026-01-28');
    });
  });

  describe('findBookDir', () => {
    it('finds book directory by slug at top level', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'vibesync-docs', isDirectory: () => true },
        { name: 'other-book', isDirectory: () => true },
      ]);

      const result = exporter.findBookDir('/tmp/extract', 'vibesync-docs');
      expect(result).toBe(path.join('/tmp/extract', 'vibesync-docs'));
    });

    it('returns null when book not found', () => {
      fs.readdirSync.mockReturnValue([{ name: 'other-book', isDirectory: () => true }]);

      const result = exporter.findBookDir('/tmp/extract', 'nonexistent-book');
      expect(result).toBeNull();
    });
  });

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = exporter.getStats();
      expect(stats.totalExports).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastExportAt).toBeNull();
    });
  });
});

describe('BookStackService', () => {
  let service;
  let config;
  let db;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig();
    db = createMockDb();
    service = new BookStackService(config, db);
  });

  describe('initialize', () => {
    it('initializes and reports archive status', async () => {
      fs.existsSync.mockReturnValue(false);
      const result = await service.initialize();
      expect(result.archiveExists).toBe(false);
      expect(service.initialized).toBe(true);
    });
  });

  describe('getBookSlugForProject', () => {
    it('returns slug for mapped project', () => {
      expect(service.getBookSlugForProject('HVSYN')).toBe('vibesync-docs');
    });

    it('returns null for unmapped project', () => {
      expect(service.getBookSlugForProject('UNKNOWN')).toBeNull();
    });
  });

  describe('syncExport', () => {
    it('skips when no mapping exists', async () => {
      const result = await service.syncExport('UNKNOWN', '/opt/stacks/unknown');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_mapping');
    });

    it('skips when export is not due', async () => {
      db.getBookStackLastExport.mockReturnValue(Date.now() - 1000);

      const result = await service.syncExport('HVSYN', '/opt/stacks/vibesync');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('not_due');
    });

    it('attempts export when due', async () => {
      db.getBookStackLastExport.mockReturnValue(null);
      fs.existsSync.mockReturnValue(false);

      const result = await service.syncExport('HVSYN', '/opt/stacks/vibesync');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_archive');
    });
  });

  describe('getHealthInfo', () => {
    it('returns health information', () => {
      const health = service.getHealthInfo();
      expect(health.enabled).toBe(true);
      expect(health.url).toBe('https://docs.test.com');
      expect(health.mappings).toBe(1);
      expect(health.syncInterval).toBe('3600s');
    });
  });

  describe('getStats', () => {
    it('returns combined stats', () => {
      const stats = service.getStats();
      expect(stats.exportsCompleted).toBe(0);
      expect(stats.exportsFailed).toBe(0);
      expect(stats.exporter).toBeDefined();
    });
  });

  describe('syncImport', () => {
    it('skips when no mapping exists', async () => {
      const result = await service.syncImport('UNKNOWN', '/opt/stacks/unknown');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_mapping');
    });

    it('skips when API not connected', async () => {
      service.apiConnected = false;
      const result = await service.syncImport('HVSYN', '/opt/stacks/vibesync');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('api_not_connected');
    });

    it('skips when docs directory does not exist', async () => {
      service.apiConnected = true;
      fs.existsSync.mockReturnValue(false);
      const result = await service.syncImport('HVSYN', '/opt/stacks/vibesync');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_docs_dir');
    });

    it('processes changes and returns results', async () => {
      service.apiConnected = true;
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([
        { name: 'page.md', isFile: () => true, isDirectory: () => false },
      ]);
      fs.readFileSync.mockReturnValue('# Test Page\n\nContent');

      db.getBookStackPages.mockReturnValue([
        {
          local_path: 'vibesync-docs/page.md',
          content_hash: 'oldhash',
          bookstack_page_id: 123,
        },
      ]);

      service.apiClient = {
        updatePage: vi.fn().mockResolvedValue({ id: 123, slug: 'test-page' }),
      };

      const result = await service.syncImport('HVSYN', '/opt/stacks/vibesync');
      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.failed).toBe(0);
      expect(service.apiClient.updatePage).toHaveBeenCalledWith(123, {
        markdown: '# Test Page\n\nContent',
      });
    });
  });

  describe('detectLocalChanges', () => {
    beforeEach(() => {
      fs.existsSync.mockReturnValue(true);
    });

    it('finds updated files with hash mismatch', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'page.md', isFile: () => true, isDirectory: () => false },
      ]);
      fs.readFileSync.mockReturnValue('# Updated Content');

      db.getBookStackPages.mockReturnValue([
        {
          local_path: 'vibesync-docs/page.md',
          content_hash: 'oldhash',
          bookstack_page_id: 123,
        },
      ]);

      const changes = service.detectLocalChanges(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs'
      );

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('update');
      expect(changes[0].localPath).toBe('vibesync-docs/page.md');
      expect(changes[0].contentHash).not.toBe('oldhash');
    });

    it('finds new files with # Title heading', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'new-page.md', isFile: () => true, isDirectory: () => false },
      ]);
      fs.readFileSync.mockReturnValue('# New Page Title\n\nContent here');

      db.getBookStackPages.mockReturnValue([]);

      const changes = service.detectLocalChanges(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs'
      );

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('create');
      expect(changes[0].title).toBe('New Page Title');
      expect(changes[0].localPath).toBe('vibesync-docs/new-page.md');
    });

    it('skips new files without # Title heading', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'no-title.md', isFile: () => true, isDirectory: () => false },
      ]);
      fs.readFileSync.mockReturnValue('Just some content without a title');

      db.getBookStackPages.mockReturnValue([]);

      const changes = service.detectLocalChanges(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs'
      );

      expect(changes).toHaveLength(0);
    });

    it('echo loop guard skips files within 60s of export', () => {
      fs.readdirSync.mockReturnValue([
        { name: 'recent.md', isFile: () => true, isDirectory: () => false },
      ]);
      fs.readFileSync.mockReturnValue('# Recent Export\n\nModified content');

      const now = Date.now();
      db.getBookStackPages.mockReturnValue([
        {
          local_path: 'vibesync-docs/recent.md',
          content_hash: 'oldhash',
          last_export_at: now - 30000,
          sync_direction: 'export',
        },
      ]);

      const changes = service.detectLocalChanges(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs'
      );

      expect(changes).toHaveLength(0);
    });
  });

  describe('importPage', () => {
    beforeEach(() => {
      service.apiConnected = true;
      service.apiClient = {
        updatePage: vi.fn(),
        createPage: vi.fn(),
        createChapter: vi.fn(),
        listBooks: vi.fn(),
        getBookContents: vi.fn(),
      };
    });

    it('updates existing page via API', async () => {
      const change = {
        type: 'update',
        localPath: 'bookstack/vibesync-docs/page.md',
        content: '# Updated Page',
        contentHash: 'newhash',
        tracked: {
          bookstack_page_id: 123,
          content_hash: 'oldhash',
        },
      };

      service.apiClient.updatePage.mockResolvedValue({ id: 123, slug: 'page' });

      const result = await service.importPage('HVSYN', change);

      expect(result.success).toBe(true);
      expect(result.type).toBe('update');
      expect(result.pageId).toBe(123);
      expect(service.apiClient.updatePage).toHaveBeenCalledWith(123, {
        markdown: '# Updated Page',
      });
      expect(db.upsertBookStackPage).toHaveBeenCalled();
    });

    it('creates new page in book root', async () => {
      const change = {
        type: 'create',
        localPath: 'bookstack/vibesync-docs/new-page.md',
        content: '# New Page',
        contentHash: 'hash123',
        title: 'New Page',
      };

      service.apiClient.listBooks.mockResolvedValue([
        { id: 1, slug: 'vibesync-docs', name: 'Vibesync Docs' },
      ]);
      service.apiClient.getBookContents.mockResolvedValue({ chapters: [] });
      service.apiClient.createPage.mockResolvedValue({
        id: 456,
        slug: 'new-page',
        name: 'New Page',
        updated_at: '2026-01-29T00:00:00Z',
      });

      const result = await service.importPage('HVSYN', change);

      expect(result.success).toBe(true);
      expect(result.type).toBe('create');
      expect(result.pageId).toBe(456);
      expect(service.apiClient.createPage).toHaveBeenCalledWith({
        name: 'New Page',
        markdown: '# New Page',
        book_id: 1,
      });
    });

    it('creates new page in existing chapter', async () => {
      const change = {
        type: 'create',
        localPath: 'bookstack/vibesync-docs/my-chapter/page.md',
        content: '# Chapter Page',
        contentHash: 'hash456',
        title: 'Chapter Page',
      };

      service.apiClient.listBooks.mockResolvedValue([
        { id: 1, slug: 'vibesync-docs', name: 'Vibesync Docs' },
      ]);
      service.apiClient.getBookContents.mockResolvedValue({
        chapters: [{ id: 10, slug: 'my-chapter', name: 'My Chapter' }],
      });
      service.apiClient.createPage.mockResolvedValue({
        id: 789,
        slug: 'chapter-page',
        name: 'Chapter Page',
        updated_at: '2026-01-29T00:00:00Z',
      });

      const result = await service.importPage('HVSYN', change);

      expect(result.success).toBe(true);
      expect(service.apiClient.createPage).toHaveBeenCalledWith({
        name: 'Chapter Page',
        markdown: '# Chapter Page',
        chapter_id: 10,
      });
    });

    it('auto-creates chapter when not found', async () => {
      const change = {
        type: 'create',
        localPath: 'bookstack/vibesync-docs/new-chapter/page.md',
        content: '# Page in New Chapter',
        contentHash: 'hash789',
        title: 'Page in New Chapter',
      };

      service.apiClient.listBooks.mockResolvedValue([
        { id: 1, slug: 'vibesync-docs', name: 'Vibesync Docs' },
      ]);
      service.apiClient.getBookContents.mockResolvedValue({ chapters: [] });
      service.apiClient.createChapter.mockResolvedValue({
        id: 20,
        name: 'New Chapter',
      });
      service.apiClient.createPage.mockResolvedValue({
        id: 999,
        slug: 'page-in-new-chapter',
        name: 'Page in New Chapter',
        updated_at: '2026-01-29T00:00:00Z',
      });

      const result = await service.importPage('HVSYN', change);

      expect(result.success).toBe(true);
      expect(service.apiClient.createChapter).toHaveBeenCalledWith({
        book_id: 1,
        name: 'New Chapter',
      });
      expect(service.apiClient.createPage).toHaveBeenCalledWith({
        name: 'Page in New Chapter',
        markdown: '# Page in New Chapter',
        chapter_id: 20,
      });
    });
  });

  describe('importSingleFile', () => {
    beforeEach(() => {
      service.apiConnected = true;
      service.apiClient = {
        updatePage: vi.fn(),
      };
    });

    it('skips non-md files', async () => {
      fs.existsSync.mockReturnValue(true);
      const result = await service.importSingleFile(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs/file.txt'
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('invalid_file');
    });

    it('echo loop guard skips recent exports', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('# Test Page\n\nContent');

      const now = Date.now();
      db.getBookStackPageByPath.mockReturnValue({
        local_path: 'bookstack/vibesync-docs/page.md',
        content_hash: 'oldhash',
        last_export_at: now - 30000,
        sync_direction: 'export',
      });

      const result = await service.importSingleFile(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs/page.md'
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('echo_loop_guard');
      expect(result.timeSinceExport).toBeLessThan(60000);
    });

    it('skips when no change detected', async () => {
      fs.existsSync.mockReturnValue(true);
      const content = '# Test Page\n\nContent';
      fs.readFileSync.mockReturnValue(content);

      const contentHash = crypto.createHash('sha256').update(content).digest('hex');
      db.getBookStackPageByPath.mockReturnValue({
        local_path: 'bookstack/vibesync-docs/page.md',
        content_hash: contentHash,
      });

      const result = await service.importSingleFile(
        'HVSYN',
        '/opt/stacks/vibesync/docs/bookstack/vibesync-docs/page.md'
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_change');
    });
  });

  describe('_walkMarkdownFiles', () => {
    it('returns only .md files recursively', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync
        .mockReturnValueOnce([
          { name: 'page1.md', isFile: () => true, isDirectory: () => false },
          { name: 'chapter1', isFile: () => false, isDirectory: () => true },
          { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
          { name: '.hidden', isFile: () => false, isDirectory: () => true },
        ])
        .mockReturnValueOnce([
          { name: 'page2.md', isFile: () => true, isDirectory: () => false },
          { name: 'image.png', isFile: () => true, isDirectory: () => false },
        ]);

      const results = service._walkMarkdownFiles('/test/dir');

      expect(results).toHaveLength(2);
      expect(results[0]).toContain('page1.md');
      expect(results[1]).toContain('page2.md');
      expect(results.some(r => r.includes('readme.txt'))).toBe(false);
      expect(results.some(r => r.includes('.hidden'))).toBe(false);
    });

    it('returns empty array when directory does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      const results = service._walkMarkdownFiles('/nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('syncBidirectional', () => {
    const projectId = 'HVSYN';
    const projectPath = '/opt/stacks/vibesync';
    const bookSlug = 'vibesync-docs';
    const docsDir = path.join(projectPath, 'docs/bookstack', bookSlug);

    const hashOf = content => crypto.createHash('sha256').update(content).digest('hex');
    const oldContent = 'old content';
    const oldHash = hashOf(oldContent);
    const newRemoteContent = 'new remote content';
    const newRemoteHash = hashOf(newRemoteContent);
    const newLocalContent = 'new local content';
    const newLocalHash = hashOf(newLocalContent);

    function makeTrackedPage(overrides = {}) {
      return {
        bookstack_page_id: 100,
        bookstack_book_id: 1,
        bookstack_chapter_id: null,
        project_identifier: projectId,
        slug: 'test-page',
        title: 'Test Page',
        local_path: `${bookSlug}/test-page.md`,
        content_hash: oldHash,
        bookstack_content_hash: oldHash,
        bookstack_modified_at: '2026-01-28T00:00:00Z',
        bookstack_revision_count: 5,
        local_modified_at: Date.now() - 100000,
        last_export_at: Date.now() - 100000,
        sync_direction: 'export',
        sync_status: 'synced',
        ...overrides,
      };
    }

    function setupApiClient(overrides = {}) {
      service.apiConnected = true;
      service.apiClient = {
        listBooks: vi
          .fn()
          .mockResolvedValue([{ id: 1, slug: bookSlug, name: 'Vibesync Docs' }]),
        getBookContents: vi.fn().mockResolvedValue({
          chapters: [],
          pages: [{ id: 100, slug: 'test-page', name: 'Test Page' }],
        }),
        getPage: vi.fn().mockResolvedValue({
          id: 100,
          slug: 'test-page',
          name: 'Test Page',
          markdown: oldContent,
          updated_at: '2026-01-28T00:00:00Z',
          revision_count: 5,
        }),
        updatePage: vi.fn().mockResolvedValue({ id: 100, slug: 'test-page' }),
        createPage: vi.fn().mockResolvedValue({
          id: 200,
          slug: 'new-page',
          name: 'New Page',
          updated_at: '2026-01-29T00:00:00Z',
          revision_count: 1,
        }),
        createChapter: vi.fn().mockResolvedValue({ id: 20, name: 'New Chapter' }),
        listPagesByBook: vi.fn().mockResolvedValue([]),
        ...overrides,
      };
    }

    describe('setup and guard tests', () => {
      it('skips when no mapping', async () => {
        const result = await service.syncBidirectional('UNKNOWN', projectPath);
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('no_mapping');
      });

      it('skips when API not connected', async () => {
        service.apiConnected = false;
        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('api_not_connected');
      });

      it('skips when book not found in API', async () => {
        setupApiClient({ listBooks: vi.fn().mockResolvedValue([]) });
        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('book_not_found');
      });
    });

    describe('decision matrix', () => {
      it('no-op when neither local nor remote changed', async () => {
        setupApiClient();
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(oldContent);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.unchanged).toBe(1);
        expect(result.exported).toBe(0);
        expect(result.imported).toBe(0);
        expect(result.conflicts).toBe(0);
      });

      it('exports (overwrites local) when only remote changed', async () => {
        setupApiClient({
          getPage: vi.fn().mockResolvedValue({
            id: 100,
            slug: 'test-page',
            name: 'Test Page',
            markdown: newRemoteContent,
            updated_at: '2026-01-29T00:00:00Z',
            revision_count: 6,
          }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(oldContent);
        fs.writeFileSync.mockReturnValue(undefined);
        fs.mkdirSync.mockReturnValue(undefined);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.exported).toBe(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
          expect.stringContaining('test-page.md'),
          newRemoteContent,
          'utf-8'
        );
        expect(db.upsertBookStackPage).toHaveBeenCalledWith(
          expect.objectContaining({
            content_hash: newRemoteHash,
            bookstack_content_hash: newRemoteHash,
            sync_direction: 'export',
          })
        );
      });

      it('imports (pushes to BookStack) when only local changed', async () => {
        setupApiClient();
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(newLocalContent);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.imported).toBe(1);
        expect(service.apiClient.updatePage).toHaveBeenCalledWith(100, {
          markdown: newLocalContent,
        });
        expect(db.upsertBookStackPage).toHaveBeenCalledWith(
          expect.objectContaining({
            content_hash: newLocalHash,
            bookstack_content_hash: newLocalHash,
            sync_direction: 'import',
          })
        );
      });

      it('resolves conflict with BookStack wins when both changed', async () => {
        const { logger } = await import('../../src/logger.js');
        setupApiClient({
          getPage: vi.fn().mockResolvedValue({
            id: 100,
            slug: 'test-page',
            name: 'Test Page',
            markdown: newRemoteContent,
            updated_at: '2026-01-29T00:00:00Z',
            revision_count: 6,
          }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(newLocalContent);
        fs.writeFileSync.mockReturnValue(undefined);
        fs.mkdirSync.mockReturnValue(undefined);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.conflicts).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ pageId: 100 }),
          expect.stringContaining('Conflict detected')
        );
        expect(fs.writeFileSync).toHaveBeenCalledWith(
          expect.stringContaining('test-page.md'),
          newRemoteContent,
          'utf-8'
        );
        expect(db.upsertBookStackPage).toHaveBeenCalledWith(
          expect.objectContaining({
            content_hash: newRemoteHash,
            sync_direction: 'export',
          })
        );
      });

      it('re-exports from BookStack when local deleted and remote changed', async () => {
        setupApiClient({
          getPage: vi.fn().mockResolvedValue({
            id: 100,
            slug: 'test-page',
            name: 'Test Page',
            markdown: newRemoteContent,
            updated_at: '2026-01-29T00:00:00Z',
            revision_count: 6,
          }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(false);
        fs.writeFileSync.mockReturnValue(undefined);
        fs.mkdirSync.mockReturnValue(undefined);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.exported).toBe(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
          expect.any(String),
          newRemoteContent,
          'utf-8'
        );
      });

      it('warns and counts unchanged when local deleted and remote unchanged', async () => {
        const { logger } = await import('../../src/logger.js');
        setupApiClient();
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(false);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.unchanged).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ pageId: 100 }),
          expect.stringContaining('not deleting from BookStack')
        );
      });
    });

    describe('remote deletion', () => {
      it('removes local file and marks deleted_remote when page gone from BookStack', async () => {
        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({ chapters: [], pages: [] }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockImplementation(p => {
          if (typeof p === 'string' && p.includes('test-page.md')) return true;
          if (typeof p === 'string' && p.includes(bookSlug)) return false;
          return false;
        });
        fs.unlinkSync.mockReturnValue(undefined);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.remoteDeleted).toBe(1);
        expect(fs.unlinkSync).toHaveBeenCalled();
        expect(db.upsertBookStackPage).toHaveBeenCalledWith(
          expect.objectContaining({
            sync_status: 'deleted_remote',
          })
        );
      });

      it('handles case where local file already gone for deleted remote page', async () => {
        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({ chapters: [], pages: [] }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(false);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.remoteDeleted).toBe(1);
        expect(fs.unlinkSync).not.toHaveBeenCalled();
        expect(db.upsertBookStackPage).toHaveBeenCalledWith(
          expect.objectContaining({
            sync_status: 'deleted_remote',
          })
        );
      });
    });

    describe('new local files', () => {
      it('detects untracked local .md files and imports them to BookStack', async () => {
        setupApiClient();
        db.getBookStackPages.mockReturnValue([]);
        fs.existsSync.mockReturnValue(true);
        fs.readdirSync.mockReturnValue([
          { name: 'new-page.md', isFile: () => true, isDirectory: () => false },
        ]);
        fs.readFileSync.mockReturnValue('# New Page\n\nFresh content');

        service.importPage = vi.fn().mockResolvedValue({ success: true });

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.newLocal).toBe(1);
        expect(service.importPage).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            type: 'create',
            title: 'New Page',
          })
        );
      });

      it('skips untracked local files without # Title heading', async () => {
        const { logger } = await import('../../src/logger.js');
        setupApiClient();
        db.getBookStackPages.mockReturnValue([]);
        fs.existsSync.mockReturnValue(true);
        fs.readdirSync.mockReturnValue([
          { name: 'no-title.md', isFile: () => true, isDirectory: () => false },
        ]);
        fs.readFileSync.mockReturnValue('Just some content without a heading');

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.newLocal).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ file: expect.any(String) }),
          expect.stringContaining('no # Title heading')
        );
      });
    });

    describe('integration scenarios', () => {
      it('processes mixed scenario with multiple page states', async () => {
        const unchangedTracked = makeTrackedPage({ bookstack_page_id: 100, slug: 'unchanged' });
        const remoteChangedTracked = makeTrackedPage({
          bookstack_page_id: 101,
          slug: 'remote-changed',
          local_path: `${bookSlug}/remote-changed.md`,
        });
        const localChangedTracked = makeTrackedPage({
          bookstack_page_id: 102,
          slug: 'local-changed',
          local_path: `${bookSlug}/local-changed.md`,
        });
        const bothChangedTracked = makeTrackedPage({
          bookstack_page_id: 103,
          slug: 'both-changed',
          local_path: `${bookSlug}/both-changed.md`,
        });
        const deletedRemoteTracked = makeTrackedPage({
          bookstack_page_id: 104,
          slug: 'deleted-remote',
          local_path: `${bookSlug}/deleted-remote.md`,
        });

        const remotePages = [
          { id: 100, slug: 'unchanged', name: 'Unchanged' },
          { id: 101, slug: 'remote-changed', name: 'Remote Changed' },
          { id: 102, slug: 'local-changed', name: 'Local Changed' },
          { id: 103, slug: 'both-changed', name: 'Both Changed' },
        ];

        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({ chapters: [], pages: remotePages }),
          getPage: vi.fn().mockImplementation(async id => {
            const base = { updated_at: '2026-01-29T00:00:00Z', revision_count: 6 };
            if (id === 100)
              return { id, slug: 'unchanged', name: 'Unchanged', markdown: oldContent, ...base };
            if (id === 101)
              return {
                id,
                slug: 'remote-changed',
                name: 'Remote Changed',
                markdown: newRemoteContent,
                ...base,
              };
            if (id === 102)
              return {
                id,
                slug: 'local-changed',
                name: 'Local Changed',
                markdown: oldContent,
                ...base,
              };
            if (id === 103)
              return {
                id,
                slug: 'both-changed',
                name: 'Both Changed',
                markdown: newRemoteContent,
                ...base,
              };
            return { id, slug: 'unknown', name: 'Unknown', markdown: '', ...base };
          }),
        });

        db.getBookStackPages.mockReturnValue([
          unchangedTracked,
          remoteChangedTracked,
          localChangedTracked,
          bothChangedTracked,
          deletedRemoteTracked,
        ]);

        fs.existsSync.mockImplementation(p => {
          if (typeof p === 'string' && p.endsWith('.md')) return true;
          return false;
        });
        fs.readFileSync.mockImplementation(p => {
          if (typeof p === 'string' && p.includes('local-changed')) return newLocalContent;
          if (typeof p === 'string' && p.includes('both-changed')) return newLocalContent;
          return oldContent;
        });
        fs.writeFileSync.mockReturnValue(undefined);
        fs.mkdirSync.mockReturnValue(undefined);
        fs.unlinkSync.mockReturnValue(undefined);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.unchanged).toBe(1);
        expect(result.exported).toBe(1);
        expect(result.imported).toBe(1);
        expect(result.conflicts).toBe(1);
        expect(result.remoteDeleted).toBe(1);
      });

      it('returns correct result counts structure', async () => {
        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({ chapters: [], pages: [] }),
        });
        db.getBookStackPages.mockReturnValue([]);
        fs.existsSync.mockReturnValue(false);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result).toHaveProperty('exported');
        expect(result).toHaveProperty('imported');
        expect(result).toHaveProperty('conflicts');
        expect(result).toHaveProperty('remoteDeleted');
        expect(result).toHaveProperty('newLocal');
        expect(result).toHaveProperty('unchanged');
        expect(result).toHaveProperty('errors');
        expect(result).toHaveProperty('success');
      });

      it('updates stats counters for conflicts', async () => {
        setupApiClient({
          getPage: vi.fn().mockResolvedValue({
            id: 100,
            slug: 'test-page',
            name: 'Test Page',
            markdown: newRemoteContent,
            updated_at: '2026-01-29T00:00:00Z',
            revision_count: 6,
          }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(newLocalContent);
        fs.writeFileSync.mockReturnValue(undefined);
        fs.mkdirSync.mockReturnValue(undefined);

        await service.syncBidirectional(projectId, projectPath);
        expect(service.stats.conflictsDetected).toBe(1);
        expect(service.stats.conflictsResolved).toBe(1);
        expect(service.stats.bidirectionalSyncs).toBe(1);
      });

      it('updates stats counters for remote deletions', async () => {
        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({ chapters: [], pages: [] }),
        });
        const tracked = makeTrackedPage();
        db.getBookStackPages.mockReturnValue([tracked]);
        fs.existsSync.mockReturnValue(false);

        await service.syncBidirectional(projectId, projectPath);
        expect(service.stats.remoteDeleted).toBe(1);
        expect(service.stats.bidirectionalSyncs).toBe(1);
      });

      it('handles API errors gracefully and continues processing', async () => {
        const okTracked = makeTrackedPage({ bookstack_page_id: 100 });
        const errTracked = makeTrackedPage({
          bookstack_page_id: 101,
          slug: 'error-page',
          local_path: `${bookSlug}/error-page.md`,
        });

        setupApiClient({
          getBookContents: vi.fn().mockResolvedValue({
            chapters: [],
            pages: [
              { id: 101, slug: 'error-page', name: 'Error Page' },
              { id: 100, slug: 'test-page', name: 'Test Page' },
            ],
          }),
          getPage: vi.fn().mockImplementation(async id => {
            if (id === 101) throw new Error('API timeout');
            return {
              id: 100,
              slug: 'test-page',
              name: 'Test Page',
              markdown: oldContent,
              updated_at: '2026-01-28T00:00:00Z',
              revision_count: 5,
            };
          }),
        });

        db.getBookStackPages.mockReturnValue([okTracked, errTracked]);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(oldContent);

        const result = await service.syncBidirectional(projectId, projectPath);
        expect(result.errors).toBe(1);
        expect(result.unchanged).toBe(1);
      });
    });
  });

  describe('_flattenBookPages', () => {
    it('flattens chapters with pages and standalone pages', () => {
      const contents = {
        chapters: [
          {
            id: 1,
            slug: 'chapter-one',
            pages: [
              { id: 10, slug: 'ch1-page1' },
              { id: 11, slug: 'ch1-page2' },
            ],
          },
          {
            id: 2,
            slug: 'chapter-two',
            pages: [{ id: 20, slug: 'ch2-page1' }],
          },
        ],
        pages: [
          { id: 30, slug: 'standalone1' },
          { id: 31, slug: 'standalone2' },
        ],
      };

      const result = service._flattenBookPages(contents);
      expect(result).toHaveLength(5);
      expect(result.map(p => p.id)).toEqual([10, 11, 20, 30, 31]);
    });

    it('handles empty chapters and no standalone pages', () => {
      const contents = {
        chapters: [
          { id: 1, slug: 'empty-chapter', pages: [] },
          { id: 2, slug: 'no-pages' },
        ],
        pages: [],
      };

      const result = service._flattenBookPages(contents);
      expect(result).toHaveLength(0);
    });
  });

  describe('getHealthInfo bidirectional fields', () => {
    it('includes bidirectional sync fields', () => {
      service.stats.conflictsDetected = 3;
      service.stats.conflictsResolved = 3;
      service.stats.remoteDeleted = 2;
      service.stats.bidirectionalSyncs = 5;

      const health = service.getHealthInfo();
      expect(health.conflictsDetected).toBe(3);
      expect(health.conflictsResolved).toBe(3);
      expect(health.remoteDeleted).toBe(2);
      expect(health.bidirectionalSyncs).toBe(5);
    });

    it('defaults bidirectional fields to zero', () => {
      const health = service.getHealthInfo();
      expect(health.conflictsDetected).toBe(0);
      expect(health.conflictsResolved).toBe(0);
      expect(health.remoteDeleted).toBe(0);
      expect(health.bidirectionalSyncs).toBe(0);
    });
  });
});
