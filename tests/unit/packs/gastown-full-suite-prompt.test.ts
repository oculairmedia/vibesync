/**
 * vibesync soak run 2 (2026-11-18): the coder's role prompt said "You do not run the full test suite to verify - that's Tester's
 * job" while the engine (vibesync-6zos.7) fails a coder step that does not prove a full-suite run. The Terra coder obeyed its prompt,
 * the engine sent it back, and it answered "Full-suite execution is reserved for the tester by governing instructions": a blocked
 * step, so the run ended. A role prompt must never contradict a gate the engine enforces on that role's step.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFormulasFromFile } from '../../../src/engine/formula/index.js';

const packRoot = join(process.cwd(), 'packs/gastown');
const formulaFiles = readdirSync(join(packRoot, 'formulas')).filter((f) => f.endsWith('.toml'));
const rolePrompt = (role: string): string => readFileSync(join(packRoot, 'prompts', `${role}-system.md`), 'utf8');
/** The role's persona file: the live role agent was created from it and carries it as its own system text, ahead of any step prompt. */
const personaFile = (role: string): string => readFileSync(join(packRoot, '.letta/agents', `${role}.md`), 'utf8');

/** Sentences that hand the full suite to someone else, in the spellings the prompts have used. */
const HANDS_OFF = /(?:do(?:es)? not|never|don't)\s+run\s+the\s+full\s+(?:test\s+)?suite|full\s+(?:test\s+)?suite[^.\n]{0,80}(?:is|are)\s+(?:the\s+)?tester'?s?\s+(?:job|to)|that'?s\s+tester'?s\s+job|reserved\s+for\s+the\s+tester|full\s+gate\)?\.\s*$|(?:do(?:es)?\s+not|never|don't)\s+run\s+the\s+full\s+gate/im;

describe('a role prompt does not contradict a gate the engine enforces on its step (vibesync soak run 2)', () => {
  const required = formulaFiles.flatMap((file) =>
    loadFormulasFromFile(join(packRoot, 'formulas', file)).flatMap((formula) =>
      formula.steps.filter((s) => s.requiresFullSuite).map((s) => ({ formula: formula.name, role: s.role }))));

  it('there are shipped steps that require the full suite (so the check below is not vacuous)', () => {
    expect(required.length).toBeGreaterThanOrEqual(3);
  });

  it.each(required)('the $role prompt of $formula does not hand the full suite to someone else', ({ role }) => {
    expect(rolePrompt(role)).not.toMatch(HANDS_OFF);
  });

  it.each([...new Set(required.map((r) => r.role))])('the %s persona file does not hand the full suite to someone else either (the live agent carries it as its identity)', (role) => {
    expect(personaFile(role)).not.toMatch(HANDS_OFF);
  });

  // The step prompt AND the persona file (the live agent's own system text) must each say it: the persona is read on every turn,
  // before any step prompt, so a persona that drops a part of the rule leaves the coder with half of it.
  const sources = [...new Set(required.map((r) => r.role))].flatMap((role) => [
    { role, kind: 'step prompt', text: () => rolePrompt(role) },
    { role, kind: 'persona file', text: () => personaFile(role) },
  ]);
  it.each(sources)('the $role $kind tells the role to run the full suite itself, one run at a time, to wait for it to exit, and names the report the engine reads', ({ text }) => {
    const prompt = text();
    expect(prompt).toMatch(/full (?:test )?suite/i);
    expect(prompt).toContain('/tmp/vitest-');
    expect(prompt).toMatch(/one run at a time/i);
    expect(prompt).toMatch(/until it exits/i);
  });

  // Operational safeguards the two outside reviews asked for. Lexical regression checks, not behavioural proof: behaviour is
  // proved by a live dispatch (the next trial run).
  const SAFEGUARDS: Array<[string, RegExp]> = [
    ['one run at a time, never overlapping', /ONE RUN AT A TIME\. Never start a second run, and never launch a replacement, while one is alive/],
    ['wait on the SAME run when the tool returns early', /(?:may )?return(?:s)? before a long command has exited[\s\S]{0,200}still running[\s\S]{0,120}wait on that same run/i],
    ['no backgrounding', /\bnohup\b/i],
    ['rerun after the last change, including a commit hook', /hook/i],
    ['a stopping rule that reports the exact diagnostics', /exact (?:diagnostics|output|failure)/i],
    ['a filtered run is not the report', /Read its numbers when it exits:[^\n]*A filtered run \(a file, or `-t`\) is a debugging aid, never the report/],
  ];
  const safeguardCases = sources.flatMap((src) => SAFEGUARDS.map(([what, re]) => ({ ...src, what, re })));
  it.each(safeguardCases)('the $role $kind carries the safeguard: $what', ({ text, re }) => {
    expect(text()).toMatch(re);
  });
  it('no coder source offers the suite as optional or in the background', () => {
    for (const { text } of sources) expect(text()).not.toMatch(/optionally|or in the background|or background|\bmay run the full/i);
  });

  it('the formula steps that tell their role to run the suite also require it (the engine check must not be dropped by someone who thinks the coder does it now)', () => {
    for (const role of new Set(required.map((r) => r.role))) {
      const prompt = rolePrompt(role);
      if (!prompt.includes('/tmp/vitest-')) continue;
      const steps = formulaFiles.flatMap((file) => loadFormulasFromFile(join(packRoot, 'formulas', file)).flatMap((f) => f.steps.filter((x) => x.role === role)));
      expect(steps.every((x) => x.requiresFullSuite === true), `every ${role} step must set requires_full_suite`).toBe(true);
    }
  });

  it('the detector catches the sentences that cost run 2 (so the test cannot pass on a changed spelling)', () => {
    expect('- You do not run the full test suite to verify — that\'s Tester\'s job.').toMatch(HANDS_OFF);
    expect('The full test suite and the task\'s other gates are the tester\'s job, not yours.').toMatch(HANDS_OFF);
    expect('Full-suite execution is reserved for the tester.').toMatch(HANDS_OFF);
    expect("Does not decide WHAT to build (that's Mayor's job), does not run the full gate (Tester's job).").toMatch(HANDS_OFF);
    expect('- I do not run the full test suite — that\'s the tester\'s job. I run a fast local check, not the full gate.').toMatch(HANDS_OFF);
    expect('Run the full suite once, in the foreground.').not.toMatch(HANDS_OFF);
  });
});
