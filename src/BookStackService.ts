import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { createBookStackExporter } from './BookStackExporter';
import { createBookStackApiClient } from './BookStackApiClient';
import { _flattenBookPages, _exportRemotePage, _walkMarkdownFiles } from './bookstack/BookStackCommon';
import { createExportMethods } from './bookstack/BookStackSyncExporter';
import { createImportMethods } from './bookstack/BookStackSyncImporter';
import { createBidirectionalMethods } from './bookstack/BookStackBidirectional';

interface BookStackServiceConfig {
  url: string;
  tokenId: string;
  tokenSecret: string;
  enabled?: boolean;
  syncInterval: number;
  docsSubdir: string;
  projectBookMappings: Array<{ projectIdentifier: string; bookSlug: string }>;
  bidirectionalSync?: boolean;
  exporterOutputPath: string;
}

interface ServiceStats {
  exportsCompleted: number;
  exportsFailed: number;
  pagesTracked: number;
  apiExports: number;
  archiverExports: number;
  importsCompleted?: number;
  importsFailed?: number;
  conflictsDetected?: number;
  conflictsResolved?: number;
  remoteDeleted?: number;
  bidirectionalSyncs?: number;
  [key: string]: number | undefined;
}

export class BookStackService {
  config: BookStackServiceConfig;
  db: {
    getBookStackPages: (projectId: string) => unknown[];
    upsertBookStackPage: (data: Record<string, unknown>) => void;
    getBookStackPageByPath: (path: string) => unknown;
    setBookStackLastExport: (projectId: string, ts: number) => void;
    getBookStackLastExport: (projectId: string) => number | null;
  };
  exporter: ReturnType<typeof createBookStackExporter>;
  apiClient: ReturnType<typeof createBookStackApiClient>;
  initialized: boolean;
  apiConnected: boolean;
  stats: ServiceStats;

  syncExportViaApi!: (projectIdentifier: string, projectPath: string, bookSlug: string) => Promise<unknown>;
  syncExportViaArchive!: (projectIdentifier: string, projectPath: string, bookSlug: string) => Promise<unknown>;
  _flattenBookPages!: (contents: Record<string, unknown>) => unknown[];
  _exportRemotePage!: typeof _exportRemotePage;
  detectLocalChanges!: (projectIdentifier: string, docsDir: string) => unknown[];
  importPage!: (projectIdentifier: string, change: Record<string, unknown>) => Promise<Record<string, unknown>>;
  importSingleFile!: (projectIdentifier: string, filePath: string) => Promise<unknown>;
  _walkMarkdownFiles!: (dir: string) => string[];
  syncBidirectional!: (projectIdentifier: string, projectPath: string) => Promise<unknown>;

  constructor(config: BookStackServiceConfig, db: BookStackService['db']) {
    this.config = config;
    this.db = db;
    this.exporter = createBookStackExporter(config);
    this.apiClient = createBookStackApiClient(config);
    this.initialized = false;
    this.apiConnected = false;
    this.stats = {
      exportsCompleted: 0,
      exportsFailed: 0,
      pagesTracked: 0,
      apiExports: 0,
      archiverExports: 0,
      importsCompleted: 0,
      importsFailed: 0,
      conflictsDetected: 0,
      conflictsResolved: 0,
      remoteDeleted: 0,
      bidirectionalSyncs: 0,
    };

    // Defer sub-module binding to initialize or first use
    this._bindModules();
  }

  private _bindModules(): void {
    const expMixin = createExportMethods(this as unknown as Record<string, unknown>);
    this.syncExportViaApi = expMixin.syncExportViaApi;
    this.syncExportViaArchive = expMixin.syncExportViaArchive;
    this._flattenBookPages = expMixin._flattenBookPages;
    this._exportRemotePage = expMixin._exportRemotePage;

    const impMixin = createImportMethods(this as unknown as Record<string, unknown>);
    this.detectLocalChanges = impMixin.detectLocalChanges;
    this.importPage = impMixin.importPage;
    this.importSingleFile = impMixin.importSingleFile;
    this._walkMarkdownFiles = impMixin._walkMarkdownFiles;

    const bidirMixin = createBidirectionalMethods(this as unknown as Record<string, unknown>);
    this.syncBidirectional = bidirMixin.syncBidirectional;
  }

  async initialize(): Promise<{ archiveExists: boolean; apiConnected: boolean; bookCount: number }> {
    const archiveExists = this.exporter.getLatestArchive() !== null;
    const connectionTest = await this.apiClient.testConnection();
    this.apiConnected = connectionTest.connected;
    this.initialized = true;

    logger.info({ url: this.config.url, mappings: this.config.projectBookMappings.length, archiveExists, apiConnected: this.apiConnected, bookCount: connectionTest.bookCount || 0 }, 'BookStackService initialized');

    return { archiveExists, apiConnected: this.apiConnected, bookCount: connectionTest.bookCount || 0 };
  }

  getBookSlugForProject(projectIdentifier: string): string | null {
    const mapping = this.config.projectBookMappings.find((m) => m.projectIdentifier === projectIdentifier);
    return mapping?.bookSlug || null;
  }

  async syncExport(projectIdentifier: string, projectPath: string): Promise<unknown> {
    const bookSlug = this.getBookSlugForProject(projectIdentifier);
    if (!bookSlug) return { skipped: true, reason: 'no_mapping' };

    const lastExport = this.db.getBookStackLastExport(projectIdentifier);
    const exportDue = !lastExport || Date.now() - lastExport > this.config.syncInterval;
    if (!exportDue) return { skipped: true, reason: 'not_due' };

    return this.apiConnected
      ? this.syncExportViaApi(projectIdentifier, projectPath, bookSlug)
      : this.syncExportViaArchive(projectIdentifier, projectPath, bookSlug);
  }

  async syncImport(projectIdentifier: string, projectPath: string): Promise<unknown> {
    const bookSlug = this.getBookSlugForProject(projectIdentifier);
    if (!bookSlug) return { skipped: true, reason: 'no_mapping' };
    if (!this.apiConnected) return { skipped: true, reason: 'api_not_connected' };

    const docsDir = path.join(projectPath, this.config.docsSubdir, bookSlug);
    if (!fs.existsSync(docsDir)) return { skipped: true, reason: 'no_docs_dir' };

    const changes = this.detectLocalChanges(projectIdentifier, docsDir) as Array<{ success?: boolean; localPath?: string }>;
    if (changes.length === 0) return { skipped: true, reason: 'no_changes' };

    const results = [];
    for (const change of changes) {
      try {
        results.push(await this.importPage(projectIdentifier, change));
      } catch (err) {
        logger.warn({ err, file: change.localPath }, 'Failed to import page');
        results.push({ success: false, localPath: change.localPath, error: (err as Error).message });
      }
    }

    const imported = results.filter((r: unknown) => (r as Record<string, unknown>).success).length;
    const failed = results.length - imported;
    this.stats.importsCompleted = (this.stats.importsCompleted || 0) + imported;
    this.stats.importsFailed = (this.stats.importsFailed || 0) + failed;
    logger.info({ projectIdentifier, bookSlug, imported, failed, total: changes.length }, 'BookStack import completed');

    return { success: failed === 0, results, imported, failed };
  }

  getHealthInfo(): Record<string, unknown> {
    return {
      enabled: this.config.enabled, initialized: this.initialized, apiConnected: this.apiConnected,
      url: this.config.url, mappings: this.config.projectBookMappings.length,
      syncInterval: `${this.config.syncInterval / 1000}s`, exporterStats: this.exporter.getStats(),
      serviceStats: { ...this.stats }, bidirectionalSync: this.config.bidirectionalSync || false,
      conflictsDetected: this.stats.conflictsDetected || 0, conflictsResolved: this.stats.conflictsResolved || 0,
      remoteDeleted: this.stats.remoteDeleted || 0, bidirectionalSyncs: this.stats.bidirectionalSyncs || 0,
    };
  }

  getStats(): Record<string, unknown> {
    return { ...this.stats, exporter: this.exporter.getStats() };
  }
}

export function createBookStackService(config: BookStackServiceConfig, db: BookStackService['db']): BookStackService {
  return new BookStackService(config, db);
}
