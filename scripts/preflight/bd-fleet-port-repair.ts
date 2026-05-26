#!/usr/bin/env bun
/**
 * bd-fleet-port-repair — central Beads/Dolt port allocator for registered projects.
 *
 * Default mode is a dry-run audit. It reports projects whose configured
 * `.beads/dolt-server.port` is either owned by another project's Dolt process
 * or duplicates another registered project. With --apply, it uses supported bd
 * commands only (`bd dolt set port`, `bd dolt start`) to move affected projects
 * to free ports. It never edits `.beads/dolt` contents and never kills by port.
 *
 * Usage:
 *   bun scripts/preflight/bd-fleet-port-repair.ts
 *   bun scripts/preflight/bd-fleet-port-repair.ts --json
 *   bun scripts/preflight/bd-fleet-port-repair.ts --apply
 *   bun scripts/preflight/bd-fleet-port-repair.ts --project letta-mobile --apply
 */

// @ts-expect-error bun-only import; resolved at runtime under Bun
import Database from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { preflight } from './bd-preflight.js';
import {
  DEFAULT_FLEET_PORT_END,
  DEFAULT_FLEET_PORT_START,
  defaultDeps as defaultSweeperDeps,
  detectConflict,
  pickFreePort,
  type SweeperProject,
} from '../../src/beads/PortSweeper.js';

interface ProjectRow {
  readonly identifier: string;
  readonly name: string;
  readonly filesystem_path: string | null;
  readonly status: string;
}

type FindingKind = 'port-owner-conflict' | 'duplicate-configured-port';
type FindingStatus = 'dry-run' | 'repaired' | 'failed';

interface Finding {
  readonly identifier: string;
  readonly name: string;
  readonly path: string;
  readonly kind: FindingKind;
  readonly currentPort: number;
  readonly recommendedPort: number;
  readonly detail: string;
  readonly commands: readonly string[];
  readonly status: FindingStatus;
  readonly error?: string;
}

interface Options {
  readonly apply: boolean;
  readonly json: boolean;
  readonly dbPath: string;
  readonly projects: ReadonlySet<string>;
  readonly startPort: number;
  readonly endPort: number;
}

function parseArgs(argv: readonly string[]): Options {
  const projects = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') {
      const value = argv[i + 1];
      if (!value) throw new Error('--project requires an identifier');
      for (const id of value.split(',').map((entry) => entry.trim()).filter(Boolean)) projects.add(id);
      i++;
    }
  }

  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    dbPath: readFlag(argv, '--db') ?? process.env.VIBESYNC_DB_PATH ?? '/opt/stacks/vibesync/logs/sync-state.db',
    projects,
    startPort: Number.parseInt(readFlag(argv, '--start-port') ?? String(DEFAULT_FLEET_PORT_START), 10),
    endPort: Number.parseInt(readFlag(argv, '--end-port') ?? String(DEFAULT_FLEET_PORT_END), 10),
  };
}

function readFlag(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readRegistry(dbPath: string): ProjectRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<ProjectRow, []>(
      `SELECT identifier, name, filesystem_path, status FROM projects WHERE status != 'archived'`,
    ).all();
  } finally {
    db.close();
  }
}

function candidateProjects(projects: readonly ProjectRow[], selected: ReadonlySet<string>): ProjectRow[] {
  return projects.filter((project) => {
    if (selected.size > 0 && !selected.has(project.identifier)) return false;
    if (!project.filesystem_path) return false;
    return existsSync(join(project.filesystem_path, '.beads', 'dolt')) && existsSync(join(project.filesystem_path, '.beads', 'dolt-server.port'));
  });
}

function asSweeperProject(row: ProjectRow): SweeperProject {
  return { identifier: row.identifier, filesystem_path: row.filesystem_path };
}

function commandPlan(projectPath: string, port: number): string[] {
  return [
    `cd ${projectPath} && bd dolt set port ${port}`,
    `cd ${projectPath} && bd dolt start`,
    `bun /opt/stacks/vibesync/scripts/preflight/bd-preflight.ts ${projectPath}`,
  ];
}

function applyRepair(projectPath: string, port: number): string | null {
  try {
    execFileSync('bd', ['dolt', 'set', 'port', String(port)], { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    execFileSync('bd', ['dolt', 'start'], { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const report = preflight(projectPath);
    const owner = report.checks.find((check) => check.name === 'dolt-server-port-owner');
    if (owner?.level === 'error') return owner.detail;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function auditAndMaybeRepair(opts: Options): Finding[] {
  const projects = candidateProjects(readRegistry(opts.dbPath), opts.projects);
  const sweeperRegistry = projects.map(asSweeperProject);

  const findings: Finding[] = [];

  for (const project of projects) {
    const conflict = detectConflict(asSweeperProject(project), sweeperRegistry, defaultSweeperDeps);
    if (!conflict) continue;

    // pickFreePort recomputes reservations from the registry + listening ports
    // each call, so two concurrently-broken projects won't collide on the same
    // replacement port — the just-repaired project's new port is in its own
    // .beads/dolt-server.port by the time the next loop iteration reads it.
    const recommendedPort = pickFreePort(sweeperRegistry, defaultSweeperDeps, opts.startPort, opts.endPort);
    findings.push(buildFinding({
      opts,
      project,
      kind: conflict.kind === 'duplicate-configured-port' ? 'duplicate-configured-port' : 'port-owner-conflict',
      currentPort: conflict.currentPort,
      recommendedPort,
      detail: conflict.detail,
    }));
  }

  return findings;
}

function buildFinding(args: {
  readonly opts: Options;
  readonly project: ProjectRow;
  readonly kind: FindingKind;
  readonly currentPort: number;
  readonly recommendedPort: number;
  readonly detail: string;
}): Finding {
  const projectPath = args.project.filesystem_path ?? '';
  const commands = commandPlan(projectPath, args.recommendedPort);
  if (!args.opts.apply) {
    return {
      identifier: args.project.identifier,
      name: args.project.name,
      path: projectPath,
      kind: args.kind,
      currentPort: args.currentPort,
      recommendedPort: args.recommendedPort,
      detail: args.detail,
      commands,
      status: 'dry-run',
    };
  }
  const error = applyRepair(projectPath, args.recommendedPort);
  return {
    identifier: args.project.identifier,
    name: args.project.name,
    path: projectPath,
    kind: args.kind,
    currentPort: args.currentPort,
    recommendedPort: args.recommendedPort,
    detail: args.detail,
    commands,
    status: error ? 'failed' : 'repaired',
    ...(error ? { error } : {}),
  };
}

function format(findings: readonly Finding[], opts: Options): string {
  const lines = [`# bd fleet port repair (${opts.apply ? 'apply' : 'dry-run'})`, ''];
  if (findings.length === 0) {
    lines.push('No Beads/Dolt port conflicts found.');
    return lines.join('\n');
  }
  for (const finding of findings) {
    const status = finding.status === 'failed' ? '✗' : finding.status === 'repaired' ? '✓' : '·';
    lines.push(`${status} ${finding.identifier} ${finding.kind}: ${finding.currentPort} -> ${finding.recommendedPort}`);
    lines.push(`  path: ${finding.path}`);
    lines.push(`  detail: ${finding.detail}`);
    if (finding.error) lines.push(`  error: ${finding.error}`);
    if (!opts.apply) {
      lines.push('  commands:');
      for (const command of finding.commands) lines.push(`    ${command}`);
    }
  }
  return lines.join('\n');
}

function main(): void {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const findings = auditAndMaybeRepair(opts);
    const failed = findings.filter((finding) => finding.status === 'failed').length;
    if (opts.json) {
      console.log(JSON.stringify({ dryRun: !opts.apply, total: findings.length, failed, findings }, null, 2));
    } else {
      console.log(format(findings, opts));
    }
    process.exit(failed > 0 ? 2 : findings.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
