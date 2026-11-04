import fs from 'node:fs';
import path from 'node:path';
import { logger as rootLogger } from './logger';
import { stripUrlCredentials } from './utils';
import { ensureRig, type EnsureRigResult } from './rig/provisioner.js';
import type { SyncDatabase } from './database';
import type { ProjectRow } from './types/db.js';

export interface RigEvent {
  type: 'rig:provisioned' | 'rig:error';
  projectId: string;
  action: EnsureRigResult['action'];
  remoteUrl?: string;
  error?: string;
}

interface TechDetector {
  file: string;
  stack: string;
}

interface RegistryFilters {
  status?: string;
  tech_stack?: string;
}

interface ProjectUpdates {
  name?: string;
  filesystem_path?: string;
  git_url?: string;
  status?: string;
}

type ProjectDB = Pick<SyncDatabase,
  'getAllProjects' | 'getProject' | 'resolveProjectIdentifier' | 'updateProject' | 'archiveProject'
  | 'unarchiveProject' | 'deleteProject' | 'upsertProject' | 'setProjectScan' | 'setBeadsRemoteResult'>;

interface RegistryOptions {
  db: ProjectDB;
  baseDir?: string;
  logger?: typeof rootLogger;
  onRigEvent?: (event: RigEvent) => void;
}

const TECH_STACK_DETECTORS: TechDetector[] = [
  { file: 'package.json', stack: 'node' },
  { file: 'Cargo.toml', stack: 'rust' },
  { file: 'go.mod', stack: 'go' },
  { file: 'pyproject.toml', stack: 'python' },
  { file: 'setup.py', stack: 'python' },
  { file: 'requirements.txt', stack: 'python' },
  { file: 'Gemfile', stack: 'ruby' },
  { file: 'pom.xml', stack: 'java' },
  { file: 'build.gradle', stack: 'java' },
  { file: 'mix.exs', stack: 'elixir' },
  { file: 'composer.json', stack: 'php' },
  { file: 'CMakeLists.txt', stack: 'cpp' },
  { file: 'Makefile', stack: 'make' },
  { file: 'docker-compose.yml', stack: 'docker' },
  { file: 'Dockerfile', stack: 'docker' },
];

interface ScanResults {
  discovered: number;
  updated: number;
  errors: string[];
}

export class ProjectRegistry {
  private db: ProjectDB;
  private baseDir: string;
  private log: ReturnType<typeof rootLogger.child>;
  private onRigEvent?: (event: RigEvent) => void;

  constructor(opts: RegistryOptions | null = null) {
    if (!opts?.db) throw new Error('ProjectRegistry requires a db instance');
    this.db = opts.db;
    this.baseDir = opts.baseDir || process.env.STACKS_DIR || '/opt/stacks';
    this.log = (opts.logger || rootLogger).child({ module: 'project-registry' });
    if (opts.onRigEvent) this.onRigEvent = opts.onRigEvent;
  }

  scanProjects(): ScanResults {
    const results: ScanResults = { discovered: 0, updated: 0, errors: [] };

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch (err) {
      this.log.error({ err, baseDir: this.baseDir }, 'Failed to read base directory');
      results.errors.push(`Cannot read ${this.baseDir}: ${(err as Error).message}`);
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(this.baseDir, entry.name);
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const hasGit = fs.existsSync(path.join(dirPath, '.git'));
      if (!hasGit) continue;

      results.discovered++;
      try {
        this._registerDir(dirPath, { hasGit });
        results.updated++;
      } catch (err) {
        const msg = `Failed to register ${dirPath}: ${(err as Error).message}`;
        this.log.warn({ err, dirPath }, msg);
        results.errors.push(msg);
      }
    }

    this.log.info(
      { discovered: results.discovered, updated: results.updated, errors: results.errors.length },
      'Project scan complete',
    );
    return results;
  }

  getProjects(filters: RegistryFilters = {}): ProjectRow[] {
    let rows = this.db.getAllProjects();

    if (filters.status) rows = rows.filter(r => r.status === filters.status);
    if (filters.tech_stack) rows = rows.filter(r => r.tech_stack === filters.tech_stack);
    return rows;
  }

  getProject(identifier: string): ProjectRow | null {
    const project = this.db.getProject(identifier);
    if (project) return project;

    const resolved = this.db.resolveProjectIdentifier(identifier);
    if (resolved) return this.db.getProject(resolved) ?? null;

    return null;
  }

  registerProject(dirPath: string): ProjectRow | null {
    const absPath = path.resolve(dirPath);
    if (!fs.existsSync(absPath)) throw new Error(`Directory does not exist: ${absPath}`);

    const hasGit = fs.existsSync(path.join(absPath, '.git'));
    // An explicit registration is a deliberate (re)activation.
    this._registerDir(absPath, { hasGit, reactivate: true });

    const folderName = path.basename(absPath);
    return this.getProjectByPath(absPath) || this.getProject(folderName);
  }

  updateProject(identifier: string, updates: ProjectUpdates = {}): ProjectRow | null {
    const existing = this.getProject(identifier);
    if (!existing) return null;

    const nextUpdates: Partial<ProjectUpdates> = {};
    if (updates.name !== undefined) nextUpdates.name = updates.name;
    if (updates.filesystem_path !== undefined) {
      const absPath = path.resolve(updates.filesystem_path);
      if (!fs.existsSync(absPath)) throw new Error(`Directory does not exist: ${absPath}`);
      nextUpdates.filesystem_path = absPath;
    }
    if (updates.git_url !== undefined) nextUpdates.git_url = updates.git_url;
    if (updates.status !== undefined) nextUpdates.status = updates.status;

    const updated = this.db.updateProject(existing.identifier, nextUpdates);
    if (updated?.filesystem_path) {
      this.db.setProjectScan(updated.identifier, this._detectTechStack(updated.filesystem_path), Date.now());
    }

    return this.getProject(existing.identifier);
  }

  archiveProject(identifier: string): ProjectRow | null {
    return this.db.archiveProject(identifier);
  }

  unarchiveProject(identifier: string): ProjectRow | null {
    return this.db.unarchiveProject(identifier);
  }

  deleteProject(identifier: string): boolean {
    const existing = this.getProject(identifier);
    if (!existing) return false;
    return this.db.deleteProject(existing.identifier);
  }

  getProjectByPath(fsPath: string): ProjectRow | null {
    const normalised = path.resolve(fsPath);
    const all = this.db.getAllProjects();
    return all.find(p => p.filesystem_path === normalised) || null;
  }

  private _detectTechStack(dirPath: string): string | null {
    for (const { file, stack } of TECH_STACK_DETECTORS) {
      if (fs.existsSync(path.join(dirPath, file))) return stack;
    }
    return null;
  }

  private _readGitUrl(dirPath: string): string | null {
    const gitConfigPath = path.join(dirPath, '.git', 'config');
    try {
      if (!fs.existsSync(gitConfigPath)) return null;
      const content = fs.readFileSync(gitConfigPath, 'utf8');
      const match = content.match(/url\s*=\s*(.+)/);
      // SECURITY (vibesync-6kg): strip any inline credential before persisting.
      // git config can carry `https://<token>@host/...` if the remote was added
      // with credentials inline. We must NEVER let that reach the database.
      return stripUrlCredentials(match?.[1]?.trim() ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Upsert a project from its directory. A boot scan must keep an operator's
   * status: re-registering every repo as `active` would silently resurrect
   * archived (deprecated) projects on each restart.
   */
  private _registerDir(dirPath: string, { hasGit, reactivate = false }: { hasGit: boolean; reactivate?: boolean }): void {
    const folderName = path.basename(dirPath);
    const now = Date.now();

    if (!hasGit) throw new Error(`Directory is not a git repository: ${dirPath}`);

    const techStack = this._detectTechStack(dirPath);
    const gitUrl = hasGit ? this._readGitUrl(dirPath) : null;

    const existing = this.getProjectByPath(dirPath);
    const identifier = existing?.identifier || folderName;

    this.db.upsertProject({
      identifier, name: existing?.name || folderName,
      filesystem_path: dirPath, git_url: gitUrl,
      status: reactivate || !existing ? 'active' : existing.status, last_checked_at: now,
    });
    this.db.setProjectScan(identifier, techStack, now);

    // Never provision (bd init, add a remote) a project an operator archived;
    // only an explicit registration reactivates it.
    if (existing && !reactivate && existing.status !== 'active') return;

    try {
      const rig = ensureRig(dirPath);
      if (rig.action !== 'none' && rig.action !== 'skipped') {
        this.log.info({ dirPath, action: rig.action, message: rig.message }, 'Rig auto-provisioned');
        if (rig.ok && rig.remoteUrl) {
          this.db.setBeadsRemoteResult(identifier, { ok: true, remoteUrl: rig.remoteUrl }, now);
          this.onRigEvent?.({ type: 'rig:provisioned', projectId: identifier, action: rig.action, remoteUrl: rig.remoteUrl });
        } else if (!rig.ok) {
          this.db.setBeadsRemoteResult(identifier, { ok: false, error: rig.message }, now);
          this.onRigEvent?.({ type: 'rig:error', projectId: identifier, action: rig.action, error: rig.message });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ err, dirPath }, 'Rig auto-provisioning failed');
      this.db.setBeadsRemoteResult(identifier, { ok: false, error: msg }, now);
      this.onRigEvent?.({ type: 'rig:error', projectId: identifier, action: 'init', error: msg });
    }
  }
}
