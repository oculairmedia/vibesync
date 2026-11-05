# Vibesync agent instructions

Vibesync is the Beads-backed molecule orchestration engine: formulas cook into
molecule beads, the scheduler dispatches ready steps to role agents over the
Iroh wrapper, and outcomes are written back to Beads. A small SQLite registry
holds project paths, provider routing and role-agent bindings. All canonical
work state lives in Beads/Dolt.

## Documentation

Project documentation (PRDs, design notes, architecture reviews, decisions)
lives in Beads: write it into the relevant bead's description, design or notes
fields. Do not create markdown docs in the repository except the architecture
references under `docs/` that code and tests cite.

## Reporting

Report progress on the bead you are working (`bd comments add <id> ...`) and in
the PR. Escalate blockers to the project PM agent.

<!-- VIBESYNC:beads-instructions:START -->

## Issue Tracking

This project uses **bd** (Beads) for local issue tracking. Beads is a CLI tool: interact with it only through `bd` commands, not by reading or writing its backing database directly. Run `bd prime` for the current workflow context and command reference.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for task tracking and follow-up work; do not route issue operations through external issue tools.
- Do not access the Beads/Dolt backing database directly. Use the `bd` CLI for all issue reads, updates, claims, closes, syncs, and durable notes.
- Create or update Beads issues before writing code when the work is non-trivial.
- Close completed issues with `bd close <id>` and include a reason when helpful.
- Use `bd remember` for durable project knowledge instead of ad-hoc memory files.

### Preflight (vibesync-1sb, vibesync-v02)

Before claiming work in any Beads-backed project, run the per-project preflight check:

```bash
bun /opt/stacks/vibesync/scripts/preflight/bd-preflight.ts $(pwd)
```

This reports:

- `.beads` directory present + writable
- Deprecated `.beads/dolt_server_port` ABSENT (presence = pre-migration shape; fix before working)
- Current `.beads/dolt-server.port` present + valid port
- `bd` and `dolt` binaries on PATH
- `bd list --json` smoke check succeeds
- `bd dolt status` reports a running server (when backend=dolt)
- A Dolt remote is configured (warning only if absent — local-only is sometimes intentional)

Exit codes: `0` = all clean, `1` = warnings (proceed with care), `2` = errors (fix before working).

**Do NOT** mutate `.beads/dolt/` directly. All writes go through the `bd` CLI; reads can also go directly to the local Dolt MySQL port that `bd init` manages (this is the daemon-hot-path; see VibeSync's `src/engine/store/dolt-client.ts` for the pattern).

### Persistence

- Beads state is local-first. If the repository has a remote, persist issue changes with the configured Beads sync command before ending a session.
- If no git remote is configured, leave the Beads database and JSONL export in a clean local state and note that work is local-only.

<!-- VIBESYNC:beads-instructions:END -->

<!-- VIBESYNC:custom-rules:START -->

## Project-Specific Rules

### Git workflow — NEVER push to main (lcp-uye8)

This is a HARD rule for every agent that touches code, no exceptions:

- **NEVER commit on `main`.** Always create a feature branch first: `git checkout -b fix/<bead-id>-<short-desc>`.
- **NEVER push to `main`.** `origin/main` is branch-protected — direct pushes are rejected. Push your feature branch and open a PR.
- **NEVER merge your own PR** or run `git checkout main && git merge`. Merging is a separate gated step (reviewer/human + CI typecheck/tests). Your job ends at "PR opened."
- A change MUST typecheck (`npx tsc --noEmit`) before you open the PR. Do not open a PR for code that does not compile.
- Every feature, fix, or behavior change MUST add or update a regression test that would fail if the behavior regressed later. PRs without test coverage for new or changed behavior should be rejected in review.
- If any git operation fails because of branch protection, STOP and report it — do not work around it.

Background: an autonomous rig run pushed broken, unreviewed code straight to `origin/main` (it did not even typecheck), nearly breaking the service on the next restart. Branch protection + PR-only is the safety gate. See lcp-uye8.

<!-- VIBESYNC:custom-rules:END -->

<!-- VIBESYNC:layering-invariants:START -->

## Layering Invariants

These five rules — verbatim from [Gas City](https://github.com/gastownhall/gascity)'s
`AGENTS.md` — are the load-bearing architecture discipline for everything
under `src/engine/` and any code that integrates with it. Cite them
in PR reviews when blocking a change. A violation is a defect even if the
code "works."

Full rationale + the multi-agent orchestration plan that motivated adopting
these lives at `docs/architecture/gastown-orchestration.md`. The
binding reference decision for what VibeSync owns versus what the
runtime layer (Bun reference today, Kotlin App Server target) owns
— including the controller/runtime split, RuntimeProvider seam
ownership, Beads/Dolt authority, role-pack/config activation,
Iroh transport layering, A2A deferral, and the strangler/shadow
cutover plan — is ADR-0001 at
[`docs/architecture/ORCHESTRATION_OWNERSHIP_ADR.md`](docs/architecture/ORCHESTRATION_OWNERSHIP_ADR.md)
(`vibesync-jxri.1`). The versioned RuntimeProvider contract
(typed `SessionSpec.extra` extensions, `SessionEvent` schema,
wire-format stability) is owned by `vibesync-jxri.5`, not by this
ADR.

1. **No upward dependencies.** Layer N never imports Layer N+1. Concretely
   in VibeSync: `src/engine/runtime/` never imports
   `src/engine/formula/`; `src/engine/formula/` never imports
   `src/engine/daemon.ts`. If a lower layer needs to call back into
   a higher one, pass a callback / interface, never an import.

2. **Beads is the universal persistence substrate** for domain state. The
   bd/Dolt database is the single source of truth for both human-curated
   work (tasks/bugs/features/epics) AND runtime work (molecule_root /
   molecule_step). VibeSync's pre-bd registry tables in `vibesync.db`
   are LEGACY — migrate to bd over time, do not add new domain state
   outside bd. The convention that keeps human and runtime work cleanly
   separable inside one database is pinned in
   [`docs/architecture/bd-conventions.md`](docs/architecture/bd-conventions.md).

3. **Event bus is the universal observation substrate.** All cross-layer
   visibility goes through it. If layer A needs to know what layer B did,
   B emits an event and A subscribes. No direct status polling between
   layers. No reading another layer's internal state directly. (See
   `vibesync-ds4`.)

4. **Config is the universal activation mechanism.** Features turn on via
   config presence, not hardcoded branches. A feature that "exists if env
   var X is set" is a code smell; the same feature expressed as "exists if
   the relevant config section is present in the project's config" is the
   correct shape.

5. **Zero hardcoded roles.** If a line of TS references a specific role
   name (`pm-agent`, `reviewer`, `backend`, etc.), it's a defect. Role
   behavior lives in pack TOML + prompt templates, not code. The one
   tolerated exception today is `LettaConfig.controlAgentName` which is
   itself the escape hatch from hardcoding — extend that discipline to all
   role references going forward. Gas Town accumulated two years of
   role-hardcoding debt before extracting Gas City to escape it; VibeSync
   skips the cost by enforcing rule 5 from day one.

### Why these matter

Gas Town iterated for two years before realizing the role-hardcoding bug
(rule 5) — that realization is what motivated extracting Gas City and the
MEOW stack. Adopting these rules costs nothing today and prevents the
same accumulating debt. They're checked in not because we're done
adopting them, but because they're the rules we agree to be checked
against.

<!-- VIBESYNC:layering-invariants:END -->

<!-- VIBESYNC:runtime-provider-discipline:START -->

## RuntimeProvider discipline

Formula steps run on persistent role agents over the Iroh wrapper:
`IrohWrapperProvider` (`src/engine/runtime/iroh-wrapper-provider.ts`,
provider kind `letta-code-iroh`) is the only RuntimeProvider. Each step is
sent directly to the role agent named in `project_role_agents`; the wrapper
creates the step's conversation and reports its id.

The shim provider (`letta-code-subagent`, the admin shim on :8291) and Letta
Teams were removed (vibesync-9lzk.29). A project routing row or
`VIBESYNC_ORCHESTRATION_PROVIDER` naming a removed kind is a configuration
error and fails loudly; there is no fallback path.

Do **not**:

1. Add a second route to the Letta runtime. New transport needs go through
   the Iroh wrapper and its grants.
2. Rely on a runtime to own task graphs, retries or memory seeding.
   Formulas (`src/engine/formula/`) and molecule beads own dependency
   graphs, retry and waits; role packs (`packs/<name>/roles/*.toml`) own
   memory block content.

If a change would cross either of these, block it in review and route the
work above the `RuntimeProvider` interface instead.

<!-- VIBESYNC:runtime-provider-discipline:END -->
