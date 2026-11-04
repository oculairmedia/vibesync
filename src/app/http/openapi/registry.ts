import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ApiSchemas } from './schemas.js';

/**
 * OpenAPI registry for Vibesync API.
 * This registry is used to generate the OpenAPI specification.
 */
export const registry = new OpenAPIRegistry();

// ============================================================================
// Register Common Schemas
// ============================================================================

registry.register('Pagination', ApiSchemas.Pagination);
registry.register('DataFreshness', ApiSchemas.DataFreshness);
registry.register('ErrorResponse', ApiSchemas.ErrorResponse);
registry.register('ConflictResponse', ApiSchemas.ConflictResponse);

// ============================================================================
// Register Project Schemas
// ============================================================================

registry.register('ProjectSummary', ApiSchemas.ProjectSummary);
registry.register('ProjectDetail', ApiSchemas.ProjectDetail);
registry.register('ProjectListResponse', ApiSchemas.ProjectListResponse);
registry.register('CreateProjectRequest', ApiSchemas.CreateProjectRequest);
registry.register('UpdateProjectRequest', ApiSchemas.UpdateProjectRequest);

// ============================================================================
// Register Issue Schemas
// ============================================================================

registry.register('IssueSummary', ApiSchemas.IssueSummary);
registry.register('IssueDetail', ApiSchemas.IssueDetail);
registry.register('IssueListResponse', ApiSchemas.IssueListResponse);
registry.register('ClaimIssueRequest', ApiSchemas.ClaimIssueRequest);
registry.register('UpdateIssueStatusRequest', ApiSchemas.UpdateIssueStatusRequest);
registry.register('AddIssueNoteRequest', ApiSchemas.AddIssueNoteRequest);
registry.register('CloseIssueRequest', ApiSchemas.CloseIssueRequest);

// ============================================================================
// Register Health Schemas
// ============================================================================

registry.register('HealthMetrics', ApiSchemas.HealthMetrics);
registry.register('StatsResponse', ApiSchemas.StatsResponse);

export { ApiSchemas };
