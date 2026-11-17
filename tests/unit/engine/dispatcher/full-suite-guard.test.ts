/**
 * vibesync-6zos.7 guard: the full-suite evidence check cannot be removed silently. Soak runs 2 and 4 failed because the
 * coder's "I ran the suite" was trusted; the engine now reads the report. This pins that the step path still calls the check
 * and that every shipped formula's coder step still asks for it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFormulasFromFile } from '../../../../src/engine/formula/index.js';

const stepTurn = readFileSync(resolve('src/engine/dispatcher/step-turn.ts'), 'utf8');

describe('full-suite evidence guard (vibesync-6zos.7)', () => {
  it('the step verdict path runs the check for steps that require the full suite, and fails them closed', () => {
    expect(stepTurn).toMatch(/stepSpec\.requiresFullSuite\s*\n?\s*\?\s*await this\.fullSuiteShortfall\(/);
    expect(stepTurn).toMatch(/if \(unproven !== null\) return \{ signal: \{ origin: 'stopped' \}, error: new FullSuiteUnprovenError\(unproven\)/);
    // A short report is sent back to the coder, bounded, and the retry prompt carries the reason (both outside reviews).
    expect(stepTurn).toMatch(/failure\.error instanceof FullSuiteUnprovenError && state\.attempt < FULL_SUITE_ATTEMPTS/);
    expect(stepTurn).toMatch(/\}\) \+ fullSuiteRetryNote\(args\.step\) \+/);
  });

  it.each(['code-review', 'implement-fix', 'onboard-feature'])('the shipped %s formula requires the full suite of its coder step', (name) => {
    const [formula] = loadFormulasFromFile(resolve(`packs/gastown/formulas/${name}.toml`));
    const coder = formula!.steps.find((s) => s.role === 'coder');
    expect(coder, 'the formula has a coder step').toBeDefined();
    expect(coder!.requiresFullSuite).toBe(true);
  });
});
