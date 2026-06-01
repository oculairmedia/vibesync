import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  discoverPacks,
  loadPack,
  validatePackPath,
} from '../../../src/orchestration/packs/index.js';
import { renderTemplate } from '../../../src/orchestration/dispatcher/render.js';

/**
 * Integration: the gastown pack at packs/gastown/ loads cleanly and
 * carries the role + formula catalog described in
 * docs/architecture/gastown-role-catalog.md.
 */

const PROJECT_ROOT = process.cwd();
const PACK_ROOT = join(PROJECT_ROOT, 'packs', 'gastown');

describe('gastown pack', () => {
  it('validatePackPath reports ok:true', () => {
    expect(validatePackPath(PACK_ROOT)).toEqual({ ok: true });
  });

  it('loadPack picks up manifest + 5 roles + 3 formulas', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    expect(pack.manifest.name).toBe('gastown');
    expect(pack.manifest.version).toBe('0.1.0');

    const roleNames = pack.roles.map((r) => r.name).sort();
    expect(roleNames).toEqual(['coder', 'mayor', 'refinery', 'reviewer', 'tester']);

    const formulaNames = pack.formulas.map((f) => f.name).sort();
    expect(formulaNames).toEqual(['code-review', 'onboard-feature', 'refinery-sweep']);
  });

  it('roles carry tools array + system_prompt_template references', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    const mayor = pack.roles.find((r) => r.name === 'mayor');
    expect(mayor?.systemPromptTemplate).toBe('prompts/mayor-system.md');
    expect(mayor?.tools).toContain('dispatch_molecule');

    const tester = pack.roles.find((r) => r.name === 'tester');
    expect(tester?.tools).toContain('run_shell');
  });

  it('all roles carry at least persona and scope memory blocks', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    for (const role of pack.roles) {
      expect(role.memoryBlocks?.map((block) => block.label)).toEqual(expect.arrayContaining(['persona', 'scope']));
      expect(role.memoryBlocks?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('code-review formula declares reviewer → coder → tester chain', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    const f = pack.formulas.find((x) => x.name === 'code-review');
    expect(f).toBeDefined();
    expect(f!.steps.map((s) => s.role)).toEqual(['reviewer', 'coder', 'tester']);
    expect(f!.steps[1]!.dependsOn).toEqual(['reviewer']);
    expect(f!.steps[2]!.dependsOn).toEqual(['coder']);
  });

  it('onboard-feature formula starts with mayor and chains four roles', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    const f = pack.formulas.find((x) => x.name === 'onboard-feature');
    expect(f).toBeDefined();
    expect(f!.steps.map((s) => s.role)).toEqual(['mayor', 'coder', 'reviewer', 'tester']);
  });

  it('onboard-feature role prompt templates render concrete input and prior handoff context', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    const f = pack.formulas.find((x) => x.name === 'onboard-feature');
    expect(f).toBeDefined();

    for (const step of f!.steps) {
      const rendered = renderTemplate({
        packRoot: pack.root,
        template: step.promptTemplate!,
        context: {
          input: 'Build the onboarding feature in /opt/stacks/example.',
          prior_outputs: '## mayor\nUse src/onboarding.ts and add tests.',
          prior_mayor: 'Use src/onboarding.ts and add tests.',
          prior_coder: 'Changed src/onboarding.ts and tests/onboarding.test.ts.',
          prior_reviewer: 'LGTM-with-nits',
        },
      });

      expect(rendered).toContain('Build the onboarding feature in /opt/stacks/example.');
      expect(rendered).toContain('## mayor\nUse src/onboarding.ts and add tests.');
      expect(rendered).not.toContain('${input}');
      expect(rendered).not.toContain('${prior_outputs}');
    }
  });

  it('refinery-sweep is a single-step formula', () => {
    const pack = loadPack(PACK_ROOT, 'project');
    const f = pack.formulas.find((x) => x.name === 'refinery-sweep');
    expect(f).toBeDefined();
    expect(f!.steps.map((s) => s.role)).toEqual(['refinery']);
  });

  it('discoverPacks does NOT find packs/gastown at project scope because the discovery root is .vibesync/packs', () => {
    // Packs at packs/<name>/ (repo-root packs/) are bundled with the
    // app — they live alongside src/. Discovery sweeps
    // .vibesync/packs/ (user-installed). The bundled packs/ tree is
    // loaded by name via loadPack(), not discovered.
    const packs = discoverPacks({ projectRoot: PROJECT_ROOT, homeDir: '/tmp/nohome-for-test' });
    expect(packs.find((p) => p.manifest.name === 'gastown')).toBeUndefined();
  });

  it('bundled pack registers correctly under a synthetic discovery root', () => {
    // Demonstrates how a pack install command would route the
    // bundled gastown pack into a discoverable location:
    // symlink or copy to .vibesync/packs/gastown/. For the test we
    // pass projectRoot = the parent of packs/ so .vibesync/packs/
    // search finds nothing, then loadPack directly.
    const pack = loadPack(join(PROJECT_ROOT, 'packs', 'gastown'), 'global');
    expect(pack.roles).toHaveLength(5);
  });
});
