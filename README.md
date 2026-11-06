# Vibesync

Vibesync runs Beads-backed orchestration formulas for projects. Formula packs
(`packs/gastown/`) define bounded multi-step work; each run cooks into a root
bead and dependent step beads. The scheduler finds eligible work, dispatches
steps to project role agents through the Letta Iroh wrapper, and records
outcomes and durable wait/retry state in Beads.

Beads/Dolt is the source of truth for issue and molecule state. Vibesync keeps a
small local SQLite registry for project metadata and role-agent bindings; this
registry is not a mirror of Beads work. The service also exposes an HTTP API for
health, formulas, molecules, and project registry operations.

## Prerequisites

- Bun 1.2.10 or newer, Git, Beads 1.3.2 or newer, and Dolt.
- For agent execution: a reachable Iroh wrapper, a paired peer identity, and
  role-agent bindings for the project.
- For the documented systemd deployment: Linux with systemd and a staged
  release worktree.

## Run locally

Install dependencies and the native SQLite binding, then run the type check,
tests, and service:

```bash
bun install --frozen-lockfile --ignore-scripts
npm rebuild better-sqlite3
bun run type-check
bun run test
bun run start
```

The scheduler is disabled by default. Set `ENABLE_ORCHESTRATION=true` to enable
the orchestration API and `VIBESYNC_SCHEDULER_ENABLED=true` to start the
scheduler. At minimum, set `VIBESYNC_SCHEDULER_PROJECT` to a project registered
in Vibesync. Supply `VIBESYNC_IROH_*` connection settings and project
role-agent bindings before dispatching work. See `src/app/config.ts`,
`src/app/configSchema.ts`, and `src/engine/runtime/iroh/native-dialer.ts` for
configuration names, defaults, and validation.

Example scheduler settings:

```bash
ENABLE_ORCHESTRATION=true
VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh
VIBESYNC_SCHEDULER_ENABLED=true
VIBESYNC_SCHEDULER_PROJECT=my-project
VIBESYNC_SCHEDULER_READY_LABEL=scheduler:eligible
VIBESYNC_SCHEDULER_AUTO_MERGE=false
```

Auto-merge remains off unless explicitly enabled. Enabling it also requires
configured required checks and an allowed repository list. PM wakes and durable
wait reconciliation are separate opt-in settings; see `src/app/config.ts` for
their defaults and options.

## Schedule work

1. Create a Bead with bounded scope and acceptance criteria in the configured
   project.
2. Add the configured ready label (default `scheduler:eligible`) when it is
   ready, for example: `bd update <id> --add-label scheduler:eligible`.
3. The scheduler uses the configured formula (default `onboard-feature` from
   `packs/gastown/`) and dispatches ready steps to the project's role agents.
4. Check the resulting Beads state and pull request. Auto-merge is opt-in and
   should only be enabled with required checks and allowed repositories set.

Step readiness is scoped to its molecule (`bd ready --mol <id>`). The scheduler
polls periodically and can also react to Beads events; pool size, batch size,
poll interval, formula, pack directory, and other controls are configured with
`VIBESYNC_SCHEDULER_*` variables. Scheduler and orchestration defaults are
defined in `src/app/config.ts`.

## HTTP API

- `GET /health`
- `GET /formulas`, `POST /formulas/:name/run`
- `GET /molecules`, `GET /molecules/:id`, `GET /molecules/:id/trace`,
  `GET /molecules/:id/events` (SSE), `POST /molecules/:id/resume`,
  `DELETE /molecules/:id`
- Project registry: `GET /api/projects`, `GET /api/projects/:id`,
  `GET /api/projects/:id/beads-remote`,
  `POST /api/projects/:id/beads-remote/provision`,
  `POST /api/registry/projects`, `GET|PATCH|DELETE /api/registry/projects/:id`
- `GET /openapi.json`, `GET /docs`

## Deploy with systemd

The `vibesync.service` unit runs `bun src/index.ts` from the selected release
worktree and reads its `.env` file. Stage a Git worktree with dependencies
installed and a valid `.env`, then run:

```bash
scripts/deploy/swap.sh <release-dir>
```

The swap script installs/reloads the unit, points its release drop-in at the
staged worktree, restarts the service, and prints the previous working
directory and rollback command. Do not restart while formula runs are
in-flight. The unit and release drop-in template are in `deploy/systemd/`;
deployment behavior and prerequisites are defined in
`scripts/deploy/swap.sh`.
