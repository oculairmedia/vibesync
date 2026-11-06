import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 100 * 1024 * 1024,
});
if (output.error || output.signal || (output.status !== 0 && output.status !== 1)) {
  process.stderr.write(output.error?.message ?? output.stderr ?? `ESLint exited with status ${output.status ?? 'unknown'}.\n`);
  process.exit(1);
}
if (!output.stdout) {
  process.stderr.write(output.stderr || 'ESLint produced no JSON output.\n');
  process.exit(output.status ?? 1);
}
const report = JSON.parse(output.stdout);
const fatalFiles = report.filter((file) => file.messages.some((message) => message.fatal));
if (fatalFiles.length) {
  console.error(`ESLint reported fatal or unclassified diagnostics:\n${fatalFiles.map((file) => path.relative(root, file.filePath)).join('\n')}`);
  process.exit(1);
}
const baseline = {};
for (const file of report) {
  const filePath = path.relative(root, file.filePath).split(path.sep).join('/');
  for (const message of file.messages) {
    const key = `${filePath}:${message.ruleId}`;
    baseline[key] = (baseline[key] ?? 0) + 1;
  }
}
writeFileSync(path.join(root, 'eslint-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`Updated eslint-baseline.json with ${Object.keys(baseline).length} file/rule entries.`);
