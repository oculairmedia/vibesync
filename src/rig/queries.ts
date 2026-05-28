import { execFile } from 'node:child_process';
import { readdirSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { auditRigs, summarizeRigHealth } from './provisioner.js';

export const DEFAULT_STACKS_DIR = '/opt/stacks';
const BD_TIMEOUT_MS = 10_000;

// ── Audit log ────────────────────────────────────────────────────
// Every write/dispatch tool invocation is appended to the vibesync
// rig's .beads/meridian-audit.jsonl. Derived from stacksDir so tests
// can isolate to a tempdir rather than polluting the production log.

export interface AuditEntry {
  ts: string;
  tool: string;
  agent?: string | undefined;
  input: Record<string, unknown>;
  result: 'ok' | 'error';
  detail?: string | undefined;
}

export function auditLogDir(stacksDir: string): string {
  return join(stacksDir, 'vibesync', '.beads');
}

export function appendAuditLog(entry: AuditEntry, stacksDir: string): void {
  try {
    const logDir = auditLogDir(stacksDir);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'meridian-audit.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
}

function audit(stacksDir: string, tool: string, input: Record<string, unknown>, result: 'ok' | 'error', detail?: string, agent?: string) {
  appendAuditLog({ ts: new Date().toISOString(), tool, agent, input, result, ...(detail ? { detail } : {}) }, stacksDir);
}

export function rigDirs(stacksDir: string, filter?: string[]): string[] {
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(stacksDir);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (entry.startsWith('_') || entry === 'tmp' || entry === 'node_modules') continue;
    const full = resolve(stacksDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(`${full}/.beads`)) continue;
    if (filter && filter.length > 0 && !filter.includes(entry)) continue;
    dirs.push(full);
  }
  return dirs.sort();
}

export function bdJson(args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('bd', args, { cwd, timeout: BD_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`bd ${args.join(' ')} in ${cwd} failed: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`bd ${args.join(' ')} in ${cwd}: invalid JSON output`));
      }
    });
  });
}

export function bdExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bd', args, { cwd, timeout: BD_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`bd ${args.join(' ')} in ${cwd} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function resolveRigDir(stacksDir: string, rig: string): string {
  const dirs = rigDirs(stacksDir, [rig]);
  if (dirs.length === 0) throw new Error(`Rig "${rig}" not found or has no .beads directory.`);
  return dirs[0]!;
}

export interface RigStatusResult {
  health: ReturnType<typeof summarizeRigHealth>;
  rigs: { name: string; path: string; hasRig: boolean; hasRemote: boolean; hasGitRemote: boolean; issuePrefix: string | null }[];
  activeDispatches: { rig: string; beads: unknown[] }[];
  recentActivity: { rig: string; beads: unknown[] }[];
}

export async function queryRigStatus(stacksDir: string, rig?: string): Promise<RigStatusResult> {
  const rigStatuses = auditRigs(stacksDir);
  const filtered = rig ? rigStatuses.filter(r => r.name === rig) : rigStatuses;

  if (rig && filtered.length === 0) {
    throw new Error(`Rig "${rig}" not found. Available rigs: ${rigStatuses.map(r => r.name).join(', ')}`);
  }

  const health = summarizeRigHealth(filtered);
  const rigsWithBeads = rigDirs(stacksDir, rig ? [rig] : undefined);
  const targetRigs = rig ? rigsWithBeads : rigsWithBeads.slice(0, 20);

  const activeDispatches: { rig: string; beads: unknown[] }[] = [];
  const recentActivity: { rig: string; beads: unknown[] }[] = [];

  await Promise.all(targetRigs.map(async (dir) => {
    const name = basename(dir);
    try {
      const inProgress = await bdJson(['list', '--json', '--status=in_progress'], dir) as unknown[];
      if (inProgress.length > 0) activeDispatches.push({ rig: name, beads: inProgress });
    } catch { /* skip */ }

    try {
      const recent = await bdJson(['list', '--json', '--status=open'], dir) as unknown[];
      const top5 = recent.slice(0, 5);
      if (top5.length > 0) recentActivity.push({ rig: name, beads: top5 });
    } catch { /* skip */ }
  }));

  return {
    health,
    rigs: filtered.map(r => ({
      name: r.name, path: r.path, hasRig: r.hasRig,
      hasRemote: r.hasRemote, hasGitRemote: r.hasGitRemote, issuePrefix: r.issuePrefix,
    })),
    activeDispatches,
    recentActivity: rig ? recentActivity : [],
  };
}

export interface BeadSummary {
  id: unknown; title: unknown; status: unknown; priority: unknown;
  issue_type: unknown; assignee: unknown; labels: unknown;
  created_at: unknown; updated_at: unknown;
}

export interface QueryBeadsResult {
  query: { rigs: string[] | string; status: string[]; search?: string | undefined; type?: string | undefined };
  total: number;
  results: { rig: string; beads: BeadSummary[] }[];
}

export async function queryBeads(
  stacksDir: string,
  opts: { rigs?: string[] | undefined; status?: string[] | undefined; search?: string | undefined; type?: string | undefined; limit?: number | undefined },
): Promise<QueryBeadsResult> {
  const dirs = rigDirs(stacksDir, opts.rigs);
  if (dirs.length === 0) throw new Error('No matching rigs found.');

  const targetDirs = dirs.slice(0, 30);
  const perRigLimit = opts.limit ?? 20;
  const statuses = opts.status ?? ['open', 'in_progress'];
  const results: { rig: string; beads: BeadSummary[] }[] = [];

  await Promise.all(targetDirs.map(async (dir) => {
    const name = basename(dir);
    const rigBeads: Record<string, unknown>[] = [];

    for (const s of statuses) {
      try {
        const beads = await bdJson(['list', '--json', `--status=${s}`], dir) as Record<string, unknown>[];
        rigBeads.push(...beads);
      } catch { /* skip */ }
    }

    let filtered = rigBeads;

    if (opts.search) {
      const term = opts.search.toLowerCase();
      filtered = filtered.filter(b =>
        String(b.title ?? '').toLowerCase().includes(term) ||
        String(b.description ?? '').toLowerCase().includes(term) ||
        (Array.isArray(b.labels) && b.labels.some((l: unknown) => String(l).toLowerCase().includes(term))),
      );
    }

    if (opts.type) {
      filtered = filtered.filter(b => b.issue_type === opts.type);
    }

    if (filtered.length > 0) {
      results.push({
        rig: name,
        beads: filtered.slice(0, perRigLimit).map(b => ({
          id: b.id, title: b.title, status: b.status, priority: b.priority,
          issue_type: b.issue_type, assignee: b.assignee, labels: b.labels,
          created_at: b.created_at, updated_at: b.updated_at,
        })),
      });
    }
  }));

  return {
    query: { rigs: opts.rigs ?? '(all)', status: statuses, ...(opts.search ? { search: opts.search } : {}), ...(opts.type ? { type: opts.type } : {}) },
    total: results.reduce((sum, r) => sum + r.beads.length, 0),
    results,
  };
}

export interface DispatchStepInfo {
  id: unknown; title: unknown; status: unknown; step: unknown;
  provider_kind: unknown; task_id: unknown; session_id: unknown;
  conversation_id: unknown; agent_id: unknown; attempts: unknown;
  error_trace: unknown; output_length: number | undefined;
}

export interface ShowDispatchResult {
  rig: string;
  dispatch: Record<string, unknown>;
  steps: DispatchStepInfo[];
  stepSummary: { total: number; open: number; in_progress: number; closed: number };
}

export async function showDispatch(
  stacksDir: string,
  dispatchId: string,
  rig?: string,
): Promise<ShowDispatchResult> {
  const dirs = rig ? rigDirs(stacksDir, [rig]) : rigDirs(stacksDir);

  for (const dir of dirs) {
    const name = basename(dir);
    try {
      const beads = await bdJson(['show', '--json', dispatchId], dir) as Record<string, unknown>[];
      if (!beads || beads.length === 0) continue;

      const root = beads[0] as Record<string, unknown>;
      const metadata = root.metadata as Record<string, unknown> | undefined;
      const exec = metadata?.exec as Record<string, unknown> | undefined;

      let steps: DispatchStepInfo[] = [];
      if (root.issue_type === 'molecule_root' || root.issue_type === 'molecule_step') {
        try {
          const allBeads = await bdJson(['list', '--json'], dir) as Record<string, unknown>[];
          steps = allBeads
            .filter(b => {
              const m = b.metadata as Record<string, unknown> | undefined;
              const e = m?.exec as Record<string, unknown> | undefined;
              return b.issue_type === 'molecule_step' && e?.molecule === dispatchId;
            })
            .map(b => {
              const m = b.metadata as Record<string, unknown> | undefined;
              const e = m?.exec as Record<string, unknown> | undefined;
              return {
                id: b.id, title: b.title, status: b.status, step: e?.step,
                provider_kind: e?.provider_kind, task_id: e?.task_id,
                session_id: e?.session_id, conversation_id: e?.conversation_id,
                agent_id: e?.agent_id, attempts: e?.attempts,
                error_trace: e?.error_trace,
                output_length: typeof (e?.output_payload as Record<string, unknown>)?.output === 'string'
                  ? ((e?.output_payload as Record<string, unknown>).output as string).length
                  : undefined,
              };
            });
        } catch { /* step query failed */ }
      }

      return {
        rig: name,
        dispatch: {
          id: root.id, title: root.title, status: root.status,
          issue_type: root.issue_type, priority: root.priority,
          created_at: root.created_at, updated_at: root.updated_at,
          closed_at: root.closed_at, formula: exec?.formula,
          motivating_bead: exec?.motivating_bead, writeback_status: exec?.writeback_status,
        },
        steps,
        stepSummary: {
          total: steps.length,
          open: steps.filter(s => s.status === 'open').length,
          in_progress: steps.filter(s => s.status === 'in_progress').length,
          closed: steps.filter(s => s.status === 'closed').length,
        },
      };
    } catch { /* not in this rig */ }
  }

  throw new Error(`Dispatch "${dispatchId}" not found in any rig.`);
}

// ── Tier 2: Write / dispatch ──────────────────────────────────────

export interface DispatchMoleculeInput {
  rig: string;
  formula: string;
  input: string;
  pack?: string | undefined;
  motivating_bead?: string | undefined;
  agent?: string | undefined;
  stacksDir?: string | undefined;
}

export interface DispatchMoleculeResult {
  moleculeId: string;
  formulaName: string;
  pack: string;
  rig: string;
}

export async function dispatchMolecule(
  apiUrl: string,
  opts: DispatchMoleculeInput,
): Promise<DispatchMoleculeResult> {
  const stacksDir = opts.stacksDir ?? DEFAULT_STACKS_DIR;
  const pack = opts.pack ?? 'gastown';
  const body: Record<string, unknown> = {
    input: opts.input,
    pack,
    projectIdentifier: opts.rig,
  };
  if (opts.motivating_bead) body.motivatingBeadId = opts.motivating_bead;

  const res = await fetch(`${apiUrl}/formulas/${encodeURIComponent(opts.formula)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `Formula dispatch failed: HTTP ${res.status} — ${text || res.statusText}`;
    audit(stacksDir, 'vibesync_dispatch_molecule', opts as unknown as Record<string, unknown>, 'error', msg, opts.agent);
    throw new Error(msg);
  }

  const data = await res.json() as Record<string, unknown>;
  const result: DispatchMoleculeResult = {
    moleculeId: String(data.moleculeId ?? ''),
    formulaName: opts.formula,
    pack,
    rig: opts.rig,
  };
  audit(stacksDir, 'vibesync_dispatch_molecule', opts as unknown as Record<string, unknown>, 'ok', result.moleculeId, opts.agent);
  return result;
}

export interface AssignBeadInput {
  bead_id: string;
  rig: string;
  assignee: string;
  claim?: boolean | undefined;
  agent?: string | undefined;
}

export interface AssignBeadResult {
  bead_id: string;
  rig: string;
  assignee: string;
  claimed: boolean;
  bead: unknown;
}

export async function assignBead(
  stacksDir: string,
  opts: AssignBeadInput,
): Promise<AssignBeadResult> {
  const dir = resolveRigDir(stacksDir, opts.rig);
  const args = ['update', opts.bead_id, '--assignee', opts.assignee];
  if (opts.claim !== false) args.push('--claim');
  await bdExec(args, dir);

  let bead: unknown = null;
  try {
    const beads = await bdJson(['show', '--json', opts.bead_id], dir) as unknown[];
    bead = beads[0] ?? null;
  } catch { /* show failed, still return the assignment result */ }

  const result: AssignBeadResult = {
    bead_id: opts.bead_id,
    rig: opts.rig,
    assignee: opts.assignee,
    claimed: opts.claim !== false,
    bead,
  };
  audit(stacksDir, 'vibesync_assign_bead', opts as unknown as Record<string, unknown>, 'ok', undefined, opts.agent);
  return result;
}

export type ReviewDecision = 'accept' | 'reject' | 'changes_requested';

export interface ReviewDispatchInput {
  dispatch_id: string;
  rig?: string | undefined;
  decision: ReviewDecision;
  notes: string;
  agent?: string | undefined;
}

export interface ReviewDispatchResult {
  dispatch_id: string;
  rig: string;
  decision: ReviewDecision;
  dispatch_closed: boolean;
}

export async function reviewDispatch(
  stacksDir: string,
  opts: ReviewDispatchInput,
): Promise<ReviewDispatchResult> {
  const dispatch = await showDispatch(stacksDir, opts.dispatch_id, opts.rig);
  const dir = resolveRigDir(stacksDir, dispatch.rig);

  const notePrefix = `[review:${opts.decision}]`;
  await bdExec(['update', opts.dispatch_id, '--append-notes', `${notePrefix} ${opts.notes}`], dir);

  let dispatchClosed = false;
  if (opts.decision === 'accept') {
    try {
      await bdExec(['close', opts.dispatch_id], dir);
      dispatchClosed = true;
    } catch { /* close may fail if already closed or has open steps */ }
  }

  const result: ReviewDispatchResult = {
    dispatch_id: opts.dispatch_id,
    rig: dispatch.rig,
    decision: opts.decision,
    dispatch_closed: dispatchClosed,
  };
  audit(stacksDir, 'vibesync_review_dispatch', opts as unknown as Record<string, unknown>, 'ok', opts.decision, opts.agent);
  return result;
}

// ── Tier 3: Verification + merge gate ─────────────────────────────

export interface VerifyPrInput {
  rig: string;
  pr_number: number;
  suite?: string | undefined;
  agent?: string | undefined;
}

export interface VerifyPrResult {
  rig: string;
  pr_number: number;
  suite: string;
  exit_code: number;
  passed: boolean;
  output: string;
}

export async function verifyPr(
  stacksDir: string,
  opts: VerifyPrInput,
): Promise<VerifyPrResult> {
  const dir = resolveRigDir(stacksDir, opts.rig);
  const suite = opts.suite ?? 'typecheck';

  const commands: Record<string, string[]> = {
    typecheck: ['npx', 'tsc', '--noEmit'],
    test: ['npx', 'vitest', 'run', '--reporter=verbose'],
    lint: ['npx', 'eslint', '.', '--max-warnings=0'],
  };

  const cmd = commands[suite];
  if (!cmd) throw new Error(`Unknown suite "${suite}". Available: ${Object.keys(commands).join(', ')}`);

  const result = await new Promise<{ exitCode: number; output: string }>((resolve) => {
    execFile(cmd[0]!, cmd.slice(1), { cwd: dir, timeout: 120_000, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      if (err && 'code' in err && typeof err.code === 'number') {
        resolve({ exitCode: err.code, output: output.slice(-4000) });
      } else if (err) {
        resolve({ exitCode: 1, output: (err.message + '\n' + output).slice(-4000) });
      } else {
        resolve({ exitCode: 0, output: output.slice(-4000) });
      }
    });
  });

  const out: VerifyPrResult = {
    rig: opts.rig,
    pr_number: opts.pr_number,
    suite,
    exit_code: result.exitCode,
    passed: result.exitCode === 0,
    output: result.output,
  };
  audit(stacksDir, 'vibesync_verify_pr', opts as unknown as Record<string, unknown>, out.passed ? 'ok' : 'error', `exit=${result.exitCode}`, opts.agent);
  return out;
}

export interface RequestMergeInput {
  rig: string;
  pr_number: number;
  justification: string;
  agent?: string | undefined;
}

export interface RequestMergeResult {
  rig: string;
  pr_number: number;
  merge_request_bead: string;
  status: 'queued_for_human_approval';
}

export async function requestMerge(
  stacksDir: string,
  opts: RequestMergeInput,
): Promise<RequestMergeResult> {
  const dir = resolveRigDir(stacksDir, opts.rig);

  const createArgs = [
    'create',
    '--title', `[merge-request] PR #${opts.pr_number} — ${opts.rig}`,
    '--description', `Merge requested for PR #${opts.pr_number}.\n\nJustification: ${opts.justification}\n\nRequested by: ${opts.agent ?? 'unknown'}\n\n**This requires human approval before merging.**`,
    '--type', 'task',
    '--priority', '1',
    '--labels', `merge-request,pr:${opts.pr_number}`,
  ];

  const output = await bdExec(createArgs, dir);
  const idMatch = output.match(/Created issue:\s*([a-z0-9]+(?:-[a-z0-9]+)+)/i)
    ?? output.match(/([a-z]+(?:-[a-z0-9]+)+)/i);
  const beadId = idMatch ? idMatch[1]! : output.trim();

  const result: RequestMergeResult = {
    rig: opts.rig,
    pr_number: opts.pr_number,
    merge_request_bead: beadId,
    status: 'queued_for_human_approval',
  };
  audit(stacksDir, 'vibesync_request_merge', opts as unknown as Record<string, unknown>, 'ok', beadId, opts.agent);
  return result;
}
