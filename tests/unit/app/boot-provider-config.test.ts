/**
 * vibesync-9lzk.29 (CodeRabbit on #89): a VIBESYNC_ORCHESTRATION_PROVIDER that
 * names a removed provider is a configuration error. It must stop the service
 * at boot. The bug it guards: the engine boot loop retried the error like a
 * slow Dolt start, then logged "continuing without it" and served the API with
 * orchestration silently off. Unit tests of bootOrchestrationPlane cannot see
 * that, because the retry lives in src/app/main.ts, so this runs the REAL
 * entry point (`bun src/index.ts`) the way vibesync.service does.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Bun on PATH (CI installs it with oven-sh/setup-bun), else the local install. */
function findBun(): string | null {
  if (process.env['BUN_BIN']) return process.env['BUN_BIN'];
  try {
    return execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return existsSync('/root/.bun/bin/bun') ? '/root/.bun/bin/bun' : null;
  }
}
const BUN = findBun();
// CI must actually run this: a silent skip there would hide the bug it guards.
if (process.env['CI'] && !BUN) throw new Error('bun is required in CI for the boot provider-config test');

function bootWith(provider: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vibesync-boot-provider-'));
  mkdirSync(join(dir, 'stacks'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    ENABLE_ORCHESTRATION: 'true',
    VIBESYNC_ORCHESTRATION_PROVIDER: provider,
    VIBESYNC_LETTA_CODE_PARENT_AGENT_ID: 'agent-parent',
    // Several attempts with the default backoff would take ~30 s if the error
    // were retried; the test's timeout below would then fail it.
    ORCHESTRATION_BOOT_ATTEMPTS: '5',
    STACKS_DIR: join(dir, 'stacks'),
    VIBESYNC_DB_PATH: join(dir, 'registry.db'),
    VIBESYNC_PORT_SWEEP_INTERVAL_MS: '0',
    HEALTH_PORT: '0',
    NO_PRETTY_LOGS: '1',
  };
  const started = Date.now();
  const result = spawnSync(BUN!, ['src/index.ts'], { env, encoding: 'utf8', timeout: 20_000 });
  return { ...result, elapsedMs: Date.now() - started, output: `${result.stdout}\n${result.stderr}` };
}

describe.skipIf(!BUN)('real boot: unsupported orchestration provider (vibesync-9lzk.29)', () => {
  for (const provider of ['letta-code-subagent', 'letta-teams', '']) {
    it(`VIBESYNC_ORCHESTRATION_PROVIDER=${JSON.stringify(provider)} exits non-zero before any retry`, () => {
      const run = bootWith(provider);
      // Killed by the timeout (status null) means it kept running: the bug.
      expect(run.status, run.output.slice(-2000)).toBe(1);
      // Format-agnostic: JSON logs escape the quotes inside the message.
      expect(run.output).toContain('UnsupportedProviderError');
      expect(run.output).toContain('letta-code-iroh is the only provider');
      expect(run.output).toContain('Fatal error, exiting');
      expect(run.output).not.toContain('retrying with backoff');
      expect(run.output).not.toContain('continuing without it');
      expect(run.output).not.toContain('API server running');
    }, 30_000);
  }
});
