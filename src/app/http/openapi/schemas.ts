import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Extend Zod with OpenAPI capabilities
extendZodWithOpenApi(z);

/**
 * Centralized Zod schema definitions for Vibesync API.
 * These schemas are used for both runtime validation and OpenAPI spec generation.
 */

// ============================================================================
// Common Schemas
// ============================================================================

export const PaginationSchema = z.object({
  next_cursor: z.string().optional(),
  has_more: z.boolean(),
  total_known: z.number().optional(),
});

export const DataFreshnessSchema = z.object({
  status: z.enum(['ok', 'stale', 'error']),
  last_sync_at: z.string().datetime().optional(),
  error: z.string().optional(),
});

export const EtagSchema = z.string();

// ============================================================================
// Health & Metrics
// ============================================================================

export const HealthMetricsSchema = z.object({
  status: z.string(),
  uptime: z.record(z.string(), z.unknown()),
  sync: z.record(z.string(), z.unknown()),
  memory: z.record(z.string(), z.unknown()),
  connectionPool: z.record(z.string(), z.unknown()),
});

export const StatsResponseSchema = z.object({
  uptime: z.record(z.string(), z.unknown()),
  sync: z.record(z.string(), z.unknown()),
  memory: z.record(z.string(), z.unknown()),
  connectionPool: z.record(z.string(), z.unknown()),
  sseClients: z.number(),
  syncHistory: z.object({
    total: z.number(),
    mappings: z.number(),
  }),
  database: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Projects
// ============================================================================

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  filesystem_path: z.string(),
  git_url: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'archived']),
  etag: EtagSchema,
  tracker: z.object({
    provider: z.string(),
    data_freshness: DataFreshnessSchema,
  }),
  pm_agent: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
  activity: z.object({
    last_sync_at: z.string().datetime().optional(),
    last_mutation_at: z.string().datetime().optional(),
  }).optional(),
});

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  agents: z.array(z.record(z.string(), z.unknown())).optional(),
  conversations: z.array(z.record(z.string(), z.unknown())).optional(),
  work_items: z.array(z.record(z.string(), z.unknown())).optional(),
  activity_log: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSummarySchema),
  page: PaginationSchema,
});

export const CreateProjectRequestSchema = z.object({
  filesystem_path: z.string(),
  name: z.string().optional(),
  git_url: z.string().optional(),
});

export const UpdateProjectRequestSchema = z.object({
  filesystem_path: z.string().optional(),
  git_url: z.string().optional(),
  description: z.string().optional(),
});

// ============================================================================
// Issues
// ============================================================================

export const IssueSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.string(),
  title: z.string(),
  type: z.string(),
  priority: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']),
  statusLabel: z.string(),
  ready: z.boolean(),
  assignee: z.string().nullable(),
  blockedBy: z.array(z.string()),
  blocks: z.array(z.string()),
  isBlocked: z.boolean(),
  updatedAt: z.string().datetime(),
  summary: z.string().optional(),
  etag: EtagSchema,
});

export const IssueDetailSchema = IssueSummarySchema.extend({
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  validationWarnings: z.array(z.string()).optional(),
  createdAt: z.string().datetime().optional(),
  closedAt: z.string().datetime().optional(),
});

export const IssueListResponseSchema = z.object({
  issues: z.array(IssueSummarySchema),
  page: PaginationSchema,
});

export const ClaimIssueRequestSchema = z.object({
  assignee: z.string(),
});

export const UpdateIssueStatusRequestSchema = z.object({
  status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']),
  reason: z.string().optional(),
});

export const AddIssueNoteRequestSchema = z.object({
  text: z.string(),
});

export const CloseIssueRequestSchema = z.object({
  reason: z.string().optional(),
});

// ============================================================================
// Error Responses
// ============================================================================

export const ErrorResponseSchema = z.object({
  error: z.string(),
  statusCode: z.number(),
  timestamp: z.string().datetime(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ConflictResponseSchema = z.object({
  error: z.string(),
  statusCode: z.literal(409),
  conflict: z.object({
    reason: z.string(),
    expected: z.string().optional(),
    current: z.string().optional(),
    issueId: z.string().optional(),
  }),
});

// ============================================================================
// Query & Parameter Schemas
// ============================================================================

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const IssueFilterQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  type: z.string().optional(),
  ready: z.boolean().optional(),
  q: z.string().optional(),
  updatedSince: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const ProjectIdParamSchema = z.object({
  id: z.string(),
});

export const IssueIdParamSchema = z.object({
  id: z.string(),
});

export const ConflictHeadersSchema = z.object({
  'If-Match': z.string().optional(),
  'Idempotency-Key': z.string().optional(),
});

export const ProvisionBeadsRemoteRequestSchema = z.object({
  push: z.boolean().optional().default(true),
});

// ============================================================================
// Export all schemas as a registry
// ============================================================================

export const ApiSchemas = {
  // Common
  Pagination: PaginationSchema,
  DataFreshness: DataFreshnessSchema,
  Etag: EtagSchema,

  // Health
  HealthMetrics: HealthMetricsSchema,
  StatsResponse: StatsResponseSchema,

  // Projects
  ProjectSummary: ProjectSummarySchema,
  ProjectDetail: ProjectDetailSchema,
  ProjectListResponse: ProjectListResponseSchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  UpdateProjectRequest: UpdateProjectRequestSchema,

  // Issues
  IssueSummary: IssueSummarySchema,
  IssueDetail: IssueDetailSchema,
  IssueListResponse: IssueListResponseSchema,
  ClaimIssueRequest: ClaimIssueRequestSchema,
  UpdateIssueStatusRequest: UpdateIssueStatusRequestSchema,
  AddIssueNoteRequest: AddIssueNoteRequestSchema,
  CloseIssueRequest: CloseIssueRequestSchema,

  // Errors
  ErrorResponse: ErrorResponseSchema,
  ConflictResponse: ConflictResponseSchema,

  // Query & Parameters
  PaginationQuery: PaginationQuerySchema,
  IssueFilterQuery: IssueFilterQuerySchema,
  ProjectIdParam: ProjectIdParamSchema,
  IssueIdParam: IssueIdParamSchema,
  ConflictHeaders: ConflictHeadersSchema,
  ProvisionBeadsRemoteRequest: ProvisionBeadsRemoteRequestSchema,
};
