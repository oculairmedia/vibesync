import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createScalarDocsHtml } from '../../src/app/http/routes/openapi.js';

interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
}

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, {
    get?: {
      parameters?: OpenApiParameter[];
      responses: Record<string, {
        content?: Record<string, unknown>;
      }>;
    };
  }>;
  components: {
    schemas: Record<string, unknown>;
  };
}

describe('OpenAPI Spec Generation', () => {
  let specPath: string;
  let spec: OpenApiSpec;

  beforeAll(() => {
    specPath = path.join(process.cwd(), 'dist', 'openapi.json');
    expect(fs.existsSync(specPath)).toBe(true);
    spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenApiSpec;
  });

  it('should generate a valid OpenAPI 3.1.0 spec', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('should have required info fields', () => {
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('Vibesync API');
    expect(spec.info.version).toBe('1.0.0');
  });

  // Which paths exist, and that each one has a handler, is pinned by
  // tests/unit/openapi-routes.test.ts against the real route table.
  it('should declare the health route and the orchestration routes', () => {
    for (const pathName of ['/health', '/api/projects', '/api/projects/{id}', '/formulas', '/formulas/{name}/run', '/molecules', '/molecules/{id}']) {
      expect(spec.paths[pathName]).toBeDefined();
    }
  });

  it('should register the response schemas it references', () => {
    for (const schemaName of ['Health', 'ProjectSummary', 'RegisteredProject', 'FormulaListResponse', 'MoleculeDetail', 'ErrorResponse']) {
      expect(spec.components.schemas[schemaName]).toBeDefined();
    }
  });

  it('should have valid response schemas', () => {
    const healthPath = spec.paths['/health'];
    expect(healthPath.get).toBeDefined();
    expect(healthPath.get.responses['200']).toBeDefined();
    expect(healthPath.get.responses['200'].content['application/json']).toBeDefined();
  });

  it('should have proper parameter definitions', () => {
    const projectPath = spec.paths['/api/projects/{id}'];
    expect(projectPath.get).toBeDefined();
    expect(projectPath.get.parameters).toBeDefined();
    const idParam = projectPath.get.parameters?.find((parameter) => parameter.name === 'id');
    expect(idParam).toBeDefined();
    expect(idParam.in).toBe('path');
    expect(idParam.required).toBe(true);
  });

  it('should render Scalar docs against the generated OpenAPI endpoint', () => {
    const html = createScalarDocsHtml();
    expect(html).toContain('Vibesync API Reference');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/@scalar/api-reference');
    expect(html).toContain("url: '/openapi.json'");
    expect(html).toContain("Scalar.createApiReference('#app'");
  });
});
