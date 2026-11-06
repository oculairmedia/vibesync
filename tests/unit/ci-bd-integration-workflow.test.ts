import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/test.yml'), 'utf8');

describe('bd-backed integration CI', () => {
  it('installs checksum-pinned bd and Dolt before enabling all isolated suites', () => {
    const bdInstall = workflow.indexOf('name: Install pinned bd for isolated integration suites');
    const doltInstall = workflow.indexOf('name: Install pinned Dolt for isolated integration suites');
    const testRun = workflow.indexOf('name: Run tests with coverage');

    expect(bdInstall).toBeGreaterThan(-1);
    expect(doltInstall).toBeGreaterThan(bdInstall);
    expect(testRun).toBeGreaterThan(doltInstall);
    expect(workflow).toContain('sha256sum --check');
    expect(workflow).toContain('VIBESYNC_TEST_BD: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('VIBESYNC_TEST_BD_WAKES: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('VIBESYNC_TEST_BD_WAITS: ${{ env.VIBESYNC_BD_BINARY }}');
    expect(workflow).toContain('GITHUB_PATH');
  });
});
