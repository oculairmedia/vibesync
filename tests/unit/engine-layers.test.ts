/**
 * vibesync-9lzk.59.1: the engine's layer map must place every package, and only
 * real ones. A package the map omits gets no layer rule at all, which is how 12
 * of 16 packages went unchecked before this test.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ENGINE_LAYERS } from '../../eslint.config.js';

const ENGINE = join(__dirname, '../../src/engine');
const packages = readdirSync(ENGINE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const mapped = (ENGINE_LAYERS as readonly (readonly string[])[]).flat();

describe('engine layer map', () => {
  it('places every package under src/engine', () => {
    expect(packages.filter((p) => !mapped.includes(p))).toEqual([]);
  });

  it('names no directory that does not exist', () => {
    expect(mapped.filter((p) => !packages.includes(p))).toEqual([]);
  });

  it('places each package exactly once', () => {
    expect(mapped.filter((p, i) => mapped.indexOf(p) !== i)).toEqual([]);
  });
});
