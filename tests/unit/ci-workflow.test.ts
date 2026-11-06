import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CI dependency installation', () => {
  it('uses better-sqlite3 prebuilds with a source-build fallback in every job', () => {
    const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
    const installSteps = workflow.split('      - name: Install dependencies').slice(1);

    expect(installSteps.length).toBeGreaterThan(0);
    for (const step of installSteps) {
      expect(step).toContain('bun install --frozen-lockfile --ignore-scripts');
      expect(step).toContain('npx prebuild-install || npm run build-release');
      expect(step).not.toContain('npm rebuild better-sqlite3');
    }
  });
});
