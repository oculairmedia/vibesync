import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger as defaultLogger } from './logger';
import {
  defaultDeps as defaultPortSweeperDeps,
  detectConflict as detectPortConflict,
  pickFreePort,
  type PortSweeperDeps,
  type SweeperProject,
} from './beads/PortSweeper';
import type {
  DoltHubProvisioningConfig,
  DoltHubProvisioningResult,
} from './types/dolthub';

const execFileAsync = promisify(execFile);
const DEFAULT_BRANCH = 'main';

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
}

interface BeadsRemote {
  name: string;
  url: string;
  raw: string;
}

interface ProvisioningPlan {
  owner: string;
  repo: string;
  remoteName: string;
  remoteUrl: string;
  visibility: string;
  apiEndpoint: string;
}

interface CreateDbResult {
  created: boolean;
  alreadyExists: boolean;
  dryRun?: boolean;
  response?: unknown;
}

interface RemoteConfigResult {
  changed: boolean;
  pushed: boolean;
}

interface ProvisionOptions {
  push?: boolean;
}

interface BeadsProject {
  identifier: string;
  filesystem_path: string;
  name?: string;
}

interface RegistryProject {
  identifier: string;
  filesystem_path?: string | null;
}

interface DbProject {
  projects?: {
    getAllProjects?: () => RegistryProject[];
    setProjectBeadsRemote?: (identifier: string, data: Record<string, unknown>) => void;
    setProjectBeadsRemoteError?: (identifier: string, error: string) => void;
  };
}

type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

interface DoltHubServiceOptions {
  config?: Partial<DoltHubProvisioningConfig>;
  db?: DbProject | null;
  logger?: { child?: (ctx: Record<string, unknown>) => unknown; error?: (ctx: Record<string, unknown>, msg: string) => void; info?: (ctx: Record<string, unknown>, msg: string) => void };
  fetchImpl?: FetchImpl;
  commandRunner?: CommandRunner;
  portSweeperDeps?: PortSweeperDeps;
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

export function normalizeDoltHubRepoName(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return normalized || 'project';
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message
    .replace(/authorization:\s*[^\s,)]+/gi, 'authorization: [redacted]')
    .replace(/token\s+[A-Za-z0-9._-]+/gi, 'token [redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function parseJsonMaybe(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseRemoteList(output: string): BeadsRemote[] {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      return { name: parts[0], url: parts[1], raw: line };
    })
    .filter((r): r is BeadsRemote => r !== null);
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: options.env,
  });
  return { stdout: (result as { stdout?: string }).stdout || '', stderr: (result as { stderr?: string }).stderr || '' };
}

export class DoltHubProvisioningService {
  private config: DoltHubProvisioningConfig;
  private db: DbProject | null;
  private logger: DoltHubServiceOptions['logger'];
  private fetchImpl: FetchImpl;
  private commandRunner: CommandRunner;
  private portSweeperDeps: PortSweeperDeps;

  constructor(options: DoltHubServiceOptions = {}) {
    const {
      config = {},
      db = null,
      logger = defaultLogger,
      fetchImpl = globalThis.fetch as FetchImpl,
      commandRunner,
      portSweeperDeps,
    } = options;
    this.config = {
      enabled: Boolean(config.enabled),
      dryRun: Boolean(config.dryRun),
      apiUrl: config.apiUrl || '',
      apiToken: config.apiToken,
      owner: config.owner || 'oulair',
      defaultVisibility: config.defaultVisibility || 'private',
      remoteName: config.remoteName || 'origin',
    } as DoltHubProvisioningConfig;
    this.db = db;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.commandRunner = commandRunner || defaultCommandRunner;
    this.portSweeperDeps = portSweeperDeps ?? defaultPortSweeperDeps;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get dryRun(): boolean {
    return this.config.dryRun;
  }

  get owner(): string {
    return this.config.owner;
  }

  get remoteName(): string {
    return this.config.remoteName;
  }

  get visibility(): string {
    return this.config.defaultVisibility;
  }

  get apiUrl(): string {
    return trimTrailingSlash(this.config.apiUrl || 'https://www.dolthub.com/api/v1alpha1');
  }

  buildPlan(project: BeadsProject): ProvisioningPlan {
    const sourceName =
      path.basename(project.filesystem_path || '') || project.name || project.identifier;
    const repo = normalizeDoltHubRepoName(sourceName);
    const remoteUrl = `https://doltremoteapi.dolthub.com/${this.owner}/${repo}`;

    return {
      owner: this.owner,
      repo,
      remoteName: this.remoteName,
      remoteUrl,
      visibility: this.visibility,
      apiEndpoint: `${this.apiUrl}/database`,
    };
  }

  async provisionProject(
    project: BeadsProject,
    options: ProvisionOptions = {},
  ): Promise<DoltHubProvisioningResult> {
    if (!project?.identifier) {
      throw new Error('Project identifier is required');
    }
    if (!project.filesystem_path) {
      throw new Error('Project has no filesystem path');
    }
    if (!this.enabled && !this.dryRun) {
      throw new Error('DoltHub provisioning is disabled');
    }

    const plan = this.buildPlan(project);
    const commands: string[] = [];

    try {
      await this.ensureUniqueBeadsPort(project, commands);
      const createResult = await this.createDoltHubDatabase(project, plan);
      const remoteResult = await this.configureBeadsRemote(
        project.filesystem_path,
        plan,
        { push: options.push !== false, commands },
      );
      const status = this.dryRun ? 'dry_run' : 'provisioned';
      const lastPushAt = remoteResult.pushed ? Date.now() : null;

      this.db?.projects?.setProjectBeadsRemote?.(project.identifier, {
        owner: plan.owner,
        repo: plan.repo,
        url: plan.remoteUrl,
        name: plan.remoteName,
        status,
        visibility: plan.visibility,
        last_push_at: lastPushAt,
      });

      return {
        success: true,
        status,
        databaseName: plan.repo,
        databaseUrl: plan.remoteUrl,
        dry_run: this.dryRun,
        project_identifier: project.identifier,
        owner: plan.owner,
        repo: plan.repo,
        remote_name: plan.remoteName,
        remote_url: plan.remoteUrl,
        visibility: plan.visibility,
        database_created: createResult.created,
        database_already_exists: createResult.alreadyExists,
        remote_changed: remoteResult.changed,
        pushed: remoteResult.pushed,
        commands,
      };
    } catch (error) {
      const safeError = sanitizeErrorMessage(error);
      this.db?.projects?.setProjectBeadsRemoteError?.(project.identifier, safeError);
      (this.logger as { error?: (ctx: Record<string, unknown>, msg: string) => void })?.error?.(
        { err: error, project_identifier: project.identifier },
        'Beads remote provisioning failed',
      );
      throw new Error(safeError);
    }
  }

  private async createDoltHubDatabase(
    project: BeadsProject,
    plan: ProvisioningPlan,
  ): Promise<CreateDbResult> {
    if (this.dryRun) {
      return { created: false, alreadyExists: false, dryRun: true };
    }
    if (!this.config.apiToken) {
      throw new Error('DOLTHUB_API_TOKEN is required for DoltHub database creation');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Fetch implementation is not available for DoltHub database creation');
    }

    const response = await this.fetchImpl(plan.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: this.config.apiToken,
      },
      body: JSON.stringify({
        ownerName: plan.owner,
        repoName: plan.repo,
        description: `Beads issue database for ${project.name || project.identifier}`,
        visibility: plan.visibility,
      }),
    });

    const responseText = await response.text().catch(() => '');
    const responseJson = parseJsonMaybe(responseText) as Record<string, unknown> | null;
    const message = String(responseJson?.error || responseJson?.message || responseText);

    if (response.ok) {
      return { created: true, alreadyExists: false, response: responseJson };
    }

    if (
      response.status === 409 ||
      /already\s+exists|exists\s+already|database.*exists/i.test(message)
    ) {
      return { created: false, alreadyExists: true, response: responseJson };
    }

    throw new Error(
      `DoltHub database creation failed (${response.status}): ${message || response.statusText}`,
    );
  }

  private async configureBeadsRemote(
    projectPath: string,
    plan: ProvisioningPlan,
    options: { commands: string[]; push?: boolean },
  ): Promise<RemoteConfigResult> {
    const commands = options.commands || [];
    const remotes = await this.listBeadsRemotes(projectPath, commands);
    const existing = remotes.find((remote) => remote.name === plan.remoteName);
    let changed = false;

    if (existing && existing.url !== plan.remoteUrl) {
      await this.runBd(projectPath, ['dolt', 'remote', 'remove', plan.remoteName], commands);
      changed = true;
    }

    if (!existing || existing.url !== plan.remoteUrl) {
      await this.runBd(
        projectPath,
        ['dolt', 'remote', 'add', plan.remoteName, plan.remoteUrl],
        commands,
      );
      changed = true;
    }

    const verifiedRemotes = await this.listBeadsRemotes(projectPath, commands);
    const verified = verifiedRemotes.find(
      (remote) => remote.name === plan.remoteName && remote.url === plan.remoteUrl,
    );

    if (!this.dryRun && !verified) {
      throw new Error(`Beads remote ${plan.remoteName} was not configured correctly`);
    }

    let pushed = false;
    if (options.push !== false) {
      await this.runBd(
        projectPath,
        ['dolt', 'push', plan.remoteName, DEFAULT_BRANCH],
        commands,
        120000,
      );
      pushed = true;
    }

    return { changed, pushed };
  }

  private async ensureUniqueBeadsPort(project: BeadsProject, commands: string[]): Promise<void> {
    const registry: readonly SweeperProject[] = (this.db?.projects?.getAllProjects?.() ?? []).map(
      (entry) => ({ identifier: entry.identifier, filesystem_path: entry.filesystem_path ?? null }),
    );
    const sweeperProject: SweeperProject = {
      identifier: project.identifier,
      filesystem_path: project.filesystem_path,
    };

    const conflict = detectPortConflict(sweeperProject, registry, this.portSweeperDeps);
    if (!conflict) return;

    const nextPort = pickFreePort(registry, this.portSweeperDeps);
    await this.runBd(project.filesystem_path, ['dolt', 'set', 'port', String(nextPort)], commands);
    await this.runBd(project.filesystem_path, ['dolt', 'start'], commands);
  }

  private async listBeadsRemotes(
    projectPath: string,
    commands: string[],
  ): Promise<BeadsRemote[]> {
    const result = await this.runBd(projectPath, ['dolt', 'remote', 'list'], commands);
    return parseRemoteList(result.stdout);
  }

  private async runBd(
    projectPath: string,
    args: string[],
    commands: string[],
    timeout: number = 30000,
  ): Promise<CommandResult> {
    commands.push(['bd', ...args].join(' '));

    if (this.dryRun) {
      return { stdout: '', stderr: '' };
    }

    return this.commandRunner('bd', args, {
      cwd: projectPath,
      timeout,
      env: process.env as NodeJS.ProcessEnv,
    });
  }
}


export function createDoltHubProvisioningService(
  options: DoltHubServiceOptions,
): DoltHubProvisioningService {
  return new DoltHubProvisioningService(options);
}
