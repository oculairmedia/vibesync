/**
 * Zod Schema Definitions
 *
 * Runtime validation schemas for API responses and data structures
 */

import { z } from 'zod'

// ============================================================================
// API Response Schemas
// ============================================================================

/**
 * Health Response Schema
 */
export const HealthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  version: z.string(),
  uptime: z.object({
    milliseconds: z.number(),
    seconds: z.number(),
    human: z.string(),
  }),
  sync: z.object({
    lastSyncTime: z.string().nullable(),
    lastSyncDuration: z.string().nullable(),
    totalSyncs: z.number(),
    errorCount: z.number(),
    successRate: z.string(),
  }),
  lastError: z
    .object({
      message: z.string(),
      timestamp: z.string(),
      age: z.string(),
    })
    .nullable(),
  config: z.object({
    syncInterval: z.string(),
    apiDelay: z.string(),
    parallelSync: z.boolean(),
    maxWorkers: z.number(),
    dryRun: z.boolean(),
    lettaEnabled: z.boolean(),
  }),
  memory: z.object({
    rss: z.string(),
    heapUsed: z.string(),
    heapTotal: z.string(),
  }),
  connectionPool: z.object({
    http: z.object({ sockets: z.number(), freeSockets: z.number() }),
    https: z.object({ sockets: z.number(), freeSockets: z.number() }),
  }),
})

/**
 * Stats Response Schema
 */
export const StatsResponseSchema = z.object({
  uptime: HealthResponseSchema.shape.uptime,
  sync: HealthResponseSchema.shape.sync,
  memory: HealthResponseSchema.shape.memory,
  connectionPool: HealthResponseSchema.shape.connectionPool,
  sseClients: z.number(),
  syncHistory: z.object({
    total: z.number(),
    mappings: z.number(),
  }),
})

/**
 * Configuration Schema
 */
export const ConfigurationSchema = z.object({
  huly: z.object({
    apiUrl: z.string(),
    useRestApi: z.boolean(),
  }),
  vibeKanban: z.object({
    apiUrl: z.string(),
    useRestApi: z.boolean(),
  }),
  sync: z.object({
    interval: z.number(),
    dryRun: z.boolean(),
    incremental: z.boolean(),
    parallel: z.boolean(),
    maxWorkers: z.number(),
    skipEmpty: z.boolean(),
    apiDelay: z.number(),
  }),
  stacks: z.object({
    baseDir: z.string(),
  }),
  letta: z.object({
    enabled: z.boolean(),
    baseURL: z.string(),
  }),
})

/**
 * Config Response Schema
 */
export const ConfigResponseSchema = z.object({
  config: ConfigurationSchema,
  updatedAt: z.string(),
})

/**
 * Config Update Request Schema
 */
export const ConfigUpdateRequestSchema = z.object({
  syncInterval: z.number().optional(),
  maxWorkers: z.number().optional(),
  apiDelay: z.number().optional(),
  dryRun: z.boolean().optional(),
  incremental: z.boolean().optional(),
  parallel: z.boolean().optional(),
  skipEmpty: z.boolean().optional(),
})

/**
 * Sync Trigger Request Schema
 */
export const SyncTriggerRequestSchema = z.object({
  projectId: z.string().optional(),
})

/**
 * Sync Trigger Response Schema
 */
export const SyncTriggerResponseSchema = z.object({
  message: z.string(),
  eventId: z.string(),
  status: z.string(),
})

/**
 * Sync Event Schema
 */
export const SyncEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  projectId: z.string().optional(),
  source: z.string().optional(),
  duration: z.number().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
})

/**
 * Sync History Response Schema
 */
export const SyncHistoryResponseSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  entries: z.array(SyncEventSchema),
  hasMore: z.boolean(),
})

/**
 * Issue Mapping Schema
 */
export const IssueMappingSchema = z.object({
  hulyIdentifier: z.string(),
  vibeTaskId: z.string(),
  lastSynced: z.string(),
}).catchall(z.any())

/**
 * Mappings Response Schema
 */
export const MappingsResponseSchema = z.object({
  total: z.number(),
  mappings: z.array(IssueMappingSchema),
})

// ============================================================================
// SSE Event Schemas
// ============================================================================

/**
 * Base SSE Event Schema
 */
const BaseSSEEventSchema = z.object({
  type: z.string(),
  data: z.any(),
  timestamp: z.string(),
})

/**
 * SSE Connected Event Schema
 */
export const SSEConnectedEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('connected'),
  data: z.object({
    clientId: z.string(),
    timestamp: z.string(),
  }),
})

/**
 * SSE Sync Started Event Schema
 */
export const SSESyncStartedEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('sync:started'),
  data: z.object({
    projectId: z.string().optional(),
    timestamp: z.string(),
  }),
})

/**
 * SSE Sync Completed Event Schema
 */
export const SSESyncCompletedEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('sync:completed'),
  data: z.object({
    projectId: z.string().optional(),
    duration: z.number(),
    status: z.string(),
    timestamp: z.string(),
  }),
})

/**
 * SSE Sync Error Event Schema
 */
export const SSESyncErrorEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('sync:error'),
  data: z.object({
    projectId: z.string().optional(),
    error: z.string(),
    timestamp: z.string(),
  }),
})

/**
 * SSE Config Updated Event Schema
 */
export const SSEConfigUpdatedEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('config:updated'),
  data: z.object({
    updates: ConfigUpdateRequestSchema,
    config: ConfigurationSchema,
    timestamp: z.string(),
  }),
})

/**
 * SSE Health Updated Event Schema
 */
export const SSEHealthUpdatedEventSchema = BaseSSEEventSchema.extend({
  type: z.literal('health:updated'),
  data: HealthResponseSchema,
})

export const SSEOrchestrationEventSchema = BaseSSEEventSchema.extend({
  type: z.string(),
  data: z.object({
    id: z.string().optional(),
    ts: z.string().optional(),
    layer: z.string().optional(),
    kind: z.string().optional(),
    task_id: z.string().optional(),
    molecule_id: z.string().optional(),
    teammate: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.string().optional(),
  }).passthrough(),
})

/**
 * All SSE Event Types Schema (discriminated union)
 */
export const SSEEventTypeSchema = z.discriminatedUnion('type', [
  SSEConnectedEventSchema,
  SSESyncStartedEventSchema,
  SSESyncCompletedEventSchema,
  SSESyncErrorEventSchema,
  SSEConfigUpdatedEventSchema,
  SSEHealthUpdatedEventSchema,
])

// ============================================================================
// Error Schemas
// ============================================================================

/**
 * API Error Schema
 */
export const ApiErrorSchema = z.object({
  error: z.string(),
  statusCode: z.number(),
  timestamp: z.string(),
  details: z.any().optional(),
})

// ============================================================================
// Domain Model Schemas
// ============================================================================

/**
 * Project Schema
 */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
})

/**
 * Issue Schema
 */
export const IssueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.string(),
  projectId: z.string(),
})

/**
 * Task Schema
 */
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  projectId: z.string(),
})

// ============================================================================
// Type Inference Helpers
// ============================================================================

/**
 * Infer TypeScript types from Zod schemas
 * These can be used to ensure schema and type definitions stay in sync
 */
export type HealthResponse = z.infer<typeof HealthResponseSchema>
export type StatsResponse = z.infer<typeof StatsResponseSchema>
export type Configuration = z.infer<typeof ConfigurationSchema>
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>
export type ConfigUpdateRequest = z.infer<typeof ConfigUpdateRequestSchema>
export type SyncTriggerRequest = z.infer<typeof SyncTriggerRequestSchema>
export type SyncTriggerResponse = z.infer<typeof SyncTriggerResponseSchema>
export type SyncEvent = z.infer<typeof SyncEventSchema>
export type SyncHistoryResponse = z.infer<typeof SyncHistoryResponseSchema>
export type IssueMapping = z.infer<typeof IssueMappingSchema>
export type MappingsResponse = z.infer<typeof MappingsResponseSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>
export type Project = z.infer<typeof ProjectSchema>
export type Issue = z.infer<typeof IssueSchema>
export type Task = z.infer<typeof TaskSchema>

// SSE Event Types
export type SSEConnectedEvent = z.infer<typeof SSEConnectedEventSchema>
export type SSESyncStartedEvent = z.infer<typeof SSESyncStartedEventSchema>
export type SSESyncCompletedEvent = z.infer<typeof SSESyncCompletedEventSchema>
export type SSESyncErrorEvent = z.infer<typeof SSESyncErrorEventSchema>
export type SSEConfigUpdatedEvent = z.infer<typeof SSEConfigUpdatedEventSchema>
export type SSEHealthUpdatedEvent = z.infer<typeof SSEHealthUpdatedEventSchema>
export type SSEEventType = z.infer<typeof SSEEventTypeSchema>
