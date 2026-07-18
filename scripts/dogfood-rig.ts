#!/usr/bin/env bun
import 'dotenv/config';

import { execFileSync } from 'node:child_process';

import { bootOrchestrationPlane } from '../src/orchestration/boot.js';
import { DoltClient, defaultDoltBootDeps } from '../src/orchestration/store/index.js';
import { SchedulerDaemon, type ReadyBeadSource, type FormulaResolver } from '../src/orchestration/scheduler/daemon.js';
import type { SlingContextStore } from '../src/orchestration/scheduler/sling-context.js';
import type { PoolMemberIdentity } from '../src/orchestration/scheduler/agent-pool.js';
import type { GitHubPort, PrFacts } from '../src/orchestration/scheduler/refinery.js';
import type { RunLivenessProbe } from '../src/orchestration/scheduler/witness.js';
import { loadPack } from '../src/orchestration/packs/index.js';
import { createSyncDatabase } from '../src/database.js';
import { resolveFromAppRoot } from '../src/runtimePaths.js';
import { RoleAgentBootstrapper } from '../src/letta/RoleAgentBootstrapper.js';

const beadId = mustEnv('VIBESYNC_DOGFOOD_BEAD_ID');
const agentId = process.env['VIBESYNC_DOGFOOD_AGENT_ID'] ?? 'agent-a9db7a7a';
const lettaBaseUrl = process.env['VIBESYNC_DOGFOOD_LETTA_BASE_URL'] ?? process.env['LETTA_CODE_SHIM_URL'] ?? 'http://localhost:8291';
const formulaName = process.env['VIBESYNC_DOGFOOD_FORMULA'] ?? 'onboard-feature';
const projectIdentifier = process.env['VIBESYNC_DOGFOOD_PROJECT'] ?? 'vibesync';
const dryRunMerge = process.env['VIBESYNC_DOGFOOD_DRY_RUN_MERGE'] !== '0';

const log = {
  info(obj: unknown, msg: string) { console.log(`[rig-dogfood] ${msg}`, JSON.stringify(obj)); },
  warn(obj: unknown, msg: string) { console.warn(`[rig-dogfood] ${msg}`, JSON.stringify(obj)); },
};

const dbPath = process.env['VIBESYNC_DB_PATH'] ?? resolveFromAppRoot('logs', 'sync-state.db');
const db = createSyncDatabase(dbPath);
const dolt = await DoltClient.connect({}, { ...defaultDoltBootDeps, log(level, obj, msg) { log[level](obj, msg); } });
const roleAgentBootstrapper = new RoleAgentBootstrapper({
  repo: { getRoleAgent: db.getRoleAgent.bind(db), upsertRoleAgent: db.upsertRoleAgent.bind(db) },
  defaultModel: process.env['VIBESYNC_DOGFOOD_MODEL'] ?? 'lmstudio/sonnet-4-5',
});
const orchestration = await bootOrchestrationPlane({
  dolt,
  providerRouting: {
    store: { getProjectProviderRouting: db.getProjectProviderRouting.bind(db) },
    roleAgentBootstrapper,
    packDirsByProject: { [projectIdentifier]: 'packs/gastown' },
    storageDirsByProject: { [projectIdentifier]: '/root/.letta/lc-local-backend' },
  },
});

const pack = loadPack(resolveFromAppRoot('packs', 'gastown'), 'global');
const formula = pack.formulas.find((candidate) => candidate.name === formulaName);
if (!formula) throw new Error(`Formula ${formulaName} not found in packs/gastown`);

const contextStore = makeContextStore();
const readyBeads: ReadyBeadSource = {
  async readyWorkBeadIds() { return new Set([beadId]); },
  async metadataFor(workBeadId) {
    const priority = priorityRank(readBdField(workBeadId, 'priority') ?? 'P2');
    const unblockCount = Number(readBdField(workBeadId, 'blocks_count') ?? '0') || 0;
    return { priority, unblockCount, files: [] };
  },
};
const formulaResolver: FormulaResolver = {
  async resolve(workBeadId) {
    const input = bdShow(workBeadId);
    return { formula, pack, projectIdentifier, input };
  },
};
const poolMembers: PoolMemberIdentity[] = [{ agentId, role: 'pm', lettaBaseUrl }];
const github: GitHubPort = dryRunMerge ? dryRunGitHub() : realGitHub();
const livenessProbe: RunLivenessProbe = { async probe() { return 'alive'; } };
const escalation = {
  async onIsolated(input: unknown) { log.warn(input, 'refinery isolated merge request'); },
  async onRepeatedRecovery(input: unknown) { log.warn(input, 'witness repeated recovery'); },
  async onBlocked(input: unknown) { log.warn(input, 'propulsion blocked; needs Meridian'); },
};

const daemon = new SchedulerDaemon({
  dispatcher: orchestration.dispatcher,
  formulaResolver,
  readyBeads,
  contextStore,
  poolMembers,
  github,
  requiredCheckNames: () => ['typecheck', 'test (18.x)', 'test (20.x)'],
  livenessProbe,
  escalation,
  config: () => ({ poolSize: 1, batchSize: 1, paused: false }),
  repoFor: () => 'oculairmedia/vibesync',
  logger: log,
});

console.log(`[rig-dogfood] starting one supervised tick bead=${beadId} agent=${agentId} dryRunMerge=${dryRunMerge}`);
const result = await daemon.tick();
console.log('[rig-dogfood] tick result', JSON.stringify(result, null, 2));
await orchestration.shutdown();

type Row = { id: string; description: string; tracks: string; open: boolean };
function makeContextStore(): SlingContextStore {
  const rows: Row[] = [];
  let seq = 0;
  return {
    async createSlingContext(input) {
      const existing = rows.find((row) => row.open && row.tracks === input.tracksWorkBeadId);
      if (existing) return existing.id;
      const id = `dogfood-${++seq}`;
      rows.push({ id, description: input.description, tracks: input.tracksWorkBeadId, open: true });
      log.info({ id, tracks: input.tracksWorkBeadId }, 'sling context created');
      return id;
    },
    async listOpenSlingContexts() { return rows.filter((row) => row.open).map((row) => ({ id: row.id, description: row.description })); },
    async closeSlingContext(contextId, reason) {
      const row = rows.find((candidate) => candidate.id === contextId);
      if (row) row.open = false;
      log.info({ contextId, reason }, 'sling context closed');
    },
  };
}

function dryRunGitHub(): GitHubPort {
  return {
    async fetchFacts(repo, prNumber, required) {
      const requiredChecks: Record<string, string> = {};
      required.forEach((name) => { requiredChecks[name] = 'SUCCESS'; });
      log.info({ repo, prNumber, required }, 'dry-run github fetchFacts');
      return { requiredChecks, mergeable: 'MERGEABLE', deletedFiles: 0, behindBase: false } satisfies PrFacts;
    },
    async merge(repo, prNumber) {
      log.warn({ repo, prNumber }, 'dry-run github merge skipped');
      return `dry-run-${prNumber}`;
    },
  };
}

function realGitHub(): GitHubPort {
  return {
    async fetchFacts(repo, prNumber, required) {
      const view = JSON.parse(execFileSync('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeable,statusCheckRollup'], { encoding: 'utf8' }));
      const requiredChecks: Record<string, string> = {};
      const checks = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [];
      for (const name of required) {
        const hit = checks.find((check: any) => check.name === name || check.context === name);
        requiredChecks[name] = hit?.conclusion ?? hit?.status ?? 'absent';
      }
      const diff = execFileSync('gh', ['pr', 'diff', String(prNumber), '--repo', repo], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      return { requiredChecks, mergeable: view.mergeable, deletedFiles: (diff.match(/^deleted file mode/gm) ?? []).length, behindBase: view.mergeable === 'BEHIND' };
    },
    async merge(repo, prNumber) {
      execFileSync('gh', ['pr', 'merge', String(prNumber), '--repo', repo, '--squash', '--delete-branch'], { encoding: 'utf8' });
      return `merged-${prNumber}`;
    },
  };
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function bdShow(id: string): string { return execFileSync('bd', ['show', id], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 }); }
function readBdField(_id: string, _field: string): string | null { return null; }
function priorityRank(value: string): number { const m = /P(\d+)/i.exec(value); return m ? Number(m[1]) : 2; }
