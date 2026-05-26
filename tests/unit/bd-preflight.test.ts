import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectDoltServerPortOwner, preflight } from '../../scripts/preflight/bd-preflight.js';

describe('bd-preflight Dolt port ownership checks', () => {
  it('passes when the listening Dolt server belongs to the project data directory', () => {
    const result = inspectDoltServerPortOwner(3308, '/srv/project/.beads/dolt', {
      tryExec: () => ({
        ok: true,
        stdout: 'LISTEN 0 4096 127.0.0.1:3308 0.0.0.0:* users:(("dolt",pid=12345,fd=3))',
        stderr: '',
      }),
      readlinkSync: () => '/srv/project/.beads/dolt',
    });

    expect(result).toEqual({
      name: 'dolt-server-port-owner',
      level: 'ok',
      detail: 'port=3308 pid=12345 project=/srv/project cwd=/srv/project/.beads/dolt',
    });
  });

  it('reports the wrong owner pid/path with remediation guidance', () => {
    const result = inspectDoltServerPortOwner(3308, '/opt/stacks/letta-mobile/.beads/dolt', {
      tryExec: () => ({
        ok: true,
        stdout: 'LISTEN 0 4096 127.0.0.1:3308 0.0.0.0:* users:(("dolt",pid=1230851,fd=3))',
        stderr: '',
      }),
      readlinkSync: () => '/opt/stacks/letta-code-parallel/home/.beads/shared-server/dolt',
    });

    expect(result.name).toBe('dolt-server-port-owner');
    expect(result.level).toBe('error');
    expect(result.detail).toContain('port 3308 is owned by pid 1230851');
    expect(result.detail).toContain('project /opt/stacks/letta-code-parallel/home');
    expect(result.detail).toContain('/opt/stacks/letta-code-parallel/home/.beads/shared-server/dolt');
    expect(result.detail).toContain('expected project /opt/stacks/letta-mobile');
    expect(result.detail).toContain('/opt/stacks/letta-mobile/.beads/dolt');
    expect(result.detail).toContain('bd may appear empty or repeatedly auto-import JSONL');
    expect(result.detail).toContain('do not mutate .beads/dolt directly');
  });

  it('includes the wrong-owner error in the full preflight report', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'vibesync-preflight-'));
    const beadsDir = join(projectRoot, '.beads');
    const doltDir = join(beadsDir, 'dolt');
    mkdirSync(doltDir, { recursive: true });
    writeFileSync(join(beadsDir, 'config.yaml'), 'backend: dolt\n');
    writeFileSync(join(beadsDir, 'dolt-server.port'), '3308\n');

    const report = preflight(projectRoot, {
      tryExec: (cmd) => {
        if (cmd.startsWith('ss ')) {
          return {
            ok: true,
            stdout: 'LISTEN 0 4096 127.0.0.1:3308 0.0.0.0:* users:(("dolt",pid=42,fd=3))',
            stderr: '',
          };
        }
        return { ok: true, stdout: 'running\n', stderr: '' };
      },
      readlinkSync: () => '/other/project/.beads/dolt',
    });

    const ownerCheck = report.checks.find((check) => check.name === 'dolt-server-port-owner');
    expect(ownerCheck?.level).toBe('error');
    expect(ownerCheck?.detail).toContain('/other/project/.beads/dolt');
    expect(report.summary.error).toBe(1);
  });
});
