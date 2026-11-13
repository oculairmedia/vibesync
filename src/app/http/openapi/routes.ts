import type { ZodType } from 'zod';

import { registry, ApiSchemas, orchestrationAuth } from './registry.js';

/**
 * The published API description: one entry per route the server registers
 * (src/app/http/routes/*). tests/unit/openapi-routes.test.ts builds the real
 * route table and fails if this list and the handlers disagree in either
 * direction, so a route added, removed or renamed must change both.
 */

type Method = 'get' | 'post' | 'patch' | 'delete';

const json = (schema: ZodType) => ({ content: { 'application/json': { schema } } });
const error = (description: string) => ({ description, ...json(ApiSchemas.ErrorResponse) });
const ORCHESTRATION_DOWN = error('Orchestration plane not booted');
const UNAUTHORIZED = error('Missing or wrong bearer token (only when VIBESYNC_ORCHESTRATION_TOKEN is set)');

function route(def: {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  responses: Record<number, { description: string; content?: Record<string, { schema: unknown }> }>;
  orchestration?: boolean;
}): void {
  registry.registerPath({
    method: def.method,
    path: def.path,
    tags: [def.tag],
    summary: def.summary,
    ...(def.description ? { description: def.description } : {}),
    ...(def.orchestration ? { security: [{ [orchestrationAuth.name]: [] }] } : {}),
    request: {
      ...(def.params ? { params: def.params as never } : {}),
      ...(def.query ? { query: def.query as never } : {}),
      ...(def.body ? { body: { required: true, ...json(def.body) } } : {}),
    },
    responses: def.responses as never,
  });
}

// ---------------------------------------------------------------- health

route({
  method: 'get', path: '/health', tag: 'Health', summary: 'Service health',
  description: 'Liveness, uptime, memory, and whether the orchestration engine is ready.',
  responses: { 200: { description: 'Healthy', ...json(ApiSchemas.Health) } },
});

// ---------------------------------------------------------------- projects

route({
  method: 'get', path: '/api/projects', tag: 'Projects', summary: 'List registered projects',
  description: 'Unpaginated unless cursor or limit is given.',
  query: ApiSchemas.ProjectListQuery,
  responses: {
    200: { description: 'Projects', ...json(ApiSchemas.ProjectListResponse) },
    503: error('Registry database not available'),
  },
});

route({
  method: 'get', path: '/api/projects/{id}', tag: 'Projects', summary: 'Get a project (catalog shape)',
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'The project', ...json(ApiSchemas.ProjectDetailResponse) },
    404: error('Project not found'),
  },
});

route({
  method: 'get', path: '/api/projects/{id}/beads-remote', tag: 'Projects', summary: 'Get a project\'s Beads remote',
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'The Beads remote', ...json(ApiSchemas.BeadsRemoteResponse) },
    404: error('Project not found'),
  },
});

route({
  method: 'post', path: '/api/projects/{id}/beads-remote/provision', tag: 'Projects', summary: 'Provision a project\'s Beads remote',
  params: ApiSchemas.IdParam,
  body: ApiSchemas.ProvisionBeadsRemoteRequest,
  responses: {
    200: { description: 'Provisioned (or a dry run)', ...json(ApiSchemas.ProvisionBeadsRemoteResponse) },
    400: error('Project has no Beads database'),
    404: error('Project not found'),
    500: error('Provisioning failed'),
  },
});

route({
  method: 'post', path: '/api/registry/projects', tag: 'Projects', summary: 'Register a project',
  body: ApiSchemas.CreateProjectRequest,
  responses: {
    201: { description: 'Registered', ...json(ApiSchemas.RegisteredProjectResponse) },
    400: error('filesystem_path missing or not absolute, or registration failed'),
    503: error('Project registry not available'),
  },
});

route({
  method: 'get', path: '/api/registry/projects/{id}', tag: 'Projects', summary: 'Get a project (registry shape)',
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'The project', ...json(ApiSchemas.RegistryProjectRead) },
    404: error('Project not found'),
  },
});

route({
  method: 'patch', path: '/api/registry/projects/{id}', tag: 'Projects', summary: 'Update a project',
  params: ApiSchemas.IdParam,
  body: ApiSchemas.UpdateProjectRequest,
  responses: {
    200: { description: 'Updated', ...json(ApiSchemas.RegisteredProjectResponse) },
    400: error('Invalid field'),
    404: error('Project not found'),
  },
});

route({
  method: 'delete', path: '/api/registry/projects/{id}', tag: 'Projects', summary: 'Remove a project from the registry',
  params: ApiSchemas.IdParam,
  responses: { 200: { description: 'Deleted', ...json(ApiSchemas.DeleteProjectResponse) }, 404: error('Project not found') },
});

route({
  method: 'post', path: '/api/sync/trigger', tag: 'Projects', summary: 'Retired: project sync',
  description: 'Always 410. Beads is the source of truth; there is nothing to sync.',
  responses: { 410: { description: 'Retired', ...json(ApiSchemas.RetiredSyncResponse) } },
});

// ---------------------------------------------------------------- formulas and molecules

route({
  method: 'get', path: '/formulas', tag: 'Orchestration', summary: 'List formulas',
  description: 'Every formula in the available packs, with its role sequence.',
  responses: { 200: { description: 'Formulas', ...json(ApiSchemas.FormulaListResponse) } },
});

route({
  method: 'post', path: '/formulas/{name}/run', tag: 'Orchestration', summary: 'Start a formula run', orchestration: true,
  params: ApiSchemas.FormulaNameParam,
  body: ApiSchemas.RunFormulaRequest,
  responses: {
    202: { description: 'Started', ...json(ApiSchemas.RunFormulaResponse) },
    400: error('Missing input'),
    401: UNAUTHORIZED,
    404: error('Pack or formula not found'),
    503: error('Orchestration not booted, or the agent pool is full (retry later)'),
  },
});

route({
  method: 'get', path: '/molecules', tag: 'Orchestration', summary: 'List molecules (formula runs)', orchestration: true,
  query: ApiSchemas.MoleculeListQuery,
  responses: {
    200: { description: 'Molecules', ...json(ApiSchemas.MoleculeListResponse) },
    401: UNAUTHORIZED,
    503: ORCHESTRATION_DOWN,
  },
});

route({
  method: 'get', path: '/molecules/{id}', tag: 'Orchestration', summary: 'Get a molecule', orchestration: true,
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'The molecule', ...json(ApiSchemas.MoleculeDetail) },
    401: UNAUTHORIZED,
    404: error('Molecule not found'),
    503: ORCHESTRATION_DOWN,
  },
});

route({
  method: 'get', path: '/molecules/{id}/trace', tag: 'Orchestration', summary: 'Get a molecule\'s trace', orchestration: true,
  description: 'Steps, dependency edges and engine events.',
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'The trace', ...json(ApiSchemas.MoleculeTrace) },
    401: UNAUTHORIZED,
    404: error('Molecule not found'),
    503: ORCHESTRATION_DOWN,
  },
});

route({
  method: 'get', path: '/molecules/{id}/events', tag: 'Orchestration', summary: 'Stream a molecule\'s events', orchestration: true,
  description: 'Server-sent events.',
  params: ApiSchemas.IdParam,
  responses: {
    200: { description: 'An event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
    401: UNAUTHORIZED,
    503: ORCHESTRATION_DOWN,
  },
});

route({
  method: 'post', path: '/molecules/{id}/resume', tag: 'Orchestration', summary: 'Resume a molecule', orchestration: true,
  params: ApiSchemas.IdParam,
  responses: {
    202: { description: 'Resumed', ...json(ApiSchemas.ResumeMoleculeResponse) },
    401: UNAUTHORIZED,
    500: error('Resume failed'),
    503: ORCHESTRATION_DOWN,
  },
});

route({
  method: 'delete', path: '/molecules/{id}', tag: 'Orchestration', summary: 'Cancel a molecule', orchestration: true,
  params: ApiSchemas.IdParam,
  responses: {
    202: { description: 'Cancelled', ...json(ApiSchemas.CancelMoleculeResponse) },
    401: UNAUTHORIZED,
    409: error('Molecule is not cancellable'),
    500: error('Cancel failed'),
    503: ORCHESTRATION_DOWN,
  },
});

// ---------------------------------------------------------------- the description itself

route({
  method: 'get', path: '/openapi.json', tag: 'Docs', summary: 'This API description (OpenAPI 3.1)',
  responses: { 200: { description: 'The description', content: { 'application/json': { schema: { type: 'object' } } } } },
});

route({
  method: 'get', path: '/docs', tag: 'Docs', summary: 'Interactive API reference',
  responses: { 200: { description: 'HTML', content: { 'text/html': { schema: { type: 'string' } } } } },
});
