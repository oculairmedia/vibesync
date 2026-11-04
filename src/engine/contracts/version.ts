/**
 * Versioned-contract policy for VibeSync's orchestration golden surface
 * (vibesync-jxri.3). Every externally observable payload defined in this
 * package carries an explicit `schema_version` so producers and consumers —
 * including the future Kotlin embedded runtime (gx6ri) — can evolve
 * independently.
 *
 * Derived from the jxri.2 contract inventory
 * (docs/reference/orchestration-contract-inventory.json): the shapes here MUST
 * match the surfaces classified `normative` there. This module is the single
 * source of truth for those shapes; JSON Schema is GENERATED from it (zod v4
 * z.toJSONSchema), so the docs, types, and runtime validation never drift.
 */

/** Current schema version for the orchestration contract bundle. */
export const CONTRACT_SCHEMA_VERSION = 1 as const;

/**
 * Evolution / compatibility policy (jxri.3 acceptance). These are the RULES a
 * conformance test suite asserts; they are documented here so a reader (or the
 * Kotlin port) has one canonical statement.
 *
 * 1. UNKNOWN-FIELD TOLERANCE (forward-compat): consumers MUST ignore unknown
 *    object properties rather than reject them. A newer producer may add
 *    fields; an older consumer keeps working. => all object schemas are
 *    NON-strict (passthrough), never `.strict()`.
 *
 * 2. ENUM EXTENSIBILITY (forward-compat): closed enums are reserved for values
 *    whose exhaustiveness is load-bearing (e.g. molecule outcome). Open-ended
 *    vocabularies (event `kind`, provider `kind`, formula/role names) are typed
 *    as strings with a documented convention, NOT closed enums, so a new value
 *    does not break an old consumer.
 *
 * 3. REQUIRED FIELDS ARE PERMANENT (backward-compat): a field that is required
 *    in version N stays required (and same-typed) in N+1. New fields are added
 *    OPTIONAL. Removing/retyping a required field is a MAJOR bump.
 *
 * 4. TIMESTAMPS: RFC3339 / ISO-8601 UTC strings (`...Z`). Never epoch numbers
 *    in the golden surface.
 *
 * 5. GENERATED IDS: opaque strings. Consumers MUST NOT parse structure out of
 *    an id (prefixes like `mol-mol-` are producer conventions, not contract).
 *
 * 6. SEMANTIC NORMALIZATION: string ids/enums compare case-sensitively as
 *    stored; timestamps compare as instants, not byte-equal strings.
 *
 * 7. VERSIONING: `schema_version` is an integer. Additive changes keep the
 *    version; breaking changes bump it. The version appears in API responses,
 *    event envelopes, and reference bundles (no unversioned ad-hoc payloads).
 */
export const EVOLUTION_POLICY = {
  unknownFieldTolerance: 'ignore',
  enumExtensibility: 'open-vocabularies-are-strings',
  requiredFieldsArePermanent: true,
  timestampFormat: 'rfc3339-utc',
  idsAreOpaque: true,
  versionField: 'schema_version',
} as const;

/** A closed enum whose exhaustiveness IS load-bearing (do not open these). */
export const MOLECULE_OUTCOMES = ['completed', 'failed', 'cancelled'] as const;
export type MoleculeOutcome = (typeof MOLECULE_OUTCOMES)[number];
