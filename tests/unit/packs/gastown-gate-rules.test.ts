/**
 * The gastown role prompts carry the rules that make engine runs trustworthy
 * (vibesync-9lzk.21, 9lzk.22, 9lzk.27). These are behaviour, not prose: each
 * rule came from a real failure in an engine trial, so a later edit must not
 * drop one silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const prompt = (role: string) => readFileSync(join(process.cwd(), 'packs/gastown/prompts', `${role}-system.md`), 'utf8');

describe('gastown tester prompt', () => {
  const tester = prompt('tester');
  it('runs every gate itself, including mutation gates, never on a handoff claim (round 3)', () => {
    expect(tester).toContain('Run every gate yourself, including mutation gates');
    expect(tester).toContain('"Reported as passing in the handoff" is never a');
    expect(tester).toContain('never `git stash`');
  });
  it('treats exit code 0 as a pass and runs a gate rather than calling it inconclusive (round 4)', () => {
    expect(tester).toContain('silence plus exit code 0 is a pass');
    expect(tester).toContain('"I have not run it yet" is not inconclusive: run it');
    expect(tester).toContain('`numPendingTests`');
    expect(tester).toContain('not a\n  reason to block');
  });

  it('a mutation must undo the fix itself, not nearby code (round 4 retry)', () => {
    expect(tester).toContain('A mutation must undo the fix itself');
    expect(tester).toContain('git diff origin/main -- <file>');
    expect(tester).toContain('Only a mutation that removes the\n  fix and leaves the test passing is a FAIL');
  });

  it('cannot waive a gate and stops the run on failure (trial 1)', () => {
    expect(tester).toContain('Neither the reviewer nor the coder can waive a gate');
    expect(tester).toContain('STEP OUTCOME: BLOCKED - <which gate failed>');
  });
});

describe('gastown reviewer prompt', () => {
  const reviewer = prompt('reviewer');
  it('settles "this test cannot fail" by running a mutation, else downgrades to [suggest] (trial 2)', () => {
    expect(reviewer).toContain('Settle it by');
    expect(reviewer).toContain('running it, not by reasoning about it');
    expect(reviewer).toContain('a `[suggest]` instead');
  });
  it('lists what it checked before an LGTM (round 3)', () => {
    expect(reviewer).toContain('list what you checked');
  });
  it('treats task gates as the spec and checks delivery (trial 1)', () => {
    expect(reviewer).toContain('Never argue that something the task explicitly requires is "out of scope"');
    expect(reviewer).toContain('a pull request URL is in the coder');
  });
});

describe('gastown coder prompt', () => {
  it('delivers a real PR naming the work bead (trial 1)', () => {
    const coder = prompt('coder');
    expect(coder).toContain('gh pr create');
    expect(coder).toContain('Uncommitted edits are not a delivery');
    expect(coder).toContain('work bead id');
  });
});
