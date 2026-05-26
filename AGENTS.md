<!-- VIBESYNC:project-info:START -->
# Agent Instructions

## Project Identity

- **Project Code**: `vibesync`
- **Project Name**: vibesync
- **Letta Agent ID**: ``

## Workflow Instructions

1. **Before starting work**: Use the local Beads tracker (`bd ready`, `bd show <id>`, `bd update <id> --claim`) to find and claim related work.
2. **Issue references**: Use Beads issue IDs exactly as reported by `bd` (for example, `vibesync-abc` or the repository's configured prefix).
3. **On task completion**: Report to this project's Letta agent via `matrix-identity-bridge` using `talk_to_agent`.
4. **Memory**: Store important discoveries with the configured project memory tool.
<!-- VIBESYNC:project-info:END -->

<!-- VIBESYNC:reporting-hierarchy:START -->
## PM Agent Communication

**Project PM Agent:** `` ()

### Reporting Hierarchy

```
Emmanuel (Stakeholder)
    ↓
Meridian (Director of Engineering)
    ↓
PM Agent (Technical Product Owner - mega-experienced)
    ↓ communicates with
You (Developer Agent - experienced)
```

### MANDATORY: Report to PM Agent

**BEFORE reporting outcomes to the user**, send a report to the PM agent via Matrix:

```json
{
  "operation": "talk_to_agent",
  "agent": "",
  "message": "<your report>",
  "caller_directory": "/opt/stacks/vibesync"
}
```

### When to Contact PM Agent

| Situation             | Action                                                              |
| --------------------- | ------------------------------------------------------------------- |
| Task completed        | Report outcome to PM before responding to user                      |
| Blocking question     | Forward to PM - they know user's wishes and will escalate if needed |
| Architecture decision | Consult PM for guidance                                             |
| Unclear requirements  | PM can clarify or contact user                                      |

### Report Format

```
**Status**: [Completed/Blocked/In Progress]
**Task**: [Brief description]
**Outcome**: [What was done/What's blocking]
**Files Changed**: [List if applicable]
**Next Steps**: [If any]
```
<!-- VIBESYNC:reporting-hierarchy:END -->

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

**Do NOT** mutate `.beads/dolt/` directly. All writes go through the `bd` CLI; reads can also go directly to the local Dolt MySQL port that `bd init` manages (this is the daemon-hot-path; see VibeSync's `src/orchestration/store/dolt-client.ts` for the pattern).

### Persistence

- Beads state is local-first. If the repository has a remote, persist issue changes with the configured Beads sync command before ending a session.
- If no git remote is configured, leave the Beads database and JSONL export in a clean local state and note that work is local-only.
<!-- VIBESYNC:beads-instructions:END -->

<!-- VIBESYNC:bookstack-docs:START -->
## BookStack Documentation

- **Source of truth**: [BookStack](https://knowledge.oculair.ca)
- **Local sync**: `docs/bookstack/` (read-only mirror, syncs hourly)
- **To read docs**: Check `docs/bookstack/{book-slug}/` in your project directory
- **To create/edit docs**: Use `bookstack-mcp` tools to write directly to BookStack
- **Never edit** files in `docs/bookstack/` locally — they will be overwritten on next sync
- **PRDs and design docs** must be stored in BookStack, not local markdown files
<!-- VIBESYNC:bookstack-docs:END -->

<!-- VIBESYNC:session-completion:START -->
## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is not complete until code changes, Beads state, and handoff notes are in a clean state.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Persist changes** - If a git remote is configured, push code and Beads state:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
   If no remote is configured, verify `git status` and Beads state locally and mention that the session is local-only.
5. **Clean up** - Clear stashes and prune stale branches when applicable
6. **Verify** - All intended changes are committed or explicitly handed off
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Do not leave issue updates half-applied; Beads is the source of truth for task state.
- Use the `bd` CLI only; do not inspect or mutate the Beads/Dolt backing database directly.
- Do not use external issue tools for issue tracking.
- If push is available and fails, resolve and retry until it succeeds.
<!-- VIBESYNC:session-completion:END -->

<!-- VIBESYNC:codebase-context:START -->
## Codebase Context

**Project**: vibesync (`vibesync`)
**Path**: `/opt/stacks/vibesync`

This project's PM agent has a `codebase_ast` memory block with live structural data including:

- File counts and function counts per directory
- Key modules and their roles
- Quality signals (doc gaps, untested modules, complexity hotspots)
- Recent file changes

Ask the PM agent for architectural guidance before making significant changes.
<!-- VIBESYNC:codebase-context:END -->

<!-- VIBESYNC:custom-rules:START -->
## Project-Specific Rules

No custom rules configured. Add project-specific agent instructions here, then change the marker above to `<!-- VIBESYNC:custom-rules:CUSTOM -->` to prevent overwriting.
<!-- VIBESYNC:custom-rules:END -->

<!-- VIBESYNC:layering-invariants:START -->

## Layering Invariants

These five rules — verbatim from [Gas City](https://github.com/gastownhall/gascity)'s
`AGENTS.md` — are the load-bearing architecture discipline for everything
under `src/orchestration/` and any code that integrates with it. Cite them
in PR reviews when blocking a change. A violation is a defect even if the
code "works."

Full rationale + the multi-agent orchestration plan that motivated adopting
these lives at `docs/architecture/gastown-orchestration.md`.

1. **No upward dependencies.** Layer N never imports Layer N+1. Concretely
   in VibeSync: `src/orchestration/runtime/` never imports
   `src/orchestration/formula/`; `src/orchestration/formula/` never imports
   `src/orchestration/daemon.ts`. If a lower layer needs to call back into
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

Spawned Gastown role sessions (mayor, coder, reviewer, refinery,
tester) run on the letta-code local backend via
`LettaCodeSubagentProvider` in
`src/orchestration/runtime/letta-code-subagent-provider.ts`.
`LettaTeamsProvider` and the `letta-teams-sdk` dependency have been
removed. New code must not route projects to `provider_kind=letta-teams`
or add `letta-teams-sdk` integrations.

Specifically, **do not**:

1. **Import from `letta-teams-sdk/council`.** Code review is owned by
   `formulas/code-review.toml` driving a reviewer/coder/tester loop on
   our own dispatcher — not by teams' built-in council module.
2. **Rely on `letta-teams-sdk/init` to populate memory blocks.** Role
   packs in `packs/<name>/roles/*.toml` are the source of truth for
   memory block content. Teams' built-in init prompts are overridden
   in the provider, not consumed.
3. **Use teams' task-graph or dep semantics.** Formulas
   (`src/orchestration/formula/`) and molecules (`.beads/` molecule
   rows) own dep graphs, retry, and `wait_for`.
4. **Add a second path to `@letta-ai/letta-code-sdk`.**
   `LettaCodeSubagentProvider` is the local-backend convergence point;
   extend it instead of creating another letta-code route.

If a change would cross any of these, the layering invariant has been
crossed — block in review and route the work above the
`RuntimeProvider` interface instead.

<!-- VIBESYNC:runtime-provider-discipline:END -->
