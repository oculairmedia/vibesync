/**
 * Orchestration Activities — Project Fetching (Registry-Based)
 *
 * Activities for fetching projects from the local SQLite ProjectRegistry.
 * Phase 4: No more Huly API calls — registry is the single source of truth.
 */

import path from 'path';
import { handleOrchestratorError } from './orchestration-letta';
import type { HulyProject } from './orchestration';
import { createSyncDatabase } from '../../src/database.js';

// ============================================================
// PROJECT FETCHING ACTIVITIES
// ============================================================

/**
 * Fetch all active projects from the local SQLite ProjectRegistry.
 *
 * Replaces the old fetchHulyProjects that called the dead Huly API.
 * Returns the same HulyProject[] shape for workflow compatibility.
 */
export async function fetchRegistryProjects(): Promise<HulyProject[]> {
  console.log('[Temporal:Orchestration] Fetching projects from registry');

  try {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'logs', 'sync-state.db');
    const db = createSyncDatabase(dbPath);

    try {
      const rows = db.getAllProjects();

      // Map DB rows to HulyProject shape for backward compat
      const projects: HulyProject[] = rows
        .filter((r: any) => r.status === 'active')
        .map((r: any) => ({
          identifier: r.identifier,
          name: r.name || r.identifier,
          description: r.filesystem_path ? `Filesystem: ${r.filesystem_path}` : undefined,
        }));

      console.log(`[Temporal:Orchestration] Found ${projects.length} registry projects`);
      return projects;
    } finally {
      db.close();
    }
  } catch (error) {
    throw handleOrchestratorError(error, 'fetchRegistryProjects');
  }
}
