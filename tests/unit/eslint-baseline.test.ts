import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

describe('ESLint baseline gate', () => {
  it('allows an existing baselined violation', () => {
    const temporaryDir = makeTempDir('vibesync-eslint-');
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
    const temporaryDir = makeTempDir('vibesync-eslint-');
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
    const temporaryDir = makeTempDir('vibesync-eslint-');
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
    const temporaryDir = makeTempDir('vibesync-eslint-layer-');
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

  it('refuses to build its private tree inside the checkout (CodeRabbit, outside the diff)', () => {
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = path.join(repoRoot, 'tests');
    try {
      expect(() => makeTempDir('vibesync-eslint-')).toThrow(/inside the checkout/);
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
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
    // CodeRabbit on #194, fourth round: template boundary, normalised segments, variables in source order, reassignment.
    const templateBoundaryFixture = "writeFileSync(" + BACKTICK + "${repoRoot}/tests${'-fixtures'}/probe.ts" + BACKTICK + ", 'probe');";
    const dotSegmentFixture = "writeFileSync(path.join(repoRoot, '.', 'tests', 'probe.ts'), 'probe');";
    const dotDotFixture = "writeFileSync(path.join(repoRoot, 'tests', '..', 'scratch', 'probe.ts'), 'probe');";
    const redeclaredFixture = "{ const probe = path.join(repoRoot, 'tests', 'a.ts'); readFileSync(probe); } { const probe = path.join(tempDir, 'b.ts'); writeFileSync(probe, 'x'); }";
    const reassignedIntoRepoFixture = "let probe = path.join(tempDir, 'a.ts'); probe = path.join(repoRoot, 'tests', 'b.ts'); writeFileSync(probe, 'x');";
    // CodeRabbit on #194, fifth round: join and resolve differ for an absolute segment; a path that leaves the checkout and comes back
    // into a directory of the same name is a different directory.
    const joinAbsoluteFixture = "writeFileSync(path.join(repoRoot, '/tests', 'probe.ts'), 'probe');";
    const resolveAbsoluteFixture = "writeFileSync(path.resolve(repoRoot, 'tests', '/scratch/probe.ts'), 'probe');";
    const leavesCheckoutFixture = "writeFileSync(path.join(repoRoot, '..', 'tests', 'probe.ts'), 'probe');";
    const reassignedOutOfRepoFixture = "let probe = path.join(repoRoot, 'tests', 'a.ts'); probe = path.join(tempDir, 'b.ts'); writeFileSync(probe, 'x');";
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
    expect(findUnsafeWrites(templateBoundaryFixture), 'tests followed by more template text is another directory').toEqual([]);
    expect(findUnsafeWrites(dotSegmentFixture), 'a "." segment does not hide the write').not.toEqual([]);
    expect(findUnsafeWrites(dotDotFixture), 'a path that leaves tests with ".." is not a write under tests').toEqual([]);
    expect(findUnsafeWrites(redeclaredFixture), 'a later declaration of the same name replaces the earlier one').toEqual([]);
    expect(findUnsafeWrites(reassignedIntoRepoFixture), 'a reassignment into the repo is seen').not.toEqual([]);
    expect(findUnsafeWrites(reassignedOutOfRepoFixture), 'a reassignment out of the repo is seen').toEqual([]);
    expect(findUnsafeWrites(joinAbsoluteFixture), 'join glues a leading-slash segment on: still under tests').not.toEqual([]);
    expect(findUnsafeWrites(resolveAbsoluteFixture), 'resolve restarts at an absolute segment: outside the checkout').toEqual([]);
    expect(findUnsafeWrites(leavesCheckoutFixture), 'a path that leaves the checkout is not a write under its tests directory').toEqual([]);
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
 * or is a variable assigned such a path. Still a targeted check, not a proof: it cannot follow every way of building a path, and follows variables in source order, not by scope.
 */
function unsafeRepoWrites(source: string): string[] {
  const file = ts.createSourceFile('guarded.ts', source, ts.ScriptTarget.Latest, true);
  // Followed in SOURCE ORDER, not by scope: a declaration or an assignment sets the name's current state, so a later temp-rooted
  // `probe` replaces an earlier repo-rooted one and a reassignment is honoured (CodeRabbit on #194, fourth round).
  const repoVariables = new Map<string, boolean>();
  const staticSegments = (args: readonly ts.Expression[]): string[] => {
    const out: string[] = [];
    for (const arg of args) {
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) out.push(arg.text);
      else break;
    }
    return out;
  };
  const isRepoPath = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return repoVariables.get(node.text) === true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isRepoPath(node.expression);
    if (ts.isTemplateExpression(node)) {
      const [span] = node.templateSpans;
      if (node.head.text !== '' || !span || !ts.isIdentifier(span.expression) || span.expression.text !== 'repoRoot') return false;
      const literal = span.literal.text;
      // The directory name must end at a slash, or at the end of the whole template: more text after an interpolation continues it.
      return /^\/(?:src|tests|scripts)\//.test(literal) || (node.templateSpans.length === 1 && /^\/(?:src|tests|scripts)$/.test(literal));
    }
    if (!ts.isCallExpression(node)) return false;
    const operation = /^(?:path\.)?(join|resolve)$/.exec(node.expression.getText(file))?.[1];
    if (!operation) return false;
    const [root, ...rest] = node.arguments;
    if (!root || !ts.isIdentifier(root) || root.text !== 'repoRoot') return false;
    const segments = staticSegments(rest);
    if (segments.length === 0) return false;
    // Evaluate the leading static segments the way Node does, from a stand-in checkout root: `join` glues a leading-slash segment on,
    // `resolve` restarts at an absolute one (CodeRabbit on #194, fifth round). The first directory of the path relative to the checkout
    // decides. No separate containment test: a path that leaves the checkout comes out starting with '..', which is not one of REPO_DIRS
    // (a mutation removing an explicit containment check changed no outcome).
    const checkout = '/checkout';
    const evaluated = operation === 'join' ? path.posix.join(checkout, ...segments) : path.posix.resolve(checkout, ...segments);
    const relative = path.posix.relative(checkout, evaluated);
    return REPO_DIRS.has(relative.split('/')[0] ?? '');
  };
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) repoVariables.set(node.name.text, isRepoPath(node.initializer));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) repoVariables.set(node.left.text, isRepoPath(node.right));
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

/** A private scratch directory that is NOT inside the checkout: a concurrent `npm run lint` scans the checkout and would see it. */
function makeTempDir(prefix: string): string {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(repoRoot);
  if (parent === root || parent.startsWith(`${root}/`)) {
    throw new Error(`the temp dir ${parent} is inside the checkout ${root}: a concurrent lint would scan the scratch files`);
  }
  return mkdtempSync(path.join(parent, prefix));
}
