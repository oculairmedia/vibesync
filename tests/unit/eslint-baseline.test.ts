import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
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
    const rootSrcPath = /(?:const|let|var)\s+(\w+)\s*=\s*path\.(?:join|resolve)\(\s*repoRoot\s*,\s*['"`](?:src|tests|scripts)(?:\/|['"`])/g;
;
    const findUnsafeWrites = (source: string): string[] => {
      const rootSrcVariables = new Set<string>();
      for (const match of source.matchAll(rootSrcPath)) {
        if (match[1]) rootSrcVariables.add(match[1]);
      }
      return writeCallSites(source).flatMap((site) => {
        // A copy or rename writes only to its destination: a copy FROM the repo into a temp dir is safe.
        const args = site.destinationOnly ? destinationArgument(site.args) : site.args;
        return /(?:repoRoot[\s\S]*?['"`](?:src|tests|scripts)(?:\/|['"`])|path\.(?:join|resolve)\(\s*repoRoot\s*,\s*['"`](?:src|tests|scripts)(?:\/|['"`]))/.test(args)
          || [...rootSrcVariables].some((variable) => new RegExp(`\\b${variable}\\b`).test(args))
          ? [site.text]
          : [];
      });
    };
    for (const relativeFile of testFiles) {
      const filePath = path.join(repoRoot, 'tests', relativeFile);
      const source = readFileSync(filePath, 'utf8');
      const withoutFixtureSource = source.replace(/const originalUnsafePattern = `[^`]*`;/, '')
        .replace(/const safePattern = `[^`]*`;/, '')
        .replace(/const safeCopy = `[^`]*`;/, '')
        .replace(/const unsafeCopy = `[^`]*`;/, '')
        .replace(/const semicolonFixture = `[^`]*`;/, '')
        .replace(/const segmentFixture = `[^`]*`;/, '')
        .replace(/const assignedSegmentsFixture = `[^`]*`;/, '')
        .replace(/const regexFixture = `[^`]*`;/, '')
        .replace(/const tempSegmentsFixture = `[^`]*`;/, '');
      if (findUnsafeWrites(withoutFixtureSource).length > 0) {
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

const WRITER_NAMES = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'cpSync', 'copyFileSync', 'renameSync', 'writeFile', 'appendFile', 'mkdir', 'cp', 'copyFile', 'rename', 'createWriteStream'];
const DESTINATION_ONLY = new Set(['cpSync', 'copyFileSync', 'renameSync', 'cp', 'copyFile', 'rename']);

interface WriteCallSite {
  readonly text: string;
  readonly args: string;
  readonly destinationOnly: boolean;
}

/**
 * Every call of a file writer in `source`, with its argument text. The closing parenthesis is found by matching brackets and
 * skipping string literals and comments, so a ';' or ')' inside a string (a fixture's file content) cannot end the call early.
 * The first version used /\(([^;]*?)\);/ and never saw `writeFileSync(file, 'x: any = 1;\n')` (outside review of vibesync-eoo1).
 * Still a targeted check, not a proof: it looks for repo-rooted paths by spelling (see findUnsafeWrites).
 */
function writeCallSites(source: string): WriteCallSite[] {
  const sites: WriteCallSite[] = [];
  const opener = new RegExp(`\\b(?:${WRITER_NAMES.join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(opener)) {
    const start = match.index ?? 0;
    const open = start + match[0].length - 1;
    const close = matchingBracket(source, open);
    if (close < 0) continue;
    const name = match[0].replace(/\s*\($/, '');
    sites.push({ text: source.slice(start, close + 1), args: source.slice(open + 1, close), destinationOnly: DESTINATION_ONLY.has(name) });
  }
  return sites;
}

/** Index of the bracket that closes the one at `open`, skipping strings, templates and comments; -1 when unbalanced. */
function matchingBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === "'" || c === '"') i = skipQuoted(source, i, c);
    else if (c === '`') i = skipTemplate(source, i);
    else if (c === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      if (newline < 0) return -1;
      i = newline;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === '/' && regexAllowedAfter(source, i)) {
      i = skipRegex(source, i);
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') i++;
    else if (c === '`') return i;
    else if (c === '$' && source[i + 1] === '{') {
      const close = matchingBracket(source, i + 1);
      if (close < 0) return source.length;
      i = close;
    }
  }
  return source.length;
}

/** The second top-level argument of a call's argument text (a copy's destination), or '' when there is none. */
function destinationArgument(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === "'" || c === '"') i = skipQuoted(args, i, c);
    else if (c === '`') i = skipTemplate(args, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(i + 1);
  }
  return '';
}

/** True when a '/' at `index` starts a regular expression literal (after an operator, an opening bracket or `return`), not a division. */
function regexAllowedAfter(source: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  if (i < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(source[i]!)) return true;
  return /\breturn$/.test(source.slice(Math.max(0, i - 6), i + 1));
}

/** Index of the '/' closing the regex literal that starts at `start`; `start` itself when it is not one (so scanning goes on). */
function skipRegex(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
    else if (c === '\n') return start;
  }
  return start;
}

