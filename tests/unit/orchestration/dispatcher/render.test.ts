import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../../../../src/orchestration/dispatcher/index.js';

describe('renderTemplate', () => {
  it('renders single and multiple substitutions', () => {
    const packRoot = newPack({ 'prompts/review.md': 'Review ${target} for ${project}.' });

    expect(
      renderTemplate({
        packRoot,
        template: 'prompts/review.md',
        context: { target: 'src/foo.ts', project: 'VibeSync' },
      }),
    ).toBe('Review src/foo.ts for VibeSync.');
  });

  it('throws with the missing variable name and template path', () => {
    const packRoot = newPack({ 'prompts/review.md': 'Review ${target} and ${missing}.' });

    expect(() =>
      renderTemplate({
        packRoot,
        template: 'prompts/review.md',
        context: { target: 'src/foo.ts' },
      }),
    ).toThrow(/missing variable "missing" in prompts\/review\.md/);
  });

  it('renders escaped dollars from $$', () => {
    const packRoot = newPack({ 'prompts/cost.md': 'Budget: $$${amount}' });

    expect(renderTemplate({ packRoot, template: 'prompts/cost.md', context: { amount: 42 } })).toBe('Budget: $42');
  });

  it('rejects path traversal outside the pack root', () => {
    const packRoot = newPack({ 'prompts/safe.md': 'safe' });

    expect(() => renderTemplate({ packRoot, template: '../../etc/passwd', context: {} })).toThrow(/escapes pack root/);
  });

  it('coerces boolean and number context values predictably', () => {
    const packRoot = newPack({ 'prompts/values.md': 'dry=${dryRun}; count=${count}' });

    expect(
      renderTemplate({
        packRoot,
        template: 'prompts/values.md',
        context: { dryRun: false, count: 3 },
      }),
    ).toBe('dry=false; count=3');
  });
});

function newPack(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'vibesync-render-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
