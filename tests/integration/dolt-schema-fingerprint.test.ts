import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_BD_SCHEMA_FINGERPRINT } from '../../src/orchestration/store/schema-fingerprint.js';
import { provisionIsolatedBeads, RUN_ISOLATED_BEADS } from './orchestration/isolated-beads.js';

// VIBESYNC_TEST_BD=/absolute/path/to/pinned/bd npx vitest run tests/integration/dolt-schema-fingerprint.test.ts
// No opt-in means no CLI calls, server startup, or connection to cwd's .beads.
describe.skipIf(!RUN_ISOLATED_BEADS)('vendored schema against disposable Beads', () => {
  let store: Awaited<ReturnType<typeof provisionIsolatedBeads>> | undefined;
  beforeAll(async () => { store = await provisionIsolatedBeads(); }, 120_000);
  afterAll(async () => { await store?.close(); }, 120_000);

  it('preserves the production schema gate', async () => {
    expect(EXPECTED_BD_SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    await expect(store!.client.verifySchema()).resolves.toBeUndefined();
  });
});
