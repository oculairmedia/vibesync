/**
 * Real adapters for the SchedulerDaemon seams (vibesync-z2ws).
 *
 * The daemon (daemon.ts) and its components are written against narrow ports
 * (ReadyBeadSource, SlingContextStore, FormulaResolver, RunLivenessProbe,
 * EscalationStore, GitHubPort). This module backs those ports with the `bd`
 * and `gh` CLIs. Every adapter takes a `CommandRunner` — an injected function
 * that runs the CLI and returns stdout — so:
 *
 *   - the orchestration plane imports no database / HTTP client (layering
 *     invariant 1; same pattern as `providerRouting.store`), and
 *   - tests drive the REAL adapter logic with a fake runner instead of
 *     mocking the adapters themselves.
 *
 * Domain state stays in bd (invariant 2): sling contexts are bd beads, and
 * escalations are bd comments on the work bead.
 */


import type { Pack } from '../packs/index.js';
import type { DaemonLogger, FormulaResolver, ReadyBeadSource } from './daemon.js';
import {
  SLING_CONTEXT_LABEL,
  tryParseParams,
  type SlingCloseReason,
  type SlingContextStore,
} from './sling-context.js';
import type { RunLiveness, RunLivenessProbe, WorkingSlot } from './witness.js';


export { createCliRunner, parseJsonOutput, type CliRunnerOptions, type CommandRunner } from '../beads/cli.js';
import { parseJsonOutput, type CommandRunner } from '../beads/cli.js';

type Row = Record<string, unknown>;

function asRows(value: unknown, context: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected a JSON array`);
  return value.filter((r): r is Row => typeof r === 'object' && r !== null);
}

/** Issue types that are runtime / structural, never schedulable work. */
const NON_WORK_TYPES = 'epic,convoy,molecule,molecule_root,molecule_step,gate,event,message,decision,milestone';

// ---------------------------------------------------------------------------
// SlingContextStore on bd
// ---------------------------------------------------------------------------

/**
 * Sling contexts as bd beads. Created ephemeral so they stay out of humans'
 * `bd ready` / `bd list` (and are eligible for TTL compaction once closed);
 * the `tracks` edge ties each to its work bead, which is never modified.
 */
export class BdSlingContextStore implements SlingContextStore {
  constructor(private readonly bd: CommandRunner) {}

  async createSlingContext(input: {
    readonly label: string;
    readonly title: string;
    readonly description: string;
    readonly tracksWorkBeadId: string;
  }): Promise<string> {
    const out = await this.bd([
      'create',
      '--title', input.title,
      '--description', input.description,
      '-l', input.label,
      '--deps', `tracks:${input.tracksWorkBeadId}`,
      '--ephemeral',
      '--silent',
    ]);
    const id = out.trim();
    if (!id || /\s/.test(id)) {
      throw new Error(`bd create returned an unexpected sling-context id: ${JSON.stringify(out.slice(0, 120))}`);
    }
    return id;
  }

  async listOpenSlingContexts(label: string): Promise<ReadonlyArray<{ readonly id: string; readonly description: string }>> {
    const out = await this.bd(['list', '--label', label, '--status', 'open', '--limit', '0', '--include-ephemeral', '--json']);
    return asRows(parseJsonOutput(out, 'bd list (open sling contexts)'), 'bd list (open sling contexts)').map((r) => ({
      id: String(r['id'] ?? ''),
      description: String(r['description'] ?? ''),
    })).filter((r) => r.id.length > 0);
  }

  async closeSlingContext(contextId: string, reason: SlingCloseReason): Promise<void> {
    await this.bd(['close', contextId, '--reason', reason, '--json']);
  }

  /**
   * Work bead ids that already have a TERMINAL sling context (dispatched or
   * circuit-broken; `cleared` re-opens eligibility). The work bead is never
   * modified by the scheduler, so without this memory a bead that stays in
   * `bd ready` after dispatch would be re-scheduled — and re-run by an LLM —
   * on every tick.
   */
  async listTerminalWorkBeadIds(): Promise<Set<string>> {
    const out = await this.bd([
      'list', '--label', SLING_CONTEXT_LABEL, '--status', 'closed', '--limit', '0', '--include-ephemeral', '--json',
    ]);
    const ids = new Set<string>();
    for (const row of asRows(parseJsonOutput(out, 'bd list (closed sling contexts)'), 'bd list (closed sling contexts)')) {
      if (typeof row['close_reason'] === 'string' && row['close_reason'].toLowerCase().startsWith('cleared')) continue;
      const params = tryParseParams(String(row['description'] ?? ''));
      if (params) ids.add(params.work_bead_id);
    }
    return ids;
  }
}

// ---------------------------------------------------------------------------
// ReadyBeadSource on `bd ready`
// ---------------------------------------------------------------------------

export interface BdReadyBeadSourceOptions {
  readonly bd: CommandRunner;
  /** Only beads carrying this label are eligible. Empty = every ready work bead. */
  readonly readyLabel: string;
  /** Work beads to exclude (already dispatched / circuit-broken). */
  readonly excludeWorkBeadIds: () => Promise<ReadonlySet<string>>;
  readonly logger?: Pick<DaemonLogger, 'info'>;
}

export class BdReadyBeadSource implements ReadyBeadSource {
  private lastReady = new Map<string, Row>();
  private readonly loggedExcludedWorkBeadIds = new Set<string>();

  constructor(private readonly opts: BdReadyBeadSourceOptions) {}

  async readyWorkBeadIds(): Promise<Set<string>> {
    const args = [
      'ready', '--json', '--limit', '0',
      '--exclude-label', SLING_CONTEXT_LABEL,
      '--exclude-type', NON_WORK_TYPES,
      ...(this.opts.readyLabel ? ['--label', this.opts.readyLabel] : []),
    ];
    const rows = asRows(parseJsonOutput(await this.opts.bd(args), 'bd ready'), 'bd ready');
    const excluded = await this.opts.excludeWorkBeadIds();
    const next = new Map<string, Row>();
    for (const row of rows) {
      const id = String(row['id'] ?? '');
      if (!id) continue;
      if (excluded.has(id)) {
        if (!this.loggedExcludedWorkBeadIds.has(id)) {
          this.loggedExcludedWorkBeadIds.add(id);
          this.opts.logger?.info?.({ workBeadId: id, reason: 'terminal-sling-context' }, 'scheduler: ready bead excluded');
        }
        continue;
      }
      next.set(id, row);
    }
    this.lastReady = next;
    return new Set(next.keys());
  }

  async metadataFor(workBeadId: string): Promise<{ readonly priority: number; readonly unblockCount: number; readonly files: readonly string[] }> {
    const row = this.lastReady.get(workBeadId);
    const priority = Number(row?.['priority']);
    const unblock = Number(row?.['dependent_count']);
    return {
      priority: Number.isFinite(priority) ? priority : 2,
      unblockCount: Number.isFinite(unblock) ? unblock : 0,
      // No code-perception source is wired: file-overlap serialization is inert.
      files: [],
    };
  }
}

// ---------------------------------------------------------------------------
// FormulaResolver: config-selected formula from the loaded pack
// ---------------------------------------------------------------------------

export interface BdFormulaResolverOptions {
  readonly bd: CommandRunner;
  readonly pack: Pack;
  readonly formulaName: string;
  readonly projectIdentifier: string;
  readonly logger?: Pick<DaemonLogger, 'warn'>;
}

/** An optional bead metadata setting: where it lives, what makes it valid, and how a bad value is reported. */
interface MetadataSetting<T> {
  readonly key: string;
  readonly valid: (value: unknown) => value is T;
  readonly logField: string;
  readonly warning: string;
}

const STEP_TIMEOUT_SETTING: MetadataSetting<number> = {
  key: 'step_timeout_ms',
  valid: (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
  logField: 'stepTimeoutMs',
  warning: 'Ignoring invalid step_timeout_ms metadata',
};

const WORKDIR_SETTING: MetadataSetting<string> = {
  key: 'workdir',
  valid: (v): v is string => typeof v === 'string' && v.length > 0 && v.startsWith('/'),
  logField: 'workdir',
  warning: 'Ignoring invalid workdir metadata',
};

/** A bead's metadata when it is a plain object, else null. */
function metadataOf(bead: Row): Row | null {
  const metadata = bead['metadata'];
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? (metadata as Row) : null;
}

export class BdFormulaResolver implements FormulaResolver {
  private readonly formula: Pack['formulas'][number];
  /** Beads already warned about, per metadata key. */
  private readonly warnedInvalid = new Map<string, Set<string>>();

  constructor(private readonly opts: BdFormulaResolverOptions) {
    const formula = opts.pack.formulas.find((f) => f.name === opts.formulaName);
    if (!formula) {
      throw new Error(
        `scheduler formula "${opts.formulaName}" not found in pack "${opts.pack.manifest.name}" (available: ${opts.pack.formulas.map((f) => f.name).join(', ') || 'none'})`,
      );
    }
    this.formula = formula;
  }

  async resolve(workBeadId: string): ReturnType<FormulaResolver['resolve']> {
    const out = await this.opts.bd(['show', workBeadId, '--json']);
    const rows = asRows(parseJsonOutput(out, `bd show ${workBeadId}`), `bd show ${workBeadId}`);
    const bead = rows[0];
    if (!bead || bead['status'] === 'closed') return null;
    const title = String(bead['title'] ?? '');
    const description = String(bead['description'] ?? '');
    const metadata = metadataOf(bead);
    const stepTimeoutMs = this.validSetting(workBeadId, metadata, STEP_TIMEOUT_SETTING);
    const workdir = this.validSetting(workBeadId, metadata, WORKDIR_SETTING);
    return {
      formula: this.formula,
      pack: this.opts.pack,
      projectIdentifier: this.opts.projectIdentifier,
      input: `Bead ${workBeadId}: ${title}${description ? `\n\n${description}` : ''}`,
      ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
      ...(workdir !== undefined ? { workdir } : {}),
    };
  }

  /**
   * A bead's optional metadata setting: its value when valid, else undefined.
   * An invalid value is ignored with one warning per bead.
   */
  private validSetting<T>(workBeadId: string, metadata: Row | null, setting: MetadataSetting<T>): T | undefined {
    const raw = metadata?.[setting.key];
    if (raw === undefined) return undefined;
    if (setting.valid(raw)) return raw;
    const warned = this.warnedInvalid.get(setting.key) ?? new Set<string>();
    this.warnedInvalid.set(setting.key, warned);
    if (!warned.has(workBeadId)) {
      warned.add(workBeadId);
      this.opts.logger?.warn?.({ workBeadId, [setting.logField]: raw }, setting.warning);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// RunLivenessProbe
// ---------------------------------------------------------------------------

/**
 * Proves a slot dead only on hard evidence (work bead already closed). A bd
 * failure is thrown, which the Witness treats as "leave the slot alone".
 */
export class BdLivenessProbe implements RunLivenessProbe {
  constructor(private readonly bd: CommandRunner) {}

  async probe(slot: WorkingSlot): Promise<RunLiveness> {
    const out = await this.bd(['show', slot.workBeadId, '--json']);
    const bead = asRows(parseJsonOutput(out, `bd show ${slot.workBeadId}`), `bd show ${slot.workBeadId}`)[0];
    if (!bead) return 'run-missing';
    return bead['status'] === 'closed' ? 'bead-closed' : 'alive';
  }
}
