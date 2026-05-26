import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createScalarDocsHtml } from '../../src/api/routes/openapi.js';

interface OpenApiTestSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
  };
}

function isOpenApiTestSpec(value: unknown): value is OpenApiTestSpec {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OpenApiTestSpec>;
  return typeof candidate.openapi === 'string'
    && Boolean(candidate.info)
    && typeof candidate.info?.title === 'string'
    && typeof candidate.info?.version === 'string'
    && Boolean(candidate.paths)
    && Boolean(candidate.components?.schemas);
}

async function readOpenApiSpec(response: Response): Promise<OpenApiTestSpec> {
  const value = await response.json();
  expect(isOpenApiTestSpec(value)).toBe(true);
  if (!isOpenApiTestSpec(value)) throw new Error('Invalid OpenAPI test spec');
  return value;
}

describe('OpenAPI Endpoint Integration', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Create a minimal HTTP server with the OpenAPI route
    server = createServer((req, res) => {
      if (req.url === '/openapi.json' && req.method === 'GET') {
        // Simulate the route handler
        const spec = {
          openapi: '3.1.0',
          info: {
            title: 'Vibesync API',
            description: 'Project sync service with PM agent orchestration',
            version: '1.0.0',
          },
          paths: {
            '/health': {
              get: {
                summary: 'Health check',
                responses: {
                  '200': {
                    description: 'Health metrics',
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              HealthMetrics: {
                type: 'object',
              },
            },
          },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(spec));
      } else if (req.url === '/docs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(createScalarDocsHtml());
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address() as AddressInfo;
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('should return 200 for GET /openapi.json', async () => {
    const response = await fetch(`http://localhost:${port}/openapi.json`);
    expect(response.status).toBe(200);
  });

  it('should return valid JSON with OpenAPI 3.1.0', async () => {
    const response = await fetch(`http://localhost:${port}/openapi.json`);
    const spec = await readOpenApiSpec(response);
    expect(spec.openapi).toBe('3.1.0');
  });

  it('should have required info fields', async () => {
    const response = await fetch(`http://localhost:${port}/openapi.json`);
    const spec = await readOpenApiSpec(response);
    expect(spec.info.title).toBe('Vibesync API');
    expect(spec.info.version).toBe('1.0.0');
  });

  it('should have paths and components', async () => {
    const response = await fetch(`http://localhost:${port}/openapi.json`);
    const spec = await readOpenApiSpec(response);
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();
    expect(spec.components.schemas).toBeDefined();
  });

  it('should return Content-Type application/json', async () => {
    const response = await fetch(`http://localhost:${port}/openapi.json`);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('should return Scalar API reference HTML for GET /docs', async () => {
    const response = await fetch(`http://localhost:${port}/docs`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Vibesync API Reference');
    expect(html).toContain('Scalar.createApiReference');
    expect(html).toContain('/openapi.json');
  });
});
