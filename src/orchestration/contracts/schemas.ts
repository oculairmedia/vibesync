/**
 * Versioned zod contracts for the VibeSync orchestration golden surface
 * (vibesync-jxri.3). One source of truth: TS types are inferred from these,
 * JSON Schema is generated from these (see index.ts), and the valid/invalid
 * corpus validates against these. Shapes match the jxri.2 inventory'"'"'s
 * `normative` surfaces.
 *
 * Policy (version.ts): object schemas are NON-strict (unknown-field tolerance);
 * open vocabularies (event/provider `kind`, formula/role names) are strings,
 * not closed enums; timestamps are RFC3339 UTC strings; ids are opaque strings.
 */

import { z } from 'zod';

import { CONTRACT_SCHEMA_VERSION, MOLECULE_OUTCOMES } from './version.js';

// --- shared primitives ---

/** RFC3339 / ISO-8601 UTC timestamp (must end in Z). */
export const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be RFC3339 UTC (…Z)');

/** An opaque generated id (non-empty string; structure is NOT contract). */
export const OpaqueId = z.string().min(1);

/** The schema version literal every top-level contract carries. */
export const SchemaVersion = z.literal(CONTRACT_SCHEMA_VERSION);

// --- Formula (packs/gastown/formulas/*.toml) ---

export const FormulaStep = z.looseObject({
  name: z.string().min(1),
  role: z.string().min(1),
  /** Sibling step names this step depends on (blocks edges). */
  depends_on: z.array(z.string()).optional(),
  /** Optional per-step turn timeout override (ms). */
  turn_timeout_ms: z.number().int().positive().optional(),
});

export const FormulaContract = z.looseObject({
  schema_version: SchemaVersion,
  name: z.string().min(1),
  description: z.string().default(''),
  /** whenToUse hint surfaced to the PM agent for selection. */
  when_to_use: z.string().optional(),
  steps: z.array(FormulaStep).min(1),
});

// --- RolePack (packs/gastown/roles/*.toml) ---

export const RolePackContract = z.looseObject({
  schema_version: SchemaVersion,
  /** Role name (open vocabulary: mayor/coder/reviewer/tester/refinery/…). */
  name: z.string().min(1),
  /** Persona markdown / prompt block. */
  persona: z.string(),
  /** Optional tools this role may use. */
  tools: z.array(z.string()).optional(),
  /** Optional memory-block replace policy. */
  replace_memory: z.boolean().optional(),
});

// --- Molecule root/step metadata (issues.metadata.exec.*) ---

/** Molecule ROOT exec metadata (insertMoleculeRoot + writeback + dispatcher). */
export const MoleculeRootExec = z.looseObject({
  formula: z.string().min(1),
  /** Set at dispatch when a motivating bead was supplied (writeback target). */
  motivating_bead: OpaqueId.optional(),
  /** Closed enum — exhaustiveness is load-bearing. */
  outcome: z.enum(MOLECULE_OUTCOMES).optional(),
  /** Stamped ONLY after the writeback note lands (er21 ordering). */
  writeback_status: z.enum(['completed', 'failed']).optional(),
});

/** Molecule STEP exec metadata (insertMoleculeStep + step lifecycle). */
export const MoleculeStepExec = z.looseObject({
  step: z.string().min(1),
  molecule: OpaqueId,
  input_payload: z.unknown().optional(),
  output_payload: z.unknown().optional(),
  error_trace: z.string().optional(),
  task_id: z.string().optional(),
  provider_kind: z.string().optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
});

// --- RuntimeProvider contract (src/orchestration/runtime/provider.ts) ---

export const SessionSpecContract = z.looseObject({
  schema_version: SchemaVersion,
  /** Open vocabulary (role name). */
  role: z.string().min(1),
  /** Provider-specific extras (parentAgentId, turnTimeoutMs, …). */
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const PromptResultContract = z.looseObject({
  schema_version: SchemaVersion,
  task_id: z.string().optional(),
});

/**
 * SessionEvent — the 9-variant observe() union (kind is the discriminant).
 * Kept as a discriminated union on `kind`; each variant is loose (unknown-field
 * tolerant). `kind` is a CLOSED set here because the provider contract'"'"'s event
 * vocabulary is exhaustive per the RuntimeProvider interface — a NEW variant is
 * a deliberate contract change (bump), unlike the open EventBus `kind`.
 */
export const SessionEventContract = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('started'), ts: Timestamp }),
  z.looseObject({ kind: z.literal('first-token'), ts: Timestamp }),
  z.looseObject({ kind: z.literal('message-delta'), ts: Timestamp, text: z.string() }),
  z.looseObject({ kind: z.literal('tool-call'), ts: Timestamp, tool: z.string(), args: z.unknown() }),
  z.looseObject({ kind: z.literal('tool-result'), ts: Timestamp, tool: z.string(), result: z.unknown(), ok: z.boolean() }),
  z.looseObject({ kind: z.literal('usage'), ts: Timestamp, prompt: z.number(), completion: z.number() }),
  z.looseObject({ kind: z.literal('turn-done'), ts: Timestamp, stopReason: z.string().optional() }),
  z.looseObject({ kind: z.literal('error'), ts: Timestamp, code: z.string(), message: z.string() }),
  z.looseObject({ kind: z.literal('stopped'), ts: Timestamp }),
]);

// --- OrchestrationEvent envelope (EventBus Event) ---

/**
 * The EventBus event envelope. `kind` is an OPEN vocabulary (dispatcher/*,
 * runtime/session.*, health-patrol/*, …) — a string with a documented
 * dot-scoped convention, NOT a closed enum, so a new event kind never breaks an
 * old consumer (evolution policy #2). `layer` is a small closed set of emitters.
 */
export const OrchestrationEventContract = z.looseObject({
  schema_version: SchemaVersion,
  id: OpaqueId,
  ts: Timestamp,
  layer: z.enum(['runtime', 'daemon', 'formula', 'dispatcher', 'molecule', 'health-patrol', 'pm-agent']),
  /** Open vocabulary: `<layer>/<dotted.kind>`. */
  kind: z.string().min(1),
  task_id: OpaqueId.optional(),
  molecule_id: OpaqueId.optional(),
  teammate: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// --- Artifact manifest (self-completion evidence) ---

export const ArtifactManifestContract = z.looseObject({
  schema_version: SchemaVersion,
  work_bead_id: OpaqueId,
  run_id: OpaqueId,
  pr_url: z.string().url().optional(),
  branch: z.string().optional(),
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  created_at: Timestamp,
});

// --- Trace bundle (GET /molecules/:id/trace) ---

export const TraceBundleContract = z.looseObject({
  schema_version: SchemaVersion,
  molecule_id: OpaqueId,
  root: MoleculeRootExec,
  steps: z.array(MoleculeStepExec),
  events: z.array(OrchestrationEventContract).optional(),
});

// --- API error envelope ---

export const ApiErrorContract = z.looseObject({
  schema_version: SchemaVersion,
  /** Human-readable detail (matches existing `detail` shape). */
  detail: z.string(),
  /** Optional machine code + structured context. */
  code: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

// --- inferred TS types (generated-from-schema) ---

export type FormulaContractT = z.infer<typeof FormulaContract>;
export type RolePackContractT = z.infer<typeof RolePackContract>;
export type MoleculeRootExecT = z.infer<typeof MoleculeRootExec>;
export type MoleculeStepExecT = z.infer<typeof MoleculeStepExec>;
export type SessionSpecContractT = z.infer<typeof SessionSpecContract>;
export type PromptResultContractT = z.infer<typeof PromptResultContract>;
export type SessionEventContractT = z.infer<typeof SessionEventContract>;
export type OrchestrationEventContractT = z.infer<typeof OrchestrationEventContract>;
export type ArtifactManifestContractT = z.infer<typeof ArtifactManifestContract>;
export type TraceBundleContractT = z.infer<typeof TraceBundleContract>;
export type ApiErrorContractT = z.infer<typeof ApiErrorContract>;

/** Registry of all top-level contracts, keyed by stable name. */
export const CONTRACTS = {
  Formula: FormulaContract,
  RolePack: RolePackContract,
  MoleculeRootExec,
  MoleculeStepExec,
  SessionSpec: SessionSpecContract,
  PromptResult: PromptResultContract,
  SessionEvent: SessionEventContract,
  OrchestrationEvent: OrchestrationEventContract,
  ArtifactManifest: ArtifactManifestContract,
  TraceBundle: TraceBundleContract,
  ApiError: ApiErrorContract,
} as const;

export type ContractName = keyof typeof CONTRACTS;
