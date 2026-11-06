/**
 * vibesync-d9y2: boot-check.sh must wait briefly for the "API server running"
 * log line after /health answers. The fake server below is a REAL HTTP listener
 * on the script's HEALTH_PORT (the script exports it) whose startup log line
 * lands `logDelayMs` after it starts answering /health, or never. Everything
 * runs in a temp directory; nothing is written under the repo.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const REPO_SCRIPT = resolve('scripts/ci/boot-check.sh');

const FAKE_SERVER = `
const http = require('node:http');
const delay = Number(process.env.FAKE_LOG_DELAY_MS);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy' }));
});
server.listen(Number(process.env.HEALTH_PORT), '127.0.0.1', () => {
  // The script reads this process's stdout as the service log.
  if (delay >= 0) setTimeout(() => console.log('INFO: API server running'), delay);
});
`;

function runBootCheck(scriptPath: string, logDelayMs: number): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'vibesync-boot-check-'));
  tempDirs.push(dir);
  const server = join(dir, 'fake-server.cjs');
  writeFileSync(server, FAKE_SERVER);
  const script = join(dir, 'boot-check.sh');
  // Replace the LAUNCH line (not the first mention: line 2 is a comment naming the real command).
  const source = readFileSync(scriptPath, 'utf8');
  const launch = 'bun src/index.ts >"$LOG" 2>&1 &';
  if (!source.includes(launch)) throw new Error('boot-check.sh launch line changed; update this test');
  writeFileSync(script, source.replace(launch, `node ${server} >"$LOG" 2>&1 &`));
  chmodSync(script, 0o755);
  return spawnSync('bash', [script, '20'], {
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      BOOT_CHECK_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      FAKE_LOG_DELAY_MS: String(logDelayMs),
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('boot-check: the startup log line may land just after /health answers (vibesync-d9y2)', () => {
  it('passes when the log line arrives 1.5 s after /health starts answering', () => {
    const result = runBootCheck(REPO_SCRIPT, 1500);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(String(result.stdout)).toContain('/health answered');
  }, 30_000);

  it('still fails with the existing message when the line never appears', () => {
    const result = runBootCheck(REPO_SCRIPT, -1);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain("never logged 'API server running'");
  }, 30_000);

  it('passes immediately when the line is already there (no needless wait)', () => {
    const started = Date.now();
    const result = runBootCheck(REPO_SCRIPT, 0);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
