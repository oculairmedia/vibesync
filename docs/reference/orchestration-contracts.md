# Orchestration contracts (versioned) — vibesync-jxri.3

Versioned schemas for VibeSync's orchestration **golden surface**. One source of
truth: the zod schemas in `src/orchestration/contracts/` — TS types are inferred
from them, the JSON Schema bundle is **generated** from them, and the
valid/invalid corpus + compatibility tests validate against them. Shapes match
the `normative` surfaces in `orchestration-contract-inventory.json` (jxri.2).

## Artifacts

| Artifact | Path |
|---|---|
| Zod schemas (source of truth) | `src/orchestration/contracts/schemas.ts` |
| Evolution policy + version | `src/orchestration/contracts/version.ts` |
| Generated JSON Schema bundle (draft 2020-12) | `docs/reference/orchestration-contracts.schema.json` |
| Regenerate the bundle | `bun scripts/generate-contract-schemas.ts` |
| Corpus + compatibility tests | `tests/unit/orchestration/contracts/contracts.test.ts` |

## Contracts covered

`Formula`, `RolePack`, `MoleculeRootExec`, `MoleculeStepExec`, `SessionSpec`,
`PromptResult`, `SessionEvent` (9-variant union), `OrchestrationEvent` envelope,
`ArtifactManifest`, `TraceBundle`, `ApiError`.

## Evolution / compatibility policy

Enforced by `tests/unit/orchestration/contracts/contracts.test.ts`:

1. **Unknown-field tolerance (forward-compat).** All object schemas are
   non-strict — consumers ignore unknown properties. A newer producer may add
   fields; an older consumer keeps working.
2. **Enum extensibility (forward-compat).** Open vocabularies (EventBus event
   `kind`, provider `kind`, formula/role names) are strings with a documented
   convention, not closed enums. Closed enums are reserved for load-bearing
   exhaustiveness: molecule `outcome` (`completed|failed|cancelled`), event
   `layer`, and the RuntimeProvider `SessionEvent` `kind` (a new variant is a
   deliberate contract change).
3. **Required fields are permanent (backward-compat).** A required field in
   version N stays required and same-typed in N+1; new fields are added
   optional. Removing/retyping a required field is a major bump.
4. **Timestamps** are RFC3339 / ISO-8601 UTC strings (`…Z`), never epoch numbers.
5. **Generated ids are opaque** — consumers must not parse structure from an id.
6. **`schema_version`** (integer) appears on every top-level payload and on the
   bundle. Additive changes keep the version; breaking changes bump it. No
   unversioned ad-hoc payloads in the golden surface.
