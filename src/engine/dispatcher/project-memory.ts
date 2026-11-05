/**
 * Project memory for formula steps (vibesync-9lzk.25).
 *
 * Role agents start every step in a fresh conversation and, until now, never
 * saw what earlier runs learned. The project's durable codebase knowledge lives
 * in Beads memories (`bd remember --key codebase-...`); this module reads them
 * before each step and renders them into the prompt with an instruction to
 * write new ones back, so each run starts from what the last ones learned.
 *
 * Memory improves a step; it must never stop one. A read failure yields no
 * memory section and the step runs as before.
 */
import type { CommandRunner } from '../beads/cli.js';

/** Only keys with this prefix are injected: codebase knowledge, not session notes. */
export const PROJECT_MEMORY_PREFIX = 'codebase-';

/** Keeps the prompt bounded however many memories accumulate. */
const MAX_MEMORY_CHARS = 8_000;

export interface ProjectMemorySource {
  /** Current `codebase-*` memories, key -> content. Empty on any failure. */
  read(): Promise<ReadonlyMap<string, string>>;
}

/** Reads `bd memories --json` (a JSON object of key -> content) through the project's bd. */
export function createBdProjectMemorySource(bd: CommandRunner): ProjectMemorySource {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await bd(['memories', '--json'])) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
        const out = new Map<string, string>();
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key.startsWith(PROJECT_MEMORY_PREFIX) && typeof value === 'string' && value.trim().length > 0) out.set(key, value.trim());
        }
        return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
      } catch {
        return new Map();
      }
    },
  };
}

/**
 * The prompt section: what is known about this codebase, then how to add to
 * it. Always includes the write-back instruction, even with no memories yet,
 * so the first run can start the record.
 */
export function renderProjectMemory(memories: ReadonlyMap<string, string>): string {
  const lines = ['', '---', '## What this project has learned (shared memory)', ''];
  if (memories.size === 0) {
    lines.push('No codebase notes yet.');
  } else {
    lines.push('Earlier runs recorded these facts about this codebase. Trust them over your assumptions; if one is wrong, correct it.', '');
    let used = 0;
    let shown = 0;
    for (const [key, value] of memories) {
      const entry = `- ${key}: ${value}`;
      if (used + entry.length > MAX_MEMORY_CHARS) break;
      lines.push(entry);
      used += entry.length;
      shown += 1;
    }
    if (shown < memories.size) {
      lines.push(`- (${memories.size - shown} more not shown; run \`bd memories ${PROJECT_MEMORY_PREFIX}\`)`);
    }
  }
  lines.push(
    '',
    'If you learn something durable about this codebase that would have saved you time',
    '(a trap, a convention, how a module really behaves), record it before you finish:',
    `\`bd remember --key ${PROJECT_MEMORY_PREFIX}<topic> "<one or two sentences>"\` (reuse a key to correct it).`,
    'Record verified facts only, never guesses, and nothing about this one task.',
  );
  return lines.join('\n');
}
