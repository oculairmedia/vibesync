import { describe, expect, it } from 'vitest';

import { fullSuiteShortfall, type VitestReport } from '../../../../src/engine/dispatcher/full-suite-evidence.js';

// vibesync-6zos.7. Report shapes follow a real `vitest run --reporter=json` report (checked on this repo: 134 files on
// disk, 134 in the report; opt-in suites appear with their tests skipped).
const STARTED = new Date('2026-11-17T09:00:00Z');
const FILES = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/integration/opt-in.test.ts'];
const root = '/work/repo/';
const entry = (file: string, tests: Array<{ status: string; fullName?: string }>) => ({ name: root + file, status: 'passed', assertionResults: tests });
const full = (over: Partial<VitestReport> = {}): VitestReport => ({
  startTime: STARTED.getTime() + 1000,
  numFailedTests: 0,
  testResults: [
    entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
    entry('tests/unit/b.test.ts', [{ status: 'passed' }]),
    entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
  ],
  ...over,
});

describe('fullSuiteShortfall (vibesync-6zos.7)', () => {
  it('a complete, passing report written during the step proves the run', () => {
    expect(fullSuiteShortfall({ report: full(), stepStartedAt: STARTED, testFiles: FILES })).toBeNull();
  });
  it('opt-in suites whose tests are all skipped still count as run', () => {
    expect(fullSuiteShortfall({ report: full(), stepStartedAt: STARTED, testFiles: FILES })).toBeNull();
  });
  it('no report: full suite not run', () => {
    expect(fullSuiteShortfall({ report: null, stepStartedAt: STARTED, testFiles: FILES })).toMatch(/full suite not run/);
  });
  it('a report from before the step proves nothing (the false pass the bead names)', () => {
    expect(fullSuiteShortfall({ report: full({ startTime: STARTED.getTime() - 1 }), stepStartedAt: STARTED, testFiles: FILES })).toMatch(/older than the step/);
  });
  it('a run of named files only (soak run 4): full suite not run, naming a missing file', () => {
    const named = full({ testResults: [entry('tests/unit/a.test.ts', [{ status: 'passed' }])] });
    const why = fullSuiteShortfall({ report: named, stepStartedAt: STARTED, testFiles: FILES });
    expect(why).toMatch(/full suite not run: 2 of 3 test files are not in the report/);
    expect(why).toContain('tests/unit/b.test.ts');
  });
  it('a failing test fails it, naming the file and the test', () => {
    const failing = full({ numFailedTests: 1, testResults: [
      entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
      entry('tests/unit/b.test.ts', [{ status: 'failed', fullName: 'config requires the new field' }]),
      entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
    ] });
    expect(fullSuiteShortfall({ report: failing, stepStartedAt: STARTED, testFiles: FILES })).toBe('the full suite has failures: tests/unit/b.test.ts: config requires the new field');
  });
  it('a file that failed to load (no tests in its entry) fails it, even when no test is marked failed', () => {
    const unloaded = full({ testResults: [
      entry('tests/unit/a.test.ts', [{ status: 'passed' }]),
      entry('tests/unit/b.test.ts', []),
      entry('tests/integration/opt-in.test.ts', [{ status: 'skipped' }]),
    ] });
    expect(fullSuiteShortfall({ report: unloaded, stepStartedAt: STARTED, testFiles: FILES })).toMatch(/did not load 1 test file\(s\): tests\/unit\/b\.test\.ts/);
  });
  it('a failure counted in the totals but not attributed to a test still fails it', () => {
    expect(fullSuiteShortfall({ report: full({ numFailedTests: 2 }), stepStartedAt: STARTED, testFiles: FILES })).toMatch(/2 failing/);
  });
  it('a report with an extra file not on disk is fine: only files on disk must be present', () => {
    const extra = full({ testResults: [...(full().testResults ?? []), entry('tests/unit/gone.test.ts', [{ status: 'passed' }])] });
    expect(fullSuiteShortfall({ report: extra, stepStartedAt: STARTED, testFiles: FILES })).toBeNull();
  });
});
