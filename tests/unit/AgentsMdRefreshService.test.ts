import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshAgentsMd, type AgentsMdRefreshDeps } from '../../src/AgentsMdRefreshService';

/**
 * Unit tests for the AGENTS.md refresh service. The underlying
 * generator is exercised via integration with the real template files
 * shipped at templates/agents-md/. These tests focus on selection
 * logic (project filtering, projectId scoping), skip behavior
 * (missing path, non-existent path), and the summary shape.
 */

describe('refreshAgentsMd', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'refresh-agents-md-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  function project(id: string, name: string, fsPath: string): { identifier: string; name: string; filesystem_path: string } {
    return { identifier: id, name, filesystem_path: fsPath };
  }

  function deps(projects: { identifier: string; name: string; filesystem_path: string }[], agentIds: Record<string, string> = {}): AgentsMdRefreshDeps {
    return {
      db: { getProjects: () => projects },
      getAgentIdForProject: (identifier: string) => agentIds[identifier] ?? null,
    };
  }

  it('writes AGENTS.md into each project filesystem_path and returns updated status', async () => {
    const a = join(tmp, 'proj-a');
    const b = join(tmp, 'proj-b');
    mkdirSync(a);
    mkdirSync(b);
    const summary = await refreshAgentsMd(deps([project('a', 'Project A', a), project('b', 'Project B', b)]));
    expect(summary.total).toBe(2);
    expect(summary.updated).toBe(2);
    expect(summary.errors).toBe(0);
    expect(existsSync(join(a, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(b, 'AGENTS.md'))).toBe(true);
    const aContent = readFileSync(join(a, 'AGENTS.md'), 'utf8');
    expect(aContent).toContain('<!-- VIBESYNC:project-info:START -->');
    expect(aContent).toContain('Project A');
    expect(aContent).toContain('<!-- VIBESYNC:beads-instructions:START -->');
  });

  it('honors projectId to scope to a single project', async () => {
    const a = join(tmp, 'proj-a');
    const b = join(tmp, 'proj-b');
    mkdirSync(a);
    mkdirSync(b);
    const summary = await refreshAgentsMd(
      deps([project('a', 'Project A', a), project('b', 'Project B', b)]),
      { projectId: 'a' },
    );
    expect(summary.total).toBe(1);
    expect(summary.results[0]!.identifier).toBe('a');
    expect(existsSync(join(a, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(b, 'AGENTS.md'))).toBe(false);
  });

  it('skips projects whose filesystem_path does not exist on this host', async () => {
    const summary = await refreshAgentsMd(
      deps([project('ghost', 'Ghost', join(tmp, 'does-not-exist'))]),
    );
    expect(summary.skipped).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.results[0]!.status).toBe('skipped');
    expect(summary.results[0]!.reason).toContain('does not exist');
  });

  it('skips projects with empty filesystem_path', async () => {
    const summary = await refreshAgentsMd(deps([project('noPath', 'No Path', '')]));
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]!.reason).toContain('no filesystem_path');
  });

  it('dryRun computes changes without writing', async () => {
    const a = join(tmp, 'proj-a');
    mkdirSync(a);
    const summary = await refreshAgentsMd(deps([project('a', 'A', a)]), { dryRun: true });
    expect(summary.dryRun).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.results[0]!.status).toBe('dry-run');
    expect(existsSync(join(a, 'AGENTS.md'))).toBe(false);
  });

  it('uses getAgentIdForProject when supplied to populate agentId in templates', async () => {
    const a = join(tmp, 'proj-a');
    mkdirSync(a);
    await refreshAgentsMd(deps([project('a', 'Project A', a)], { a: 'agent-abc-123' }));
    const content = readFileSync(join(a, 'AGENTS.md'), 'utf8');
    expect(content).toContain('agent-abc-123');
    expect(content).toContain('PM - Project A');
  });

  it('falls back to getProjectsWithFilesystemPath when getProjects is absent', async () => {
    const a = join(tmp, 'proj-a');
    mkdirSync(a);
    const fallbackDeps: AgentsMdRefreshDeps = {
      db: { getProjectsWithFilesystemPath: () => [project('a', 'A', a)] },
    };
    const summary = await refreshAgentsMd(fallbackDeps);
    expect(summary.total).toBe(1);
    expect(summary.updated).toBe(1);
  });

  it('preserves CUSTOM-marked sections from previous AGENTS.md across refreshes', async () => {
    const a = join(tmp, 'proj-a');
    mkdirSync(a);
    // Hand-write a custom-marked beads section before the refresh
    writeFileSync(
      join(a, 'AGENTS.md'),
      '<!-- VIBESYNC:beads-instructions:CUSTOM -->\n# my custom rules\nhand-edited\n',
    );
    const summary = await refreshAgentsMd(deps([project('a', 'A', a)]));
    expect(summary.results[0]!.status).toBe('updated');
    const content = readFileSync(join(a, 'AGENTS.md'), 'utf8');
    expect(content).toContain('CUSTOM');
    expect(content).toContain('hand-edited');
    // Other sections still rendered
    expect(content).toContain('<!-- VIBESYNC:project-info:START -->');
  });

  it('emits a summary row per project regardless of status', async () => {
    const exists1 = join(tmp, 'p1');
    const exists2 = join(tmp, 'p2');
    mkdirSync(exists1);
    mkdirSync(exists2);
    const summary = await refreshAgentsMd(
      deps([
        project('p1', 'P1', exists1),
        project('p2', 'P2', exists2),
        project('ghost', 'Ghost', join(tmp, 'nope')),
        project('blank', 'Blank', ''),
      ]),
    );
    expect(summary.total).toBe(4);
    expect(summary.results.map((r) => r.status).sort()).toEqual(['skipped', 'skipped', 'updated', 'updated']);
  });
});
