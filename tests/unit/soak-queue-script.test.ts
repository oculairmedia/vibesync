/** Every invocation uses a disposable repository, tracker, and command wrappers. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = resolve('scripts/soak/queue.sh');
let root = '';
const run = (cmd: string, args: string[], cwd: string) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr}`);
  return result.stdout;
};
function sandbox() {
  root = mkdtempSync(join(tmpdir(), 'soak-queue-'));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), state = join(root, 'state');
  mkdirSync(repo); mkdirSync(bin); mkdirSync(state);
  run('git', ['init', '--bare', join(root, 'origin.git')], root);
  run('git', ['init', '-b', 'main'], repo);
  run('git', ['config', 'user.email', 'test@example.invalid'], repo);
  run('git', ['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'seed'), 'seed');
  run('git', ['add', 'seed'], repo); run('git', ['commit', '-m', 'seed'], repo);
  run('git', ['remote', 'add', 'origin', join(root, 'origin.git')], repo);
  run('git', ['push', '-u', 'origin', 'main'], repo);
  const wrapper = (name: string, body: string) => {
    const path = join(bin, name); writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755);
  };
  for (const name of ['git', 'jq', 'rm', 'dirname']) {
    const executable = run('which', [name], root).trim();
    wrapper(name, `echo ${name} >> "$STATE/commands"\nexec ${executable} "$@"`);
  }
  wrapper('curl', 'echo curl >> "$STATE/commands"; cat "$STATE/health"');
  wrapper('bun', 'echo bun >> "$STATE/commands"; mkdir -p node_modules/vitest; touch node_modules/vitest/vitest.mjs');
  wrapper('npm', 'echo npm >> "$STATE/commands"');
  wrapper('bd', `echo bd >> "$STATE/commands"
case "$1" in
list) case "$*" in *molecule_root*) cat "$STATE/roots";; *) cat "$STATE/contexts";; esac;;
show) node "$STATE/tracker.cjs" show;;
update) shift; node "$STATE/tracker.cjs" update "$@";;
*) exit 1;; esac`);
  writeFileSync(join(state, 'tracker.cjs'), `const fs=require('fs'), p=process.env.STATE, a=process.argv.slice(2), file=p+'/issue';
let issue=JSON.parse(fs.readFileSync(file));
if(a[0]==='show'){if(fs.existsSync(p+'/mismatch')) issue.description='wrong'; console.log(JSON.stringify([issue])); process.exit()}
fs.appendFileSync(p+'/writes',JSON.stringify(a)+'\\n');
if(a.includes('--body-file')) issue.description=fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8');
for(let i=0;i<a.length;i++) if(a[i]==='--set-metadata'){const [k,v]=a[++i].split('='); issue.metadata[k]=v}
if(a.includes('--add-label')) issue.labels.push(a[a.indexOf('--add-label')+1]); fs.writeFileSync(file,JSON.stringify(issue));`);
  for (const [name, value] of Object.entries({ health: '{"orchestration":{"ready":true}}', roots: '[]', contexts: '[]', issue: '{"id":"work-1","description":"","metadata":{},"labels":[]}', writes: '' })) writeFileSync(join(state, name), value);
  const brief = join(root, 'brief'); writeFileSync(brief, 'A `literal` brief\n');
  const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, STATE: state, VIBESYNC_REPO_DIR: repo, VIBESYNC_BD: join(bin, 'bd'), VIBESYNC_HEALTH_URL: 'http://sandbox.invalid', VIBESYNC_SOAK_REPORT_DIR: root };
  return { repo, bin, state, brief, env, invoke: () => spawnSync('bash', [script, 'work-1', brief, 'feature/test'], { cwd: repo, env, encoding: 'utf8' }) };
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it.each(['missing brief', 'empty brief', 'health', 'malformed health', 'molecule', 'context', 'worktree', 'branch', 'eligible', 'malformed roots', 'malformed context', 'malformed bead'])('refuses %s before writes', (kind) => {
  const s = sandbox();
  if (kind === 'missing brief') rmSync(s.brief);
  if (kind === 'empty brief') writeFileSync(s.brief, '');
  if (kind === 'health') writeFileSync(join(s.state, 'health'), '{"orchestration":{"ready":false}}');
  if (kind === 'malformed health') writeFileSync(join(s.state, 'health'), 'bad');
  if (kind === 'molecule') writeFileSync(join(s.state, 'roots'), '[{"metadata":{"exec":{"motivating_bead":"work-1"}}}]');
  if (kind === 'context') writeFileSync(join(s.state, 'contexts'), JSON.stringify([{ description: JSON.stringify({ work_bead_id: 'work-1' }) }]));
  if (kind === 'worktree') mkdirSync(join(s.repo, '.letta/worktrees/q-work-1'), { recursive: true });
  if (kind === 'branch') run('git', ['branch', 'feature/test'], s.repo);
  if (kind === 'eligible') writeFileSync(join(s.state, 'issue'), '{"id":"work-1","labels":["scheduler:eligible"]}');
  if (kind === 'malformed roots') writeFileSync(join(s.state, 'roots'), '{}');
  if (kind === 'malformed context') writeFileSync(join(s.state, 'contexts'), '[{"description":"bad"}]');
  if (kind === 'malformed bead') writeFileSync(join(s.state, 'issue'), '{}');
  const result = s.invoke(); expect(result.status, result.stderr).toBe(1);
  expect(readFileSync(join(s.state, 'writes'), 'utf8')).toBe('');
});

it('fails closed when brief read-back differs', () => {
  const s = sandbox(); writeFileSync(join(s.state, 'mismatch'), '1');
  const result = s.invoke(); expect(result.status, result.stderr).toBe(2);
  expect(readFileSync(join(s.state, 'writes'), 'utf8')).not.toContain('--add-label');
});

it('queues other beads independently, removes stale report and labels last', () => {
  const s = sandbox(), report = join(root, 'vitest-work-1.json');
  writeFileSync(report, 'stale');
  writeFileSync(join(s.state, 'roots'), '[{"metadata":{"exec":{"motivating_bead":"work-2"}}}]');
  writeFileSync(join(s.state, 'contexts'), JSON.stringify([{ description: JSON.stringify({ work_bead_id: 'work-2' }) }]));
  const result = s.invoke(); expect(result.status, result.stderr).toBe(0);
  expect(existsSync(report)).toBe(false);
  const writes = readFileSync(join(s.state, 'writes'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  expect(writes).toHaveLength(3); expect(writes[2]).toContain('--add-label');
  expect(JSON.parse(readFileSync(join(s.state, 'issue'), 'utf8')).labels).toContain('scheduler:eligible');
});

it('resolves every host command used by the script to sandbox stand-ins', () => {
  const s = sandbox();
  const commands = ['git', 'dirname', 'curl', 'jq', 'bd', 'bun', 'npm', 'rm'];
  const result = spawnSync('bash', ['-c', `for c in ${commands.join(' ')}; do command -v "$c"; done`], { cwd: s.repo, env: s.env, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(commands.map((name) => join(s.bin, name)));
});
