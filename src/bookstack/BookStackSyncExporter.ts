import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';

export function createExportMethods(service: Record<string, unknown>) {
  return {
    syncExportViaApi: syncExportViaApi.bind(service),
    syncExportViaArchive: syncExportViaArchive.bind(service),
    _flattenBookPages: _flattenBookPages.bind(service),
    _exportRemotePage: _exportRemotePage.bind(service),
  };
}

export async function syncExportViaApi(
  this: Record<string, unknown>,
  projectIdentifier: string,
  projectPath: string,
  bookSlug: string,
): Promise<Record<string, unknown>> {
  const startTime = Date.now();

  try {
    const apiClient = this.apiClient as {
      listBooks: () => Promise<Array<{ id: number; slug: string; name: string; updated_at?: string }>>;
      getBookContents: (id: number) => Promise<{
        chapters: { data: Array<{ id: number; slug: string; name: string; description?: string }> };
        pages: { data: Array<{ id: number; slug: string; name: string; chapter_id?: number; updated_at?: string }> };
      }>;
      exportPageMarkdown: (id: number) => Promise<unknown>;
    };
    const db = this.db as {
      upsertBookStackPage: (d: Record<string, unknown>) => void;
      setBookStackLastExport: (p: string, ts: number) => void;
    };
    const stats = this.stats as Record<string, number>;
    const config = this.config as { docsSubdir: string };

    const books = await apiClient.listBooks();
    const book = books.find(
      (b) => b.slug === bookSlug || b.name.toLowerCase().replace(/\s+/g, '-') === bookSlug,
    );

    if (!book) {
      logger.debug({ bookSlug, available: books.map((b) => b.slug).slice(0, 10) }, 'Book not found');
      return { success: false, reason: 'book_not_found' };
    }

    const contents = await apiClient.getBookContents(book.id);
    const docsDir = path.join(projectPath, config.docsSubdir, bookSlug);
    fs.mkdirSync(docsDir, { recursive: true });

    const bookMeta = { id: book.id, name: book.name, slug: book.slug, description: (book as { description?: string }).description, updated_at: book.updated_at };
    fs.writeFileSync(path.join(docsDir, '.book-metadata.json'), JSON.stringify(bookMeta, null, 2));

    const chapterMap = new Map<number, { id: number; slug: string; name: string; description?: string }>();
    for (const chapter of contents.chapters.data) {
      chapterMap.set(chapter.id, chapter);
      const chapterDir = path.join(docsDir, chapter.slug);
      fs.mkdirSync(chapterDir, { recursive: true });
      fs.writeFileSync(path.join(chapterDir, '.chapter-metadata.json'), JSON.stringify({ id: chapter.id, name: chapter.name, slug: chapter.slug, description: chapter.description }, null, 2));
    }

    const exportedPages: Array<Record<string, unknown>> = [];

    for (const page of contents.pages.data) {
      try {
        const markdown = String(await apiClient.exportPageMarkdown(page.id));
        const chapter = page.chapter_id ? chapterMap.get(page.chapter_id) ?? null : null;
        const pageDir = chapter ? path.join(docsDir, chapter.slug) : docsDir;
        const filePath = path.join(pageDir, `${page.slug}.md`);
        const contentHash = crypto.createHash('sha256').update(markdown).digest('hex');

        let shouldWrite = true;
        if (fs.existsSync(filePath)) {
          const existing = fs.readFileSync(filePath, 'utf-8');
          shouldWrite = contentHash !== crypto.createHash('sha256').update(existing).digest('hex');
        }

        if (shouldWrite) fs.writeFileSync(filePath, markdown, 'utf-8');

        const relativePath = path.relative(path.join(projectPath, config.docsSubdir), filePath);

        db.upsertBookStackPage({
          bookstack_page_id: page.id, bookstack_book_id: book.id,
          bookstack_chapter_id: page.chapter_id || null, project_identifier: projectIdentifier,
          slug: page.slug, title: page.name, local_path: relativePath,
          content_hash: contentHash, bookstack_modified_at: page.updated_at,
          local_modified_at: Date.now(), last_export_at: Date.now(), sync_direction: 'export',
        });
        stats.pagesTracked!++;

        exportedPages.push({ relativePath, contentHash, modified: shouldWrite,
          meta: { id: page.id, book_id: book.id, chapter_id: page.chapter_id, name: page.name, updated_at: page.updated_at } });
      } catch (pageError) {
        logger.warn({ err: pageError, pageId: page.id, pageSlug: page.slug }, 'Failed to export page');
      }
    }

    const duration = Date.now() - startTime;
    db.setBookStackLastExport(projectIdentifier, Date.now());
    stats.exportsCompleted!++;
    stats.apiExports!++;

    logger.info({ bookSlug, bookId: book.id, totalPages: contents.pages.data.length, chapters: contents.chapters.data.length, exported: exportedPages.length, modified: exportedPages.filter((p) => p.modified).length, durationMs: duration }, 'BookStack API export completed');

    return { success: true, pages: exportedPages, duration, method: 'api' };
  } catch (error) {
    const stats = this.stats as Record<string, number>;
    stats.exportsFailed!++;
    logger.error({ err: error, bookSlug }, 'BookStack API export failed');
    return { success: false, reason: 'api_error', error: (error as Error).message };
  }
}

export async function syncExportViaArchive(
  this: Record<string, unknown>,
  projectIdentifier: string,
  projectPath: string,
  bookSlug: string,
): Promise<Record<string, unknown>> {
  const exporter = this.exporter as { exportToProject: (p: string, b: string) => Promise<{ success: boolean; pages?: Array<{ relativePath: string; contentHash: string; modified: boolean; meta: Record<string, unknown> | null }>; duration?: number; error?: string }> };
  const db = this.db as { upsertBookStackPage: (d: Record<string, unknown>) => void; setBookStackLastExport: (p: string, ts: number) => void };
  const stats = this.stats as Record<string, number>;
  const result = await exporter.exportToProject(projectPath, bookSlug);

  if (result.success) {
    db.setBookStackLastExport(projectIdentifier, Date.now());
    stats.exportsCompleted!++;
    stats.archiverExports!++;

    for (const page of result.pages || []) {
      const pageData = {
        bookstack_page_id: page.meta?.id || 0, bookstack_book_id: page.meta?.book_id || 0,
        bookstack_chapter_id: page.meta?.chapter_id || null, project_identifier: projectIdentifier,
        slug: path.basename(page.relativePath, path.extname(page.relativePath)),
        title: page.meta?.name || path.basename(page.relativePath, path.extname(page.relativePath)),
        local_path: page.relativePath, content_hash: page.contentHash,
        bookstack_modified_at: page.meta?.updated_at || null,
        local_modified_at: Date.now(), last_export_at: Date.now(), sync_direction: 'export',
      };
      if (pageData.bookstack_page_id) {
        db.upsertBookStackPage(pageData);
        stats.pagesTracked!++;
      }
    }
  } else {
    stats.exportsFailed!++;
  }

  return { ...result, method: 'archive' };
}

type BookContents = {
  chapters?: { data?: Array<{ pages?: unknown[] }> } | Array<{ pages?: unknown[] }>;
  pages?: { data?: unknown[] } | unknown[];
};

function getChapters(contents: BookContents): Array<{ pages?: unknown[] }> {
  if (Array.isArray(contents.chapters)) return contents.chapters;
  return contents.chapters?.data ?? [];
}

function getStandalonePages(contents: BookContents): unknown[] {
  if (Array.isArray(contents.pages)) return contents.pages;
  return contents.pages?.data ?? [];
}

export function _flattenBookPages(contents: BookContents): unknown[] {
  const pages: unknown[] = [];
  for (const item of getChapters(contents)) {
    if (item.pages) pages.push(...item.pages);
  }
  for (const item of getStandalonePages(contents)) {
    pages.push(item);
  }
  return pages;
}

export async function _exportRemotePage(
  this: Record<string, unknown>,
  projectIdentifier: string,
  book: { id: number },
  remotePage: { id: number; chapter_id?: number | null },
  docsDir: string,
): Promise<void> {
  const apiClient = this.apiClient as { getPage: (id: number) => Promise<{ id: number; slug: string; name: string; markdown?: string; updated_at?: string; revision_count?: number }>; getBookContents: (id: number) => Promise<{ chapters: { data: Array<{ id: number; slug: string }> } }> };
  const db = this.db as { upsertBookStackPage: (d: Record<string, unknown>) => void };

  const detail = await apiClient.getPage(remotePage.id);
  const markdown = detail.markdown || '';
  const contentHash = crypto.createHash('sha256').update(markdown).digest('hex');

  let chapterSlug: string | null = null;
  if (remotePage.chapter_id) {
    const contents = await apiClient.getBookContents(book.id) as unknown as { chapters?: { data?: Array<{ id: number; slug: string }> } | Array<{ id: number; slug: string }> };
    const chapters = Array.isArray(contents.chapters) ? contents.chapters : (contents.chapters?.data ?? []);
    const ch = chapters.find((c) => c.id === remotePage.chapter_id);
    chapterSlug = ch?.slug ?? null;
  }

  const localDir = chapterSlug ? path.join(docsDir, chapterSlug) : docsDir;
  fs.mkdirSync(localDir, { recursive: true });
  const localFilePath = path.join(localDir, `${detail.slug}.md`);
  fs.writeFileSync(localFilePath, markdown, 'utf-8');

  const relFromDocsDir = path.relative(path.resolve(docsDir, '..'), localFilePath);

  db.upsertBookStackPage({
    bookstack_page_id: detail.id, bookstack_book_id: book.id,
    bookstack_chapter_id: remotePage.chapter_id || null, project_identifier: projectIdentifier,
    slug: detail.slug, title: detail.name, local_path: relFromDocsDir,
    content_hash: contentHash, bookstack_content_hash: contentHash,
    bookstack_modified_at: detail.updated_at, bookstack_revision_count: detail.revision_count,
    local_modified_at: Date.now(), last_export_at: Date.now(),
    sync_direction: 'export', sync_status: 'synced',
  });

  logger.info({ pageId: detail.id, slug: detail.slug, path: relFromDocsDir }, 'Exported new remote page to local');
}
