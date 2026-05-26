#!/usr/bin/env bun

/**
 * Generate OpenAPI specification from Zod schemas and route definitions.
 * This script is run during the build process to emit dist/openapi.json
 */

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from '../src/openapi/registry.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import routes to register them with the registry
import '../src/openapi/routes.js';

const generator = new OpenApiGeneratorV31(registry.definitions);

const openapi = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Vibesync API',
    description: 'Project sync service with PM agent orchestration',
    version: '1.0.0',
    contact: {
      name: 'Oculair Media',
      url: 'https://github.com/oculairmedia/vibesync',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server',
    },
  ],
});

// Ensure dist directory exists
const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Write OpenAPI spec to file
const outputPath = path.join(distDir, 'openapi.json');
fs.writeFileSync(outputPath, JSON.stringify(openapi, null, 2));

console.log(`✓ OpenAPI spec generated: ${outputPath}`);
console.log(`  - ${Object.keys(openapi.paths || {}).length} paths`);
console.log(`  - ${Object.keys(openapi.components?.schemas || {}).length} schemas`);
