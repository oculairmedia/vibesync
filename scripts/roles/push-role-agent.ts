import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeIrohConnection, resolveNativeIrohConfig } from '../../src/engine/runtime/iroh/native-dialer';
import { agentId, openRegistry, parseOptions, persona, roleNames, storedSystem, type CheckOptions } from './check-role-agents';

export async function pushRoleAgent(role: string, options: CheckOptions, update: (id: string, system: string) => Promise<unknown>): Promise<void> {
  if (!roleNames(options.pack).includes(role)) throw new Error(`unknown role ${role}`);
  const db = openRegistry(options.registryDb);
  let id: string;
  try { id = agentId(db, options.project, role); } finally { db.close(); }
  const system = persona(options.pack, role);
  await update(id, system);
  if (storedSystem(options.agentsDir, id).trim() !== system.trim()) throw new Error(`read-back differs for ${role} ${id}`);
}

async function main(): Promise<void> {
  const [role, ...args] = process.argv.slice(2);
  if (!role || role.startsWith('--')) throw new Error('role is required');
  const options = parseOptions(args);
  await pushRoleAgent(role, options, async (id, system) => {
    const connection = createNativeIrohConnection(resolveNativeIrohConfig());
    try { await connection.connect(); await connection.rpc('agent.update', { agent_id: id, system }); }
    finally { await connection.close(); }
  });
  console.log(`${role}: updated and verified`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
}
