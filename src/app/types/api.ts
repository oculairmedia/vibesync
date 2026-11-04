import type { IncomingMessage, ServerResponse } from 'http';
import type { OrchestrationHandle } from '../../engine/boot.js';
import type { ProjectRow } from './db.js';

export type Logger = {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug?: (obj: Record<string, unknown> | string, msg?: string) => void;
  child?: (bindings: Record<string, unknown>) => Logger;
  fatal?: (obj: Record<string, unknown> | string, msg?: string) => void;
};

export interface RouteContext {
  pathname: string;
  method: string;
}

export interface HandleContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
}

export interface App {
  registerRoute(opts: {
    match: (ctx: RouteContext) => boolean;
    handle: (ctx: HandleContext) => Promise<void>;
  }): void;
}

export type SendJson = (res: ServerResponse, code: number, data: unknown) => void;
export type SendError = (
  res: ServerResponse,
  code: number,
  message: string,
  details?: Record<string, unknown>,
) => void;
export type ParseJsonBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;

export interface RouteDb {
  getProject: (id: string) => ProjectRow | undefined;
  getAllProjects: () => ProjectRow[];
  getProjectsWithFilesystemPath: () => ProjectRow[];
  resolveProjectIdentifier: (id: string | null) => string | null;
}

export interface ProjectFilters {
  status?: string;
  tech_stack?: string;
}

export interface ProjectRegistryApi {
  registerProject: (path: string) => ProjectRow | null;
  getProject: (id: string) => ProjectRow | null;
  getProjects: (filters?: ProjectFilters) => ProjectRow[];
  updateProject: (id: string, updates: { name?: string; filesystem_path?: string; git_url?: string; status?: string }) => ProjectRow | null;
  deleteProject: (id: string) => boolean;
}

export interface BeadsRemoteProvisionResult {
  status: string;
  dry_run?: boolean;
  [key: string]: unknown;
}

export interface DoltHubProvisionerApi {
  readonly dryRun: boolean;
  provisionProject: (project: ProjectRow, options: { push: boolean }) => Promise<BeadsRemoteProvisionResult>;
}

export type OrchestrationApi = OrchestrationHandle;
