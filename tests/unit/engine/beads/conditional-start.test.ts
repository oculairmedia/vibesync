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

describe('BdMoleculeWriter.markMoleculeRootStatus closes the root only if it is still open', () => {
  const openRoot = { id: 'r-1', status: 'open', issue_type: 'molecule_root', metadata: { exec: {} } } as never;
  const closedRoot = { id: 'r-1', status: 'closed', issue_type: 'molecule_root', metadata: { exec: { outcome: 'cancelled' } } } as never;

  it('asks bd for the compare-and-set and reports that this call closed it', async () => {
    const calls: string[][] = [];
    const writer = new BdMoleculeWriter(async (args) => { calls.push([...args]); return ''; }, { getBead: async () => openRoot, findStepsForMolecule: async () => [] });
    expect(await writer.markMoleculeRootStatus('r-1', 'closed', 'completed')).toBe(true);
    const update = calls.find((a) => a[0] === 'update')!;
    expect(update[update.indexOf('--if-status') + 1]).toBe('open');
  });

  it('a root already closed is not written at all, and its steps are not swept', async () => {
    const calls: string[][] = [];
    const writer = new BdMoleculeWriter(async (args) => { calls.push([...args]); return ''; }, { getBead: async () => closedRoot, findStepsForMolecule: async () => [{ id: 's-1', status: 'open' } as never] });
    expect(await writer.markMoleculeRootStatus('r-1', 'closed', 'failed')).toBe(false);
    expect(calls, 'no bd write at all').toEqual([]);
  });

  it("bd's precondition exit (13) on the root write means another closer won: false, not an error", async () => {
    const writer = new BdMoleculeWriter(async (args) => {
      if (args[0] === 'update') throw new CliExitError('status mismatch', 13);
      return '';
    }, { getBead: async () => openRoot, findStepsForMolecule: async () => [] });
    expect(await writer.markMoleculeRootStatus('r-1', 'closed', 'completed')).toBe(false);
    const failing = new BdMoleculeWriter(async (args) => {
      if (args[0] === 'update') throw new CliExitError('dolt down', 1);
      return '';
    }, { getBead: async () => openRoot, findStepsForMolecule: async () => [] });
    await expect(failing.markMoleculeRootStatus('r-1', 'closed', 'completed')).rejects.toThrow('dolt down');
  });
});

