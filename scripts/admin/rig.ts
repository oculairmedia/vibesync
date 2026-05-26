#!/usr/bin/env bun
/**
 * scripts/admin/rig.ts — CLI wrapper around src/rig/provisioner.ts.
 *
 * Subcommands:
 *   audit              List all stacks, flag rigs missing Dolt remotes
 *   init <dir>         Provision a bd rig with prefix + Dolt remote
 *   repair <dir>       Add missing Dolt remote to an existing rig
 *
 * Usage:
 *   bun scripts/admin/rig.ts audit
 *   bun scripts/admin/rig.ts audit --json
 *   bun scripts/admin/rig.ts init /opt/stacks/my-project [--prefix myp]
 *   bun scripts/admin/rig.ts repair /opt/stacks/letta-code-parallel
 */

import { resolve } from 'node:path';
import {
  auditRigs,
  summarizeRigHealth,
  initRig,
  repairRig,
} from '../../src/rig/provisioner.js';

const STACKS_DIR = '/opt/stacks';

function printAudit(jsonMode: boolean) {
  const results = auditRigs(STACKS_DIR);

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const summary = summarizeRigHealth(results);
  const rigsMissing = results.filter(r => r.hasRig && !r.hasRemote);
  const rigsHealthy = results.filter(r => r.hasRig && r.hasRemote);

  console.log('=== Beads Rig Audit ===\n');
  console.log(`Total stacks: ${summary.total}`);
  console.log(`  With rig + remote: ${summary.healthy}`);
  console.log(`  With rig, NO remote: ${summary.degraded}`);
  console.log(`  No rig: ${summary.noRig}\n`);

  if (rigsMissing.length > 0) {
    console.log('--- Rigs missing Dolt remote (repairable) ---');
    for (const r of rigsMissing) {
      const fix = r.hasGitRemote
        ? `  repair: bun scripts/admin/rig.ts repair ${r.path}`
        : '  (no git remote — manual setup needed)';
      console.log(`  ${r.name}  prefix=${r.issuePrefix || '(none)'}  git=${r.hasGitRemote ? 'yes' : 'no'}`);
      console.log(fix);
    }
    console.log();
  }

  if (rigsHealthy.length > 0) {
    console.log('--- Rigs with remote (healthy) ---');
    for (const r of rigsHealthy) {
      console.log(`  ${r.name}  prefix=${r.issuePrefix || '(none)'}`);
    }
    console.log();
  }
}

function cliInit(dir: string, prefixOverride?: string) {
  const result = initRig(resolve(dir), prefixOverride);
  if (!result.ok) {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
  console.log(result.message);
}

function cliRepair(dir: string) {
  const result = repairRig(resolve(dir));
  if (!result.ok) {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
  console.log(result.message);
}

// --- CLI ---
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'audit':
    printAudit(args.includes('--json'));
    break;

  case 'init': {
    const dir = args[1];
    if (!dir) { console.error('Usage: rig.ts init <dir> [--prefix <p>]'); process.exit(1); }
    const prefixIdx = args.indexOf('--prefix');
    const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : undefined;
    cliInit(dir, prefix);
    break;
  }

  case 'repair': {
    const dir = args[1];
    if (!dir) { console.error('Usage: rig.ts repair <dir>'); process.exit(1); }
    cliRepair(dir);
    break;
  }

  default:
    console.log('Usage: rig.ts <audit|init|repair> [args]');
    console.log('  audit [--json]          Audit all stacks for rig health');
    console.log('  init <dir> [--prefix p] Initialize a new rig with Dolt remote');
    console.log('  repair <dir>            Add missing Dolt remote to existing rig');
    process.exit(1);
}
