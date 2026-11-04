/**
 * vibesync-9lzk.18: production runs under Bun (bun:sqlite), where a statement
 * with no row returns `null`; vitest runs under Node (better-sqlite3), where it
 * returns `undefined`. A migration that tested `!== undefined` passed every
 * Node test and crashed every fresh database in production. This test runs
 * the real registry under the real Bun runtime in a child process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Bun on PATH (CI installs it with oven-sh/setup-bun), else the local install. */
function findBun(): string | null {
  if (process.env['BUN_BIN']) return process.env['BUN_BIN'];
  try {
    return execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return existsSync('/root/.bun/bin/bun') ? '/root/.bun/bin/bun' : null;
  }
}
const BUN = findBun();
// CI must actually run this: a silent skip there would hide the bug it guards.
if (process.env['CI'] && !BUN) throw new Error('bun is required in CI for the bun:sqlite registry test');

describe.skipIf(!BUN)('registry on a fresh database under Bun (bun:sqlite)', () => {
  it('creates the schema and accepts a project, as production does on a new host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibesync-bun-registry-'));
    const script = join(dir, 'probe.ts');
    writeFileSync(script, [
      `const { createRegistry } = await import(${JSON.stringify(resolve('src/app/registry/registry.ts'))});`,
      `const db = createRegistry(${JSON.stringify(join(dir, 'registry.db'))});`,
      `db.upsertProject({ identifier: 'p', name: 'P' });`,
      `db.upsertRoleAgent('p', 'coder', 'agent-1', 'http://shim');`,
      `console.log(JSON.stringify({ project: db.getProject('p')?.identifier ?? null, roles: db.listRoleAgents('p').length, runtime: typeof Bun }));`,
    ].join('\n'));
    const out = execFileSync(BUN!, [script], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop()!;
    expect(JSON.parse(out)).toEqual({ project: 'p', roles: 1, runtime: 'object' });
  });
});
