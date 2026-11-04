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

import { isRepoAllowed } from '../repo-allowlist.js';

import type { Pack } from '../packs/index.js';
import type { FormulaResolver, ReadyBeadSource, DaemonLogger } from './daemon.js';
import type {
  EscalationRecord,
  EscalationStore,
  NotificationTransport,
} from './escalation.js';
import type { GitHubPort, PrFacts } from './refinery.js';
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
      if (row['close_reason'] === 'cleared') continue;
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
}

export class BdReadyBeadSource implements ReadyBeadSource {
  private lastReady = new Map<string, Row>();

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
      if (id && !excluded.has(id)) next.set(id, row);
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
}

export class BdFormulaResolver implements FormulaResolver {
  private readonly formula: Pack['formulas'][number];

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
    return {
      formula: this.formula,
      pack: this.opts.pack,
      projectIdentifier: this.opts.projectIdentifier,
      input: `Bead ${workBeadId}: ${title}${description ? `\n\n${description}` : ''}`,
    };
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

// ---------------------------------------------------------------------------
// Escalation: bead comments + log/bus. NO agent messages.
// ---------------------------------------------------------------------------

/**
 * Escalations are recorded as a `NEEDS-MERIDIAN-DECISION: ...` comment on the
 * work bead (the convention Meridian's scanner already reads). The open/closed
 * record set is held in memory; a restart cannot duplicate a marker because
 * the existing comments are checked first.
 */
export class BdCommentEscalationStore implements EscalationStore {
  private readonly records = new Map<string, EscalationRecord>();
  private seq = 0;

  constructor(private readonly bd: CommandRunner) {}

  async createEscalation(input: {
    readonly workBeadId: string;
    readonly runId: string;
    readonly severity: EscalationRecord['severity'];
    readonly summary: string;
    readonly marker: string;
    readonly createdAt: string;
  }): Promise<EscalationRecord> {
    const existing = parseJsonOutput(await this.bd(['comments', input.workBeadId, '--json']), `bd comments ${input.workBeadId}`);
    const already = Array.isArray(existing) && existing.some((c) => (c as Row)['text'] === input.marker);
    if (!already) {
      await this.bd(['comments', 'add', input.workBeadId, input.marker]);
    }
    const record: EscalationRecord = {
      id: `esc-${++this.seq}`,
      workBeadId: input.workBeadId,
      runId: input.runId,
      severity: input.severity,
      summary: input.summary,
      state: 'open',
      createdAt: input.createdAt,
      lastNotifiedAt: input.createdAt,
      reescalationCount: 0,
    };
    this.records.set(record.id, record);
    return record;
  }

  async findOpenForWorkBead(workBeadId: string): Promise<EscalationRecord | null> {
    for (const r of this.records.values()) {
      if (r.state === 'open' && r.workBeadId === workBeadId) return r;
    }
    return null;
  }

  async listOpen(): Promise<EscalationRecord[]> {
    return [...this.records.values()].filter((r) => r.state === 'open');
  }

  async markReescalated(id: string, at: string): Promise<EscalationRecord> {
    const r = this.records.get(id);
    if (!r) throw new Error(`escalation ${id} not found`);
    const next: EscalationRecord = { ...r, lastNotifiedAt: at, reescalationCount: r.reescalationCount + 1 };
    this.records.set(id, next);
    return next;
  }

  async closeEscalation(id: string, _reason: string): Promise<void> {
    const r = this.records.get(id);
    if (r) this.records.set(id, { ...r, state: 'closed' });
  }
}

/**
 * Default transport: log only (the bus event is emitted by the composition).
 * Sending real agent messages requires an explicit transport to be injected.
 */
export function createLogNotificationTransport(logger: DaemonLogger | undefined): NotificationTransport {
  return {
    async notifyMeridian(input) {
      logger?.warn?.(
        { workBeadId: input.workBeadId, severity: input.severity, reescalation: input.reescalation },
        `scheduler escalation (log only, no agent message sent): ${input.summary}`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// GitHubPort
// ---------------------------------------------------------------------------

/**
 * Port that refuses everything. Wired when `autoMerge` is false so a merge is
 * impossible even if some future code path enqueues a merge request.
 */
export const disabledGitHubPort: GitHubPort = {
  async fetchFacts(): Promise<PrFacts> {
    throw new Error('scheduler auto-merge is disabled (set VIBESYNC_SCHEDULER_AUTO_MERGE=true to enable)');
  },
  async merge(): Promise<string> {
    throw new Error('scheduler auto-merge is disabled (set VIBESYNC_SCHEDULER_AUTO_MERGE=true to enable)');
  },
};

/** GitHubPort over the `gh` CLI. Only constructed when autoMerge is explicitly on. */
export class GhCliGitHubPort implements GitHubPort {
  private readonly headOids = new Map<string, string>();

  /**
   * @param allowedRepos owner/repo allowlist (vibesync-5c8y). Required, no default:
   *   an empty list refuses every repo. Defence in depth behind the daemon's own check.
   */
  constructor(
    private readonly gh: CommandRunner,
    private readonly allowedRepos: readonly string[],
  ) {}

  private assertAllowed(repo: string): void {
    if (!isRepoAllowed(repo, this.allowedRepos)) {
      throw new Error(`refusing GitHub access to ${JSON.stringify(repo)}: repo is not in scheduler.allowedRepos`);
    }
  }

  async fetchFacts(repo: string, prNumber: number, requiredCheckNames: readonly string[]): Promise<PrFacts> {
    this.assertAllowed(repo);
    const view = parseJsonOutput(
      await this.gh(['pr', 'view', String(prNumber), '-R', repo, '--json', 'mergeable,mergeStateStatus,statusCheckRollup,headRefOid']),
      `gh pr view ${repo}#${prNumber}`,
    ) as Row;
    const removedOut = await this.gh([
      'api', `repos/${repo}/pulls/${prNumber}/files`, '--paginate',
      '--jq', '[.[] | select(.status == "removed")] | length',
    ]);
    const deletedFiles = removedOut.split(/\s+/).filter(Boolean).reduce((n, tok) => n + (Number.parseInt(tok, 10) || 0), 0);

    const requiredChecks: Record<string, string> = {};
    const rollup = Array.isArray(view['statusCheckRollup']) ? (view['statusCheckRollup'] as Row[]) : [];
    for (const entry of rollup) {
      const name = String(entry['name'] ?? entry['context'] ?? '');
      if (!name || !requiredCheckNames.includes(name)) continue;
      // CheckRun: conclusion is null until complete (then status says why);
      // StatusContext: state. Upper-case so lowercase API variants still match.
      const value = String(entry['conclusion'] || entry['state'] || entry['status'] || 'UNKNOWN').toUpperCase();
      const prior = requiredChecks[name];
      if (prior === undefined || prior === 'SUCCESS') requiredChecks[name] = value;
    }

    const oid = String(view['headRefOid'] ?? '');
    if (oid) this.headOids.set(`${repo}#${prNumber}`, oid);

    return {
      requiredChecks,
      mergeable: String(view['mergeable'] ?? 'UNKNOWN'),
      deletedFiles,
      behindBase: String(view['mergeStateStatus'] ?? '') === 'BEHIND',
    };
  }

  async merge(repo: string, prNumber: number): Promise<string> {
    this.assertAllowed(repo);
    const oid = this.headOids.get(`${repo}#${prNumber}`);
    if (!oid) throw new Error(`refusing to merge ${repo}#${prNumber}: no verified head sha from fetchFacts`);
    // --match-head-commit: merge only the exact commit whose gates we checked.
    await this.gh(['pr', 'merge', String(prNumber), '-R', repo, '--squash', '--match-head-commit', oid]);
    return oid;
  }
}
