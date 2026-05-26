import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

let server: http.Server;
let baseUrl = '';
let requests: RecordedRequest[] = [];

beforeEach(async () => {
  requests = [];
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });

    if (req.url === '/formulas') {
      sendJson(res, 200, { formulas: [{ pack: 'gastown', name: 'code-review', description: 'Review', stepCount: 3 }] });
      return;
    }
    if (req.url === '/formulas/code-review/run' && req.method === 'POST') {
      sendJson(res, 202, { moleculeId: 'mol-123', formulaName: 'code-review', pack: 'gastown' });
      return;
    }
    if (req.url === '/molecules/mol-123') {
      sendJson(res, 200, {
        moleculeId: 'mol-123',
        status: 'completed',
        steps: [{ stepName: 'reviewer', role: 'reviewer', status: 'closed', output: 'LGTM' }],
      });
      return;
    }
    if (req.url === '/molecules/mol-123/resume' && req.method === 'POST') {
      sendJson(res, 202, { moleculeId: 'mol-123', outputs: { reviewer: 'recovered' } });
      return;
    }
    if (req.url === '/molecules/mol-123' && req.method === 'DELETE') {
      sendJson(res, 202, { moleculeId: 'mol-123', status: 'cancelled', cancelledStepCount: 1 });
      return;
    }
    if (req.url === '/molecules/mol-123/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: dispatcher/step.started\n');
      res.write('data: {"kind":"dispatcher/step.started","ts":"2026-05-18T00:00:00.000Z","payload":{"stepName":"reviewer"}}\n\n');
      res.write('event: dispatcher/formula.completed\n');
      res.write('data: {"kind":"dispatcher/formula.completed","ts":"2026-05-18T00:00:01.000Z","payload":{"moleculeId":"mol-123"}}\n\n');
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await once(server, 'close');
});

describe('vibesync formula CLI', () => {
  it('lists formulas', async () => {
    const result = await runCli(['formula', 'list']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('code-review');
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/formulas' });
  });

  it('runs a formula and sends the expected request body', async () => {
    const result = await runCli(['formula', 'run', 'code-review', '--input', 'review this', '--pack', 'gastown', '--motivating-bead', 'vibesync-1']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('moleculeId:');
    expect(result.stdout).toContain('mol-123');
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/formulas/code-review/run' });
    expect(JSON.parse(requests[0]!.body)).toEqual({ input: 'review this', pack: 'gastown', motivatingBeadId: 'vibesync-1' });
  });

  it('shows molecule status', async () => {
    const result = await runCli(['formula', 'status', 'mol-123']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('reviewer');
    expect(result.stdout).toContain('LGTM');
  });

  it('resumes a molecule', async () => {
    const result = await runCli(['formula', 'resume', 'mol-123']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('resumed:');
    expect(result.stdout).toContain('mol-123');
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/molecules/mol-123/resume' });
  });

  it('cancels a molecule', async () => {
    const result = await runCli(['formula', 'cancel', 'mol-123']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cancelled:');
    expect(result.stdout).toContain('mol-123');
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/molecules/mol-123' });
  });

  it('streams molecule events to completion', async () => {
    const result = await runCli(['formula', 'events', 'mol-123']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dispatcher/step.started');
    expect(result.stdout).toContain('dispatcher/formula.completed');
  });
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function runCli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['src/cli.ts', '--api-url', baseUrl, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
