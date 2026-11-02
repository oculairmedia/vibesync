/**
 * Persisted PM-wake state (vibesync-2bgv).
 *
 * WHY A SMALL JSON FILE AND NOT A BEAD. Layering invariant 2 puts DOMAIN state
 * in Beads. "When did the loop last wake this project's PM" is not domain
 * state: it is the loop's own operational bookkeeping (a rate-limiter anchor),
 * it has no human audience, and writing it into bd would turn every wake into
 * a Dolt commit and make the wake log itself feed `bd ready`/event noise. The
 * only requirement is that a daemon restart must not reset the 8 h backstop
 * clock — a tiny atomically-written file satisfies that.
 *
 * Shape: one key per project, `{ firstSeenAt, lastWokenAt, lastByReason }`.
 * Writes are atomic (tmp file in the same directory + rename) and preserve
 * other projects' keys.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { WakeReason } from './pm-waker.js';

export interface PmWakeProjectState {
  /** ISO time the loop first observed this project (backstop anchor until the first wake). */
  firstSeenAt: string;
  /** ISO time of the last SUCCESSFUL wake of any reason; null if never woken. */
  lastWokenAt: string | null;
  /** ISO time of the last successful wake per reason. */
  lastByReason: Partial<Record<WakeReason, string>>;
}

export interface PmWakeStateStore {
  load(projectIdentifier: string): PmWakeProjectState | null;
  save(projectIdentifier: string, state: PmWakeProjectState): void;
}

type StateFile = Record<string, PmWakeProjectState>;

export class FilePmWakeStateStore implements PmWakeStateStore {
  constructor(
    private readonly filePath: string,
    private readonly logger?: { warn?(o: unknown, m: string): void },
  ) {}

  load(projectIdentifier: string): PmWakeProjectState | null {
    const entry = this.readAll()[projectIdentifier];
    if (!entry || typeof entry.firstSeenAt !== 'string') return null;
    return {
      firstSeenAt: entry.firstSeenAt,
      lastWokenAt: typeof entry.lastWokenAt === 'string' ? entry.lastWokenAt : null,
      lastByReason: entry.lastByReason && typeof entry.lastByReason === 'object' ? { ...entry.lastByReason } : {},
    };
  }

  save(projectIdentifier: string, state: PmWakeProjectState): void {
    const all = this.readAll();
    all[projectIdentifier] = state;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  private readAll(): StateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      this.logger?.warn?.({ file: this.filePath, error: String(err) }, 'pm-wake: state file unreadable — starting empty');
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StateFile) : {};
    } catch (err) {
      this.logger?.warn?.({ file: this.filePath, error: String(err) }, 'pm-wake: state file is not valid JSON — starting empty');
      return {};
    }
  }
}
