import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintArgs = ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json'];
const output = spawnSync(process.execPath, eslintArgs, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 100 * 1024 * 1024,
});
if (!output.stdout) {
  process.stderr.write(output.stderr || 'ESLint produced no JSON output.\n');
  process.exit(output.status ?? 1);
}

const report = JSON.parse(output.stdout);
const current = new Map();
for (const file of report) {
  const filePath = path.relative(root, file.filePath).split(path.sep).join('/');
  for (const message of file.messages) {
    if (message.fatal || !message.ruleId) continue;
    const key = `${filePath}:${message.ruleId}`;
    current.set(key, (current.get(key) ?? 0) + 1);
  }
}
const baselinePath = process.env['ESLINT_BASELINE_PATH'] ?? path.join(root, 'eslint-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (process.env['ESLINT_EXTRA_FILE']) {
  const filePath = path.relative(root, process.env['ESLINT_EXTRA_FILE']).split(path.sep).join('/');
  const extra = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', filePath, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (!extra.stdout) {
    process.stderr.write(extra.stderr || 'ESLint produced no JSON output.\n');
    process.exit(extra.status ?? 1);
  }
  for (const file of JSON.parse(extra.stdout)) {
    const extraPath = path.relative(root, file.filePath).split(path.sep).join('/');
    for (const message of file.messages) {
      if (message.fatal || !message.ruleId) continue;
      const key = `${extraPath}:${message.ruleId}`;
      current.set(key, (current.get(key) ?? 0) + 1);
    }
  }
}
const regressions = [...current].filter(([key, count]) => count > (baseline[key] ?? 0));
if (regressions.length) {
  console.error(`ESLint introduced ${regressions.length} violation(s):\n${regressions.map(([key, count]) => `${key}: ${count} (baseline ${baseline[key] ?? 0})`).join('\n')}`);
  process.exit(1);
}
console.log(`ESLint baseline passed (${current.size} file/rule entries).`);
