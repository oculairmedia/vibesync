# Vibesync

Vibesync runs Beads-backed orchestration formulas for projects. Formula packs
(`packs/gastown/`) define bounded multi-step work; each run cooks into a root
bead and dependent step beads. A scheduler per enabled project finds eligible
work, dispatches steps to the project's role agents through the Letta Iroh
wrapper, and records outcomes and durable wait/retry state in Beads.

Beads/Dolt is the source of truth for issue and molecule state. Vibesync keeps a
small local SQLite registry of projects (where each checkout is) and their
role-agent bindings; it is not a mirror of Beads work. The service also exposes
an HTTP API for health, formulas, molecules and the project registry.

## Prerequisites

- Bun 1.2.10 or newer, Git, Beads 1.3.2 or newer, and Dolt.
- For agent execution: a reachable Iroh wrapper, a paired peer identity, and
  role-agent bindings for each project.
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

Orchestration and the scheduler are off by default. Set
`ENABLE_ORCHESTRATION=true` to enable the engine and the formula/molecule API,
and `VIBESYNC_SCHEDULER_ENABLED=true` with `VIBESYNC_SCHEDULER_PROJECTS` to start
schedulers. Supply `VIBESYNC_IROH_*` connection settings and the projects'
role-agent bindings before dispatching work. Configuration names, defaults and
validation are in `src/app/config.ts`, `src/app/configSchema.ts` and
`src/engine/runtime/iroh/native-dialer.ts`.

Example settings:

```bash
ENABLE_ORCHESTRATION=true
VIBESYNC_ORCHESTRATION_PROVIDER=letta-code-iroh
VIBESYNC_SCHEDULER_ENABLED=true
VIBESYNC_SCHEDULER_PROJECTS=my-project,another-project
VIBESYNC_SCHEDULER_AUTO_MERGE=false
```

`VIBESYNC_SCHEDULER_PROJECTS` is a comma-separated list of registered project
identifiers; each gets its own scheduler. (It replaced the single-project
`VIBESYNC_SCHEDULER_PROJECT`; the service refuses to start if only the old name
is set.) The `VIBESYNC_SCHEDULER_*` formula, ready label, pool size and required
checks are the defaults for any project that does not set its own (below).

Auto-merge stays off unless explicitly enabled; enabling it also requires
required checks and an allowed-repository list. PM wakes and durable wait
reconciliation are separate opt-in settings; see `src/app/config.ts`.

## Onboard a project

1. Register the project's checkout in the registry
   (`POST /api/registry/projects` with its absolute `filesystem_path`), set up
   its Beads tracker, and register its role agents.
2. Commit `.meridian/project.json` on the project's default branch:

   ```json
   {
     "schemaVersion": 1,
     "projectId": "01234567-89ab-cdef-0123-456789abcdef",
     "key": "my-project",
     "name": "My Project",
     "engine": {
       "formula": "onboard-feature",
       "readyLabel": "scheduler:eligible",
       "poolSize": 1,
       "ciChecks": ["typecheck", "test"]
     }
   }
   ```

   Vibesync reads only the `engine` block today; `projectId`, `key` and `name`
   are for the Meridian project registry. Every `engine` field is optional, and
   a missing one uses the scheduler default. `ciChecks` names the CI checks a
   run's pull request must pass. The engine reads the file as committed on the
   default branch, so uncommitted edits and branches under review do not change
   its behaviour. If the file is invalid, that project's scheduler does not
   start and a warning names the field; other projects are unaffected.
3. Add the project to `VIBESYNC_SCHEDULER_PROJECTS` and restart Vibesync.

## Schedule work

1. Create a bead with bounded scope and acceptance criteria in the project's
   tracker.
2. When it is ready, add the project's ready label (default
   `scheduler:eligible`): `bd update <id> --add-label scheduler:eligible`.
3. The project's scheduler runs its formula and dispatches each ready step to
   the project's role agents. Formulas in `packs/gastown/formulas/`:
   - `onboard-feature`: mayor plans, coder implements, reviewer checks (sending
     work back to the coder for up to three rounds), tester verifies.
   - `implement-fix`: the same without the mayor, for projects that have none.
   - `code-review`, `refinery-sweep` and `dogfood-rig-smoke` for narrower jobs.
4. Check the resulting bead notes and pull request. A step that hits its turn
   limit saves its work to a `wip/` branch and escalates to the project's PM
   instead of retrying.

Pool size, batch size, poll interval and the other scheduler controls are
`VIBESYNC_SCHEDULER_*` variables, with defaults in `src/app/config.ts`.

## HTTP API

The full description is served at `GET /openapi.json`, with an interactive
reference at `GET /docs`; a test keeps it in step with the routes the server
handles.

- `GET /health`
- Orchestration: `GET /formulas`, `POST /formulas/:name/run`, `GET /molecules`,
  `GET /molecules/:id`, `GET /molecules/:id/trace`, `GET /molecules/:id/events`
  (SSE), `POST /molecules/:id/resume`, `DELETE /molecules/:id`. When
  `VIBESYNC_ORCHESTRATION_TOKEN` is set, the run and molecule routes require it
  as a bearer token.
- Project registry: `GET /api/projects`, `GET /api/projects/:id`,
  `GET /api/projects/:id/beads-remote`,
  `POST /api/projects/:id/beads-remote/provision`,
  `POST /api/registry/projects`, `GET|PATCH|DELETE /api/registry/projects/:id`.
  `POST /api/sync/trigger` is retired and always answers 410.

## Deploy with systemd

The `vibesync.service` unit runs `bun src/index.ts` from the selected release
worktree and reads its `.env` file. Stage a Git worktree with dependencies
installed and a valid `.env`, check it boots (`scripts/ci/boot-check.sh`, and
`scripts/ci/engine-boot-check.sh` with orchestration on), then run:

```bash
scripts/deploy/swap.sh <release-dir>
```

The swap script installs/reloads the unit, points its release drop-in at the
staged worktree, restarts the service, and prints the previous working
directory and rollback command. Do not restart while formula runs are
in flight. After the swap, `GET /health` should report
`orchestration.ready: true`; if not, swap back. The unit and release drop-in
template are in `deploy/systemd/`.
