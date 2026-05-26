import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';

type BookContentsChapters = { chapters?: { data?: Array<{ id: number; slug: string }> } | Array<{ id: number; slug: string }> };

function getChapters(contents: BookContentsChapters): Array<{ id: number; slug: string }> {
  if (Array.isArray(contents.chapters)) return contents.chapters;
  return contents.chapters?.data ?? [];
}

export function createImportMethods(service: Record<string, unknown>) {
  return {
    detectLocalChanges: detectLocalChanges.bind(service),
    importPage: importPage.bind(service),
    importSingleFile: importSingleFile.bind(service),
    _walkMarkdownFiles: _walkMarkdownFiles.bind(service),
  };
}

export function detectLocalChanges(
  this: Record<string, unknown>,
  projectIdentifier: string,
  docsDir: string,
): unknown[] {
  const changes: unknown[] = [];
  const db = this.db as { getBookStackPages: (id: string) => Array<Record<string, unknown>> };
  const trackedPages = db.getBookStackPages(projectIdentifier);
  const pagesByPath = new Map(trackedPages.map((p) => [p.local_path, p]));

  const files = (_walkMarkdownFiles as (dir: string) => string[]).call(this, docsDir);
  const now = Date.now();

  for (const filePath of files) {
    const relFromDocsDir = path.relative(path.resolve(docsDir, '..'), filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const tracked = pagesByPath.get(relFromDocsDir) as Record<string, unknown> | undefined;

    if (tracked?.last_export_at && tracked.sync_direction === 'export') {
      const timeSinceExport = now - (tracked.last_export_at as number);
      if (timeSinceExport < 60000) continue;
    }

    if (tracked) {
      if (contentHash !== tracked.content_hash) {
        changes.push({ type: 'update', localPath: relFromDocsDir, absolutePath: filePath, contentHash, content, tracked });
      }
    } else {
      const titleMatch = content.match(/^#\s+(.+)$/m);
      if (!titleMatch) continue;
      changes.push({ type: 'create', localPath: relFromDocsDir, absolutePath: filePath, contentHash, content, title: titleMatch[1]!.trim() });
    }
  }

  return changes;
}

export async function importPage(
  this: Record<string, unknown>,
  projectIdentifier: string,
  change: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const apiClient = this.apiClient as { updatePage: (id: number, d: Record<string, unknown>) => Promise<{ id: number; slug: string; updated_at: string }>; createPage: (d: Record<string, unknown>) => Promise<{ id: number; slug: string; name: string; updated_at: string }>; listBooks: () => Promise<Array<{ id: number; slug: string; name: string }>>; getBookContents: (id: number) => Promise<{ chapters: { data: Array<{ id: number; slug: string }> } }>; createChapter: (d: { book_id: number; name: string }) => Promise<{ id: number; name: string }> };
  const db = this.db as { upsertBookStackPage: (d: Record<string, unknown>) => void };
  const getBookSlugForProject = (id: string): string | null => (this.getBookSlugForProject as (id: string) => string | null).call(this, id);

  if (change.type === 'update' && change.tracked) {
    const tracked = change.tracked as Record<string, unknown>;
    if (tracked.bookstack_page_id) {
      const result = await apiClient.updatePage(tracked.bookstack_page_id as number, { markdown: change.content as string });
      db.upsertBookStackPage({ ...tracked, content_hash: change.contentHash, local_modified_at: Date.now(), last_import_at: Date.now(), sync_direction: 'import' });
      logger.info({ pageId: result.id, slug: result.slug, path: change.localPath }, 'Updated page in BookStack');
      return { success: true, type: 'update', pageId: result.id, localPath: change.localPath };
    }
  }

  if (change.type === 'create') {
    const bookSlug = getBookSlugForProject(projectIdentifier);
    const books = await apiClient.listBooks();
    const book = books.find((b) => b.slug === bookSlug || b.name.toLowerCase().replace(/\s+/g, '-') === bookSlug);
    if (!book) return { success: false, localPath: change.localPath, error: 'book_not_found' };

    const pathParts = (change.localPath as string).split(path.sep);
    let chapterId: number | null = null;

    if (pathParts.length >= 3) {
      const chapterSlug = pathParts[pathParts.length - 2]!;
      if (chapterSlug !== bookSlug) {
        const contents = await apiClient.getBookContents(book.id);
        const chapter = getChapters(contents).find((c) => c.slug === chapterSlug);
        if (chapter) {
          chapterId = chapter.id;
        } else {
          const newChapter = await apiClient.createChapter({ book_id: book.id, name: chapterSlug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()) });
          chapterId = newChapter.id;
        }
      }
    }

    const createData: Record<string, unknown> = { name: change.title, markdown: change.content };
    if (chapterId) createData.chapter_id = chapterId;
    else createData.book_id = book.id;

    const result = await apiClient.createPage(createData);
    db.upsertBookStackPage({
      bookstack_page_id: result.id, bookstack_book_id: book.id,
      bookstack_chapter_id: chapterId, project_identifier: projectIdentifier,
      slug: result.slug, title: result.name, local_path: change.localPath,
      content_hash: change.contentHash, bookstack_modified_at: result.updated_at,
      local_modified_at: Date.now(), last_import_at: Date.now(), sync_direction: 'import',
    });
    return { success: true, type: 'create', pageId: result.id, localPath: change.localPath };
  }

  return { success: false, localPath: change.localPath, error: 'unknown_change_type' };
}

export async function importSingleFile(
  this: Record<string, unknown>,
  projectIdentifier: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const getBookSlugForProject = (id: string): string | null => (this.getBookSlugForProject as (id: string) => string | null).call(this, id);
  const apiConnected = this.apiConnected as boolean;
  const config = this.config as { docsSubdir: string };
  const db = this.db as { getBookStackPageByPath: (p: string) => Record<string, unknown> | null };

  const bookSlug = getBookSlugForProject(projectIdentifier);
  if (!bookSlug) return { skipped: true, reason: 'no_mapping' };
  if (!apiConnected) return { skipped: true, reason: 'api_not_connected' };
  if (!fs.existsSync(filePath) || !filePath.endsWith('.md')) return { skipped: true, reason: 'invalid_file' };

  const docsDir = path.join(path.dirname(filePath).split(config.docsSubdir)[0]!, config.docsSubdir);
  const relFromDocsDir = path.relative(path.resolve(docsDir), filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const tracked = db.getBookStackPageByPath(relFromDocsDir) as Record<string, unknown> | null;
  const now = Date.now();

  if (tracked?.last_export_at && tracked.sync_direction === 'export') {
    const timeSinceExport = now - (tracked.last_export_at as number);
    if (timeSinceExport < 60000) return { skipped: true, reason: 'echo_loop_guard', timeSinceExport };
  }

  if (tracked && contentHash === tracked.content_hash) return { skipped: true, reason: 'no_change' };

  const change = tracked
    ? { type: 'update', localPath: relFromDocsDir, absolutePath: filePath, contentHash, content, tracked }
    : (() => { const tm = content.match(/^#\s+(.+)$/m); return tm ? { type: 'create', localPath: relFromDocsDir, absolutePath: filePath, contentHash, content, title: tm[1]!.trim() } : null; })();

  if (!change) return { skipped: true, reason: 'no_title_heading' };
  return importPage.call(this, projectIdentifier, change as Record<string, unknown>);
}

export function _walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      results.push(..._walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}
