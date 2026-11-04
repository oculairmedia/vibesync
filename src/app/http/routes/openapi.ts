import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { App, SendJson } from '../../types/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface OpenApiRouteDeps {
  sendJson: SendJson;
}

const SCALAR_CDN_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';

export function createScalarDocsHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vibesync API Reference</title>
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_CDN_URL}"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/openapi.json',
        pageTitle: 'Vibesync API Reference',
        layout: 'modern',
        theme: 'default'
      })
    </script>
  </body>
</html>`;
}

export function registerOpenApiRoutes(app: App, deps: OpenApiRouteDeps): void {
  const { sendJson } = deps;

  // Serve OpenAPI spec
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/openapi.json' && method === 'GET',
    handle: async ({ res }) => {
      try {
        // Try to load the generated OpenAPI spec from dist/
        const specPath = path.join(__dirname, '../../..', 'dist', 'openapi.json');
        if (fs.existsSync(specPath)) {
          const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
          sendJson(res, 200, spec);
        } else {
          // Fallback: return a minimal spec if the file doesn't exist
          sendJson(res, 200, {
            openapi: '3.1.0',
            info: {
              title: 'Vibesync API',
              description: 'Project sync service with PM agent orchestration',
              version: '1.0.0',
            },
            paths: {},
            components: { schemas: {} },
          });
        }
      } catch (error) {
        sendJson(res, 500, {
          error: 'Failed to load OpenAPI spec',
          details: (error as Error).message,
        });
      }
    },
  });

  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/docs' && method === 'GET',
    handle: async ({ res }) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(createScalarDocsHtml());
    },
  });
}
