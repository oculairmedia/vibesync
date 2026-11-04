# Vibesync

The molecule orchestration engine for Beads-backed projects.

Formulas (in `packs/gastown/`) cook into a molecule: a root bead plus one bead
per step, joined by dependency edges. A scheduler picks up ready work, runs each
step on that project's role agent over the Iroh wrapper, and writes the outcome
back to the bead that motivated the run. Retries, durable waits, run deadlines
and liveness checks all keep their state in Beads.

**Beads/Dolt is the source of truth.** Vibesync's own SQLite database is a small
registry of projects (path, PM agent, provider routing, pack and storage
directories, Beads remote status) and role-agent bindings. It mirrors no issue
or molecule state.

The engine runs in TypeScript on Bun today. The intended end state is a module
inside the embedded Meridian runtime.

## Run

Prerequisites: Bun, Git, Beads **1.3.2 or newer**, Dolt. Agent execution also
needs a running Iroh wrapper, a paired peer identity and role-agent bindings.

```bash
bun install --frozen-lockfile --ignore-scripts
npm rebuild better-sqlite3
bun run type-check
bun test            # or: bun run test
bun run start
```

## Configuration

Configuration is loaded by `src/app/config.ts` and validated by `src/app/configSchema.ts`.

```bash
ENABLE_ORCHESTRATION=true
VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh
VIBESYNC_SCHEDULER_ENABLED=true
VIBESYNC_SCHEDULER_PROJECT=vibesync
VIBESYNC_SCHEDULER_READY_LABEL=scheduler:eligible
VIBESYNC_SCHEDULER_AUTO_MERGE=false
# PM wakes (off by default; 'inbox' needs the explicit sender settings below)
VIBESYNC_PM_WAKE_ENABLED=true
VIBESYNC_PM_WAKE_SINK=inbox
VIBESYNC_PM_WAKE_CLI_EXECUTABLE=/path/to/release/bin/meridian-iroh-wrapper
VIBESYNC_PM_WAKE_CLI_SENDER=<service agent id>
VIBESYNC_PM_WAKE_CLI_IDENTITIES=/path/to/identities
VIBESYNC_PM_WAKE_CLI_ADDRESS_STORE=/path/to/host-addresses
VIBESYNC_PM_WAKE_CLI_CONTRACT_VERIFIED=false
```

The Iroh connection is configured with the `VIBESYNC_IROH_*` settings in
`src/engine/runtime/iroh/native-dialer.ts`.

## How work runs

1. Create a bounded bead with acceptance criteria.
2. Label it `scheduler:eligible` when it is ready: `bd update <id> --add-label scheduler:eligible`.
3. The scheduler cooks the configured formula and dispatches ready steps to role
   agents; outputs feed dependent steps.
4. The outcome is written back to the bead. Review the resulting PR; auto-merge
   stays off unless explicitly configured.

Molecule step readiness is molecule-scoped (`bd ready --mol <id>`).

## HTTP API

- `GET /health`
- `GET /formulas`, `POST /formulas/:name/run`
- `GET /molecules`, `GET /molecules/:id`, `GET /molecules/:id/trace`,
  `GET /molecules/:id/events` (SSE), `POST /molecules/:id/resume`, `DELETE /molecules/:id`
- Project registry (used by letta-mobile through the Iroh wrapper):
  `GET /api/projects`, `GET /api/projects/:id`, `GET /api/projects/:id/beads-remote`,
  `POST /api/projects/:id/beads-remote/provision`, `POST /api/registry/projects`,
  `GET|PATCH|DELETE /api/registry/projects/:id`
- `GET /openapi.json`, `GET /docs`

## Deploy

`vibesync.service` runs from a staged release worktree. Stage a release, then
`scripts/deploy/swap.sh <release-dir>`; the script prints the rollback command.
Unit and drop-in live in `deploy/systemd/`.
