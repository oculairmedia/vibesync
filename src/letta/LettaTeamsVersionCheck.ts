/**
 * Boot-time SDK ↔ CLI version assertion for letta-teams.
 *
 * Background (vibesync-3dz): the letta-teams stack is split into two
 * npm packages — `letta-teams-sdk` (what vibesync imports) and
 * `letta-teams` (the global CLI binary). The SDK spawns the daemon by
 * launching the CLI as a child process; if the two are on different
 * major or minor versions, IPC messages drift and the daemon fails to
 * start with a generic "Failed to start daemon" error. The first
 * Gastown bring-up cost 30+ minutes of debugging exactly that.
 *
 * This module is the once-on-boot guard. It:
 *
 *   1. Reads `letta-teams-sdk@VERSION` from the SDK package's
 *      package.json (resolved through `require.resolve` so we use the
 *      same copy the running process actually imports).
 *   2. Resolves the CLI entry path — preferring an explicit
 *      `LETTA_TEAMS_CLI_ENTRY` override, then `which letta-teams` on
 *      PATH. Errors out if neither is found.
 *   3. Spawns the resolved CLI with `--version` and parses the semver
 *      it prints.
 *   4. Compares SDK and CLI on major+minor (patch is allowed to drift
 *      — letta-teams keeps daemon IPC shapes stable within a minor).
 *   5. Throws `LettaTeamsVersionMismatchError` on skew with an
 *      operator-facing message that includes the exact
 *      `npm install -g letta-teams@X.Y.Z` command needed to fix it.
 *   6. Sets `process.env.LETTA_TEAMS_CLI_ENTRY` to the resolved path
 *      when the operator did not set it themselves, so the SDK's
 *      `startDaemonInBackground` does not fall back to `process.argv[1]`
 *      (vibesync's own src/index.ts — which is exactly how the
 *      original bring-up incident manifested).
 *
 * All process and filesystem calls go through `VersionCheckDeps` so
 * tests can pin every branch without touching real disk.
 */

import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VersionCheckDeps {
  /** Return the parsed `package.json` for `letta-teams-sdk`, or null
   *  when the SDK is not installed in any resolvable location. */
  readonly readSdkPackageJson: () => { version?: string } | null;
  /** Resolve the CLI path: prefer `cliEntryEnv` if set+nonempty, else
   *  search PATH. Return null when no CLI can be found. */
  readonly resolveCliPath: (cliEntryEnv: string | undefined) => string | null;
  /** Execute the CLI with `--version` and return its stdout. */
  readonly readCliVersion: (cliPath: string) => string;
  /** Mutate the process env. Defaults to assigning into process.env. */
  readonly setEnv: (key: string, value: string) => void;
}

export class LettaTeamsVersionMismatchError extends Error {
  readonly sdkVersion: string;
  readonly cliVersion: string;
  readonly cliPath: string;
  constructor(args: { sdkVersion: string; cliVersion: string; cliPath: string }) {
    super(
      `letta-teams version mismatch: letta-teams-sdk@${args.sdkVersion} is loaded but the ` +
        `letta-teams CLI at ${args.cliPath} reports ${args.cliVersion}. Run: ` +
        `npm install -g letta-teams@${args.sdkVersion}`,
    );
    this.name = 'LettaTeamsVersionMismatchError';
    this.sdkVersion = args.sdkVersion;
    this.cliVersion = args.cliVersion;
    this.cliPath = args.cliPath;
  }
}

export class LettaTeamsCliMissingError extends Error {
  constructor(sdkVersion: string) {
    super(
      `letta-teams CLI not found: LETTA_TEAMS_CLI_ENTRY is unset and "letta-teams" is not on PATH. ` +
        `Run: npm install -g letta-teams@${sdkVersion}`,
    );
    this.name = 'LettaTeamsCliMissingError';
  }
}

export class LettaTeamsSdkMissingError extends Error {
  constructor() {
    super(
      'letta-teams-sdk is not resolvable from this process — cannot enforce SDK/CLI version pin. ' +
        'Was the package removed from node_modules?',
    );
    this.name = 'LettaTeamsSdkMissingError';
  }
}

function defaultReadSdkPackageJson(): { version?: string } | null {
  // Walk up from this file looking for `node_modules/letta-teams-sdk/
  // package.json`. We deliberately avoid `require.resolve()` (Bun and
  // Node disagree on createRequire semantics in some configurations)
  // and the SDK's `exports` field (it does not publish ./package.json)
  // by replicating Node's own node_modules walk on the filesystem.
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let depth = 0; depth < 20; depth += 1) {
    const candidate = `${dir}/node_modules/letta-teams-sdk/package.json`;
    try {
      const raw = readFileSync(candidate, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === 'letta-teams-sdk') return pkg;
    } catch {
      // not here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function defaultResolveCliPath(cliEntryEnv: string | undefined): string | null {
  if (typeof cliEntryEnv === 'string' && cliEntryEnv.length > 0) {
    try {
      return realpathSync(cliEntryEnv);
    } catch {
      // Env explicitly set but path is broken — surface that as
      // "missing" rather than silently falling back to PATH; the
      // operator's intent was clearly to override.
      return null;
    }
  }
  try {
    const out = execFileSync('which', ['letta-teams'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim();
    if (!out) return null;
    try {
      return realpathSync(out);
    } catch {
      return out;
    }
  } catch (err) {
    const status = (err as SpawnSyncReturns<string>).status;
    // `which` exits non-zero when the binary is missing. Same outcome
    // whichever error code: treat as "no CLI found".
    void status;
    return null;
  }
}

function defaultReadCliVersion(cliPath: string): string {
  return execFileSync(cliPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function defaultSetEnv(key: string, value: string): void {
  process.env[key] = value;
}

export const defaultVersionCheckDeps: VersionCheckDeps = {
  readSdkPackageJson: defaultReadSdkPackageJson,
  resolveCliPath: defaultResolveCliPath,
  readCliVersion: defaultReadCliVersion,
  setEnv: defaultSetEnv,
};

/**
 * Parse a "X.Y.Z" semver string into [major, minor, patch]. Throws on
 * unparseable input. Leading "v" and trailing pre-release suffixes are
 * allowed; everything else after the third numeric group is ignored.
 */
export function parseSemver(raw: string): readonly [number, number, number] {
  const match = raw.trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`parseSemver: cannot parse "${raw}" as X.Y.Z`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface VersionAssertOptions {
  /** Read the override env value via this seam. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the default dep set — tests pin every branch through this. */
  readonly deps?: Partial<VersionCheckDeps>;
}

/**
 * The boot-time check itself. Throws on skew, on missing CLI, or on
 * unresolvable SDK. On success returns the SDK and CLI versions plus
 * the resolved CLI path so the caller can log them.
 */
export function assertLettaTeamsVersionMatch(opts: VersionAssertOptions = {}): {
  readonly sdkVersion: string;
  readonly cliVersion: string;
  readonly cliPath: string;
} {
  const env = opts.env ?? process.env;
  const deps: VersionCheckDeps = { ...defaultVersionCheckDeps, ...opts.deps };

  const pkg = deps.readSdkPackageJson();
  if (!pkg || typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new LettaTeamsSdkMissingError();
  }
  const sdkVersion = pkg.version;

  const cliEntryEnv = env['LETTA_TEAMS_CLI_ENTRY'];
  const cliPath = deps.resolveCliPath(cliEntryEnv);
  if (!cliPath) {
    throw new LettaTeamsCliMissingError(sdkVersion);
  }

  const cliVersionRaw = deps.readCliVersion(cliPath);
  const [sdkMajor, sdkMinor] = parseSemver(sdkVersion);
  const [cliMajor, cliMinor, cliPatch] = parseSemver(cliVersionRaw);
  if (sdkMajor !== cliMajor || sdkMinor !== cliMinor) {
    throw new LettaTeamsVersionMismatchError({
      sdkVersion,
      cliVersion: `${cliMajor}.${cliMinor}.${cliPatch}`,
      cliPath,
    });
  }

  if (!cliEntryEnv || cliEntryEnv.length === 0) {
    deps.setEnv('LETTA_TEAMS_CLI_ENTRY', cliPath);
  }

  return { sdkVersion, cliVersion: `${cliMajor}.${cliMinor}.${cliPatch}`, cliPath };
}
