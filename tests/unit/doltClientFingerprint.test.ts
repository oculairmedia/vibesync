/**
 * Tests for the DoltClient fingerprint check — vibesync-84a.
 *
 * The pool query path requires a real mysql server, so we test the pure
 * comparison via `assertFingerprintMatch` here. Spinning up an integration
 * test against a Dolt server is left to higher layers.
 */

import { describe, expect, it } from 'vitest';
import {
  WrongDoltDatabaseError,
  assertFingerprintMatch,
} from '../../src/orchestration/store/dolt-client.js';

describe('assertFingerprintMatch', () => {
  it('returns silently when the values match', () => {
    expect(() =>
      assertFingerprintMatch({
        expectedRepoId: 'abcdef1234567890abcdef1234567890',
        actualRepoId: 'abcdef1234567890abcdef1234567890',
        database: 'letta_mobile',
        port: 3308,
      }),
    ).not.toThrow();
  });

  it('treats an empty actual fingerprint as legacy (no throw)', () => {
    // bd doctor downgrades "no repo_id row" to a WARN; we mirror that
    // so legacy databases don't trip the new error path.
    expect(() =>
      assertFingerprintMatch({
        expectedRepoId: 'abcdef1234567890abcdef1234567890',
        actualRepoId: '',
        database: 'legacy_db',
        port: 3309,
      }),
    ).not.toThrow();
  });

  it('throws WrongDoltDatabaseError with rich context on mismatch', () => {
    expect.assertions(6);
    try {
      assertFingerprintMatch({
        expectedRepoId: '49ccb4f49b9c5b0fb18a5cddde646911',
        actualRepoId: 'c764961ff39c5544d4c26a5988040eed',
        database: 'letta_mobile',
        port: 3308,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WrongDoltDatabaseError);
      const wrong = err as WrongDoltDatabaseError;
      expect(wrong.name).toBe('WrongDoltDatabaseError');
      expect(wrong.database).toBe('letta_mobile');
      expect(wrong.port).toBe(3308);
      expect(wrong.expectedRepoId).toBe('49ccb4f49b9c5b0fb18a5cddde646911');
      expect(wrong.actualRepoId).toBe('c764961ff39c5544d4c26a5988040eed');
    }
  });

  it('includes the 8-char prefix of both fingerprints in the message', () => {
    try {
      assertFingerprintMatch({
        expectedRepoId: '49ccb4f49b9c5b0fb18a5cddde646911',
        actualRepoId: 'c764961ff39c5544d4c26a5988040eed',
        database: 'letta_mobile',
        port: 3308,
      });
    } catch (err) {
      const message = (err as Error).message;
      // Matches bd doctor's "stored: c764961f, current: 49ccb4f4" style.
      expect(message).toContain('49ccb4f4');
      expect(message).toContain('c764961f');
      expect(message).toContain('letta_mobile');
      expect(message).toContain('3308');
    }
  });
});
