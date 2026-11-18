import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { parse } from 'smol-toml';

export interface CheckOptions {
  project: string;
  pack: string;
  agentsDir: string;
  registryDb: string;
}

export function roleNames(pack: string): string[] {
  const files = readdirSync(join(pack, 'roles')).filter((name) => name.endsWith('.toml')).sort();
  if (!files.length) throw new Error('pack has no roles');
  return files.map((file) => {
    const role = parse(readFileSync(join(pack, 'roles', file), 'utf8')).role;
    if (!role || typeof role !== 'object' || !('name' in role) || typeof role.name !== 'string' || !/^[\w-]+$/.test(role.name)) {
      throw new Error(`invalid role in ${file}`);
    }
    return role.name;
  });
}

export function persona(pack: string, role: string): string {
  return readFileSync(join(pack, '.letta', 'agents', `${role}.md`), 'utf8');
}

export function agentId(db: Database.Database, project: string, role: string): string {
  const row = db.prepare('SELECT agent_id FROM project_role_agents WHERE project_identifier = ? AND role_name = ?').get(project, role) as { agent_id: unknown } | undefined;
  if (!row || typeof row.agent_id !== 'string' || !row.agent_id) throw new Error(`no agent for role ${role} in project ${project}`);
  return row.agent_id;
}

export function storedSystem(agentsDir: string, id: string): string {
  const value: unknown = JSON.parse(readFileSync(join(agentsDir, `${Buffer.from(id).toString('base64')}.json`), 'utf8'));
  if (!value || typeof value !== 'object' || !('system' in value) || typeof value.system !== 'string') throw new Error(`invalid system text for agent ${id}`);
  return value.system;
}

export function check(options: CheckOptions, output: (line: string) => void = console.log): number {
  let db: Database.Database | undefined;
  let status = 0;
  try {
    db = new Database(options.registryDb, { readonly: true, fileMustExist: true });
    for (const role of roleNames(options.pack)) {
      try {
        const id = agentId(db, options.project, role);
        const expected = persona(options.pack, role).trim();
        const actual = storedSystem(options.agentsDir, id).trim();
        if (expected === actual) output(`${role} ${id}: in sync`);
        else {
          status = Math.max(status, 1);
          const a = expected.split('\n'); const b = actual.split('\n');
          let i = 0; while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
          output(`${role} ${id}: differs at line ${i + 1}\n  persona: ${a[i] ?? '<end of file>'}\n  stored: ${b[i] ?? '<end of file>'}`);
        }
      } catch (error) {
        status = 2;
        output(`${role}: ${String(error)}`);
      }
    }
  } catch (error) {
    status = 2;
    output(String(error));
  } finally { db?.close(); }
  return status;
}

export function parseOptions(args: string[]): CheckOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key || !['--project', '--pack', '--agents-dir', '--registry-db'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('invalid arguments');
    values[key] = value;
  }
  if (!values['--project']) throw new Error('--project is required');
  return {
    project: values['--project'], pack: values['--pack'] ?? 'packs/gastown',
    agentsDir: values['--agents-dir'] ?? join(homedir(), '.letta/lc-local-backend/agents'),
    registryDb: values['--registry-db'] ?? process.env.VIBESYNC_DB_PATH ?? resolve(process.env.VIBESYNC_APP_ROOT ?? '.', 'logs/sync-state.db'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = check(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(String(error)); process.exitCode = 2; }
}
