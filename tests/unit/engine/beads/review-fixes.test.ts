import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { BdMoleculeWriter } from '../../../../src/engine/beads/molecule-writer.js';
import { createCliRunner, redactArgs } from '../../../../src/engine/beads/cli.js';
import { bootOrchestrationPlane } from '../../../../src/engine/boot.js';
import type { BeadRow } from '../../../../src/engine/store/index.js';

const bead = (id: string): BeadRow => ({
  id, title: id, description: '', status: 'in_progress', priority: 2, issue_type: 'molecule_step',
  created_at: new Date(0), updated_at: new Date(0), closed_at: null, metadata: { exec: { step: 's' } },
});

describe('bd CLI error messages never carry payloads', () => {
  it('redacts metadata/notes values, keeps @file refs and other args', () => {
    expect(redactArgs(['update', 'x', '--metadata', '{"exec":{"output_payload":"SECRET"}}', '--append-notes', 'SECRET2', '--status', 'closed']))
      .toEqual(['update', 'x', '--metadata', '<redacted>', '--append-notes', '<redacted>', '--status', 'closed']);
    expect(redactArgs(['create', '--metadata', '@/tmp/m.json'])).toEqual(['create', '--metadata', '@/tmp/m.json']);
    expect(redactArgs(['update', '--notes=SECRET3'])).toEqual(['update', '--notes=<redacted>']);
  });

  it('a failing run reports redacted args and bounded stderr', async () => {
    const run = createCliRunner({ binary: process.execPath, timeoutMs: 10_000 });
    const err = await run(['-e', "process.stderr.write('E'.repeat(5000)); process.exit(1)", '--metadata', 'SECRET']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('SECRET');
    expect((err as Error).message.length).toBeLessThan(1500);
  });
});

describe('BdMoleculeWriter passes metadata by file, never argv', () => {
  it('a 1 MiB step output is written via @file with the full payload', async () => {
    const big = 'x'.repeat(1024 * 1024);
    const seen: { args: string[]; file: string | null }[] = [];
    const bd = vi.fn(async (args: readonly string[]) => {
      const i = args.indexOf('--metadata');
      const ref = i >= 0 ? args[i + 1]! : null;
      seen.push({ args: [...args], file: ref?.startsWith('@') ? readFileSync(ref.slice(1), 'utf8') : null });
      return '';
    });
    const writer = new BdMoleculeWriter(bd, { getBead: async (id) => bead(id) });
    await writer.markStepDone('s1', { text: big });
    const call = seen.find((c) => c.args.includes('--metadata'))!;
    expect(call.args.every((a) => a.length < 4096)).toBe(true);
    expect(JSON.parse(call.file!).exec.output_payload.text).toHaveLength(big.length);
  });
});

describe('a step that succeeds after a failed attempt drops the old error (CodeRabbit on #165)', () => {
  it('markStepDone writes no error_trace, keeping the rest of exec', async () => {
    const written: Record<string, unknown>[] = [];
    const bd = vi.fn(async (args: readonly string[]) => {
      const i = args.indexOf('--metadata');
      if (i >= 0) written.push(JSON.parse(readFileSync(args[i + 1]!.slice(1), 'utf8')) as Record<string, unknown>);
      return '';
    });
    const retried: BeadRow = { ...bead('s1'), metadata: { exec: { step: 's', attempts: 2, error_trace: 'first attempt failed' } } };
    const writer = new BdMoleculeWriter(bd, { getBead: async () => retried });
    await writer.markStepDone('s1', 'second attempt ok');
    const exec = written.at(-1)!.exec as Record<string, unknown>;
    expect(exec).not.toHaveProperty('error_trace');
    expect(exec).toMatchObject({ step: 's', attempts: 2, output_payload: 'second attempt ok' });
  });
});

describe('boot reads the molecule id prefix before any side effect', () => {
  it('an invalid issue_prefix fails boot without starting the patrol', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const dolt = {
      beadsRoot: '/nonexistent', readIssuePrefix: async () => { throw new Error('no valid issue_prefix'); },
      verifyFingerprint: async () => undefined, verifySchema: async () => undefined,
    };
    await expect(bootOrchestrationPlane({ dolt: dolt as never, persistEvents: false, runDriftAuditOnBoot: false })).rejects.toThrow('issue_prefix');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
