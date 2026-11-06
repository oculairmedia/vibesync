import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/test.yml'), 'utf8');

/** The text of one top-level job (from its `  <name>:` line to the next job or end). */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('bd-backed integration CI', () => {
  it('installs checksum-pinned bd and Dolt before enabling all isolated suites', () => {
    const bdInstall = workflow.indexOf('name: Install pinned bd for isolated integration suites');
    const doltInstall = workflow.indexOf('name: Install pinned Dolt for isolated integration suites');
    const testRun = workflow.indexOf('name: Run bd-backed integration suites');
    const bdStep = workflow.slice(bdInstall, doltInstall);
    const doltStep = workflow.slice(doltInstall, testRun);

    expect(bdInstall).toBeGreaterThan(-1);
    expect(doltInstall).toBeGreaterThan(bdInstall);
    expect(testRun).toBeGreaterThan(doltInstall);
    expect(bdStep).toContain('sha256sum --check');
    expect(bdStep).toContain('releases/download/v1.3.2');
    expect(doltStep).toContain('releases/download/v2.7.2');
    expect(doltStep).toContain('72825a65d96bf0a0967ec408ad43bc21afc9b1c899b84cb84344a35f567fb11f');
    expect(doltStep).toContain('sha256sum --check');
    expect(workflow).toContain('VIBESYNC_TEST_BD: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('VIBESYNC_TEST_BD_WAKES: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('VIBESYNC_TEST_BD_WAITS: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('GITHUB_PATH');
  });

  it('keeps the bd-backed suites OUT of the required test job, in their own integration-bd job', () => {
    const test = job('test');
    const integration = job('integration-bd');
    expect(test).not.toBe('');
    expect(integration).not.toBe('');
    // The required test (20.x) job must not wait out real bd timers (it went from ~2 to ~24 min).
    expect(test).not.toContain('VIBESYNC_TEST_BD');
    expect(test).not.toContain('Install pinned bd');
    expect(integration).toContain('Install pinned bd for isolated integration suites');
    expect(integration).toContain('VIBESYNC_TEST_BD_WAKES: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(integration).toContain('vitest run tests/integration');
  });
});
