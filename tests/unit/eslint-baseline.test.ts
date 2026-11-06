import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

describe('ESLint baseline gate', () => {
  it('rejects a new violation even when the file already has baselined findings', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-'));
    const extraFile = path.join(repoRoot, 'src/engine/baseline-regression.test-lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      const violations = Object.keys(baseline).filter((key) => key.startsWith('src/engine/'));
      for (const violation of violations) baseline[violation] = 0;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));
      writeFileSync(extraFile, 'const regression: any = 1;\n');
      const checkScript = readFileSync(path.join(repoRoot, 'scripts/eslint-baseline-check.mjs'), 'utf8')
        .replace("path.join(root, 'eslint-baseline.json')", `path.join(root, ${JSON.stringify(path.join(temporaryDir, 'eslint-baseline.json'))})`);
      const checkPath = path.join(temporaryDir, 'check.mjs');
      writeFileSync(checkPath, checkScript);
      const result = spawnSync(process.execPath, [checkPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: extraFile },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ESLint introduced');
    } finally {
      rmSync(extraFile, { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });
});
