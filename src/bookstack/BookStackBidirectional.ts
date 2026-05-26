import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger';

export function createBidirectionalMethods(service: Record<string, unknown>) {
  return { syncBidirectional: syncBidirectional.bind(service) };
}

export async function syncBidirectional(
  this: Record<string, unknown>,
  projectIdentifier: string,
  projectPath: string,
): Promise<Record<string, unknown>> {
  const getBookSlugForProject = (id: string): string | null => (this.getBookSlugForProject as (id: string) => string | null).call(this, id);
  const apiConnected = this.apiConnected as boolean;
  const config = this.config as { docsSubdir: string };
  const db = this.db as {
    getBookStackPages: (id: string) => Array<Record<string, unknown>>;
    upsertBookStackPage: (d: Record<string, unknown>) => void;
  };
  const apiClient = this.apiClient as {
    listBooks: () => Promise<Array<{ id: number; slug: string; name: string }>>;
    getBookContents: (id: number) => Promise<{ chapters: { data: Array<{ id: number; slug?: string; pages?: unknown[] }> }; pages: { data: unknown[] } }>;
    getPage: (id: number) => Promise<{ id: number; updated_at?: string; revision_count?: number; markdown?: string }>;
    updatePage: (id: number, d: { markdown: string }) => Promise<unknown>;
  };
  const stats = this.stats as Record<string, number>;
  const flattenBookPages = this._flattenBookPages as (c: unknown) => unknown[];
  const exportRemotePage = this._exportRemotePage as (pid: string, book: { id: number }, rp: { id: number; chapter_id?: number }, d: string) => Promise<void>;
  const walkMarkdownFiles = this._walkMarkdownFiles as (d: string) => string[];
  const importPage = this.importPage as (pid: string, c: Record<string, unknown>) => Promise<Record<string, unknown>>;

  const bookSlug = getBookSlugForProject(projectIdentifier);
  if (!bookSlug) return { skipped: true, reason: 'no_mapping' };
  if (!apiConnected) return { skipped: true, reason: 'api_not_connected' };

  const docsDir = path.join(projectPath, config.docsSubdir, bookSlug);
  const trackedPages = db.getBookStackPages(projectIdentifier) as Array<Record<string, unknown>>;
  const pagesByRemoteId = new Map(trackedPages.map((p) => [p.bookstack_page_id, p]));
  const pagesByPath = new Map(trackedPages.map((p) => [p.local_path, p]));

  const books = await apiClient.listBooks();
  const book = books.find((b) => b.slug === bookSlug || b.name.toLowerCase().replace(/\s+/g, '-') === bookSlug);
  if (!book) return { skipped: true, reason: 'book_not_found' };

  const contents = await apiClient.getBookContents(book.id);
  const allRemotePages = flattenBookPages(contents) as Array<{ id: number; chapter_id?: number }>;
  const remotePageIds = new Set(allRemotePages.map((p) => p.id));

  const results = { exported: 0, imported: 0, conflicts: 0, remoteDeleted: 0, newRemote: 0, newLocal: 0, unchanged: 0, errors: 0 };

  for (const remotePage of allRemotePages) {
    try {
      const tracked = pagesByRemoteId.get(remotePage.id) as Record<string, unknown> | undefined;

      if (!tracked) {
        await exportRemotePage(projectIdentifier, book, remotePage, docsDir);
        results.newRemote++;
        continue;
      }

      const remoteDetail = await apiClient.getPage(remotePage.id);
      const remoteMarkdown = remoteDetail.markdown || '';
      const remoteHash = crypto.createHash('sha256').update(remoteMarkdown).digest('hex');
      const localFilePath = path.join(path.resolve(docsDir, '..'), tracked.local_path as string);

      const localExists = fs.existsSync(localFilePath);
      let localHash: string | null = null;
      if (localExists) {
        localHash = crypto.createHash('sha256').update(fs.readFileSync(localFilePath, 'utf-8')).digest('hex');
      }

      const remoteChanged = remoteHash !== (tracked.bookstack_content_hash || tracked.content_hash);
      const localChanged = localExists && localHash !== tracked.content_hash;
      const localDeleted = !localExists;

      if (localDeleted && remoteChanged) {
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
        fs.writeFileSync(localFilePath, remoteMarkdown, 'utf-8');
        db.upsertBookStackPage({ ...tracked, content_hash: remoteHash, bookstack_content_hash: remoteHash,
          bookstack_modified_at: remoteDetail.updated_at, bookstack_revision_count: remoteDetail.revision_count,
          local_modified_at: Date.now(), last_export_at: Date.now(), sync_direction: 'export', sync_status: 'synced' });
        results.exported++;
        continue;
      }

      if (localDeleted && !remoteChanged) {
        logger.warn({ pageId: remotePage.id, path: tracked.local_path }, 'Local file deleted but remote unchanged; not deleting from BookStack.');
        results.unchanged++;
        continue;
      }
      if (!remoteChanged && !localChanged) { results.unchanged++; continue; }

      if (remoteChanged && !localChanged) {
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
        fs.writeFileSync(localFilePath, remoteMarkdown, 'utf-8');
        db.upsertBookStackPage({ ...tracked, content_hash: remoteHash, bookstack_content_hash: remoteHash,
          bookstack_modified_at: remoteDetail.updated_at, bookstack_revision_count: remoteDetail.revision_count,
          local_modified_at: Date.now(), last_export_at: Date.now(), sync_direction: 'export', sync_status: 'synced' });
        results.exported++;
        continue;
      }

      if (localChanged && !remoteChanged) {
        const localContent = fs.readFileSync(localFilePath, 'utf-8');
        await apiClient.updatePage(tracked.bookstack_page_id as number, { markdown: localContent });
        db.upsertBookStackPage({ ...tracked, content_hash: localHash, bookstack_content_hash: localHash,
          local_modified_at: Date.now(), last_import_at: Date.now(), sync_direction: 'import', sync_status: 'synced' });
        results.imported++;
        continue;
      }

      // Conflict — BookStack wins
      logger.warn({ pageId: remotePage.id, path: tracked.local_path, localHash, remoteHash, storedHash: tracked.content_hash }, 'Conflict detected - both local and remote changed. BookStack wins.');
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
      fs.writeFileSync(localFilePath, remoteMarkdown, 'utf-8');
      db.upsertBookStackPage({ ...tracked, content_hash: remoteHash, bookstack_content_hash: remoteHash,
        bookstack_modified_at: remoteDetail.updated_at, bookstack_revision_count: remoteDetail.revision_count,
        local_modified_at: Date.now(), last_export_at: Date.now(), sync_direction: 'export', sync_status: 'synced' });
      results.conflicts++;
      stats.conflictsDetected = (stats.conflictsDetected || 0) + 1;
      stats.conflictsResolved = (stats.conflictsResolved || 0) + 1;
    } catch (err) {
      logger.error({ err, pageId: remotePage.id }, 'Error processing page in bidirectional sync');
      results.errors++;
    }
  }

  for (const tracked of trackedPages) {
    if (!remotePageIds.has(tracked.bookstack_page_id as number)) {
      const lp = path.join(path.resolve(docsDir, '..'), tracked.local_path as string);
      if (fs.existsSync(lp)) fs.unlinkSync(lp);
      db.upsertBookStackPage({ ...tracked, sync_status: 'deleted_remote', sync_direction: 'export' });
      results.remoteDeleted++;
      stats.remoteDeleted = (stats.remoteDeleted || 0) + 1;
    }
  }

  if (fs.existsSync(docsDir)) {
    const localFiles = walkMarkdownFiles(docsDir);
    for (const fp of localFiles) {
      const relFromDocsDir = path.relative(path.resolve(docsDir, '..'), fp);
      if (!pagesByPath.has(relFromDocsDir)) {
        const content = fs.readFileSync(fp, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (!titleMatch) { logger.warn({ file: relFromDocsDir }, 'Skipping new local file - no # Title heading'); continue; }
        try {
          await importPage(projectIdentifier, { type: 'create', localPath: relFromDocsDir, absolutePath: fp, contentHash: crypto.createHash('sha256').update(content).digest('hex'), content, title: titleMatch[1]!.trim() });
          results.newLocal++;
        } catch (err) {
          logger.error({ err, file: relFromDocsDir }, 'Failed to import new local file');
          results.errors++;
        }
      }
    }
  }

  stats.bidirectionalSyncs = (stats.bidirectionalSyncs || 0) + 1;
  logger.info({ projectIdentifier, bookSlug, ...results }, 'Bidirectional sync completed');
  return { success: results.errors === 0, ...results };
}
