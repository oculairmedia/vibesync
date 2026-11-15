/**
 * vibesync-6zos.4: tests take ports from the operating system, never from a
 * random number. See tests/_fixtures/free-port.ts.
 */
import { createServer } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { freePort } from '../_fixtures/free-port.js';

/** A line that builds a port number from Math.random. */
const RANDOM_PORT = /port[^\n;]*Math\.random\(|Math\.random\([^\n;]*port/i;

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('test ports come from the operating system (vibesync-6zos.4)', () => {
  it('freePort returns a port this process can bind at once', async () => {
    const port = freePort();
    await new Promise<void>((done, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => server.close(() => done()));
    });
  });

  it('never returns a port that is held: every port in a batch can be bound while the earlier ones stay held', async () => {
    // The old picker (40000 + random * 10000) had no way to know a port was taken.
    const held: Array<{ close(cb: () => void): void }> = [];
    try {
      for (let i = 0; i < 25; i++) {
        const port = freePort();
        await new Promise<void>((done, fail) => {
          const server = createServer();
          server.once('error', (error) => fail(new Error(`port ${port} (number ${i + 1}) could not be bound: ${String(error)}`)));
          server.listen(port, '127.0.0.1', () => { held.push(server); done(); });
        });
      }
    } finally {
      await Promise.all(held.map((server) => new Promise<void>((done) => server.close(() => done()))));
    }
    expect(held).toHaveLength(25);
  });

  it('no file under tests/ builds a port from Math.random', () => {
    const testsDir = resolve('tests');
    const self = resolve('tests/unit/free-port.test.ts');
    const offenders = filesUnder(testsDir)
      .filter((path) => /\.(ts|js|mjs|cjs)$/.test(path) && path !== self)
      .flatMap((path) => readFileSync(path, 'utf8').split('\n')
        .map((line, index) => ({ line, where: `${relative(testsDir, path)}:${index + 1}` }))
        .filter(({ line }) => RANDOM_PORT.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .map(({ where }) => where));
    expect(offenders).toEqual([]);
  });

  it('the guard recognises the line that failed on CI, and does not flag ordinary uses of Math.random', () => {
    expect(RANDOM_PORT.test("      BOOT_CHECK_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),")).toBe(true);
    expect(RANDOM_PORT.test('const port = 3000 + Math.floor(Math.random() * 1000);')).toBe(true);
    expect(RANDOM_PORT.test('const id = `run-${Math.random().toString(36).slice(2)}`;')).toBe(false);
    expect(RANDOM_PORT.test('const port = freePort();')).toBe(false);
  });
});
