/**
 * Integration guard for vibesync-bll: the vendored bd schema fingerprint
 * must match the live bd schema in `.beads/dolt/`.
 *
 * This test confirms two things at once:
 *   1. The canonicalization in schema-fingerprint.ts produces a stable
 *      hash against a real Dolt instance's `SHOW CREATE TABLE` output.
 *   2. The vendored `EXPECTED_BD_SCHEMA_FINGERPRINT` is current — if a
 *      bd upgrade changes a relevant table, this test fails and the
 *      operator is forced to re-verify before bumping the constant.
 *
 * Skipped when `.beads/dolt-server.port` is missing (e.g. CI runners
 * that don't spin up Dolt).
 */

import { existsSync } from 'node:fs';
import { describe, expect, it, afterAll } from 'vitest';

import { DoltClient } from '../../src/orchestration/store/dolt-client.js';
import {
  EXPECTED_BD_SCHEMA_FINGERPRINT,
} from '../../src/orchestration/store/schema-fingerprint.js';

const portFile = '.beads/dolt-server.port';
const haveDolt = existsSync(portFile);
const describeOrSkip = haveDolt ? describe : describe.skip;

describeOrSkip('vendored bd schema fingerprint matches live bd', () => {
  let client: DoltClient | null = null;

  afterAll(async () => {
    if (client) await client.close();
  });

  it('verifySchema() succeeds against the running Dolt server', async () => {
    client = new DoltClient();
    await expect(client.verifySchema()).resolves.toBeUndefined();
    // The expected constant is non-empty and 64 hex chars — sanity check
    // so a future "set to empty string" diff fails here instead of
    // silently passing.
    expect(EXPECTED_BD_SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
  });
});
