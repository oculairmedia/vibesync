import type { FullSuiteEvidenceSource } from '../../src/engine/dispatcher/step-turn.js';

/**
 * vibesync-6zos.7: an evidence reader that reports a complete, passing full-suite run written at the moment it is read
 * (during the step). For tests that run a shipped formula, whose coder step has `requires_full_suite`, and are not about
 * that check: a coder that really ran the suite leaves this report behind.
 */
export function passingFullSuiteEvidence(): FullSuiteEvidenceSource {
  const file = 'tests/unit/all.test.ts';
  return {
    async readReport() {
      return { startTime: Date.now(), numFailedTests: 0, testResults: [{ name: `/work/${file}`, status: 'passed', assertionResults: [{ status: 'passed' }] }] };
    },
    async listTestFiles() { return [file]; },
  };
}
