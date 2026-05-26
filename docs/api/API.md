# Vibesync HTTP API Reference

## Overview

Vibesync exposes a Bun/Node HTTP API for project registry discovery, Beads-backed issue tracking, Letta PM-agent metadata, file access for remote agents, legacy sync telemetry, Temporal schedule controls, and formula/molecule orchestration.

**Default base URL:** `http://localhost:3099`

The listen port is controlled by `HEALTH_PORT`; when unset, the service uses `3099`.

## Authentication

Most local service endpoints are unauthenticated today and are intended for trusted internal network use. Formula and molecule control endpoints are optionally protected: when `VIBESYNC_ORCHESTRATION_TOKEN` is set, send `Authorization: Bearer <token>` to all endpoints under `/formulas` and `/molecules` except `GET /formulas`.

## Common response shape

JSON responses are pretty-printed and include permissive CORS headers. Errors use this general shape:

```json
{
  "error": "Endpoint not found",
  "statusCode": 404,
  "timestamp": "2026-05-18T12:00:00.000Z",
  "details": {}
}
```

Some older route handlers return route-specific errors with the same `error` field but fewer metadata fields.

## Health and metrics

### `GET /health`

Returns the service health snapshot from `HealthService`, including uptime, sync, memory, and connection-pool fields.

### `GET /metrics`

Returns Prometheus metrics using the registry content type.

### `GET /api/stats`

Returns a compact operational stats object including health metrics, SSE client count, sync history counts, and database stats when the database is available.

## Project registry and project views

### `GET /api/projects`

Lists registered projects.

Query parameters:

- `status`: `active` or `archived`.
- `tech_stack`: filter by stored tech stack.
- `mcp_enabled`: `true` or `false`.
- `cursor`: enables cursor pagination.
- `limit`: page size; maximum `100`.

Response includes `total`, `projects`, `timestamp`, and `page`.

### `GET /api/projects/:id`

Returns a project summary and project `etag` for the given project identifier.

### `POST /api/registry/projects`

Registers a project from a local git repository path.

Request body:

```json
{
  "filesystem_path": "/opt/stacks/vibesync"
}
```

`filesystem_path` is required, must be absolute, and must exist.

### `GET /api/registry/projects/:id`

Returns the registry record for a project identifier.

## Beads-backed issue APIs

### `GET /api/projects/:id/issues`

Lists compact issues for a project. The route prefers the Beads mirror and falls back to database rows or direct Beads hydration depending on availability.

Query parameters:

- `status`: comma-separated normalized statuses (`open`, `in_progress`, `blocked`, `deferred`, `closed`).
- `priority`: comma-separated priorities.
- `type`: issue type.
- `assignee`: passed to Beads hydration filters when direct Beads hydration is needed.
- `ready`: `true` or `false`.
- `q`: text search over title and description.
- `updatedSince` or `updated_since`: numeric timestamp filter.
- `sort`: `priority`, `updated`, or `created`; default is `priority`.
- `cursor`: cursor from a previous response.
- `limit`: page size; maximum `100`.

Response includes `projectId`, `project`, `issues`, `tracker_stats`, `data_freshness`, and `page`.

### `GET /api/projects/:id/ready-work`

Android-friendly equivalent of `bd ready`. Returns open, actionable, unblocked work for the project.

Query parameters:

- `cursor`
- `limit`

Response fields: `projectId`, `ready_work`, and `page`.

### `GET /api/projects/:id/work-items`

Returns list-optimized work items for a project.

Query parameters:

- `status`
- `priority`
- `cursor`: offset cursor returned by the endpoint.
- `limit`: page size; maximum `100`.

Response includes `project_identifier`, `provider`, `work_items`, `page`, `etag`, `data_freshness`, and `timestamp`.

### `GET /api/projects/:id/issue-analytics`

Returns issue analytics for a date range. Range parsing is implemented in `src/api/routes/issueAnalytics.ts`.

Response includes schema version, range metadata, created/completed buckets, summary, timeline pagination, freshness, and generated timestamp.

### `GET /api/issues/:id`

Returns full issue detail by stable issue ID. The response includes normalized status, blocker references, timestamps, labels, metadata, `etag`, notes/comments placeholders, and validation warnings.

### Issue mutation endpoints

All mutation endpoints require an `Idempotency-Key` header. Conflict-aware mutation services may also use `If-Match` or body-level etag fields depending on the configured Beads service implementation.

- `POST /api/issues/:id/claim`
- `POST /api/issues/:id/unclaim`
- `POST /api/issues/:id/close`
- `POST /api/issues/:id/reopen`
- `PATCH /api/issues/:id/status`
- `POST /api/issues/:id/notes`

`PATCH /api/issues/:id/status` requires a JSON body with `status`.

`POST /api/issues/:id/notes` requires a JSON body with `content`.

Example:

```http
POST /api/issues/vibesync-2ge/claim
Idempotency-Key: mobile-queue-42
Content-Type: application/json

{
  "assignee": "emmanuel"
}
```

## Beads remote provisioning

### `POST /api/projects/:id/beads-remote/provision`

Creates or reuses a project-scoped DoltHub database, configures the project's Beads remote, and pushes by default.

Request body:

```json
{
  "push": true
}
```

Set `push` to `false` to configure the remote without pushing immediately.

## Letta agent metadata and AGENTS.md refresh

### `GET /api/agents`

Lists registered projects that have Letta PM-agent metadata.

### `GET /api/agents/lookup?repo=<name>`

Finds the Letta agent metadata associated with a repository name.

### `POST /api/admin/agents-md/refresh`

Re-renders AGENTS.md content from the configured templates.

Request body:

```json
{
  "projectId": "HVSYN",
  "dryRun": true
}
```

`projectId` is optional. When omitted, all registry projects are targeted. `dryRun` defaults to `false`.

## Formula and molecule orchestration

These endpoints operate on Beads-backed formula runs and molecule state. If `VIBESYNC_ORCHESTRATION_TOKEN` is configured, include `Authorization: Bearer <token>`.

### `GET /formulas`

Lists available formulas from the default `gastown` pack and discovered packs.

### `POST /formulas/:name/run`

Starts a formula run and returns `202 Accepted` with the molecule ID.

Request body:

```json
{
  "input": "Review the current diff",
  "pack": "gastown",
  "motivatingBeadId": "vibesync-2ge"
}
```

`input` is required. `pack` defaults to `gastown`; `motivatingBeadId` is optional.

### `GET /molecules/:id`

Returns molecule status and serialized step outputs.

### `POST /molecules/:id/resume`

Resumes a resumable molecule through the orchestration dispatcher and returns accepted outputs.

### `DELETE /molecules/:id`

Cancels a cancellable molecule. Returns `409` if the molecule is not cancellable.

### `GET /molecules/:id/events`

Streams Server-Sent Events for dispatcher events scoped to a molecule. The stream closes on formula completion or failure.

## Configuration

### `GET /api/config`

Returns current runtime configuration.

### `PATCH /api/config`

Applies configuration updates through `ConfigurationHandler`.

### `POST /api/config/reset`

Resets configuration to defaults through `ConfigurationHandler`.

## Legacy sync telemetry and controls

These endpoints remain for compatibility with the service's historical sync subsystem. New domain state should use Beads-backed project and issue APIs.

### `POST /api/sync/trigger`

Triggers manual sync. Optional request body:

```json
{
  "projectId": "HVSYN"
}
```

Returns `202 Accepted` when the trigger is queued.

### `GET /api/sync/history?limit=20&offset=0`

Returns sync history events from the in-memory sync history store.

### `GET /api/sync/history/:id`

Returns one sync history event.

### `GET /api/sync/mappings`

Returns recorded legacy issue mappings.

### `GET /api/sync/mappings/:id`

Returns one legacy issue mapping.

## Real-time events

### `GET /api/events/stream`

Opens the general Server-Sent Events stream managed by `SSEManager`.

## Remote agent file operations

File paths are resolved under `config.stacks.baseDir` or `/opt/stacks` by default.

### `POST /api/files/read`

Request body:

```json
{
  "file_path": "vibesync/README.md",
  "start_line": 1,
  "max_lines": 200
}
```

Returns the requested line window plus path metadata.

### `POST /api/files/edit`

Request body:

```json
{
  "file_path": "vibesync/README.md",
  "start_line": 10,
  "end_line": 12,
  "new_content": "replacement text"
}
```

Replaces the inclusive line range and returns edit counts.

### `POST /api/files/info`

Request body:

```json
{
  "file_path": "vibesync/README.md"
}
```

Returns existence, size, timestamps, line count, and extension metadata.

## Temporal controls

Temporal endpoints return an unavailable response when Temporal is not configured.

### `GET /api/temporal/schedule`

Returns the active scheduled sync status.

### `POST /api/temporal/schedule/start`

Starts scheduled sync.

Request body fields:

- `intervalMinutes`: optional; defaults from config.
- `dryRun`: optional; defaults from config.

### `POST /api/temporal/schedule/stop`

Stops scheduled sync if active.

### `PATCH /api/temporal/schedule`

Restarts the schedule with a new interval. `intervalMinutes` is required and must be at least `1`.

### `POST /api/temporal/reconciliation/run`

Runs the Temporal data reconciliation workflow.

Request body fields:

- `projectIdentifier`
- `action`
- `dryRun`

### `GET /api/temporal/workflows?limit=20`

Lists recent sync workflows.

## MCP endpoint

### `POST /mcp`

Hosts the project MCP server over Streamable HTTP when `config.projectMcp.enabled !== false`. The path defaults to `/mcp` and can be changed with `config.projectMcp.path`.

`GET` and `DELETE` on the MCP path return JSON-RPC method-not-allowed errors.

## Documentation readiness notes

Vibesync now generates an OpenAPI 3.1 document from Zod route schemas during `bun run build:openapi` and serves it at `GET /openapi.json`. Interactive Scalar documentation is available at `GET /docs` and reads from that generated spec.

This Markdown file remains a human-maintained narrative reference; endpoint schemas should be kept current in `src/openapi/` so `/openapi.json` and `/docs` stay aligned with the runtime API.
