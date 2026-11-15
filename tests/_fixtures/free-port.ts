/**
 * A TCP port that is free right now, chosen by the operating system
 * (vibesync-6zos.4).
 *
 * Do not build a port from Math.random: a number picked from a range is a
 * guess, and another process, or a test in the other vitest fork, may hold it.
 * On 2026-11-15 a boot-check test guessed 43972 on a CI runner where it was in
 * use and failed with EADDRINUSE (PR #186, run 43706299684).
 *
 * Synchronous on purpose: the tests that need it use spawnSync. The port is
 * free at the moment the child closes its listener; a caller binds it right
 * away. That window is one process start, against the old guess's whole range.
 */
import { spawnSync } from 'node:child_process';

const ASK_OS = `
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => process.stdout.write(String(port)));
});
`;

export function freePort(): number {
  const result = spawnSync(process.execPath, ['-e', ASK_OS], { encoding: 'utf8', timeout: 10_000 });
  const port = Number(result.stdout);
  if (result.status !== 0 || !Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`freePort: the operating system gave no port (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  return port;
}
