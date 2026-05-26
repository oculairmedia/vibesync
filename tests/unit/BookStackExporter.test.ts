import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));
vi.mock('crypto', () => ({
  default: {
    createHash: vi.fn(),
  },
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

const { BookStackExporter, createBookStackExporter } = await import(
  '../../src/BookStackExporter.js'
);
const { execSync } = await import('child_process');
const fs = (await import('fs')).default;
const crypto = (await import('crypto')).default;
const { logger } = await import('../../src/logger.js');
const { recordApiLatency } = await import('../../src/HealthService.js');

function createTestConfig(overrides = {}) {
  return {
    exporterOutputPath: '/tmp/bookstack-exports',
    docsSubdir: 'docs/bookstack',
    ...overrides,
  };
}

function makeDirent(name, isDir = false) {
  return { name, isDirectory: () => isDir };
}

function setupHashMock(hexValue = 'abc123') {
  const hashObj = {
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue(hexValue),
  };
  crypto.createHash.mockReturnValue(hashObj);
  return hashObj;
}

describe('BookStackExporter', () => {
  let exporter;
  let config;

  beforeEach(() => {
    vi.resetAllMocks();
    config = createTestConfig();
    exporter = new BookStackExporter(config);
  });

  describe('constructor', () => {
    it('stores config and exporterOutputPath', () => {
      expect(exporter.config).toBe(config);
      expect(exporter.exporterOutputPath).toBe('/tmp/bookstack-exports');
    });

    it('initializes stats with defaults', () => {
      expect(exporter.stats).toEqual({
        lastExportAt: null,
        lastExportDuration: null,
        totalExports: 0,
        errors: 0,
      });
    });
  });

  describe('getLatestArchive', () => {
    it('returns null when output directory does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      expect(exporter.getLatestArchive()).toBeNull();
    });

    it('returns null when directory is empty', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
      expect(exporter.getLatestArchive()).toBeNull();
    });

    it('returns null when no matching archive files exist', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['random.txt', 'other.tgz', 'bookstack_export_nope.zip']);
      expect(exporter.getLatestArchive()).toBeNull();
    });

    it('returns the single matching archive', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['bookstack_export_2026-01-01.tgz']);
      const result = exporter.getLatestArchive();
      expect(result).toBe('/tmp/bookstack-exports/bookstack_export_2026-01-01.tgz');
    });

    it('returns the latest archive when multiple exist (sorted reverse)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([
        'bookstack_export_2026-01-01.tgz',
        'bookstack_export_2026-01-03.tgz',
        'bookstack_export_2026-01-02.tgz',
      ]);
      const result = exporter.getLatestArchive();
      expect(result).toBe('/tmp/bookstack-exports/bookstack_export_2026-01-03.tgz');
    });
  });

  describe('extractArchive', () => {
    it('creates output directory and extracts archive on success', () => {
      execSync.mockReturnValue(Buffer.from(''));
      const result = exporter.extractArchive('/path/to/archive.tgz', '/tmp/output');
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/output', { recursive: true });
      expect(execSync).toHaveBeenCalledWith('tar -xzf "/path/to/archive.tgz" -C "/tmp/output"', {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      expect(result).toBe(true);
    });

    it('returns false and logs error when execSync throws', () => {
      execSync.mockImplementation(() => {
        throw new Error('tar failed');
      });
      const result = exporter.extractArchive('/bad/archive.tgz', '/tmp/output');
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ archive: '/bad/archive.tgz' }),
        'Failed to extract BookStack archive'
      );
    });
  });

  describe('exportToProject', () => {
    it('returns no_archive when no archive exists', async () => {
      fs.existsSync.mockReturnValue(false);
      const result = await exporter.exportToProject('/project', 'my-book');
      expect(result).toEqual({ success: false, reason: 'no_archive' });
      expect(logger.debug).toHaveBeenCalledWith('No BookStack export archive found');
    });

    it('returns extract_failed when extraction fails', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['bookstack_export_2026.tgz']);
      execSync.mockImplementation(() => {
        throw new Error('tar failed');
      });

      const result = await exporter.exportToProject('/project', 'my-book');
      expect(result).toEqual({ success: false, reason: 'extract_failed' });
    });

    it('returns book_not_found when book slug is not in archive', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync
        .mockReturnValueOnce(['bookstack_export_2026.tgz'])
        .mockReturnValueOnce([makeDirent('other-book', true)])
        .mockReturnValueOnce([]);

      execSync.mockReturnValue(Buffer.from(''));

      const result = await exporter.exportToProject('/project', 'my-book');
      expect(result).toEqual({ success: false, reason: 'book_not_found' });
      expect(logger.debug).toHaveBeenCalledWith(
        { bookSlug: 'my-book' },
        'Book not found in export archive'
      );
    });

    it('returns success with pages on full successful flow', async () => {
      // getLatestArchive
      fs.existsSync
        .mockReturnValueOnce(true) // exporterOutputPath exists
        .mockReturnValueOnce(false); // targetPath does not exist (shouldWrite = true)

      fs.readdirSync
        .mockReturnValueOnce(['bookstack_export_2026.tgz']) // getLatestArchive
        .mockReturnValueOnce([makeDirent('my-book', true)]) // findBookDir root level
        .mockReturnValueOnce([makeDirent('page.md', false)]); // walkAndSync entries

      execSync.mockReturnValue(Buffer.from(''));

      const sourceContent = Buffer.from('# Hello');
      fs.readFileSync.mockReturnValue(sourceContent);
      fs.existsSync
        .mockReturnValueOnce(false) // target file doesn't exist
        .mockReturnValueOnce(false); // meta file doesn't exist

      setupHashMock('abc123hash');

      const result = await exporter.exportToProject('/project', 'my-book');
      expect(result.success).toBe(true);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].relativePath).toBe('page.md');
      expect(result.pages[0].modified).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'export', expect.any(Number));
      expect(exporter.stats.totalExports).toBe(1);
      expect(exporter.stats.lastExportAt).not.toBeNull();
    });

    it('increments errors and records latency when exception is thrown', async () => {
      vi.spyOn(exporter, 'getLatestArchive').mockImplementation(() => {
        throw new Error('unexpected disk error');
      });

      const result = await exporter.exportToProject('/project', 'my-book');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('error');
      expect(result.error).toBe('unexpected disk error');
      expect(exporter.stats.errors).toBe(1);
      expect(recordApiLatency).toHaveBeenCalledWith('bookstack', 'export', expect.any(Number));
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ bookSlug: 'my-book' }),
        'BookStack export failed'
      );
    });
  });

  describe('findBookDir', () => {
    it('finds exact match at root level', () => {
      fs.readdirSync.mockReturnValue([makeDirent('other-book', true), makeDirent('my-book', true)]);
      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBe('/extract/my-book');
    });

    it('finds nested match within subdirectory', () => {
      // Root level - no match, one subdir to search
      fs.readdirSync
        .mockReturnValueOnce([makeDirent('level1', true)])
        .mockReturnValueOnce([makeDirent('my-book', true)]);

      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBe('/extract/level1/my-book');
    });

    it('returns null when depth exceeds 3', () => {
      // Create dirs that never match, going 4+ levels deep
      const dirEntry = [makeDirent('subdir', true)];
      fs.readdirSync.mockReturnValue(dirEntry);

      // After 4 levels of recursion, depth > 3 triggers null
      const result = exporter.findBookDir('/extract', 'nonexistent-book');
      // It will recurse but hit depth limit
      expect(result).toBeNull();
    });

    it('uses normalized slug matching (ignores special chars)', () => {
      fs.readdirSync.mockReturnValue([makeDirent('My-Book!', true)]);
      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBe('/extract/My-Book!');
    });

    it('returns null when no match found', () => {
      fs.readdirSync.mockReturnValue([makeDirent('file.txt', false), makeDirent('.hidden', true)]);
      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBeNull();
    });

    it('skips hidden directories when recursing', () => {
      fs.readdirSync.mockReturnValue([makeDirent('.git', true), makeDirent('file.txt', false)]);
      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBeNull();
      // Should not recurse into .git
      expect(fs.readdirSync).toHaveBeenCalledTimes(1);
    });

    it('skips non-directory entries in first pass', () => {
      fs.readdirSync.mockReturnValue([
        makeDirent('my-book', false), // file, not dir
      ]);
      const result = exporter.findBookDir('/extract', 'my-book');
      expect(result).toBeNull();
    });
  });

  describe('syncDirectory', () => {
    it('returns pages array from walkAndSync', () => {
      fs.readdirSync.mockReturnValue([]);
      const pages = exporter.syncDirectory('/source', '/target');
      expect(pages).toEqual([]);
    });
  });

  describe('walkAndSync', () => {
    it('creates directory and recurses for directory entries', () => {
      fs.readdirSync.mockReturnValueOnce([makeDirent('subdir', true)]).mockReturnValueOnce([]); // empty subdir

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(fs.mkdirSync).toHaveBeenCalledWith('/target/subdir', { recursive: true });
      expect(pages).toEqual([]);
    });

    it('writes new file when target does not exist', () => {
      const content = Buffer.from('# Page content');
      fs.readdirSync.mockReturnValue([makeDirent('page.md', false)]);
      fs.readFileSync.mockReturnValue(content);
      fs.existsSync
        .mockReturnValueOnce(false) // target doesn't exist
        .mockReturnValueOnce(false); // no meta file
      setupHashMock('newhash');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(fs.writeFileSync).toHaveBeenCalledWith('/target/page.md', content);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toEqual({
        relativePath: 'page.md',
        contentHash: 'newhash',
        modified: true,
        meta: null,
      });
    });

    it('skips write when content hash matches existing file', () => {
      const content = Buffer.from('same content');
      fs.readdirSync.mockReturnValue([makeDirent('page.md', false)]);
      fs.readFileSync.mockReturnValue(content);
      fs.existsSync
        .mockReturnValueOnce(true) // target exists
        .mockReturnValueOnce(false); // no meta file
      setupHashMock('samehash');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(pages[0].modified).toBe(false);
    });

    it('writes file when content hash differs from existing', () => {
      const sourceContent = Buffer.from('new content');
      const existingContent = Buffer.from('old content');
      fs.readdirSync.mockReturnValue([makeDirent('page.md', false)]);
      fs.readFileSync.mockReturnValueOnce(sourceContent).mockReturnValueOnce(existingContent);
      fs.existsSync
        .mockReturnValueOnce(true) // target exists
        .mockReturnValueOnce(false); // no meta file

      // Different hashes for source vs existing
      const hashObj = { update: vi.fn().mockReturnThis(), digest: vi.fn() };
      hashObj.digest.mockReturnValueOnce('sourcehash').mockReturnValueOnce('existinghash');
      crypto.createHash.mockReturnValue(hashObj);

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(fs.writeFileSync).toHaveBeenCalledWith('/target/page.md', sourceContent);
      expect(pages[0].modified).toBe(true);
    });

    it('parses meta JSON for .md files when meta file exists', () => {
      const content = Buffer.from('# Content');
      const metaData = { title: 'My Page', id: 42 };
      fs.readdirSync.mockReturnValue([makeDirent('page.md', false)]);
      fs.readFileSync
        .mockReturnValueOnce(content) // source content
        .mockReturnValueOnce(JSON.stringify(metaData)); // meta file
      fs.existsSync
        .mockReturnValueOnce(false) // target doesn't exist
        .mockReturnValueOnce(true); // meta file exists
      setupHashMock('hash1');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(pages[0].meta).toEqual(metaData);
    });

    it('handles .html files as pages', () => {
      const content = Buffer.from('<h1>Hello</h1>');
      fs.readdirSync.mockReturnValue([makeDirent('page.html', false)]);
      fs.readFileSync.mockReturnValue(content);
      fs.existsSync.mockReturnValue(false);
      setupHashMock('htmlhash');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(pages).toHaveLength(1);
      expect(pages[0].relativePath).toBe('page.html');
    });

    it('handles .txt files as pages', () => {
      const content = Buffer.from('plain text');
      fs.readdirSync.mockReturnValue([makeDirent('readme.txt', false)]);
      fs.readFileSync.mockReturnValue(content);
      fs.existsSync.mockReturnValue(false);
      setupHashMock('txthash');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(pages).toHaveLength(1);
      expect(pages[0].relativePath).toBe('readme.txt');
    });

    it('does not add non-page files to pages array', () => {
      const content = Buffer.from('image data');
      fs.readdirSync.mockReturnValue([makeDirent('image.png', false)]);
      fs.readFileSync.mockReturnValue(content);
      fs.existsSync.mockReturnValue(false);
      setupHashMock('imghash');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(pages).toHaveLength(0);
      // But file should still be written
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('handles meta parse failure gracefully', () => {
      const content = Buffer.from('# Content');
      fs.readdirSync.mockReturnValue([makeDirent('page.md', false)]);
      fs.readFileSync
        .mockReturnValueOnce(content) // source
        .mockReturnValueOnce('not valid json'); // bad meta
      fs.existsSync
        .mockReturnValueOnce(false) // target doesn't exist
        .mockReturnValueOnce(true); // meta file exists
      setupHashMock('hash1');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      expect(pages[0].meta).toBeNull();
    });

    it('creates parent directory for target file', () => {
      fs.readdirSync.mockReturnValue([makeDirent('file.dat', false)]);
      fs.readFileSync.mockReturnValue(Buffer.from('data'));
      fs.existsSync.mockReturnValue(false);
      setupHashMock('h');

      const pages = [];
      exporter.walkAndSync('/source', '/target', '/source', pages);

      // mkdirSync should be called for the target parent dir
      expect(fs.mkdirSync).toHaveBeenCalledWith('/target', { recursive: true });
    });
  });

  describe('cleanup', () => {
    it('removes directory recursively', () => {
      exporter.cleanup('/tmp/dir');
      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/dir', { recursive: true, force: true });
    });

    it('does not throw when rmSync fails', () => {
      fs.rmSync.mockImplementation(() => {
        throw new Error('permission denied');
      });
      expect(() => exporter.cleanup('/tmp/dir')).not.toThrow();
    });
  });

  describe('getStats', () => {
    it('returns a copy of stats', () => {
      const stats = exporter.getStats();
      expect(stats).toEqual({
        lastExportAt: null,
        lastExportDuration: null,
        totalExports: 0,
        errors: 0,
      });
      // Verify it's a copy
      stats.totalExports = 999;
      expect(exporter.stats.totalExports).toBe(0);
    });
  });

  describe('createBookStackExporter', () => {
    it('returns a BookStackExporter instance', () => {
      const exp = createBookStackExporter(config);
      expect(exp).toBeInstanceOf(BookStackExporter);
      expect(exp.exporterOutputPath).toBe('/tmp/bookstack-exports');
    });
  });
});
