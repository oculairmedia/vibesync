import { buildOpenApiDocument } from '../openapi/document.js';
import type { App, SendJson } from '../../types/api.js';

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

  // Built once, on first request, from the route definitions: not from a build
  // artifact. Reading dist/openapi.json, which no deploy produced, served an empty
  // description in production.
  let document: ReturnType<typeof buildOpenApiDocument> | null = null;
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/openapi.json' && method === 'GET',
    handle: async ({ res }) => {
      document ??= buildOpenApiDocument();
      sendJson(res, 200, document);
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
