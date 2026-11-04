/**
 * Versioned orchestration contracts (vibesync-jxri.3). Public surface:
 * the zod schemas + inferred types + a JSON Schema generator so external
 * consumers (and the Kotlin port) get machine-readable contracts without
 * importing zod.
 */

import { z } from 'zod';

export { CONTRACT_SCHEMA_VERSION, EVOLUTION_POLICY, MOLECULE_OUTCOMES } from './version.js';
export type { MoleculeOutcome } from './version.js';

export * from './schemas.js';

import { CONTRACTS, type ContractName } from './schemas.js';
import { CONTRACT_SCHEMA_VERSION } from './version.js';

/** Generate the JSON Schema (draft 2020-12) for a single named contract. */
export function toJsonSchema(name: ContractName): Record<string, unknown> {
  return z.toJSONSchema(CONTRACTS[name], { target: 'draft-2020-12' }) as Record<string, unknown>;
}

/**
 * Generate the full versioned bundle: every contract'"'"'s JSON Schema under a
 * top-level object that itself carries the schema_version (no unversioned
 * ad-hoc payloads in the golden surface — jxri.3 acceptance).
 */
export function toJsonSchemaBundle(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const name of Object.keys(CONTRACTS) as ContractName[]) {
    schemas[name] = toJsonSchema(name);
  }
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    $comment: 'VibeSync orchestration contract bundle (vibesync-jxri.3). Generated from zod schemas; do not hand-edit.',
    contracts: schemas,
  };
}
