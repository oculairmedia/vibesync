import { execFileSync } from 'node:child_process';

export interface ProjectEngineSettings {
  readonly formula?: string;
  readonly readyLabel?: string;
  readonly poolSize?: number;
  readonly ciChecks?: readonly string[];
}

export type ProjectSettingsSource = (projectIdentifier: string) => ProjectEngineSettings;

export class ProjectSettingsError extends Error {
  constructor(project: string, field: string, rule: string) {
    super(`project "${project}" settings field "${field}" ${rule}`);
    this.name = 'ProjectSettingsError';
  }
}

const MAX_FILE_BYTES = 16 * 1024;
const FORMULA = /^[a-z0-9][a-z0-9-]{0,63}$/;
const READY_LABEL = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One field of the `engine` block: how to check it and what to say when it is
 * wrong. A field that is absent keeps the engine's default; a field that is
 * present and fails its check fails the whole file.
 */
const ENGINE_FIELDS: readonly { readonly name: keyof ProjectEngineSettings; readonly valid: (value: unknown) => boolean; readonly rule: string }[] = [
  { name: 'formula', valid: (v) => typeof v === 'string' && FORMULA.test(v), rule: 'must match [a-z0-9][a-z0-9-]{0,63}' },
  { name: 'readyLabel', valid: (v) => typeof v === 'string' && READY_LABEL.test(v), rule: 'must match [a-z0-9][a-z0-9:_-]{0,63}' },
  { name: 'poolSize', valid: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 8, rule: 'must be an integer from 1 to 8' },
  { name: 'ciChecks', valid: (v) => Array.isArray(v) && v.length <= 16, rule: 'must be an array of at most 16 strings' },
];

function isCheckName(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100;
}

/** The parsed `engine` block of a project file, or null when the file has none. */
function readEngineBlock(projectIdentifier: string, content: string): Record<string, unknown> | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ProjectSettingsError(projectIdentifier, 'file', 'must be at most 16 KiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProjectSettingsError(projectIdentifier, 'file', 'must contain strict JSON');
  }
  if (!isRecord(parsed)) throw new ProjectSettingsError(projectIdentifier, 'file', 'must contain a JSON object');
  const engine = parsed['engine'];
  if (engine === undefined) return null;
  if (!isRecord(engine)) throw new ProjectSettingsError(projectIdentifier, 'engine', 'must be an object');
  return engine;
}

/** The validated engine settings; unknown fields are ignored. */
function validateEngine(projectIdentifier: string, engine: Record<string, unknown>): ProjectEngineSettings {
  const settings: Mutable<ProjectEngineSettings> = {};
  for (const field of ENGINE_FIELDS) {
    const value = engine[field.name];
    if (value === undefined) continue;
    if (!field.valid(value)) throw new ProjectSettingsError(projectIdentifier, `engine.${field.name}`, field.rule);
    (settings as Record<string, unknown>)[field.name] = value;
  }
  if (settings.ciChecks && !settings.ciChecks.every(isCheckName)) {
    throw new ProjectSettingsError(projectIdentifier, 'engine.ciChecks', 'entries must be strings of 1 to 100 characters');
  }
  return settings;
}

export function createProjectFileSettingsSource(args: {
  readonly checkoutOf: (projectIdentifier: string) => string | null | undefined;
  readonly readCommittedFile: (checkout: string, path: string) => string | null;
}): ProjectSettingsSource {
  return (projectIdentifier) => {
    const checkout = args.checkoutOf(projectIdentifier);
    const content = checkout ? args.readCommittedFile(checkout, '.meridian/project.json') : null;
    if (content === null) return {};
    const engine = readEngineBlock(projectIdentifier, content);
    return engine ? validateEngine(projectIdentifier, engine) : {};
  };
}

/** Where to look for a checkout's default branch, most specific first. */
const DEFAULT_BRANCH_CANDIDATES = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'] as const;

/**
 * The commit that stands for a checkout's default branch: `origin/HEAD` when
 * the clone recorded it, else origin/main, origin/master, main or master, and
 * only when none exists the checked-out HEAD. A checkout sitting on a feature
 * branch (common on this host: 17 of 37 sampled checkouts have no origin/HEAD)
 * must not have its settings read from that branch.
 */
function defaultBranchRef(git: (args: readonly string[]) => string): string {
  try {
    const remoteHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim();
    if (remoteHead) return remoteHead;
  } catch {
    // no recorded origin/HEAD: try the usual names
  }
  for (const ref of DEFAULT_BRANCH_CANDIDATES) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // not present: next candidate
    }
  }
  return 'HEAD';
}

/**
 * A file as committed on the checkout's default branch (see defaultBranchRef).
 * The working tree is never read, so a branch under review or an uncommitted
 * edit cannot change engine behaviour. Returns null when the file is not in
 * that commit; any other git failure throws.
 */
export function readDefaultBranchCommittedFile(checkout: string, filePath: string): string | null {
  const git = (args: readonly string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return readCommittedFileAt(checkout, defaultBranchRef(git), filePath);
}

/** A file as committed at `ref` in `checkout`; null when that commit does not have it. */
export function readCommittedFileAt(checkout: string, ref: string, filePath: string): string | null {
  const git = (args: readonly string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['cat-file', '-e', `${ref}:${filePath}`]);
  } catch {
    return null;
  }
  return git(['show', `${ref}:${filePath}`]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The engine's two settings readers (vibesync-9lzk.55.4). A project's settings
 * come from its own checkout's default branch. The home project's CI checks
 * come from its file as committed in the running release (HEAD of
 * `releaseRoot`), so they change only with a deploy. An invalid file gives no
 * checks, so that project's final steps end unsettled; the reason is logged.
 */
export function createProjectSettings(args: {
  readonly checkoutOf: (projectIdentifier: string) => string | null | undefined;
  readonly releaseRoot: string;
  readonly warn: (obj: Record<string, unknown>, msg: string) => void;
}): { readonly forProject: ProjectSettingsSource; readonly ciChecks: (projectIdentifier: string | undefined) => readonly string[] } {
  const forProject = createProjectFileSettingsSource({ checkoutOf: args.checkoutOf, readCommittedFile: readDefaultBranchCommittedFile });
  const forRelease = createProjectFileSettingsSource({
    checkoutOf: () => args.releaseRoot,
    readCommittedFile: (checkout, file) => readCommittedFileAt(checkout, 'HEAD', file),
  });
  const ciChecks = (projectIdentifier: string | undefined): readonly string[] => {
    const project = projectIdentifier ?? 'home';
    try {
      return (projectIdentifier ? forProject(project) : forRelease(project)).ciChecks ?? [];
    } catch (err) {
      args.warn({ project, err }, 'Project settings are invalid; CI checks cannot be configured');
      return [];
    }
  };
  return { forProject, ciChecks };
}
