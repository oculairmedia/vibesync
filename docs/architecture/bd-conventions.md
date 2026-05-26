# Bd Conventions

How VibeSync uses the bd issue tracker to hold both human-curated work
and runtime orchestration state without the two polluting each other.

Cross-link target from `AGENTS.md` (layering invariants, rule 2).

## Two kinds of work, one database

Bd's local Dolt instance hosts both:

- **Human-curated work** — features, bugs, tasks, decisions an engineer
  picks up, reviews, and ships. Long lifetime; PR-driven.
- **Runtime orchestration work** — molecule roots + steps created and
  closed by the orchestration daemon during workflow execution. Short
  lifetime; machine-driven.

Co-located in one Dolt database — see
`docs/architecture/gastown-orchestration.md` for the rationale (Dolt's
local MySQL server handles write churn; MVCC isolates human reads from
daemon writes; co-location preserves the "Beads is the universal
persistence substrate" invariant).

## Type discriminator

| Type            | Audience          | Lifetime  | Source       |
|-----------------|-------------------|-----------|--------------|
| `task`          | engineers         | days/weeks| `bd create`  |
| `bug`           | engineers         | days/weeks| `bd create`  |
| `feature`       | engineers         | days/weeks| `bd create`  |
| `epic`          | engineers         | months    | `bd create`  |
| `chore`         | engineers         | days      | `bd create`  |
| `decision`      | engineers (ADR)   | indefinite| `bd create`  |
| `molecule_root` | daemon + operators| minutes/hr| daemon SQL   |
| `molecule_step` | daemon + operators| seconds/min| daemon SQL  |
| `mail`          | (future) Gas Town messaging | hours | daemon SQL |

The custom types are registered in bd config:

```bash
bd config get types.custom
# molecule_root,molecule_step,mail
```

To extend, set `types.custom` with the additional comma-separated names.
The bd CLI accepts custom types when set this way; they're stored as
regular `type` field values on beads.

## Default-filter convention

The HUMAN type set is `task,bug,feature,epic,chore,decision` — anything
an engineer would expect to see in their work queue.

The RUNTIME type set is `molecule_root,molecule_step,mail` — produced by
the daemon for execution bookkeeping.

**Human-facing queries default-filter to the HUMAN type set.**
Runtime/operational queries explicitly opt in to the RUNTIME set or
query a specific type.

### Pattern

Per Wave 1 (today), the convention is enforced by aliases and tooling:

```bash
# Human queue — what most engineers want most of the time
alias bd-ready='bd ready --type=task,bug,feature,epic,chore,decision'
alias bd-list-mine='bd list --status=in_progress --type=task,bug,feature,epic,chore,decision'

# Operator queue — runtime state
alias bd-runtime='bd list --type=molecule_root,molecule_step --status=open,in_progress'
alias bd-runtime-failed='bd list --type=molecule_step --status=blocked,closed --priority=0,1'
```

When VibeSync ships its own CLI wrapper (`vibesync bd`), the wrapper
should apply the human filter by default with a `--runtime` flag to
opt in to the runtime types.

### Naming convention for runtime beads

To make runtime beads scannable when they DO surface, daemon-created
titles follow the convention:

- molecule_root: `[formula:<name>] <one-line summary of trigger>`
  - e.g. `[formula:code-review] PR#123 in oculairmedia/letta-mobile`
- molecule_step: `[formula:<name>/step:<step-name>] <step description>`
  - e.g. `[formula:code-review/step:reviewer] Review diff`

Title prefix is convention, not enforcement — the type discriminator
remains the authoritative signal.

## Schema overlay for runtime beads

bd's beads table is the substrate. Runtime beads use the SAME schema as
human beads with the following additional conventions:

- `priority` — runtime beads default to `2` (medium). Operators can
  bump failed steps to `0` or `1` to surface them in their work queue.
- `labels` — runtime beads carry structured labels keyed under `exec.*`:
  - `exec.formula:<name>` — which formula this came from
  - `exec.step:<step-name>` — step name within the formula
  - `exec.molecule:<molecule-root-id>` — link to the root bead
  - `exec.retry:<N>` — retry attempt counter

Execution-specific large fields (input/output payloads, error traces)
live in a sidecar table — see vibesync-uxx (Molecules) for the
schema-fit decision.

## Daemon access pattern

Engineers use the `bd` CLI. The daemon connects directly to the local
Dolt MySQL port and writes via typed SQL — never shell out to
`bd create`. See vibesync-w5z for the direct-SQL contract.

The discipline that ties this together:

- **Schema migrations** still go through `bd`'s migration path so the
  CLI stays compatible with whatever shape the daemon writes.
- **Direct SQL writes** by the daemon use the same schema as `bd` (no
  parallel tables for things that fit) plus blessed sidecars where
  bd's "issue" schema doesn't.
- **Reads** by both humans and the daemon use the same Dolt MVCC
  semantics. The daemon doesn't shortcut through any cache; if a row
  exists in bd, the daemon sees it.

## Retention

Runtime beads accumulate. Closed `molecule_step` beads older than 30
days (configurable) are eligible for archive — moved to a `_archived`
branch in Dolt, leaving the main branch lean. See future bead for the
sweeper job.

Human-typed beads are NEVER auto-archived.

## Migration of pre-bd state

VibeSync's legacy sqlite registry DB (filename `vibesync.db` —
pending rename to `vibesync.db` in a separate migration) holds the legacy project
registry. Per layering invariant #2, that's legacy state — new domain
state goes in bd. Existing registry data is migrated lazily as the
relevant code paths get touched; no big-bang migration is planned.

## Open questions (track as beads when decided)

- Do molecule events live in the event bus only, or do they also
  materialize as bead notes for audit? (See vibesync-ds4.)
- Does the daemon batch-commit (`dolt.auto-commit=batch`) to reduce
  Dolt write amplification on high-churn turns?
- Do we need a custom `status` value for "mid-retry"?
