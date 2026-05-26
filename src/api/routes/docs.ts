interface App {
  registerRoute(opts: { match: (ctx: { pathname: string; method: string }) => boolean; handle: (ctx: { res: unknown }) => Promise<void> }): void;
}

export function registerDocsRoutes(app: App): void {
  app.registerRoute({
    match: ({ pathname, method }) => pathname === '/' && method === 'GET',
    handle: async ({ res }) => {
      (res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }).writeHead(200, { 'Content-Type': 'text/plain' });
      (res as { end: (body: string) => void }).end(`Vibesync Service API

Available Endpoints:

Health & Metrics:
  GET  /health                       - Service health check
  GET  /metrics                      - Prometheus metrics
  GET  /api/stats                    - Human-readable statistics (includes database stats)

Projects & Issues:
  GET  /api/projects                 - List registered projects
  GET  /api/projects/:id             - Get project detail
  GET  /api/projects/:id/issues      - List Beads-backed project issues
  GET  /api/projects/:id/ready-work  - List ready, unblocked project work
  GET  /api/projects/:id/work-items  - List compact project work items
  GET  /api/projects/:id/issue-analytics - Get issue analytics
  GET  /api/issues/:id               - Get full issue detail
  POST /api/issues/:id/claim         - Claim an issue (Idempotency-Key required)
  POST /api/issues/:id/unclaim       - Unclaim an issue (Idempotency-Key required)
  POST /api/issues/:id/close         - Close an issue (Idempotency-Key required)
  POST /api/issues/:id/reopen        - Reopen an issue (Idempotency-Key required)
  PATCH /api/issues/:id/status       - Update issue status (Idempotency-Key required)
  POST /api/issues/:id/notes         - Add an issue note (Idempotency-Key required)

Project Registry & Remotes:
  POST /api/registry/projects        - Register a local project path
  GET  /api/registry/projects/:id    - Get a registry project
  POST /api/projects/:id/beads-remote/provision - Configure/push Beads DoltHub remote

Letta Agents:
  GET  /api/agents                   - List projects with Letta agent metadata
  GET  /api/agents/lookup?repo=<name> - Lookup project agent metadata by repo
  POST /api/admin/agents-md/refresh  - Re-render AGENTS.md from templates

Formula Orchestration:
  GET  /formulas                     - List available formulas
  POST /formulas/:name/run           - Start a formula run (token protected when configured)
  GET  /molecules/:id                - Get molecule status
  POST /molecules/:id/resume         - Resume a molecule
  DELETE /molecules/:id              - Cancel a molecule
  GET  /molecules/:id/events         - Stream molecule events

Configuration:
  GET  /api/config                   - Get current configuration
  PATCH /api/config                  - Update configuration
  POST /api/config/reset             - Reset to defaults

Sync Control:
  POST /api/sync/trigger             - Trigger manual sync
  POST /api/sync/trigger (projectId) - Trigger sync for specific project

Sync History:
  GET  /api/sync/history             - Get sync history (paginated)
  GET  /api/sync/history/:id         - Get specific sync event

Issue Mappings:
  GET  /api/sync/mappings            - Get all issue mappings
  GET  /api/sync/mappings/:id        - Get specific mapping

Real-time Events:
  GET  /api/events/stream            - Server-Sent Events stream

File Operations (Remote Agent File Mounting):
   POST /api/files/read               - Read file content (for remote agents)
   POST /api/files/edit               - Edit file content (for remote agents)
   POST /api/files/info               - Get file metadata

Temporal Schedule Management:
  GET  /api/temporal/schedule        - Get scheduled sync status
  POST /api/temporal/schedule/start  - Start scheduled sync workflow
  POST /api/temporal/schedule/stop   - Stop scheduled sync workflow
  PATCH /api/temporal/schedule       - Update schedule interval
  POST /api/temporal/reconciliation/run - Run data reconciliation
  GET  /api/temporal/workflows       - List sync workflows

MCP:
  POST /mcp                          - Project MCP server (path configurable)

Reference:
  GET  /openapi.json                  - OpenAPI 3.1 specification
  GET  /docs                          - Interactive Scalar API reference
  docs/api/API.md                    - Current human-maintained API reference

Event Types (SSE):
    - connected                  - Client connected
    - sync:triggered             - Sync manually triggered
    - sync:started               - Sync cycle started
    - sync:completed             - Sync cycle completed
    - sync:error                 - Error during sync
    - config:updated             - Configuration changed
    - health:updated             - Health metrics updated
    - temporal:schedule-started  - Temporal schedule started
    - temporal:schedule-stopped  - Temporal schedule stopped
    - temporal:schedule-updated  - Temporal schedule interval updated
`);
    },
  });
}
