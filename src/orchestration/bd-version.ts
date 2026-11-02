/**
 * Minimum `bd` version the orchestration plane relies on (vibesync-efee).
 *
 * Formula steps are beads and dispatch uses bd's molecule-scoped readiness
 * (`bd ready --mol`, mirrored by DoltClient.findReadyStepsForMolecule), and the
 * durable-wait work builds on bd gates. Both were verified against bd 1.3.2.
 * A downgrade below this would silently remove primitives we rely on, so boot
 * and the preflight script refuse it and name the version they found.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MIN_BD_VERSION = '1.3.2';

export class BdVersionTooOldError extends Error {
  constructor(readonly found: string, readonly minimum: string = MIN_BD_VERSION) {
    super(
      `bd ${found} is older than the required minimum ${minimum}. ` +
        `Upgrade bd (formula steps rely on 'bd ready --mol' and gate primitives added in ${minimum}).`,
    );
    this.name = 'BdVersionTooOldError';
  }
}

/** Extract `major.minor.patch` from `bd --version` output ("bd version 1.3.2 (9b65b9e19)"). */
export function parseBdVersion(output: string): string | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Numeric semver comparison of two `x.y.z` strings: negative, 0, positive. */
export function compareBdVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when the `bd --version` output names a version >= `minimum`. Unparsable output is NOT satisfying. */
export function bdVersionSatisfies(output: string, minimum: string = MIN_BD_VERSION): boolean {
  const version = parseBdVersion(output);
  return version !== null && compareBdVersions(version, minimum) >= 0;
}

/**
 * Throws BdVersionTooOldError (carrying the version found) when below the
 * minimum, and a plain Error when the output has no recognisable version.
 */
export function assertBdVersion(output: string, minimum: string = MIN_BD_VERSION): string {
  const version = parseBdVersion(output);
  if (version === null) {
    throw new Error(`could not read a bd version from ${JSON.stringify(output.trim().slice(0, 120))}`);
  }
  if (compareBdVersions(version, minimum) < 0) throw new BdVersionTooOldError(version, minimum);
  return version;
}

/** Run `bd --version` (no shell) and return its stdout. */
export async function probeBdVersion(): Promise<string> {
  const { stdout } = await execFileAsync('bd', ['--version'], { timeout: 10_000 });
  return stdout;
}
