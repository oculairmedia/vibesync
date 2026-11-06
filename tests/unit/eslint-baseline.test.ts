import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

describe('ESLint baseline gate', () => {
  it('allows an existing baselined violation and rejects a new one', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-'));
      const existingFile = path.join(repoRoot, 'tests/unit/eslint-baseline-existing.lint.ts');
      const newFile = path.join(repoRoot, 'tests/unit/eslint-baseline-new.lint.ts');
    const malformedFile = path.join(repoRoot, 'tests/unit/eslint-baseline-malformed.lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any'] = 2;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-unused-vars'] = 2;
      baseline['scripts/eslint-baseline-check.test-helper.mjs:quotes'] = 3;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));

      const checkScript = readFileSync(path.join(repoRoot, 'scripts/eslint-baseline-check.mjs'), 'utf8')
        .replace("path.join(root, 'eslint-baseline.json')", `path.join(root, ${JSON.stringify(path.join(temporaryDir, 'eslint-baseline.json'))})`)
        .replaceAll("'node_modules/eslint/bin/eslint.js'", JSON.stringify(path.join(repoRoot, 'node_modules/eslint/bin/eslint.js')));
      const checkPath = path.join(temporaryDir, 'check.mjs');
      writeFileSync(checkPath, checkScript);
      const checkInRepo = path.join(repoRoot, 'scripts/eslint-baseline-check.test-helper.mjs');
      writeFileSync(checkInRepo, checkScript);

      writeFileSync(existingFile, 'const existing: any = 1;\n');
      const existingResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: existingFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(existingResult.status, existingResult.stderr).toBe(0);

      writeFileSync(newFile, 'const regression: any = 1;\n');
      const newResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: newFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(newResult.status).toBe(1);
      expect(newResult.stderr).toContain('ESLint introduced');

      writeFileSync(malformedFile, 'const malformed: = ;\n');
      const malformedResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: malformedFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(malformedResult.status).toBe(1);
      expect(malformedResult.stderr).toContain('fatal or unclassified diagnostics');
    } finally {
      rmSync(existingFile, { force: true });
      rmSync(newFile, { force: true });
      rmSync(malformedFile, { force: true });
      rmSync(path.join(repoRoot, 'scripts/eslint-baseline-check.test-helper.mjs'), { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('rejects an engine import from a higher layer', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-layer-'));
    const extraFile = path.join(repoRoot, 'src/engine/runtime/layer-regression.lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['src/engine/runtime/layer-regression.lint.ts:no-restricted-imports'] = 0;
      baseline['scripts/eslint-baseline-layer.test-helper.mjs:quotes'] = 99;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));
      writeFileSync(extraFile, "import '../../app/main.js';\n");
      const checkScript = readFileSync(path.join(repoRoot, 'scripts/eslint-baseline-check.mjs'), 'utf8')
        .replace("path.join(root, 'eslint-baseline.json')", `path.join(root, ${JSON.stringify(path.join(temporaryDir, 'eslint-baseline.json'))})`)
        .replaceAll("'node_modules/eslint/bin/eslint.js'", JSON.stringify(path.join(repoRoot, 'node_modules/eslint/bin/eslint.js')));
      const checkInRepo = path.join(repoRoot, 'scripts/eslint-baseline-layer.test-helper.mjs');
      writeFileSync(checkInRepo, checkScript);
      const result = spawnSync(process.execPath, [checkInRepo], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: extraFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ESLint introduced');
      expect(result.stderr).toContain('no-restricted-imports');
    } finally {
      rmSync(extraFile, { force: true });
      rmSync(path.join(repoRoot, 'scripts/eslint-baseline-layer.test-helper.mjs'), { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });
});
