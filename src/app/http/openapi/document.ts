import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { registry } from './registry.js';
import './routes.js';

/**
 * The API description, generated from the route definitions in this folder.
 * The server serves it from memory: it used to read dist/openapi.json, a build
 * artifact no deploy produced, and silently served an empty description when the
 * file was missing.
 */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Vibesync API',
      description: 'Beads-backed formula orchestration and the project registry',
      version: '1.0.0',
      contact: { name: 'Oculair Media', url: 'https://github.com/oculairmedia/vibesync' },
    },
  });
}
