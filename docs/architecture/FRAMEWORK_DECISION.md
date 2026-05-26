# Vibe Kanban MCP Framework Decision

## Executive Summary

**Decision**: Use **Rust + TurboMCP** for implementing the Vibe Kanban MCP server expansion.

**Rationale**: TurboMCP provides enterprise-grade performance, type safety, and proven production stability. We already have a successful reference implementation in the Letta MCP Server that demonstrates the pattern.

---

## Framework Comparison

### Original Spec Recommendation: `rmcp`
The retired Vibe Kanban MCP expansion spec originally suggested using `rmcp` because:
- Matches existing Vibe Kanban Rust codebase
- Already in use in Vibe Kanban's MCP implementation
- HTTP transport via Supergateway

### TurboMCP: Superior Alternative

**TurboMCP** is a more mature, enterprise-grade alternative that offers:

| Feature | rmcp | TurboMCP |
|---------|------|----------|
| **Performance** | Standard | SIMD-accelerated JSON (2-3x faster) |
| **Security** | Basic | OAuth 2.1, CORS, TLS, rate limiting, circuit breakers |
| **Transport** | HTTP | STDIO, HTTP, WebSocket, TCP, Unix sockets |
| **Production Features** | Limited | Connection pooling, health monitoring, auto-retry |
| **MCP Compliance** | Partial | 100% (MCP 2025-06-18 spec) |
| **Type Safety** | Yes | Comprehensive Rust types + schemars |
| **Documentation** | Limited | Extensive with examples |
| **Ecosystem** | Standalone | TurboMCP Studio, active development |

---

## Why TurboMCP?

### 1. **Proven Track Record**
We already have a production TurboMCP implementation:
- **Location**: `/opt/stacks/letta-MCP-server/letta-server/`
- **Status**: Phase 3 complete, 97 operations across 7 consolidated tools
- **Performance**: Handles 93% of Letta API with SDK integration
- **Reliability**: Enterprise error handling, automatic retries, timeouts

### 2. **Perfect Pattern Match**
The Letta MCP implementation provides an exact template for Vibe Kanban:

**Letta MCP Structure**:
```
7 consolidated tools (93% SDK-based)
├── letta_agent_advanced (22 operations)
├── letta_memory_unified (15 operations)
├── letta_tool_manager (13 operations)
├── letta_mcp_ops (10 operations)
├── letta_source_manager (15 operations)
├── letta_job_monitor (4 operations)
└── letta_file_folder_ops (8 operations)
```

**Vibe Kanban Target** (from spec):
```
35+ tools across 9 categories
Phase 1 (Critical):
├── Executor Profile Management (5 tools)
├── Task Attempt Management (16 tools)
└── Execution Process Management (7 tools)
```

### 3. **Enterprise Features Built-In**
- **Connection Pooling**: 50 concurrent connections, 10 warm connections
- **Error Handling**: Unified error transformation (SDK + HTTP errors)
- **Security**: OAuth, CORS, TLS ready for production
- **Monitoring**: Health checks, metrics, logging
- **Resilience**: Circuit breakers, automatic retries, timeouts

### 4. **Developer Experience**
- **Auto-schema generation**: `#[derive(schemars::JsonSchema)]` generates MCP schemas
- **Type-safe handlers**: Rust compiler catches errors at compile time
- **Macros**: `#[tool]` attribute for automatic MCP registration
- **Discriminator pattern**: Single tool with multiple operations (like Letta)

---

## Implementation Approach

### Option 1: Extend Vibe Kanban Rust Codebase ✅ RECOMMENDED

**Location**: `/opt/stacks/vibe-kanban/crates/server/src/mcp/`

**Advantages**:
- Direct access to Vibe Kanban internals
- No additional deployment
- Same binary, shared memory, zero latency
- Maintain single codebase

**Migration Path**:
1. Replace `rmcp` with TurboMCP in `Cargo.toml`
2. Migrate existing 7 tools to TurboMCP pattern
3. Add Phase 1 critical tools (28 new tools)
4. Extend with Phase 2 & 3 tools

**Example Migration** (`task_server.rs`):
```rust
// BEFORE (rmcp)
use rmcp::*;

#[tool(description = "List projects")]
async fn list_projects(&self, params: ListProjectsParams) -> Result<CallToolResult, ErrorData> {
    let url = self.url("/api/projects");
    let result: Vec<Project> = self.send_json(
        self.client.get(&url)
    ).await?;

    TaskServer::success(&result)
}

// AFTER (TurboMCP)
use turbomcp::prelude::*;

#[tool(description = "List all projects")]
async fn list_projects(&self, _request: EmptyRequest) -> McpResult<String> {
    let url = format!("{}/api/projects", self.base_url);
    let response = self.client.get(&url)
        .send()
        .await
        .map_err(|e| McpError::internal(format!("Failed to list projects: {}", e)))?;

    let projects: Vec<Project> = response.json().await?;

    Ok(serde_json::to_string_pretty(&ProjectsResponse {
        success: true,
        operation: "list".to_string(),
        message: format!("Found {} projects", projects.len()),
        data: Some(serde_json::to_value(&projects)?),
        count: Some(projects.len()),
    })?)
}
```

### Option 2: Standalone TurboMCP Server

**Location**: `/opt/stacks/vibe-kanban-mcp/` (new project)

**Advantages**:
- Independent deployment and versioning
- Faster development iteration (no Rust recompilation of entire Vibe Kanban)
- Can use REST API (already documented)
- Easier testing in isolation

**Disadvantages**:
- Network latency for API calls
- Separate deployment to manage
- Duplication of types/logic

---

## Recommended Implementation Pattern

Based on the Letta MCP Server success, use the **consolidated tool pattern**:

### File Structure
```
vibe-kanban/crates/server/src/mcp/
├── lib.rs                          # Server struct with #[turbomcp::server]
├── main.rs                         # Entry point (HTTP/stdio transport)
└── tools/
    ├── mod.rs                      # Module exports
    ├── project_management.rs       # 9 operations
    ├── task_management.rs          # 11 operations
    ├── task_attempt_advanced.rs    # 16 operations (CRITICAL)
    ├── execution_process.rs        # 7 operations (CRITICAL)
    ├── executor_profiles.rs        # 5 operations (CRITICAL - our blocker!)
    ├── approval_workflow.rs        # 4 operations
    ├── tags_labels.rs              # 5 operations
    ├── system_config.rs            # 8 operations
    └── authentication.rs           # 3 operations
```

### Example Tool Implementation

**File**: `tools/executor_profiles.rs`

```rust
//! Executor Profile Management Operations
//!
//! Critical tool that addresses the executor discovery gap we encountered.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use turbomcp::McpError;
use reqwest::Client;

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutorOperation {
    List,
    Get,
    Create,
    Update,
    Delete,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecutorProfileRequest {
    /// The operation to perform
    pub operation: ExecutorOperation,

    /// Profile ID (required for get, update, delete)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,

    /// Profile configuration (required for create/update)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct ExecutorProfileResponse {
    pub success: bool,
    pub operation: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

pub async fn handle_executor_profiles(
    client: &Client,
    base_url: &str,
    request: ExecutorProfileRequest,
) -> Result<String, McpError> {
    let operation_str = format!("{:?}", request.operation).to_lowercase();

    let response = match request.operation {
        ExecutorOperation::List => handle_list_profiles(client, base_url).await?,
        ExecutorOperation::Get => handle_get_profile(client, base_url, request).await?,
        ExecutorOperation::Create => handle_create_profile(client, base_url, request).await?,
        ExecutorOperation::Update => handle_update_profile(client, base_url, request).await?,
        ExecutorOperation::Delete => handle_delete_profile(client, base_url, request).await?,
    };

    Ok(serde_json::to_string_pretty(&response)?)
}

async fn handle_list_profiles(
    client: &Client,
    base_url: &str,
) -> Result<ExecutorProfileResponse, McpError> {
    let url = format!("{}/api/executor-profiles", base_url);
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| McpError::internal(format!("Failed to list profiles: {}", e)))?;

    let profiles: Vec<Value> = response.json().await?;

    Ok(ExecutorProfileResponse {
        success: true,
        operation: "list".to_string(),
        message: format!("Found {} executor profiles", profiles.len()),
        data: Some(serde_json::to_value(&profiles)?),
    })
}

// ... other handlers
```

**Registering in Server** (`lib.rs`):

```rust
use turbomcp::prelude::*;
mod tools;

#[derive(Clone)]
pub struct VibeKanbanServer {
    client: reqwest::Client,
    base_url: String,
}

#[turbomcp::server(
    name = "vibe-kanban-mcp",
    version = "2.0.0",
    description = "MCP server for Vibe Kanban - comprehensive task execution lifecycle management"
)]
impl VibeKanbanServer {
    pub fn new(base_url: String) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            client: reqwest::Client::new(),
            base_url,
        })
    }

    #[tool(description = "Executor Profile Management - Critical for discovering available executors (claude-code, opencode, etc.). Supports 5 operations: list, get, create, update, delete.")]
    async fn vibe_executor_profiles(
        &self,
        request: tools::executor_profiles::ExecutorProfileRequest,
    ) -> McpResult<String> {
        tools::executor_profiles::handle_executor_profiles(&self.client, &self.base_url, request).await
    }

    // ... 34 more tools
}
```

---

## Migration Plan

### Phase 1: Foundation (Week 1) - 28 Tools

**Goal**: Critical executor and attempt management

1. **Setup TurboMCP** (Day 1)
   - Update `Cargo.toml` dependencies
   - Migrate server struct to TurboMCP
   - Test existing 7 tools work with TurboMCP

2. **Executor Profile Management** (Day 2) - **HIGH PRIORITY**
   - `list_executor_profiles` ⭐ **Solves our blocker**
   - `get_executor_profile`
   - `create_executor_profile`
   - `update_executor_profile`
   - `delete_executor_profile`

3. **Task Attempt Management** (Days 3-5) - 16 tools
   - `list_task_attempts` ⭐ See attempt history
   - `get_task_attempt` ⭐ Detailed attempt info
   - `get_attempt_artifacts` ⭐ Access work products
   - `merge_task_attempt` ⭐ **TESTED - WORKS**
   - `create_followup_attempt`
   - `rebase_task_attempt`
   - `abort_conflicts`
   - `get_commit_info`
   - `compare_commit_to_head`
   - `push_attempt_branch`
   - `create_github_pr`
   - `change_target_branch`
   - `get_branch_status`
   - `delete_attempt_file`
   - `open_attempt_in_editor`
   - `replace_execution_process`

4. **Execution Process Management** (Days 6-7) - 7 tools
   - `list_execution_processes`
   - `get_execution_process`
   - `stop_execution_process`
   - `get_process_raw_logs`
   - `get_process_normalized_logs`
   - `start_dev_server`
   - `stream_process_logs`

**Testing**: Integration tests for complete task lifecycle

### Phase 2: Enhancement (Week 2) - 22 Tools

5. **Project Management** (8 tools)
6. **Task Management** (6 tools)
7. **System Configuration** (8 tools)

### Phase 3: Advanced Features (Week 3) - 12 Tools

8. **Approval Workflow** (4 tools)
9. **Tags & Labels** (5 tools)
10. **Authentication** (3 tools)

---

## Success Metrics

1. **Coverage**: ✅ 100% of critical API endpoints (35+ tools)
2. **Performance**: ✅ <100ms latency for most operations
3. **Reliability**: ✅ Enterprise error handling
4. **Discoverability**: ✅ Agents can find executors (fixes our blocker!)
5. **Completeness**: ✅ Full task lifecycle without UI

---

## Reference Implementation

**Letta MCP Server**: `/opt/stacks/letta-MCP-server/letta-server/`

Key files to study:
- `src/lib.rs` - Server registration pattern
- `src/main.rs` - HTTP/stdio transport setup
- `src/tools/job_monitor.rs` - Simple consolidated tool (4 operations)
- `src/tools/agent_advanced.rs` - Complex consolidated tool (22 operations)
- `Cargo.toml` - TurboMCP dependencies

---

## Next Steps

1. **Review and approve** this framework decision
2. **Create Legacy issue** for MCP expansion (use vibe-kanban MCP)
3. **Set up development environment** with TurboMCP
4. **Implement Phase 1** (Executor Profiles first - fixes our blocker!)
5. **Test with real workflows** (OpenCode + Claude Code)
6. **Iterate based on usage**

---

**Document Version**: 1.0
**Created**: 2025-10-27
**Author**: OpenCode AI
**Status**: Proposed
