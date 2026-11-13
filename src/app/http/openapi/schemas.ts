import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Extend Zod with OpenAPI capabilities
extendZodWithOpenApi(z);

/**
 * Schemas for the published API description (GET /openapi.json, /docs).
 *
 * Each shape is taken from the handler that sends it (src/app/http/routes/*).
 * Objects are loose: the handlers may add fields, and a client must tolerate
 * them. tests/unit/openapi-routes.test.ts fails if a documented route has no
 * handler or a handler is undocumented.
 */

// ============================================================================
// Common
// ============================================================================

export const ErrorResponseSchema = z.looseObject({
  error: z.string(),
  statusCode: z.number(),
  timestamp: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const PaginationSchema = z.looseObject({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  total_known: z.number().optional(),
});

export const IdParamSchema = z.object({ id: z.string() });
export const FormulaNameParamSchema = z.object({ name: z.string() });

// ============================================================================
// Health
// ============================================================================

export const HealthSchema = z.looseObject({
  status: z.literal('healthy'),
  service: z.literal('vibesync'),
  uptime: z.looseObject({ milliseconds: z.number(), seconds: z.number() }),
  orchestration: z.looseObject({ ready: z.boolean() }),
  memory: z.looseObject({ rss: z.number(), heapUsed: z.number(), heapTotal: z.number() }),
});

// ============================================================================
// Projects (registry)
// ============================================================================

export const BeadsRemoteSchema = z.looseObject({
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  url: z.string().nullable(),
  name: z.string().nullable(),
  status: z.string(),
  visibility: z.string().nullable(),
  provisioned_at: z.string().nullable(),
  last_push_at: z.string().nullable(),
  error: z.string().nullable(),
});

/** Catalog shape: GET /api/projects and GET /api/projects/{id}. */
export const ProjectSummarySchema = z.looseObject({
  id: z.string(),
  identifier: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  tech_stack: z.string().nullable(),
  filesystem_path: z.string().nullable(),
  git_url: z.string().nullable(),
  letta_agent_id: z.string().nullable(),
  beads_prefix: z.string().nullable(),
  repo: z.looseObject({}),
  agents: z.looseObject({ total: z.number(), active: z.number(), default_agent_id: z.string().nullable() }),
  tracker: z.looseObject({ provider: z.string(), status: z.string() }),
  beads_remote: BeadsRemoteSchema,
  last_scan_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  version: z.string().nullable(),
  etag: z.string().nullable(),
});

/** Registry shape: create, read and update under /api/registry/projects. */
export const RegisteredProjectSchema = z.looseObject({
  identifier: z.string(),
  name: z.string().nullable(),
  tech_stack: z.string().nullable(),
  letta_agent_id: z.string().nullable(),
  status: z.string(),
  last_scan_at: z.unknown(),
  filesystem_path: z.string().nullable(),
  git_url: z.string().nullable(),
  beads_remote: BeadsRemoteSchema,
});

export const ProjectListResponseSchema = z.looseObject({
  total: z.number(),
  projects: z.array(ProjectSummarySchema),
  timestamp: z.string(),
  page: PaginationSchema,
});

/** Response envelopes: what each project route actually sends around the project. */
export const ProjectDetailResponseSchema = z.looseObject({
  project: ProjectSummarySchema,
  timestamp: z.string(),
});

export const BeadsRemoteResponseSchema = z.looseObject({
  project_identifier: z.string(),
  beads_remote: BeadsRemoteSchema,
  timestamp: z.string(),
});

export const RegisteredProjectResponseSchema = z.looseObject({
  message: z.string(),
  project: RegisteredProjectSchema,
  timestamp: z.string(),
});

/** GET /api/registry/projects/{id}: the registry shape with a timestamp, not wrapped. */
export const RegistryProjectReadSchema = RegisteredProjectSchema.extend({ timestamp: z.string() });

export const ProvisionBeadsRemoteResponseSchema = z.looseObject({
  message: z.string(),
  provisioning: z.looseObject({}),
  beads_remote: BeadsRemoteSchema,
  timestamp: z.string(),
});

export const DeleteProjectResponseSchema = z.looseObject({
  message: z.string(),
  identifier: z.string(),
  timestamp: z.string(),
});

export const RetiredSyncResponseSchema = z.looseObject({
  status: z.literal('retired'),
  message: z.string(),
  event_id: z.null(),
});

export const ProjectListQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  tech_stack: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const CreateProjectRequestSchema = z.object({
  filesystem_path: z.string().describe('Absolute path of the project checkout'),
  name: z.string().optional(),
  git_url: z.string().optional(),
});

export const UpdateProjectRequestSchema = z.object({
  filesystem_path: z.string().optional().describe('Absolute path'),
  git_url: z.string().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const ProvisionBeadsRemoteRequestSchema = z.object({
  push: z.boolean().optional().describe('Push the tracker after provisioning (default true)'),
});

// ============================================================================
// Formulas and molecules (orchestration)
// ============================================================================

export const FormulaSummarySchema = z.looseObject({
  name: z.string(),
  pack: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  delivers: z.string().nullable(),
  stepCount: z.number(),
  roles: z.array(z.string()),
});

export const FormulaListResponseSchema = z.looseObject({
  formulas: z.array(FormulaSummarySchema),
  queue: z.looseObject({ depth: z.number() }).optional(),
});

export const RunFormulaRequestSchema = z.object({
  input: z.string().describe('The brief: the run\'s input'),
  pack: z.string().optional().describe('Pack name (default gastown)'),
  motivatingBeadId: z.string().optional().describe('Work bead the outcome is written back to'),
  projectIdentifier: z.string().optional().describe('Project whose scheduler pool and settings the run uses'),
});

export const RunFormulaResponseSchema = z.looseObject({
  moleculeId: z.string(),
  formulaName: z.string(),
  pack: z.string(),
});

export const MoleculeSummarySchema = z.looseObject({
  id: z.string(),
  formulaName: z.string().nullable(),
  motivatingBeadId: z.string().nullable(),
  status: z.string(),
  title: z.string(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
  stepCounts: z.unknown(),
  currentStep: z.string().nullable(),
  currentStepStatus: z.string().nullable(),
});

export const MoleculeListResponseSchema = z.looseObject({
  molecules: z.array(MoleculeSummarySchema),
  fleet: z.looseObject({ active: z.number(), queueDepth: z.number() }),
});

export const MoleculeListQuerySchema = z.object({
  status: z.string().optional().describe('Comma-separated bead statuses, or "all" (default open,in_progress)'),
  limit: z.number().int().positive().optional().describe('1 to 500 (default 50)'),
});

export const MoleculeDetailSchema = z.looseObject({
  moleculeId: z.string(),
  formulaName: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  progress: z.looseObject({ total: z.number(), done: z.number(), running: z.number() }),
});

export const MoleculeTraceSchema = z.looseObject({});

export const ResumeMoleculeResponseSchema = z.looseObject({
  moleculeId: z.string(),
  outputs: z.unknown(),
});

export const CancelMoleculeResponseSchema = z.looseObject({
  moleculeId: z.string(),
  status: z.literal('cancelled'),
  cancelledStepCount: z.number(),
});

// ============================================================================
// Export all schemas as a registry
// ============================================================================

export const ApiSchemas = {
  ErrorResponse: ErrorResponseSchema,
  Pagination: PaginationSchema,
  IdParam: IdParamSchema,
  FormulaNameParam: FormulaNameParamSchema,
  Health: HealthSchema,
  BeadsRemote: BeadsRemoteSchema,
  ProjectSummary: ProjectSummarySchema,
  RegisteredProject: RegisteredProjectSchema,
  ProjectDetailResponse: ProjectDetailResponseSchema,
  BeadsRemoteResponse: BeadsRemoteResponseSchema,
  RegisteredProjectResponse: RegisteredProjectResponseSchema,
  RegistryProjectRead: RegistryProjectReadSchema,
  ProvisionBeadsRemoteResponse: ProvisionBeadsRemoteResponseSchema,
  DeleteProjectResponse: DeleteProjectResponseSchema,
  RetiredSyncResponse: RetiredSyncResponseSchema,
  ProjectListResponse: ProjectListResponseSchema,
  ProjectListQuery: ProjectListQuerySchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  UpdateProjectRequest: UpdateProjectRequestSchema,
  ProvisionBeadsRemoteRequest: ProvisionBeadsRemoteRequestSchema,
  FormulaSummary: FormulaSummarySchema,
  FormulaListResponse: FormulaListResponseSchema,
  RunFormulaRequest: RunFormulaRequestSchema,
  RunFormulaResponse: RunFormulaResponseSchema,
  MoleculeSummary: MoleculeSummarySchema,
  MoleculeListResponse: MoleculeListResponseSchema,
  MoleculeListQuery: MoleculeListQuerySchema,
  MoleculeDetail: MoleculeDetailSchema,
  MoleculeTrace: MoleculeTraceSchema,
  ResumeMoleculeResponse: ResumeMoleculeResponseSchema,
  CancelMoleculeResponse: CancelMoleculeResponseSchema,
};
