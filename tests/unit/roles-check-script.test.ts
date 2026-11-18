import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pushRoleAgent } from '../../scripts/roles/push-role-agent';
import { check } from '../../scripts/roles/check-role-agents';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roles-check-')); roots.push(root);
  const pack = join(root, 'pack'); const agentsDir = join(root, 'agents'); const registryDb = join(root, 'registry.db');
  mkdirSync(join(pack, 'roles'), { recursive: true }); mkdirSync(join(pack, '.letta/agents'), { recursive: true }); mkdirSync(agentsDir);
  const db = new Database(registryDb);
  db.exec('CREATE TABLE project_role_agents (project_identifier TEXT, role_name TEXT, agent_id TEXT)');
  for (const role of ['one', 'two']) {
    writeFileSync(join(pack, 'roles', `${role}.toml`), `[role]\nname = "${role}"\n`);
    writeFileSync(join(pack, '.letta/agents', `${role}.md`), `---\n${role}\n---\nOriginal sentence.\n`);
    db.prepare('INSERT INTO project_role_agents VALUES (?, ?, ?)').run('project', role, `agent-${role}`);
    writeFileSync(join(agentsDir, `${Buffer.from(`agent-${role}`).toString('base64')}.json`), JSON.stringify({ system: `---\n${role}\n---\nOriginal sentence.\n` }));
  }
  db.close();
  const options = { project: 'project', pack, agentsDir, registryDb };
  const run = () => { const lines: string[] = []; return { status: check(options, (line) => lines.push(line)), text: lines.join('\n') }; };
  return { options, run };
}
describe('role persona check', () => {
  it('passes when all registered role personas match', () => { const { run } = fixture(); expect(run()).toMatchObject({ status: 0, text: expect.stringContaining('two agent-two: in sync') }); });
  it('reports the first differing lines from the store and persona', () => {
    const { options, run } = fixture();
    writeFileSync(join(options.agentsDir, `${Buffer.from('agent-two').toString('base64')}.json`), JSON.stringify({ system: '---\ntwo\n---\nChanged sentence.' }));
    const result = run(); expect(result.status).toBe(1); expect(result.text).toContain('two agent-two: differs at line 4'); expect(result.text).toContain('Original sentence.'); expect(result.text).toContain('Changed sentence.');
  });
  it('fails closed when a registration is missing', () => {
    const { options, run } = fixture(); const db = new Database(options.registryDb); db.prepare('DELETE FROM project_role_agents WHERE role_name = ?').run('one'); db.close();
    expect(run()).toMatchObject({ status: 2, text: expect.stringContaining('no agent for role one') });
  });
  it('fails closed when a store file cannot be read', () => {
    const { options, run } = fixture(); rmSync(join(options.agentsDir, `${Buffer.from('agent-one').toString('base64')}.json`));
    expect(run()).toMatchObject({ status: 2, text: expect.stringContaining('one: Error:') });
  });
  it('pushes the entire persona and rejects a mismatched read-back', async () => {
    const { options } = fixture();
    const update = vi.fn(async () => {});
    writeFileSync(join(options.agentsDir, `${Buffer.from('agent-one').toString('base64')}.json`), JSON.stringify({ system: 'stale' }));
    await expect(pushRoleAgent('one', options, update)).rejects.toThrow('read-back differs');
    expect(update).toHaveBeenCalledWith('agent-one', '---\none\n---\nOriginal sentence.\n');
  });
  it('fails closed when the registry is missing', () => { const { options, run } = fixture(); rmSync(options.registryDb); expect(run().status).toBe(2); });
});
