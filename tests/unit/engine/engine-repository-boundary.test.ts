import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('engine source repository boundary', () => {
  it('does not name a project or host path outside comments and bead identifiers', () => {
    const violations: string[] = [];
    for (const file of filesUnder(join(process.cwd(), 'src/engine'))) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\bvibesync-[a-z0-9]+\b/gi, '');
      const withoutStrings = code.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '');
      const violationsHere = /\bvibesync\b|\/opt\/stacks|oculairmedia/i.test(withoutStrings)
        || /\/opt\/stacks|oculairmedia/i.test(code);
      if (violationsHere) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
