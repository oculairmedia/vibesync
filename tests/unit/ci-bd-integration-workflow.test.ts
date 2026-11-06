import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/test.yml'), 'utf8');

describe('bd-backed integration CI', () => {
  it('installs checksum-pinned bd and Dolt before enabling all isolated suites', () => {
    const bdInstall = workflow.indexOf('name: Install pinned bd for isolated integration suites');
    const doltInstall = workflow.indexOf('name: Install pinned Dolt for isolated integration suites');
    const testRun = workflow.indexOf('name: Run tests with coverage');
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
});
