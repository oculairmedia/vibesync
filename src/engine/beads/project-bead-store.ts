/** Work beads in another project are accessed only through that checkout's bd. */
import { parseJsonOutput, type CommandRunner } from './cli.js';
import type { BeadRow } from '../store/index.js';

const ACTOR = 'orchestration-daemon';

export interface ProjectBeadStore {
  getBead(id: string): Promise<BeadRow | null>;
  appendNoteToBead(beadId: string, note: string): Promise<void>;
}

function isNotFound(error: unknown, id: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Issue ${id} not found`);
}

export function createBdProjectBeadStore(bd: CommandRunner): ProjectBeadStore {
  async function getBead(id: string): Promise<BeadRow | null> {
    let raw: string;
    try {
      raw = await bd(['show', id, '--json']);
    } catch (error) {
      if (isNotFound(error, id)) return null;
      throw error;
    }
    const parsed = parseJsonOutput(raw, `bd show ${id}`);
    const row = Array.isArray(parsed) ? parsed.length === 1 ? parsed[0] : null : parsed;
    if (!row || typeof row !== 'object') throw new Error(`bd show ${id} returned an invalid bead response`);
    const r = row as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'] !== id) throw new Error(`bd show ${id} returned a mismatched bead id`);
    const str = (key: string, fallback = ''): string => typeof r[key] === 'string' ? r[key] as string : fallback;
    const date = (key: string): Date | null => typeof r[key] === 'string' ? new Date(r[key] as string) : null;
    return {
      id,
      title: str('title'),
      description: str('description'),
      status: str('status', 'open'),
      priority: typeof r['priority'] === 'number' ? r['priority'] : 2,
      issue_type: str('issue_type', 'task'),
      created_at: date('created_at') ?? new Date(0),
      updated_at: date('updated_at') ?? new Date(0),
      closed_at: date('closed_at'),
      metadata: r['metadata'] && typeof r['metadata'] === 'object' ? r['metadata'] as Record<string, unknown> : {},
      ...(typeof r['notes'] === 'string' ? { notes: r['notes'] } : {}),
    };
  }

  return {
    getBead,
    async appendNoteToBead(beadId, note) {
      const bead = await getBead(beadId);
      if (!bead) throw new Error(`appendNoteToBead: bead ${beadId} not found`);
      const separator = bead.notes && bead.notes.length > 0 ? '\n' : '';
      await bd(['update', beadId, '--append-notes', `${separator}${note}`, '--actor', ACTOR]);
    },
  };
}
