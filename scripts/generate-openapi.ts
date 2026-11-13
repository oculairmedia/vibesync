#!/usr/bin/env bun

/**
 * Generate OpenAPI specification from Zod schemas and route definitions.
 * This script is run during the build process to emit dist/openapi.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildOpenApiDocument } from '../src/app/http/openapi/document.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The same document the server serves at GET /openapi.json, written out for tools and tests.
const openapi = buildOpenApiDocument();

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
