import { registry, ApiSchemas } from './registry.js';

/**
 * OpenAPI route definitions for Vibesync API.
 * Each route includes path, method, tags, description, and schema bindings.
 * 
 * NOTE: Use Zod schemas directly in route definitions. The zod-to-openapi library
 * automatically generates $ref pointers for registered schemas.
 */

// ============================================================================
// Health & Metrics Routes
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Health check',
  description: 'Returns current health metrics and system status',
  responses: {
    200: {
      description: 'Health metrics',
      content: {
        'application/json': {
          schema: ApiSchemas.HealthMetrics,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/metrics',
  tags: ['Health'],
  summary: 'Prometheus metrics',
  description: 'Returns Prometheus-format metrics',
  responses: {
    200: {
      description: 'Prometheus metrics',
      content: {
        'text/plain': {
          schema: { type: 'string' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/stats',
  tags: ['Health'],
  summary: 'API statistics',
  description: 'Returns API statistics and performance metrics',
  responses: {
    200: {
      description: 'API statistics',
      content: {
        'application/json': {
          schema: ApiSchemas.StatsResponse,
        },
      },
    },
  },
});

// ============================================================================
// Project Registry Routes
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/projects',
  tags: ['Projects'],
  summary: 'List all projects',
  description: 'Returns a paginated list of all registered projects',
  request: {
    query: ApiSchemas.PaginationQuery,
  },
  responses: {
    200: {
      description: 'List of projects',
      content: {
        'application/json': {
          schema: ApiSchemas.ProjectListResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}',
  tags: ['Projects'],
  summary: 'Get project detail',
  description: 'Returns detailed information about a specific project',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Project detail',
      content: {
        'application/json': {
          schema: ApiSchemas.ProjectDetail,
        },
      },
    },
    404: {
      description: 'Project not found',
      content: {
        'application/json': {
          schema: ApiSchemas.ErrorResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/registry/projects',
  tags: ['Projects'],
  summary: 'Register a new project',
  description: 'Registers a new project in the registry',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.CreateProjectRequest,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Project created',
      content: {
        'application/json': {
          schema: ApiSchemas.ProjectSummary,
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': {
          schema: ApiSchemas.ErrorResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/registry/projects/{id}',
  tags: ['Projects'],
  summary: 'Update project',
  description: 'Updates an existing project',
  request: {
    params: ApiSchemas.ProjectIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.UpdateProjectRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Project updated',
      content: {
        'application/json': {
          schema: ApiSchemas.ProjectSummary,
        },
      },
    },
    404: {
      description: 'Project not found',
      content: {
        'application/json': {
          schema: ApiSchemas.ErrorResponse,
        },
      },
    },
  },
});

// ============================================================================
// Project Subresources
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/agents',
  tags: ['Projects'],
  summary: 'List project agents',
  description: 'Returns agents associated with a project',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'List of agents',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/conversations',
  tags: ['Projects'],
  summary: 'List project conversations',
  description: 'Returns conversations for a project',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'List of conversations',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/work-items',
  tags: ['Projects'],
  summary: 'List project work items',
  description: 'Returns work items for a project',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'List of work items',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/activity',
  tags: ['Projects'],
  summary: 'List project activity',
  description: 'Returns activity log for a project',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Activity log',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/issues',
  tags: ['Issues'],
  summary: 'List project issues',
  description: 'Returns paginated issues for a project',
  request: {
    params: ApiSchemas.ProjectIdParam,
    query: ApiSchemas.IssueFilterQuery,
  },
  responses: {
    200: {
      description: 'List of issues',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueListResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/ready-work',
  tags: ['Issues'],
  summary: 'List ready work items',
  description: 'Returns open, actionable, unblocked work items (Android-friendly)',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'List of ready work items',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueListResponse,
        },
      },
    },
  },
});

// ============================================================================
// Issue Detail & Mutations
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/issues/{id}',
  tags: ['Issues'],
  summary: 'Get issue detail',
  description: 'Returns full issue detail by stable opaque issue ID',
  request: {
    params: ApiSchemas.IssueIdParam,
  },
  responses: {
    200: {
      description: 'Issue detail',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    404: {
      description: 'Issue not found',
      content: {
        'application/json': {
          schema: ApiSchemas.ErrorResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/issues/{id}/claim',
  tags: ['Issues'],
  summary: 'Claim an issue',
  description: 'Claims an issue for the specified assignee',
  request: {
    params: ApiSchemas.IssueIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.ClaimIssueRequest,
        },
      },
    },
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Issue claimed',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/issues/{id}/unclaim',
  tags: ['Issues'],
  summary: 'Unclaim an issue',
  description: 'Removes the assignee from an issue',
  request: {
    params: ApiSchemas.IssueIdParam,
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Issue unclaimed',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/issues/{id}/status',
  tags: ['Issues'],
  summary: 'Update issue status',
  description: 'Updates the status of an issue',
  request: {
    params: ApiSchemas.IssueIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.UpdateIssueStatusRequest,
        },
      },
    },
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Issue status updated',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/issues/{id}/notes',
  tags: ['Issues'],
  summary: 'Add issue note',
  description: 'Adds a note to an issue',
  request: {
    params: ApiSchemas.IssueIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.AddIssueNoteRequest,
        },
      },
    },
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Note added',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/issues/{id}/close',
  tags: ['Issues'],
  summary: 'Close an issue',
  description: 'Closes an issue',
  request: {
    params: ApiSchemas.IssueIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.CloseIssueRequest,
        },
      },
    },
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Issue closed',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/issues/{id}/reopen',
  tags: ['Issues'],
  summary: 'Reopen an issue',
  description: 'Reopens a closed issue',
  request: {
    params: ApiSchemas.IssueIdParam,
    headers: ApiSchemas.ConflictHeaders,
  },
  responses: {
    200: {
      description: 'Issue reopened',
      content: {
        'application/json': {
          schema: ApiSchemas.IssueDetail,
        },
      },
    },
    409: {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: ApiSchemas.ConflictResponse,
        },
      },
    },
  },
});

// ============================================================================
// Beads Remote Provisioning
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/projects/{id}/beads-remote',
  tags: ['Projects'],
  summary: 'Get Beads remote metadata',
  description: 'Returns stored Beads remote provisioning metadata',
  request: {
    params: ApiSchemas.ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Beads remote metadata',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/projects/{id}/beads-remote/provision',
  tags: ['Projects'],
  summary: 'Provision Beads remote',
  description: 'Creates or reuses a project-scoped DoltHub database and configures Beads remote',
  request: {
    params: ApiSchemas.ProjectIdParam,
    body: {
      content: {
        'application/json': {
          schema: ApiSchemas.ProvisionBeadsRemoteRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Beads remote provisioned',
      content: {
        'application/json': {
          schema: { type: 'object' },
        },
      },
    },
  },
});
