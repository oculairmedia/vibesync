# Vibesync Service

Beads-backed project tracker and Letta PM-agent coordination service for Oculair project workspaces.

## Current Scope

- Project registry API for discovering and managing workspace projects.
- Beads-backed issue, ready-work, mutation, and remote-provisioning APIs.
- Android-friendly project and issue endpoints for lightweight mobile clients.
- Letta PM-agent metadata, reporting, and orchestration integrations.
- Formula orchestration controls for Beads-backed project work.
- Dockerized runtime with health checks and optional Temporal workers.

## Quick Start

Host runtime with Bun:

```bash
cd /opt/stacks/vibesync
bun install --frozen-lockfile
bun run type-check:all
bun run start
```

Build a host-runnable binary:

```bash
bun run build:binary
./dist/vibesync
```

The binary bundles the Bun service entrypoint. Runtime integrations that shell
out to host tools, Python helpers, Beads, Dolt, Git, or mounted workspace paths
still need those tools/files available on the host.

Docker remains available for the current deployment topology:

```bash
cd /opt/stacks/vibesync
cp .env.example .env
docker-compose up -d
docker-compose logs -f
```

For production restarts that need the DoltHub provisioning token, use the
Vaultwarden-backed compose wrapper instead of storing the token in `.env`:

```bash
./scripts/vibesync-compose-vaultwarden.sh pull vibesync
./scripts/vibesync-compose-vaultwarden.sh up -d vibesync
```

The wrapper reads the `DoltHub API Token` item from Vaultwarden at runtime and
exports `DOLTHUB_API_TOKEN` only for that `docker compose` invocation.

## Configuration

See `.env.example` for supported settings. Core settings include:

```bash
VIBE_MCP_URL=http://192.168.50.90:9717/mcp
LETTA_BASE_URL=http://localhost:8283
ENABLE_ORCHESTRATION=true
VIBESYNC_ORCHESTRATION_TOKEN=
```

## Project Registry API

### List projects

`GET /api/projects`

Returns lightweight project summaries suitable for mobile first paint, including repo metadata, PM-agent metadata, tracker capabilities, activity timestamps, and version/etag fields.

### Project detail

`GET /api/projects/:id`

Returns a compact project detail summary. Large collections are exposed through separate paginated subresources.
If tracker/work-item hydration fails, the project detail still returns `200` with the normal project fields and marks only `project.tracker.data_freshness.status` as `"error"`. Error messages in freshness metadata are sanitized for UI display and never expose raw stack traces or low-level exception text.

### Project subresources

- `GET /api/projects/:id/agents`
- `GET /api/projects/:id/conversations`
- `GET /api/projects/:id/work-items`
- `GET /api/projects/:id/activity`
- `GET /api/projects/:id/issues`
- `GET /api/projects/:id/ready-work`

Subresources use cursor-style pagination envelopes with `page.next_cursor`, `page.has_more`, and `page.total_known`.
If a subresource cannot be hydrated, the endpoint returns the project-scoped envelope normally with an empty collection for that subresource and `data_freshness.status = "error"`; the `data_freshness.error` value is a sanitized, user-safe summary.

Project `etag` values change only when project summary/detail fields change. Tracker freshness and subresource availability do not change the project `etag`; each subresource response exposes its own `etag` and `data_freshness.last_sync_at` for cache invalidation and stale/error UI states.

### Android issue/work contract

`GET /api/projects/:id/ready-work` is the Android equivalent of `bd ready`: it returns open, actionable, unblocked work without requiring the client to reconstruct readiness from raw issue lists.

`GET /api/projects/:id/issues` returns compact, paginated issue summaries. It supports Android-friendly filters including `status`, `priority`, `assignee`, `type`, `ready=true|false`, text query via `q`, and incremental refresh via `updatedSince` / `updated_since`. Sorting currently supports `priority`, `updated`, and `created`.

`GET /api/issues/:id` returns full issue detail by stable opaque issue ID, including description, acceptance criteria, labels, normalized status, blocker references, child references, timestamps, and validation warnings.

Mutation endpoints are first-class and conflict-aware. Send either an `If-Match` header or `if_match` body field with the issue `etag`; stale mutations return `409` with a structured `conflict` object. Send `Idempotency-Key` or `idempotency_key` for offline-safe retries.

- `POST /api/issues/:id/claim`
- `POST /api/issues/:id/unclaim`
- `PATCH /api/issues/:id/status`
- `POST /api/issues/:id/notes`
- `POST /api/issues/:id/close`
- `POST /api/issues/:id/reopen`

Example mutation request:

```http
POST /api/issues/letta-mobile-qmbg/claim
If-Match: letta-mobile-qmbg:1778416496000
Idempotency-Key: android-queue-42
Content-Type: application/json

{
  "assignee": "emmanuel"
}
```

Conflict response:

```json
{
  "error": "Issue conflict",
  "statusCode": 409,
  "conflict": {
    "reason": "etag_mismatch",
    "expected": "letta-mobile-qmbg:stale",
    "current": "letta-mobile-qmbg:1778416496000",
    "issueId": "letta-mobile-qmbg"
  }
}
```

Issue payloads are deterministic and schema-versioned:

```json
{
  "id": "letta-mobile-qmbg",
  "projectId": "letta-mobile",
  "provider": "beads",
  "title": "Define Android Beads data contract for project workspaces",
  "type": "task",
  "priority": "high",
  "status": "open",
  "statusLabel": "todo",
  "ready": true,
  "assignee": null,
  "blockedBy": [],
  "blocks": [],
  "isBlocked": false,
  "updatedAt": "2026-05-10T12:34:56.000Z",
  "summary": "Short list-safe summary",
  "acceptanceCriteria": ["Criterion one"],
  "labels": ["android", "project-workspace"],
  "validationWarnings": [],
  "etag": "letta-mobile-qmbg:1778416496000"
}
```

Normalized machine-readable statuses are `open`, `in_progress`, `blocked`, `deferred`, and `closed`; the original tracker status remains available as `statusLabel` for display/debugging.

### Register a project

`POST /api/registry/projects`

```json
{
  "filesystem_path": "/opt/stacks/letta-mobile",
  "name": "Letta Mobile",
  "git_url": "https://github.com/oculairmedia/letta-mobile.git"
}
```

- `filesystem_path` is required and must be an absolute path.
- `name` and `git_url` are optional.
- The path must exist and be a git repository.

### Update a project

`PATCH /api/registry/projects/:id`

```json
{
  "filesystem_path": "/opt/stacks/letta-mobile",
  "git_url": "https://github.com/oculairmedia/letta-mobile.git"
}
```

### Beads/DoltHub remote provisioning

`POST /api/projects/:id/beads-remote/provision`

Creates or reuses a project-scoped DoltHub database, configures the project's Beads remote, and pushes the local Beads database by default. Database names are normalized from the project folder name, for example `/opt/stacks/letta-mobile` becomes the DoltHub remote `https://doltremoteapi.dolthub.com/oulair/letta_mobile`.

```json
{
  "push": true
}
```

Provisioning is idempotent: an already-existing DoltHub database is treated as success, and an existing local or mismatched Beads remote is replaced with the configured DoltHub remote. Use `GET /api/projects/:id/beads-remote` to inspect stored provisioning metadata.

The DoltHub API token is only used for private database creation. Routine `bd dolt push`/`pull` operations use the server's `dolt login` credentials from `~/.dolt/creds`, so keep those credentials provisioned separately.

CLI helpers:

```bash
npm run vibesync -- project-beads-remote HVSYN
npm run vibesync -- project-provision-beads-remote HVSYN
npm run vibesync -- project-provision-beads-remote HVSYN --no-push
```

## Beads Workflow

Use Beads for issue tracking in this repository. Vibesync reads and mutates project work through Beads:

```bash
bd ready
bd show <id>
bd update <id> --claim
bd close <id>
```

Do not route project issue operations through external issue tools.
