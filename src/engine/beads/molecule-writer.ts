/**
 * Molecule writes through the bd CLI (vibesync-9lzk.9).
 *
 * Replaces the raw SQL writes DoltClient used to make, which bypassed bd's
 * validation and invariants. Reads stay on DoltClient: the ready-step query is
 * a join bd cannot express, and reads cannot violate bd's rules.
 *
 * Each method is a single bd call (atomic on its own), except creating a step,
 * which needs `create` then `dep add` because bd refuses an explicit id with
 * `--parent`. A crash between them leaves a step bead with no parent-child
 * edge; `findReadyStepsForMolecule` joins on that edge, so such a bead is never
 * offered. Cook-level crash recovery is a separate slice.
 *
 * Measured on bd 1.3.2: ~190 ms per update, ~500 ms per step create. A formula
 * step is an LLM turn of minutes, so this is well under 1% of a run.
 */
import { INFRA_RETRIES_KEY, LAST_FAILURE_CLASS_KEY, RETRY_ATTEMPT_KEY, RETRY_OUTCOME_KEY, REVIEW_ROUND_KEY, FAILURE_CLASS_KEY } from '../retry/policy.js';
import type { MoleculeOutcome } from '../molecule/molecule.js';
import type { BeadRow } from '../store/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandRunner } from './cli.js';

/** bd stores `close_reason` verbatim; keep it short like the SQL path did. */
const CLOSE_REASON_MAX = 200;
const ACTOR = 'orchestration-daemon';

export interface MoleculeBeadReader {
  getBead(id: string): Promise<BeadRow | null>;
}

type Exec = Record<string, unknown>;

/**
 * Pass metadata to bd as `@file` rather than an argv value: step input/output
 * payloads are agent text of unbounded size (one argv string is capped at
 * 128 KiB on Linux), and argv is visible to every process on the host.
 */
async function withMetadataFile<T>(metadata: Record<string, unknown>, run: (ref: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vibesync-bd-meta-'));
  const file = join(dir, 'metadata.json');
  try {
    await writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
    return await run(`@${file}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class BdMoleculeWriter {
  constructor(
    private readonly bd: CommandRunner,
    private readonly reader: MoleculeBeadReader,
  ) {}

  async insertMoleculeRoot(args: {
    readonly id: string;
    readonly formulaName: string;
    readonly title: string;
    readonly motivatingBeadId?: string;
    readonly projectIdentifier?: string;
    readonly delivers?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    const metadata = {
      ...(args.metadata ?? {}),
      exec: {
        formula: args.formulaName,
        ...(args.motivatingBeadId ? { motivating_bead: args.motivatingBeadId } : {}),
        ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
        ...(args.delivers ? { delivers: args.delivers } : {}),
      },
    };
    await this.create(args.id, 'molecule_root', args.title, metadata);
  }

  async insertMoleculeStep(args: {
    readonly id: string;
    readonly parentRootId: string;
    readonly stepName: string;
    readonly title: string;
    readonly dependsOnStepIds?: readonly string[];
    readonly inputPayload?: unknown;
  }): Promise<void> {
    // Validate before the first write: bd cannot roll a step back, so invalid
    // input must leave nothing behind rather than a half-linked bead.
    const deps = args.dependsOnStepIds ?? [];
    if (new Set(deps).size !== deps.length) throw new Error(`insertMoleculeStep ${args.id}: duplicate dependency in ${deps.join(', ')}`);
    if (deps.includes(args.id) || args.parentRootId === args.id) throw new Error(`insertMoleculeStep ${args.id}: a step cannot depend on itself`);
    await this.create(args.id, 'molecule_step', args.title, {
      exec: { step: args.stepName, molecule: args.parentRootId, input_payload: args.inputPayload },
    });
    // Blocking edges first: once the parent-child edge exists the step is
    // visible to the ready query, so it must already carry its blockers.
    for (const dep of deps) {
      await this.bd(['dep', 'add', args.id, dep, '--type', 'blocks', '--actor', ACTOR]);
    }
    await this.bd(['dep', 'add', args.id, args.parentRootId, '--type', 'parent-child', '--actor', ACTOR]);
  }

  async markStepRunning(stepId: string): Promise<void> {
    await this.bd(['update', stepId, '--status', 'in_progress', '--actor', ACTOR]);
  }

  async recordStepTask(stepId: string, task: {
    readonly taskId?: string;
    readonly providerKind: string;
    readonly sessionId: string;
    readonly conversationId?: string;
  }): Promise<void> {
    await this.mergeExec(stepId, {
      ...(task.taskId ? { task_id: task.taskId } : {}),
      provider_kind: task.providerKind,
      session_id: task.sessionId,
      ...(task.conversationId ? { conversation_id: task.conversationId } : {}),
    });
  }

  async recordStepAttempt(stepId: string, attempt: number): Promise<void> {
    await this.mergeExec(stepId, { attempts: attempt }, { [RETRY_ATTEMPT_KEY]: attempt });
  }

  /**
   * Reopen a failed try for its next attempt: status back to open (bd clears
   * closed_at/close_reason), counters written, and the declared failure class
   * moved to `gc.last_failure_class` so it cannot poison the next try.
   */
  async reopenStepForRetry(stepId: string, args: {
    readonly attempt: number;
    readonly infraRetries: number;
    readonly failureClass: string | null;
    readonly errorTrace: string;
  }): Promise<void> {
    const bead = await this.require(stepId);
    const metadata: Record<string, unknown> = {
      ...bead.metadata,
      exec: { ...execOf(bead), attempts: args.attempt, error_trace: args.errorTrace },
      [RETRY_ATTEMPT_KEY]: args.attempt,
      [INFRA_RETRIES_KEY]: args.infraRetries,
    };
    delete metadata[FAILURE_CLASS_KEY];
    if (args.failureClass) metadata[LAST_FAILURE_CLASS_KEY] = args.failureClass;
    await withMetadataFile(metadata, (ref) => this.bd(['update', stepId, '--status', 'open', '--metadata', ref, '--actor', ACTOR]));
    // `--metadata` merges top-level keys, so a removed key must be unset explicitly.
    if (FAILURE_CLASS_KEY in bead.metadata) {
      await this.bd(['update', stepId, '--unset-metadata', FAILURE_CLASS_KEY, '--actor', ACTOR]);
    }
  }

  async reopenStepForRound(stepId: string, args: { readonly round: number; readonly note: string }): Promise<void> {
    const bead = await this.require(stepId);
    const exec = execOf(bead);
    // A round starts clean: the previous round's output, task and outcome
    // belong to that round, and the retry counters start over.
    const { output_payload: _output, task_id: _task, session_id: _session, error_trace: _trace, ...keep } = exec;
    const metadata: Record<string, unknown> = {
      ...bead.metadata,
      exec: { ...keep, attempts: 1, round_note: args.note },
      [RETRY_ATTEMPT_KEY]: 1,
      [INFRA_RETRIES_KEY]: 0,
      [REVIEW_ROUND_KEY]: args.round,
    };
    delete metadata[RETRY_OUTCOME_KEY];
    delete metadata[FAILURE_CLASS_KEY];
    await withMetadataFile(metadata, (ref) => this.bd(['update', stepId, '--status', 'open', '--metadata', ref, '--actor', ACTOR]));
    if (RETRY_OUTCOME_KEY in bead.metadata) {
      await this.bd(['update', stepId, '--unset-metadata', RETRY_OUTCOME_KEY, '--actor', ACTOR]);
    }
  }

  async markStepDone(stepId: string, output: unknown): Promise<void> {
    const bead = await this.require(stepId);
    // A step that succeeds after a failed attempt is not failed: drop the old
    // error_trace (reopenStepForRetry keeps it), as reopenStepForRound does.
    const exec: Record<string, unknown> = { ...execOf(bead), output_payload: output };
    delete exec.error_trace;
    await withMetadataFile({ exec }, (ref) =>
      this.bd(['update', stepId, '--status', 'closed', '--metadata', ref, '--actor', ACTOR]));
  }

  async markStepFailed(stepId: string, errorTrace: string, retryOutcome?: string): Promise<void> {
    const bead = await this.require(stepId);
    const metadata: Record<string, unknown> = { exec: { ...execOf(bead), error_trace: errorTrace } };
    if (retryOutcome) metadata[RETRY_OUTCOME_KEY] = retryOutcome;
    await withMetadataFile(metadata, (ref) => this.bd(['update', stepId, '--metadata', ref, '--actor', ACTOR]));
    await this.bd(['close', stepId, '--reason', `step failed: ${errorTrace.slice(0, CLOSE_REASON_MAX)}`, '--actor', ACTOR]);
  }

  /**
   * Close a molecule root with its outcome. Forced: a failed or cancelled run
   * legitimately leaves steps that never ran, and bd otherwise refuses to close
   * a parent with open children.
   */
  async markMoleculeRootStatus(rootId: string, status: 'closed', outcome: MoleculeOutcome): Promise<void> {
    const bead = await this.require(rootId);
    await withMetadataFile({ exec: { ...execOf(bead), outcome } }, (ref) =>
      this.bd(['update', rootId, '--status', status, '--force', '--metadata', ref, '--actor', ACTOR]));
  }

  async appendNoteToBead(beadId: string, note: string): Promise<void> {
    const bead = await this.reader.getBead(beadId);
    if (!bead) throw new Error(`appendNoteToBead: bead ${beadId} not found`);
    // bd joins appended notes with one newline; a leading newline makes that a
    // blank-line separator between blocks. Only when notes already exist, so a
    // first note does not start with a stray blank line.
    const separator = bead.notes && bead.notes.length > 0 ? '\n' : '';
    await this.bd(['update', beadId, '--append-notes', `${separator}${note}`, '--actor', ACTOR]);
  }

  async addCommentToBead(beadId: string, comment: string): Promise<void> {
    await this.bd(['comments', 'add', beadId, comment]);
  }

  /** Stamp writeback status on a root; returns the previous stamp for replay dedupe. */
  async recordMoleculeWriteback(rootId: string, status: 'completed' | 'failed' | 'interrupted'): Promise<string | undefined> {
    const bead = await this.reader.getBead(rootId);
    if (!bead) throw new Error(`recordMoleculeWriteback: molecule ${rootId} not found`);
    const exec = execOf(bead);
    const previous = typeof exec['writeback_status'] === 'string' ? exec['writeback_status'] : undefined;
    await this.mergeExec(rootId, { writeback_status: status }, {}, bead);
    return previous;
  }

  private async create(id: string, type: string, title: string, metadata: Record<string, unknown>): Promise<void> {
    await withMetadataFile(metadata, (ref) =>
      this.bd(['create', '--id', id, '--type', type, '--title', title, '--metadata', ref, '--actor', ACTOR, '--silent']));
  }

  /** Merge keys into `metadata.exec` (and optionally top-level keys) with one bd write. */
  private async mergeExec(id: string, exec: Exec, topLevel: Record<string, unknown> = {}, known?: BeadRow): Promise<void> {
    const bead = known ?? await this.require(id);
    await withMetadataFile({ ...topLevel, exec: { ...execOf(bead), ...exec } }, (ref) =>
      this.bd(['update', id, '--metadata', ref, '--actor', ACTOR]));
  }

  private async require(id: string): Promise<BeadRow> {
    const bead = await this.reader.getBead(id);
    if (!bead) throw new Error(`molecule bead ${id} not found`);
    return bead;
  }
}

function execOf(bead: BeadRow): Exec {
  const exec = bead.metadata['exec'];
  return typeof exec === 'object' && exec !== null ? { ...(exec as Exec) } : {};
}
