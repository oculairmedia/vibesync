/**
 * Reader for the host's project registry (letta-mobile project-registry-v1,
 * contract docs/reference/contracts/project-registry-v1.md, vibesync-9lzk.55.5).
 *
 * The host owns the project record; vibesync reads it with two admin RPC
 * methods, project.registry.list and project.registry.get, which need the
 * `projects.read` capability. Neither exists on the host yet (the contract's
 * S0 stage is the document and fixtures only), so nothing calls this module in
 * production: it is built and tested against the contract's fixtures, ready to
 * be wired in when the host methods ship.
 *
 * Rules applied here (contract §6): settings come from the record (X1); work
 * happens in the primary checkout (X2); only an `active` record with
 * `engine.enabled` and a primary checkout is runnable (X3, X4); unknown fields
 * are ignored and an unknown state is not runnable (X4).
 */

/** The admin RPC call this reader needs; the Iroh connection's `rpc` fits. */
export type RegistryRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ProjectState = 'active' | 'unconfirmed' | 'archived' | 'invalid';

export interface ProjectCheckout {
  readonly root: string;
  readonly relativePath: string;
  readonly path: string;
  readonly primary: boolean;
}

export interface ProjectEngine {
  readonly enabled: boolean;
  readonly formula?: string;
  readonly readyLabel?: string;
  readonly poolSize?: number;
  readonly ciChecks: readonly string[];
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly key?: string;
  readonly name: string;
  /** A state this reader does not know is kept as `unknown` and is never runnable (X4). */
  readonly state: ProjectState | 'unknown';
  readonly invalidReason?: string;
  readonly repositorySlug?: string;
  readonly checkouts: readonly ProjectCheckout[];
  readonly pmAgentId?: string;
  readonly roleAgents: Readonly<Record<string, string>>;
  readonly providerKind?: string;
  readonly engine: ProjectEngine;
  readonly revision: string;
}

/** A refusal from the host: the contract's error code (`invalid_request`, `cursor_stale`, `unknown_project`, ...). */
export class RegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const KNOWN_STATES: ReadonlySet<string> = new Set(['active', 'unconfirmed', 'archived', 'invalid']);
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The checkout an engine works in (X2), or null when the record has none. */
export function primaryCheckout(record: ProjectRecord): ProjectCheckout | null {
  return record.checkouts.find((checkout) => checkout.primary) ?? null;
}

/** Whether an engine may run work for this record (X3, X4): active, enabled, with a primary checkout. */
export function isRunnable(record: ProjectRecord): boolean {
  return record.state === 'active' && record.engine.enabled && primaryCheckout(record) !== null;
}

/**
 * The record an engine may run for this project, or null. A project the
 * snapshot does not list is not runnable, never an error: the host may leave
 * out records the caller is not scoped to see (contract §8 C5, still open).
 */
export function runnableProject(
  snapshot: RegistrySnapshot,
  ref: { readonly key: string } | { readonly projectId: string },
): ProjectRecord | null {
  const record = snapshot.records.find((r) => ('key' in ref ? r.key === ref.key : r.projectId === ref.projectId));
  return record && isRunnable(record) ? record : null;
}

export interface RegistrySnapshot {
  readonly revision: string;
  readonly records: readonly ProjectRecord[];
}

/**
 * Reads the host registry. `snapshot()` returns every record, re-reading the
 * pages only when the registry revision moved (P2: `ifRevision` answers
 * `notModified` when nothing changed); a cursor that went stale mid-read starts
 * the walk again (L2).
 */
export class HostRegistryReader {
  private cached: RegistrySnapshot | null = null;

  constructor(private readonly rpc: RegistryRpc, private readonly pageLimit = 100) {}

  async snapshot(): Promise<RegistrySnapshot> {
    if (this.cached) {
      const probe = await this.list({ ifRevision: this.cached.revision });
      if (probe.notModified) return this.cached;
    }
    this.cached = await this.readAll();
    return this.cached;
  }

  /** One record by key or projectId; null when the host has no such project. */
  async get(ref: { readonly key: string } | { readonly projectId: string }): Promise<ProjectRecord | null> {
    if ('key' in ref && !KEY.test(ref.key)) throw new RegistryError(`key ${JSON.stringify(ref.key)} is not a valid key`, 'invalid_request');
    try {
      return parseRecord(await this.rpc('project.registry.get', { ...ref }));
    } catch (err) {
      if (registryCode(err) === 'unknown_project') return null;
      throw asRegistryError(err);
    }
  }

  private async readAll(): Promise<RegistrySnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.walkPages();
      } catch (err) {
        if (registryCode(err) !== 'cursor_stale') throw asRegistryError(err);
      }
    }
    throw new RegistryError('project.registry.list: the registry kept changing while it was read', 'cursor_stale');
  }

  private async walkPages(): Promise<RegistrySnapshot> {
    const records: ProjectRecord[] = [];
    let page = await this.list({ limit: this.pageLimit });
    const revision = page.revision;
    for (;;) {
      records.push(...page.items);
      if (!page.nextCursor) return { revision, records };
      page = await this.list({ limit: this.pageLimit, cursor: page.nextCursor });
    }
  }

  private async list(params: Record<string, unknown>): Promise<ListPage> {
    return parseListPage(await this.rpc('project.registry.list', params));
  }
}

interface ListPage {
  readonly revision: string;
  readonly notModified: boolean;
  readonly items: readonly ProjectRecord[];
  readonly nextCursor?: string;
}

function parseListPage(result: unknown): ListPage {
  const r = asObject(result, 'project.registry.list result');
  const revision = requiredString(r, 'revision', 'project.registry.list result');
  if (r['notModified'] === true) return { revision, notModified: true, items: [] };
  if (!Array.isArray(r['items'])) throw new RegistryError('project.registry.list result has no items', 'malformed_result');
  const nextCursor = optionalString(r['nextCursor']);
  return { revision, notModified: false, items: r['items'].map(parseRecord), ...(nextCursor ? { nextCursor } : {}) };
}

/** A record as the host sent it; fields this reader does not know are ignored (X4). */
export function parseRecord(value: unknown): ProjectRecord {
  const r = asObject(value, 'project record');
  const projectId = requiredString(r, 'projectId', 'project record');
  const state = requiredString(r, 'state', `project ${projectId}`);
  const engine = asObject(r['engine'], `project ${projectId} engine`);
  const key = optionalString(r['key']);
  const invalidReason = optionalString(r['invalidReason']);
  const repositorySlug = optionalString(asOptionalObject(r['repository'])?.['slug']);
  const pmAgentId = optionalString(r['pmAgentId']);
  const providerKind = optionalString(r['providerKind']);
  return {
    projectId,
    name: requiredString(r, 'name', `project ${projectId}`),
    state: KNOWN_STATES.has(state) ? (state as ProjectState) : 'unknown',
    checkouts: (Array.isArray(r['checkouts']) ? r['checkouts'] : []).map(parseCheckout),
    roleAgents: stringMap(r['roleAgents']),
    engine: parseEngine(engine),
    revision: requiredString(r, 'revision', `project ${projectId}`),
    ...(key ? { key } : {}),
    ...(invalidReason ? { invalidReason } : {}),
    ...(repositorySlug ? { repositorySlug } : {}),
    ...(pmAgentId ? { pmAgentId } : {}),
    ...(providerKind ? { providerKind } : {}),
  };
}

function parseCheckout(value: unknown): ProjectCheckout {
  const c = asObject(value, 'checkout');
  return {
    root: requiredString(c, 'root', 'checkout'),
    relativePath: requiredString(c, 'relativePath', 'checkout'),
    path: requiredString(c, 'path', 'checkout'),
    primary: c['primary'] === true,
  };
}

function parseEngine(e: Record<string, unknown>): ProjectEngine {
  const formula = optionalString(e['formula']);
  const readyLabel = optionalString(e['readyLabel']);
  const poolSize = typeof e['poolSize'] === 'number' && Number.isInteger(e['poolSize']) ? e['poolSize'] : undefined;
  return {
    enabled: e['enabled'] === true,
    ciChecks: Array.isArray(e['ciChecks']) ? e['ciChecks'].filter((c): c is string => typeof c === 'string') : [],
    ...(formula ? { formula } : {}),
    ...(readyLabel ? { readyLabel } : {}),
    ...(poolSize !== undefined ? { poolSize } : {}),
  };
}

/** The contract's error code from a refusal, or null when the error is not a refusal. */
function registryCode(err: unknown): string | null {
  if (err instanceof RegistryError) return err.code;
  const message = err instanceof Error ? err.message : '';
  const match = /refused: (invalid_request|cursor_stale|unknown_project)\b/.exec(message);
  return match ? match[1]! : null;
}

function asRegistryError(err: unknown): unknown {
  const code = registryCode(err);
  return code && !(err instanceof RegistryError) ? new RegistryError((err as Error).message, code) : err;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  const o = asOptionalObject(value);
  if (!o) throw new RegistryError(`${what} is not an object`, 'malformed_result');
  return o;
}

function asOptionalObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requiredString(o: Record<string, unknown>, field: string, what: string): string {
  const value = o[field];
  if (typeof value !== 'string' || value.length === 0) throw new RegistryError(`${what} has no ${field}`, 'malformed_result');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  const o = asOptionalObject(value) ?? {};
  return Object.fromEntries(Object.entries(o).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
