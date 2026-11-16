/**
 * The step-start write is a compare-and-set (outside review of PR #188): bd's `--if-status open` refuses a step that is
 * no longer open with exit 13, and the engine must read that exit code, not a message.
 */
import { describe, expect, it } from 'vitest';

import { CliExitError, createCliRunner } from '../../../../src/engine/beads/cli.js';
import { BdMoleculeWriter } from '../../../../src/engine/beads/molecule-writer.js';

const reader = { getBead: async () => null, findStepsForMolecule: async () => [] };

describe('createCliRunner keeps the exit code of a CLI that ran and failed', () => {
  it('a non-zero exit is a CliExitError carrying that code', async () => {
    const run = createCliRunner({ binary: '/bin/sh' });
    const error = await run(['-c', 'exit 13']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliExitError);
    expect((error as CliExitError).exitCode).toBe(13);
  });

  it('a CLI that could not be started has no exit code', async () => {
    const run = createCliRunner({ binary: '/nonexistent/vibesync-no-such-binary' });
    const error = await run(['x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliExitError);
    expect((error as CliExitError).exitCode).toBeNull();
  });
});

describe('BdMoleculeWriter.markStepRunning starts a step only if it is still open', () => {
  it('asks bd for the compare-and-set and reports a start', async () => {
    const calls: string[][] = [];
    const writer = new BdMoleculeWriter(async (args) => { calls.push([...args]); return ''; }, reader);
    expect(await writer.markStepRunning('s-1')).toBe(true);
    const args = calls[0]!;
    expect(args.slice(0, 4)).toEqual(['update', 's-1', '--status', 'in_progress']);
    expect(args[args.indexOf('--if-status') + 1]).toBe('open');
  });

  it("bd's precondition exit (13) is a refusal: false, not an error", async () => {
    const writer = new BdMoleculeWriter(async () => { throw new CliExitError('status mismatch', 13); }, reader);
    expect(await writer.markStepRunning('s-1')).toBe(false);
  });

  it('any other failure is still an error', async () => {
    const other = new BdMoleculeWriter(async () => { throw new CliExitError('dolt down', 1); }, reader);
    await expect(other.markStepRunning('s-1')).rejects.toThrow('dolt down');
    const plain = new BdMoleculeWriter(async () => { throw new Error('spawn failed'); }, reader);
    await expect(plain.markStepRunning('s-1')).rejects.toThrow('spawn failed');
  });
});
