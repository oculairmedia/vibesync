import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

describe('ESLint baseline gate', () => {
  it('allows an existing baselined violation', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-'));
    const existingFile = path.join(temporaryDir, 'tests/unit/eslint-baseline-existing.lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any'] = 2;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-unused-vars'] = 2;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));

      const checkInRepo = writeBaselineCheckHelper(temporaryDir);

      writeFileSync(existingFile, 'const existing: any = 1;\n');
      const existingResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: temporaryDir,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: existingFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(existingResult.status, existingResult.stderr).toBe(0);
      // Non-vacuity: with the baseline entries removed the SAME file must be rejected, so it really was linted and produced
      // the baselined diagnostics (a config that ignored it would let both runs pass; outside review, GPT and DeepSeek).
      const stripped = { ...baseline };
      delete stripped['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any'];
      delete stripped['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-unused-vars'];
      writeFileSync(path.join(temporaryDir, 'eslint-baseline-stripped.json'), JSON.stringify(stripped));
      const rejected = spawnSync(process.execPath, [checkInRepo], {
        cwd: temporaryDir,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: existingFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline-stripped.json') },
      });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any');
    } finally {
      rmSync(existingFile, { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('rejects a new violation', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-'));
    const newFile = path.join(temporaryDir, 'tests/unit/eslint-baseline-new.lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any'] = 2;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-unused-vars'] = 2;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));
      const checkInRepo = writeBaselineCheckHelper(temporaryDir);

      writeFileSync(newFile, 'const regression: any = 1;\n');
      const newResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: temporaryDir,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: newFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(newResult.status).toBe(1);
      expect(newResult.stderr).toContain('ESLint introduced');
      expect(newResult.stderr, 'names the new file and the rule').toContain('tests/unit/eslint-baseline-new.lint.ts:@typescript-eslint/no-explicit-any');
    } finally {
      rmSync(newFile, { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed file', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-'));
    const malformedFile = path.join(temporaryDir, 'tests/unit/eslint-baseline-malformed.lint.ts');
    try {
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-explicit-any'] = 2;
      baseline['tests/unit/eslint-baseline-existing.lint.ts:@typescript-eslint/no-unused-vars'] = 2;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));
      const checkInRepo = writeBaselineCheckHelper(temporaryDir);

      writeFileSync(malformedFile, 'const malformed: = ;\n');
      const malformedResult = spawnSync(process.execPath, [checkInRepo], {
        cwd: temporaryDir,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: malformedFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(malformedResult.status).toBe(1);
      expect(malformedResult.stderr, 'names the malformed file as fatal').toContain('ESLint reported fatal or unclassified diagnostics:\ntests/unit/eslint-baseline-malformed.lint.ts');
      expect(malformedResult.stderr).toContain('fatal or unclassified diagnostics');
    } finally {
      rmSync(malformedFile, { force: true });
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('rejects an engine import from a higher layer', () => {
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'vibesync-eslint-layer-'));
    const extraFile = path.join(temporaryDir, 'src/engine/runtime/layer-regression.lint.ts');
    try {
      symlinkSync(path.join(repoRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
      cpSync(path.join(repoRoot, 'eslint.config.js'), path.join(temporaryDir, 'eslint.config.js'));
      writeFileSync(path.join(temporaryDir, 'package.json'), '{"type":"module"}\n');
      mkdirSync(path.dirname(extraFile), { recursive: true });
      mkdirSync(path.join(temporaryDir, 'src/app'), { recursive: true });
      writeFileSync(path.join(temporaryDir, 'src/app/main.ts'), 'export {};\n');
      writeFileSync(path.join(temporaryDir, 'src/engine/runtime/same-layer.ts'), "import './support.ts';\n");
      writeFileSync(path.join(temporaryDir, 'src/engine/runtime/support.ts'), 'export {};\n');
      const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'eslint-baseline.json'), 'utf8')) as Record<string, number>;
      baseline['src/engine/runtime/layer-regression.lint.ts:no-restricted-imports'] = 0;
      baseline['src/engine/runtime/same-layer.ts:no-restricted-imports'] = 0;
      writeFileSync(path.join(temporaryDir, 'eslint-baseline.json'), JSON.stringify(baseline));
      writeFileSync(extraFile, "import '../../app/main.js';\n");
      const checkPath = path.join(temporaryDir, 'check.mjs');
      const checkScript = readFileSync(path.join(repoRoot, 'scripts/eslint-baseline-check.mjs'), 'utf8')
        .replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", 'path.dirname(fileURLToPath(import.meta.url))');
      writeFileSync(checkPath, checkScript);
      const result = spawnSync(process.execPath, [checkPath], {
        cwd: temporaryDir,
        encoding: 'utf8',
        env: { ...process.env, ESLINT_EXTRA_FILE: extraFile, ESLINT_BASELINE_PATH: path.join(temporaryDir, 'eslint-baseline.json') },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ESLint introduced');
      expect(result.stderr).toContain('no-restricted-imports');
      const sameLayer = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', 'src/engine/runtime/same-layer.ts', '--format', 'json'], {
        cwd: temporaryDir,
        encoding: 'utf8',
      });
      expect(sameLayer.status).toBe(0);
      expect(JSON.parse(sameLayer.stdout)[0].messages).toEqual([]);
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('keeps test file writes out of the repository source tree', () => {
    const testFiles = readdirSync(path.join(repoRoot, 'tests'), { recursive: true })
      .filter((file): file is string => typeof file === 'string' && file.endsWith('.test.ts'));
    const unsafeWrites: string[] = [];
    const findUnsafeWrites = (source: string): string[] => unsafeRepoWrites(source);
    for (const relativeFile of testFiles) {
      const filePath = path.join(repoRoot, 'tests', relativeFile);
      const source = readFileSync(filePath, 'utf8');
      if (findUnsafeWrites(source).length > 0) {
        unsafeWrites.push(path.relative(repoRoot, filePath));
      }
    }
    const originalUnsafePattern = `
      const repoRoot = process.cwd();
      const extraFile = path.join(repoRoot, 'src/engine/runtime/probe.ts');
      writeFileSync(extraFile, 'probe');
    `;
    // A copy FROM the repo into a temp dir is safe; a copy INTO the repo is not. The examples sit in template strings the scan
    // removes (like the two above), so they are not mistaken for this file's own writes.
    const safeCopy = `
      cpSync(path.join(repoRoot, 'scripts/check.mjs'), path.join(tempDir, 'check.mjs'));
    `;
    const unsafeCopy = `
      cpSync(path.join(tempDir, 'check.mjs'), path.join(repoRoot, 'scripts/check.mjs'));
    `;
    // The original defect: a ';' inside the written content ended the old pattern's match, so these writes were invisible to it
    // (outside review: the guard caught the original file only through its helper-script write, not its fixture writes).
    const semicolonFixture = `
      const existingFile = path.join(repoRoot, 'tests/unit/eslint-baseline-existing.lint.ts');
      writeFileSync(existingFile, 'const existing: any = 1;\n');
    `;
    // CodeRabbit on #194: a repo path built from separate segments, assigned or direct, and a regex literal holding an escaped
    // bracket (which the bracket scan used to count as a real one) must not hide a repository write.
    const segmentFixture = `
      writeFileSync(path.join(repoRoot, 'tests', 'probe.ts'), 'probe');
    `;
    const assignedSegmentsFixture = `
      const probe = path.join(repoRoot, 'tests', 'probe.ts');
      writeFileSync(probe, 'probe');
    `;
    const regexFixture = `
      writeFileSync(path.join(repoRoot, 'src/probe.ts'), value.replace(/\\(/g, ''));
    `;
    const tempSegmentsFixture = `
      writeFileSync(path.join(temporaryDir, 'tests', 'probe.ts'), 'probe');
    `;
    // CodeRabbit on #194 (third round): only the DESTINATION decides, not the content written; and a postfix ++ before a division
    // slash must not be read as the start of a regex literal.
    const contentMentionFixture = `
      writeFileSync(path.join(tempDir, 'probe.txt'), "repoRoot 'tests/probe.ts'");
    `;
    const postfixFixture = `
      writeFileSync(path.join(repoRoot, 'tests/probe.ts'), String(n++ / 2)); // ratio
    `;
    const BACKTICK = String.fromCharCode(96);
    const templateFixture = "writeFileSync(" + BACKTICK + "${repoRoot}/scripts/probe.mjs" + BACKTICK + ", 'probe');";
    const appendFixture = "appendFileSync(path.join(repoRoot, 'src', 'probe.ts'), 'probe');";
    const safePattern = `
      const repoRoot = process.cwd();
      const extraFile = path.join(tempDir, 'src/engine/runtime/probe.ts');
      writeFileSync(extraFile, 'probe');
    `;
    expect(findUnsafeWrites(semicolonFixture), 'a write whose content contains a semicolon must be seen').not.toEqual([]);
    expect(findUnsafeWrites(segmentFixture), 'a repo path built from separate segments must be seen').not.toEqual([]);
    expect(findUnsafeWrites(assignedSegmentsFixture), 'an assigned repo path built from separate segments must be seen').not.toEqual([]);
    expect(findUnsafeWrites(regexFixture), 'an escaped bracket inside a regex literal must not hide the write').not.toEqual([]);
    expect(findUnsafeWrites(tempSegmentsFixture), 'the same segments under a temp dir are fine').toEqual([]);
    expect(findUnsafeWrites(contentMentionFixture), 'text that merely mentions a repo path in the CONTENT is not a repo write').toEqual([]);
    expect(findUnsafeWrites(postfixFixture), 'a postfix ++ before a division must not hide the write').not.toEqual([]);
    expect(findUnsafeWrites(templateFixture), 'a template-literal repo path must be seen').not.toEqual([]);
    expect(findUnsafeWrites(appendFixture), 'appendFileSync into the repo must be seen').not.toEqual([]);
    expect(findUnsafeWrites(safeCopy)).toEqual([]);
    expect(findUnsafeWrites(unsafeCopy)).not.toEqual([]);
    expect(findUnsafeWrites(originalUnsafePattern)).not.toEqual([]);
    expect(findUnsafeWrites(safePattern)).toEqual([]);
    expect(unsafeWrites.join(', '), 'test files that write into the repository tree (src, tests or scripts); use a private temp dir').toBe('');
  });
});

/**
 * A private copy of the repo's lint setup under `temporaryDir`: the config, a link to node_modules and the UNMODIFIED check
 * script at scripts/, so its root is the temp tree and baseline keys match the real ones. Nothing is written into the repo,
 * so two suite runs (or a suite run and `npm run lint`) in one checkout cannot see each other's scratch files
 * (vibesync-eoo1: overlapping runs failed this file's tests).
 */
function writeBaselineCheckHelper(temporaryDir: string): string {
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
  cpSync(path.join(repoRoot, 'eslint.config.js'), path.join(temporaryDir, 'eslint.config.js'));
  writeFileSync(path.join(temporaryDir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(path.join(temporaryDir, 'tests/unit'), { recursive: true });
  mkdirSync(path.join(temporaryDir, 'scripts'), { recursive: true });
  const checkPath = path.join(temporaryDir, 'scripts/eslint-baseline-check.mjs');
  cpSync(path.join(repoRoot, 'scripts/eslint-baseline-check.mjs'), checkPath);
  return checkPath;
}

const WRITER_NAMES = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'cpSync', 'copyFileSync', 'renameSync', 'writeFile', 'appendFile', 'mkdir', 'cp', 'copyFile', 'rename', 'createWriteStream']);
const DESTINATION_ONLY = new Set(['cpSync', 'copyFileSync', 'renameSync', 'cp', 'copyFile', 'rename']);
const REPO_DIRS = new Set(['src', 'tests', 'scripts']);

/**
 * Source text of every file-writing call whose DESTINATION is a path under the repository's src, tests or scripts. Read with the
 * TypeScript parser, so strings, templates, regex literals and comments are what they are (the hand-written scanner this
 * replaces went wrong three times on them: a ';' in a string, an escaped bracket in a regex, `n++ / 2`; CodeRabbit on #194).
 * A copy or rename is judged by its destination argument, every other writer by its first. A destination counts as a repo
 * path when it is built from `repoRoot` with a first segment in REPO_DIRS (a literal like 'tests/x.ts' or separate segments),
 * or is a variable assigned such a path. Still a targeted check, not a proof (it cannot follow every way of building a path).
 */
function unsafeRepoWrites(source: string): string[] {
  const file = ts.createSourceFile('guarded.ts', source, ts.ScriptTarget.Latest, true);
  const repoVariables = new Set<string>();
  const isRepoPath = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return repoVariables.has(node.text);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isRepoPath(node.expression);
    if (ts.isTemplateExpression(node)) return node.head.text === '' && node.templateSpans[0] !== undefined && ts.isIdentifier(node.templateSpans[0].expression) && node.templateSpans[0].expression.text === 'repoRoot' && /^\/(?:src|tests|scripts)(?:\/|$)/.test(node.templateSpans[0].literal.text);
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression.getText(file);
    if (!/^(?:path\.)?(?:join|resolve)$/.test(callee)) return false;
    const [root, first] = node.arguments;
    if (!root || !ts.isIdentifier(root) || root.text !== 'repoRoot' || !first) return false;
    return (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && REPO_DIRS.has(first.text.split('/')[0] ?? '');
  };
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isRepoPath(node.initializer)) repoVariables.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
      if (WRITER_NAMES.has(callee)) {
        const destination = DESTINATION_ONLY.has(callee) ? node.arguments[1] : node.arguments[0];
        if (isRepoPath(destination)) out.push(node.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
