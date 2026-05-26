import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverPacks,
  loadPack,
  validatePackPath,
} from '../../../../src/orchestration/packs/index.js';

function writePack(root: string, name: string, opts: {
  manifest?: string;
  roles?: Record<string, string>;
  formulas?: Record<string, string>;
} = {}): string {
  const packRoot = join(root, name);
  mkdirSync(packRoot, { recursive: true });
  writeFileSync(
    join(packRoot, 'pack.toml'),
    opts.manifest ??
      `[pack]\nname = "${name}"\nversion = "0.1.0"\ndescription = "Test pack"\n`,
  );
  if (opts.roles) {
    mkdirSync(join(packRoot, 'roles'), { recursive: true });
    for (const [fname, body] of Object.entries(opts.roles)) {
      writeFileSync(join(packRoot, 'roles', fname), body);
    }
  }
  if (opts.formulas) {
    mkdirSync(join(packRoot, 'formulas'), { recursive: true });
    for (const [fname, body] of Object.entries(opts.formulas)) {
      writeFileSync(join(packRoot, 'formulas', fname), body);
    }
  }
  return packRoot;
}

describe('Pack loading', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pack-test-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('loadPack parses manifest + roles + formulas', () => {
    const packRoot = writePack(tmp, 'gastown', {
      roles: {
        'reviewer.toml': `[role]\nname = "reviewer"\ndescription = "code reviewer"\nmodel = "letta/auto"\nsystem_prompt_template = "prompts/reviewer-system.md"\ntools = ["read", "search"]`,
        'coder.toml': `[role]\nname = "coder"`,
      },
      formulas: {
        'code-review.toml':
          '[formula.code-review]\ndescription = "test"\n\n[[formula.code-review.steps]]\nrole = "reviewer"\n',
      },
    });
    const pack = loadPack(packRoot, 'global');
    expect(pack.manifest.name).toBe('gastown');
    expect(pack.manifest.version).toBe('0.1.0');
    expect(pack.roles.map((r) => r.name).sort()).toEqual(['coder', 'reviewer']);
    const reviewer = pack.roles.find((r) => r.name === 'reviewer')!;
    expect(reviewer.model).toBe('letta/auto');
    expect(reviewer.tools).toEqual(['read', 'search']);
    expect(pack.formulas).toHaveLength(1);
    expect(pack.formulas[0]!.name).toBe('code-review');
  });

  it('rejects pack with no [pack] manifest', () => {
    writePack(tmp, 'bad', { manifest: '# nothing useful' });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/missing or invalid \[pack\] table/);
  });

  it('rejects pack with missing version', () => {
    writePack(tmp, 'bad', { manifest: '[pack]\nname = "bad"\n' });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/pack.version must be/);
  });

  it('rejects pack with non-string tools array', () => {
    writePack(tmp, 'bad', {
      roles: { 'r.toml': `[role]\nname = "r"\ntools = [1, 2]` },
    });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/tools must be an array of strings/);
  });

  it('skips non-toml files in roles/', () => {
    const packRoot = writePack(tmp, 'mixed', {
      roles: {
        'r.toml': `[role]\nname = "r"`,
        'README.md': 'docs only, not a role',
      },
    });
    const pack = loadPack(packRoot);
    expect(pack.roles).toHaveLength(1);
    expect(pack.roles[0]!.name).toBe('r');
  });

  it('parses [[memory_blocks]] off a role TOML', () => {
    const packRoot = writePack(tmp, 'gastown', {
      roles: {
        'reviewer.toml':
          '[role]\nname = "reviewer"\n\n' +
          '[[memory_blocks]]\nlabel = "persona"\nvalue = "You are a senior reviewer."\nlimit = 2000\n\n' +
          '[[memory_blocks]]\nlabel = "guardrails"\nvalue = "Block PRs that miss tests."\n',
      },
    });
    const pack = loadPack(packRoot, 'global');
    const reviewer = pack.roles[0]!;
    expect(reviewer.memoryBlocks).toEqual([
      { label: 'persona', value: 'You are a senior reviewer.', limit: 2000 },
      { label: 'guardrails', value: 'Block PRs that miss tests.' },
    ]);
  });

  it('rejects memory_blocks entries without a label', () => {
    writePack(tmp, 'bad', {
      roles: {
        'r.toml': '[role]\nname = "r"\n\n[[memory_blocks]]\nvalue = "..."\n',
      },
    });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/memory_blocks\[0\]\.label/);
  });

  it('rejects memory_blocks entries with a non-string value', () => {
    writePack(tmp, 'bad', {
      roles: {
        'r.toml': '[role]\nname = "r"\n\n[[memory_blocks]]\nlabel = "p"\nvalue = 42\n',
      },
    });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/memory_blocks\[0\]\.value/);
  });

  it('drops a non-positive limit silently', () => {
    const packRoot = writePack(tmp, 'pack', {
      roles: {
        'r.toml':
          '[role]\nname = "r"\n\n[[memory_blocks]]\nlabel = "p"\nvalue = "ok"\nlimit = 0\n',
      },
    });
    const pack = loadPack(packRoot, 'global');
    expect(pack.roles[0]!.memoryBlocks).toEqual([{ label: 'p', value: 'ok' }]);
  });

  it('parses [[memory_blocks_policy]] replace mode off a role TOML', () => {
    const packRoot = writePack(tmp, 'pack', {
      roles: {
        'r.toml': '[role]\nname = "r"\n\n[[memory_blocks_policy]]\nmode = "replace"\n',
      },
    });
    const pack = loadPack(packRoot, 'global');
    expect(pack.roles[0]!.memoryBlocksPolicy).toEqual({ mode: 'replace' });
  });

  it('rejects invalid memory_blocks_policy modes', () => {
    writePack(tmp, 'bad', {
      roles: {
        'r.toml': '[role]\nname = "r"\n\n[[memory_blocks_policy]]\nmode = "delete"\n',
      },
    });
    expect(() => loadPack(join(tmp, 'bad'))).toThrow(/memory_blocks_policy\.mode/);
  });

  it('validatePackPath returns ok:true for a valid pack', () => {
    writePack(tmp, 'good');
    expect(validatePackPath(join(tmp, 'good'))).toEqual({ ok: true });
  });

  it('validatePackPath returns ok:false for missing pack.toml', () => {
    mkdirSync(join(tmp, 'incomplete'), { recursive: true });
    const result = validatePackPath(join(tmp, 'incomplete'));
    expect(result.ok).toBe(false);
  });
});

describe('discoverPacks', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'discover-test-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('finds packs in project/.vibesync/packs and global ~/.letta/packs', () => {
    // Project scope
    const projectRoot = join(tmp, 'project');
    writePack(join(projectRoot, '.vibesync', 'packs'), 'projpack');
    // Global scope (via fake home)
    const fakeHome = join(tmp, 'home');
    writePack(join(fakeHome, '.letta', 'packs'), 'globpack');

    const packs = discoverPacks({ projectRoot, homeDir: fakeHome });
    const byName = Object.fromEntries(packs.map((p) => [p.manifest.name, p]));
    expect(byName['projpack']?.scope).toBe('project');
    expect(byName['globpack']?.scope).toBe('global');
  });

  it('skips entries that do not have pack.toml', () => {
    const projectRoot = join(tmp, 'project');
    mkdirSync(join(projectRoot, '.vibesync', 'packs', '.hidden'), { recursive: true });
    mkdirSync(join(projectRoot, '.vibesync', 'packs', '_internal'), { recursive: true });
    mkdirSync(join(projectRoot, '.vibesync', 'packs', 'no-manifest'), { recursive: true });
    writePack(join(projectRoot, '.vibesync', 'packs'), 'valid');
    const packs = discoverPacks({ projectRoot, homeDir: join(tmp, 'nohome') });
    expect(packs.map((p) => p.manifest.name)).toEqual(['valid']);
  });

  it('agent scope is searched when agentId provided', () => {
    const fakeHome = join(tmp, 'home');
    writePack(join(fakeHome, '.letta', 'agents', 'agent-xyz', 'packs'), 'agentpack');
    const packs = discoverPacks({
      projectRoot: join(tmp, 'noproj'),
      agentId: 'agent-xyz',
      homeDir: fakeHome,
    });
    expect(packs.map((p) => p.manifest.name)).toEqual(['agentpack']);
    expect(packs[0]!.scope).toBe('agent');
  });
});
