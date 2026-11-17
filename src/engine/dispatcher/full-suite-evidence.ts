/**
 * vibesync-6zos.7: a step that must run the full test suite proves it with the report, not its reply. Soak runs 2 and 4
 * failed the same way: the coder ran only the files it touched and its change broke tests in a file it never ran.
 *
 * A vitest JSON report proves a full-suite run when it was written by this step (its run started after the step did), it
 * lists EVERY test file in the repository (opt-in suites still appear, with their tests skipped), no test failed, and no
 * file failed to load (a file entry with no tests). Pure: the caller reads the report and lists the test files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The parts of a vitest `--reporter=json` report this check reads. */
export interface VitestReport {
  readonly startTime?: number;
  readonly numFailedTests?: number;
  readonly testResults?: ReadonlyArray<{
    readonly name?: string;
    readonly status?: string;
    readonly message?: string;
    readonly assertionResults?: ReadonlyArray<{ readonly status?: string; readonly fullName?: string; readonly title?: string }>;
  }>;
}

export interface FullSuiteEvidenceInput {
  /** The parsed report, or null when there is none. */
  readonly report: VitestReport | null;
  /** When the step's attempt started: a report from before it proves nothing about this step. */
  readonly stepStartedAt: Date;
  /** Every test file in the repository, relative to it (e.g. `tests/unit/x.test.ts`). */
  readonly testFiles: readonly string[];
  /**
   * The checkout the step ran in. When given, a report entry counts only at exactly `<workdir>/<file>`, so a report from
   * another checkout does not prove this one (outside review). Without it, entries match by relative-path suffix.
   */
  readonly workdir?: string;
}

/** Null when the report proves a passing full-suite run; otherwise why not, naming what is missing. */
export function fullSuiteShortfall(input: FullSuiteEvidenceInput): string | null {
  const { report, stepStartedAt, testFiles, workdir } = input;
  if (report === null) return 'full suite not run: no test report was written';
  if (typeof report.startTime !== 'number' || report.startTime < stepStartedAt.getTime()) {
    return 'full suite not run during this step: the test report is older than the step';
  }
  const files = report.testResults ?? [];
  const reported = new Set(files.map((f) => normalize(f.name ?? '')));
  const root = workdir === undefined ? undefined : normalize(workdir).replace(/\/+$/, '');
  const present = (f: string): boolean => (root !== undefined
    ? reported.has(`${root}/${normalize(f)}`)
    : [...reported].some((r) => r.endsWith(`/${normalize(f)}`) || r === normalize(f)));
  const missing = testFiles.filter((f) => !present(f));
  if (missing.length > 0) {
    return `full suite not run: ${missing.length} of ${testFiles.length} test files are not in the report (e.g. ${missing.slice(0, 3).join(', ')})`;
  }
  const unloaded = files.filter((f) => (f.assertionResults?.length ?? 0) === 0);
  if (unloaded.length > 0) {
    return `the suite did not load ${unloaded.length} test file(s): ${unloaded.slice(0, 3).map((f) => shortName(f.name)).join(', ')}`;
  }
  // A file whose suite failed (a hook threw, an error outside a test) can list only passing tests (outside review).
  const suiteFailed = files.find((f) => f.status === 'failed' && !(f.assertionResults ?? []).some((a) => a.status === 'failed'));
  if (suiteFailed) {
    return `the full suite has failures: ${shortName(suiteFailed.name)} failed outside its tests${suiteFailed.message ? ` (${suiteFailed.message.split('\n')[0]!.slice(0, 120)})` : ''}`;
  }
  for (const f of files) {
    const failed = (f.assertionResults ?? []).find((a) => a.status === 'failed');
    if (failed) return `the full suite has failures: ${shortName(f.name)}: ${failed.fullName ?? failed.title ?? 'a test'}`;
  }
  if ((report.numFailedTests ?? 0) > 0) return `the full suite has ${report.numFailedTests} failing test(s)`;
  // A report where nothing passed (every test skipped, by a filter or a config) proves nothing (CodeRabbit). A mix of
  // passed and skipped stays valid: opt-in suites skip their tests.
  if (!files.some((f) => (f.assertionResults ?? []).some((a) => a.status === 'passed'))) return 'full suite not proven: no test passed (every test was skipped)';
  return null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function shortName(name: string | undefined): string {
  const n = normalize(name ?? '?');
  const i = n.indexOf('/tests/');
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * The production evidence reader: the report the standing instructions name (`/tmp/vitest-<work bead>.json`), and every
 * `*.test.ts` under the workdir's `tests/`. A missing or unparseable report reads as null (the check then fails closed).
 */
export function vitestReportEvidence(reportDir = '/tmp'): { readReport(workBeadId: string): Promise<VitestReport | null>; listTestFiles(workdir: string): Promise<readonly string[]> } {
  return {
    async readReport(workBeadId) {
      const path = join(reportDir, `vitest-${workBeadId}.json`);
      if (!existsSync(path)) return null;
      try { return JSON.parse(readFileSync(path, 'utf8')) as VitestReport; } catch { return null; }
    },
    async listTestFiles(workdir) {
      const root = join(workdir, 'tests');
      if (!existsSync(root)) return [];
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          if (name === 'node_modules') continue;
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith('.test.ts')) out.push(relative(workdir, full));
        }
      };
      walk(root);
      return out;
    },
  };
}

