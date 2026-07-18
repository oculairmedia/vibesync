/**
 * Regenerate docs/reference/orchestration-contracts.schema.json from the zod
 * contracts (vibesync-jxri.3). Run: `bun scripts/generate-contract-schemas.ts`.
 * A unit test asserts the committed file matches this output (no drift).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toJsonSchemaBundle } from '../src/orchestration/contracts/index.js';

// import.meta.dir is a Bun extension (this script runs under Bun); fall back to cwd.
const scriptDir = (import.meta as { dir?: string }).dir ?? join(process.cwd(), 'scripts');
const out = join(scriptDir, '..', 'docs', 'reference', 'orchestration-contracts.schema.json');
writeFileSync(out, JSON.stringify(toJsonSchemaBundle(), null, 2) + '\n');
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
