/**
 * vibesync-6zos.3: the TLA+ model check is wired into CI, and its gate is the
 * expected-results file, not "TLC exited 0".
 *
 * scripts/ci/tlc.sh itself is exercised by running it (CI job `tlc`); it needs
 * Java and a 2 MB download, so this suite only pins the wiring that a later
 * edit could silently undo.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve('.github/workflows/test.yml'), 'utf8');
const script = readFileSync(resolve('scripts/ci/tlc.sh'), 'utf8');
const expected = readFileSync(resolve('specs/EXPECTED'), 'utf8')
  .split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#')).map((line) => line.trim().split(/\s+/));
const configs = readdirSync(resolve('specs')).filter((name) => name.endsWith('.cfg')).map((name) => name.replace(/\.cfg$/, '')).sort();

/** The text of one top-level job (from its `  <name>:` line to the next job or end). */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('TLA+ model check in CI (vibesync-6zos.3)', () => {
  it('has its own job that runs the script, on every pull request and push', () => {
    const tlc = job('tlc');
    expect(tlc).not.toBe('');
    expect(tlc).toContain('run: scripts/ci/tlc.sh');
    expect(tlc).toContain('actions/setup-java@');
    expect(tlc).not.toMatch(/continue-on-error|if:\s/); // never skipped, never allowed to fail
  });

  it('pins the checker by version and checksum, with no way to override the checksum', () => {
    expect(script).toMatch(/^TLA2TOOLS_VERSION=1\.7\.4$/m);
    expect(script).toMatch(/^TLA2TOOLS_SHA256=[0-9a-f]{64}$/m);
    expect(script).not.toContain('${TLA2TOOLS_SHA256:-');
    expect(script).toContain('sha256sum --check');
    // The checksum is verified before the jar is run.
    expect(script.indexOf('sha256sum --check')).toBeLessThan(script.indexOf('tlc2.TLC'));
  });

  it('every configuration is listed in specs/EXPECTED exactly once, and nothing else is', () => {
    expect(expected.map(([name]) => name).sort()).toEqual(configs);
    expect(new Set(expected.map(([name]) => name)).size).toBe(expected.length);
    for (const [name, want, violation] of expected) {
      expect(['pass', 'fail'], name).toContain(want);
      if (want === 'fail') expect(violation, `${name} must name the violation`).toMatch(/^[A-Za-z]+$/);
      else expect(violation, `${name} passes: no violation`).toBeUndefined();
    }
  });

  it('the design in the code must pass, and the rejected designs must still fail', () => {
    const result = new Map(expected.map(([name, want, violation]) => [name, violation ? `${want} ${violation}` : want]));
    for (const shape of ['chain', 'fan']) {
      // What the code does.
      expect(result.get(`${shape}.single-writer`)).toBe('pass');
      expect(result.get(`${shape}.single-writer-timeout`)).toBe('pass');
      // cancel() as it was, and the fence designs TLC rejected.
      expect(result.get(`${shape}.main`)).toBe('fail StepResultIsFinal');
      expect(result.get(`${shape}.fence-before-judge`)).toBe('fail StepResultIsFinal');
      expect(result.get(`${shape}.fence-atomic-settled`)).toBe('fail StepResultIsFinal');
      // The stated limit: a tracker write slower than cancel()'s wait.
      expect(result.get(`${shape}.single-writer-slow-write`)).toBe('fail StepResultIsFinal');
    }
    // Review on #188: each half of the design in the code is shown necessary (fan shape).
    expect(result.get('fan.single-writer-snapshot')).toBe('fail ClosedRootHasOnlyClosedSteps');
    // The old refusal (claim, then refuse and give the run back) strands a step: outside review of PR #188.
    expect(result.get('chain.single-writer-cancel-refuse')).toBe('fail NoStrandedStep');
    // With the compare-and-set start and the full sweep, the model holds without the pre-start re-check (sessions are covered by unit tests).
    expect(result.get('fan.single-writer-timeout-no-recheck')).toBe('pass');
    expect(result.get('fan.fence-atomic-cancelling')).toBe('fail ClosedRootHasOnlyClosedSteps');
    // A gate with nothing that must fail could never show the checker working.
    expect(expected.filter(([, want]) => want === 'fail').length).toBeGreaterThanOrEqual(8);
  });

  it('the script compares each result with EXPECTED and fails on a configuration that is not listed', () => {
    expect(script).toContain('specs/EXPECTED and the *.cfg files do not name the same configurations');
    expect(script).toMatch(/if \[ "\$got" = "\$expect" \]/);
    expect(script).toContain('-workers 1'); // one worker: the violation reported first is the same on every run
  });

  it('the spec names the code it models and what it leaves out', () => {
    const spec = readFileSync(resolve('specs/MoleculeLifecycle.tla'), 'utf8');
    for (const name of ['ClosedRootHasOnlyClosedSteps', 'StepResultIsFinal', 'NoUnruledStepAtRest', 'EventuallySettles']) expect(spec).toContain(`${name} ==`);
    expect(spec).toContain('Not modelled:');
    // The limits outside review found (PR #188, rounds 3-5) stay written down: one dispatcher, unfenced late writes.
    expect(spec).toContain('LIMITS:');
    expect(spec).toContain('ONE dispatcher');
    expect(spec).toContain('src/engine/dispatcher');
  });
});
