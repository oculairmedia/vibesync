import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packRoot = join(process.cwd(), 'packs/gastown');
const promptDir = join(packRoot, 'prompts');
const readPrompt = (role: string): string => readFileSync(join(promptDir, `${role}-system.md`), 'utf8');
const readPersona = (role: string): string => readFileSync(join(packRoot, '.letta/agents', `${role}.md`), 'utf8');
const roles = readdirSync(promptDir)
  .filter((file) => file.endsWith('-system.md'))
  .map((file) => file.slice(0, -'-system.md'.length))
  .filter((role) => /mutation gates?/i.test(readPrompt(role)));
const BARE_BAN = /\b(?:I|You)\s+do\s+not\s+modify\s+code\b|\bDoes\s+not\s+modify\s+code\b/i;

describe('mutation gate instructions agree with role personas', () => {
  it('discovers at least one role with a mutation gate', () => {
    expect(roles.length).toBeGreaterThan(0);
  });

  const sources = roles.flatMap((role) => [
    { role, kind: 'step prompt', text: () => readPrompt(role) },
    { role, kind: 'persona', text: () => readPersona(role) },
  ]);
  it.each(sources)('$role $kind allows isolated mutations and requires cleanup', ({ text }) => {
    const content = text();
    expect(content).not.toMatch(BARE_BAN);
    expect(content).toMatch(/throwaway copy/i);
    expect(content).toContain('git worktree add');
    expect(content).toContain('git worktree remove');
    expect(content).toContain('git status --short');
  });

  it('detects each original bare ban', () => {
    expect('I do not modify code. The coder does that.').toMatch(BARE_BAN);
    expect('You do not modify code;').toMatch(BARE_BAN);
    expect('Does not modify code, does not rewrite tests to make them pass,').toMatch(BARE_BAN);
  });
});
