/**
 * bd CLI access for the engine. Every bd write in the engine goes through a
 * CommandRunner so bd's own validation, hooks and invariants apply; nothing
 * writes the Beads/Dolt tables directly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs a CLI with the given args and resolves with stdout. Rejects on failure. */
export type CommandRunner = (args: readonly string[]) => Promise<string>;

export interface CliRunnerOptions {
  readonly binary: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

/**
 * Non-blocking CLI runner (execFile, not execFileSync — the scheduler shares
 * the event loop with the HTTP API and must not stall it).
 */
export function createCliRunner(opts: CliRunnerOptions): CommandRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync(opts.binary, [...args], {
        encoding: 'utf-8',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 50 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      throw new Error(
        `${opts.binary} ${args.join(' ')} failed: ${(e.stderr ?? '').trim() || e.message || String(err)}`,
      );
    }
  };
}

/** Parse CLI JSON output, tolerating leading non-JSON noise (warnings). */
export function parseJsonOutput(raw: string, context: string): unknown {
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error(`${context}: no JSON in output`);
  try {
    return JSON.parse(raw.slice(start)) as unknown;
  } catch (err) {
    throw new Error(`${context}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

