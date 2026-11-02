import { describe, expect, it } from 'vitest';

import {
  BdVersionTooOldError,
  MIN_BD_VERSION,
  assertBdVersion,
  bdVersionSatisfies,
  compareBdVersions,
  parseBdVersion,
} from '../../../src/orchestration/bd-version.js';
import { bootOrchestrationPlane } from '../../../src/orchestration/boot.js';
import { checkBdVersion } from '../../../scripts/preflight/bd-preflight.js';
import { InMemoryDoltClient } from '../../_fixtures/in-memory-dolt-client.js';
import { newFakeProvider } from '../../_fixtures/fake-provider.js';

describe('bd minimum version pin (vibesync-efee)', () => {
  it('pins 1.3.2', () => {
    expect(MIN_BD_VERSION).toBe('1.3.2');
  });

  it('parses the real `bd --version` shapes', () => {
    expect(parseBdVersion('bd version 1.3.2 (9b65b9e19)')).toBe('1.3.2');
    expect(parseBdVersion('bd version 1.3.2 (9b65b9e19: HEAD@9b65b9e198ac)\n')).toBe('1.3.2');
    expect(parseBdVersion('bd version 1.2.2 (7fcf4e1634bf)')).toBe('1.2.2');
    expect(parseBdVersion('bd version 0.62.0')).toBe('0.62.0');
    expect(parseBdVersion('command not found')).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(compareBdVersions('1.3.2', '1.3.2')).toBe(0);
    expect(compareBdVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareBdVersions('1.3.10', '1.3.2')).toBeGreaterThan(0);
    expect(compareBdVersions('1.2.99', '1.3.0')).toBeLessThan(0);
    expect(compareBdVersions('0.62.0', '1.3.2')).toBeLessThan(0);
    expect(compareBdVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('satisfies at and above the minimum; rejects below and unparsable', () => {
    expect(bdVersionSatisfies('bd version 1.3.2 (x)')).toBe(true);
    expect(bdVersionSatisfies('bd version 1.3.3 (x)')).toBe(true);
    expect(bdVersionSatisfies('bd version 1.4.0 (x)')).toBe(true);
    expect(bdVersionSatisfies('bd version 1.3.1 (x)')).toBe(false);
    expect(bdVersionSatisfies('bd version 1.2.2 (7fcf4e1634bf)')).toBe(false);
    expect(bdVersionSatisfies('garbage')).toBe(false);
  });

  it('assertBdVersion names the version it found when too old', () => {
    expect(assertBdVersion('bd version 1.3.2 (x)')).toBe('1.3.2');
    let thrown: unknown;
    try { assertBdVersion('bd version 1.2.2 (7fcf4e1634bf)'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BdVersionTooOldError);
    expect((thrown as BdVersionTooOldError).found).toBe('1.2.2');
    expect((thrown as Error).message).toContain('1.2.2');
    expect((thrown as Error).message).toContain('1.3.2');
    expect(() => assertBdVersion('???')).toThrow(/could not read a bd version/);
  });

  it('preflight reports ok / error / warn for the bd version', () => {
    const exec = (stdout: string, ok = true) => ({ tryExec: () => ({ ok, stdout, stderr: '' }), readlinkSync: () => '' });
    expect(checkBdVersion(exec('bd version 1.3.2 (9b65b9e19)\n'))).toMatchObject({ name: 'bd-version', level: 'ok' });
    const old = checkBdVersion(exec('bd version 1.2.2 (7fcf4e1634bf)\n'));
    expect(old.level).toBe('error');
    expect(old.detail).toContain('1.2.2');
    expect(checkBdVersion(exec('', false)).level).toBe('warn');
  });

  it('orchestration boot fails loudly, before any side effect, when bd is too old', async () => {
    await expect(
      bootOrchestrationPlane({
        dolt: new InMemoryDoltClient() as never,
        provider: newFakeProvider(),
        persistEvents: false,
        runDriftAuditOnBoot: false,
        bdVersion: async () => 'bd version 1.2.2 (7fcf4e1634bf)',
      }),
    ).rejects.toThrow(/bd 1\.2\.2 is older than the required minimum 1\.3\.2/);
  });

  it('orchestration boot accepts bd at the minimum', async () => {
    const handle = await bootOrchestrationPlane({
      dolt: new InMemoryDoltClient() as never,
      provider: newFakeProvider(),
      persistEvents: false,
      runDriftAuditOnBoot: false,
      bdVersion: async () => 'bd version 1.3.2 (9b65b9e19)',
    });
    await handle.shutdown();
  });
});
