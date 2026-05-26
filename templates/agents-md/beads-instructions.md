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
