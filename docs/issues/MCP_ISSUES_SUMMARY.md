# Vibe Kanban MCP Server Expansion - Issues Summary

## Overview

**Project**: Vibe Kanban (VIBEK)
**Component**: MCP Server
**Framework**: TurboMCP (Rust)
**Total Issues Created**: 37
**Date**: 2025-10-27

This historical document summarizes issues created for the former Vibe Kanban MCP server expansion and should not be treated as the current Vibesync API specification. Current API documentation lives in [../api/API.md](../api/API.md); the framework comparison remains in [FRAMEWORK_DECISION.md](./FRAMEWORK_DECISION.md).

---

## Phase 1: Critical Foundation (29 issues)

### Setup & Migration (1 issue)
**Priority**: Urgent
**Timeline**: Week 1, Day 1

- **VIBEK-16**: Phase 1: Setup TurboMCP Framework
  - Migrate from rmcp to TurboMCP
  - Update Cargo.toml dependencies
  - Test existing 7 tools with new framework
  - Configure HTTP transport

### Executor Profile Management (5 issues) ⭐ **BLOCKS RESOLVED**
**Priority**: Urgent to Low
**Timeline**: Week 1, Day 2

This addresses the executor discovery blocker we encountered during testing.

- **VIBEK-15**: Implement list_executor_profiles tool ⭐ **CRITICAL**
- **VIBEK-20**: Implement get_executor_profile tool
- **VIBEK-19**: Implement create_executor_profile tool
- **VIBEK-17**: Implement update_executor_profile tool
- **VIBEK-18**: Implement delete_executor_profile tool

**Impact**: Agents can now discover available executors (CLAUDE_CODE, OPENCODE, etc.) and understand their capabilities, preventing the CCR timeout issue we encountered.

### Task Attempt Management (16 issues) ⭐ **CORE WORKFLOW**
**Priority**: Urgent to Low
**Timeline**: Week 1, Days 3-5

Critical for debugging failures, resuming work, iterative refinement, and code review workflows.

**High Priority (Urgent):**
- **VIBEK-21**: Implement list_task_attempts tool - See attempt history
- **VIBEK-22**: Implement get_task_attempt tool - Detailed attempt info
- **VIBEK-24**: Implement get_attempt_artifacts tool - Access work products
- **VIBEK-23**: Implement merge_task_attempt tool - **TESTED AND WORKS**

**Medium Priority (High):**
- **VIBEK-25**: Implement create_followup_attempt tool
- **VIBEK-26**: Implement rebase_task_attempt tool
- **VIBEK-30**: Implement push_attempt_branch tool
- **VIBEK-31**: Implement create_github_pr tool

**Standard Priority (Medium):**
- **VIBEK-27**: Implement abort_conflicts tool
- **VIBEK-28**: Implement get_commit_info tool
- **VIBEK-29**: Implement compare_commit_to_head tool
- **VIBEK-32**: Implement change_target_branch tool
- **VIBEK-34**: Implement get_branch_status tool
- **VIBEK-36**: Implement replace_execution_process tool

**Lower Priority (Low):**
- **VIBEK-33**: Implement delete_attempt_file tool
- **VIBEK-35**: Implement open_attempt_in_editor tool

### Execution Process Management (7 issues)
**Priority**: High to Medium
**Timeline**: Week 1, Days 6-7

Essential for monitoring execution, debugging failures, and managing long-running processes.

**High Priority:**
- **VIBEK-38**: Implement list_execution_processes tool
- **VIBEK-40**: Implement get_execution_process tool
- **VIBEK-39**: Implement stop_execution_process tool
- **VIBEK-37**: Implement get_process_raw_logs tool

**Medium Priority:**
- **VIBEK-41**: Implement get_process_normalized_logs tool
- **VIBEK-43**: Implement start_dev_server tool
- **VIBEK-42**: Implement stream_process_logs tool (WebSocket)

---

## Phase 2: Enhancement (5 issues)

### Project, Task, and System Management (3 group issues + 2 support)
**Priority**: Medium to High
**Timeline**: Week 2

These issues are structured as epic/parent issues, each containing multiple tools:

**Project Management (8 tools):**
- **VIBEK-44**: Phase 2: Enhanced Project Management (8 tools)
  - get_project, create_project, update_project, delete_project
  - get_project_branches, search_project_files
  - open_project_in_editor, get_project_executor_profiles

**Task Management (6 tools):**
- **VIBEK-45**: Phase 2: Enhanced Task Management (6 tools)
  - create_task_and_start (atomic operation)
  - get_task_images, upload_task_image
  - search_tasks, bulk_update_tasks, get_task_history

**System Configuration (8 tools):**
- **VIBEK-46**: Phase 2: System Configuration (8 tools)
  - get_system_info, get_config, update_config
  - list_mcp_servers, update_mcp_servers
  - list_git_repos, list_directory, health_check

**Testing & Documentation:**
- **VIBEK-48**: Create comprehensive integration tests for MCP tools
  - Tool invocation tests
  - Workflow tests (complete lifecycle)
  - Performance tests
  - Error handling validation

- **VIBEK-49**: Document TurboMCP migration and implementation patterns
  - Migration guide (rmcp → TurboMCP)
  - Tool implementation patterns
  - Error handling best practices
  - Testing guide

---

## Phase 3: Advanced Features (3 issues)

### Workflow Enhancements
**Priority**: Low
**Timeline**: Week 3

**Approval Workflow (4 tools):**
- **VIBEK-47**: Phase 3: Approval Workflow (4 tools)
  - create_approval, get_approval_status
  - respond_to_approval, get_pending_approvals
  - Enables human-in-the-loop workflows

**Tags & Labels (5 tools):**
- **VIBEK-50**: Phase 3: Tags & Labels (5 tools)
  - list_tags, get_tag, create_tag, update_tag, delete_tag
  - Categorization and filtering capabilities

**Authentication (3 tools):**
- **VIBEK-51**: Phase 3: Authentication (3 tools)
  - github_auth_start, github_auth_poll, github_check_token
  - GitHub integration workflow

---

## Implementation Timeline

### Week 1: Phase 1 - Critical Foundation (29 issues)
**Days 1-2**: Setup + Executor Profiles (6 issues)
- Day 1: TurboMCP migration and testing
- Day 2: Executor profile management (solves blocker!)

**Days 3-5**: Task Attempt Management (16 issues)
- Focus on urgent/high priority tools first
- Implement merge, list, get, artifacts tools
- Add GitHub PR and push capabilities

**Days 6-7**: Execution Process Management (7 issues)
- Process listing and monitoring
- Log access (raw and normalized)
- Process control (start/stop/restart)

### Week 2: Phase 2 - Enhancement (5 issues)
**Days 1-3**: Project, Task, System tools
- Enhanced project management
- Advanced task operations
- System configuration and discovery

**Days 4-5**: Testing and Documentation
- Comprehensive integration tests
- Migration documentation
- Implementation guides

### Week 3: Phase 3 - Advanced Features (3 issues)
**Days 1-2**: Approval workflow and tags
**Days 3-4**: Authentication and polish
**Day 5**: Final testing and release

---

## Success Metrics

1. ✅ **Coverage**: 35+ tools implemented (currently 7)
2. ✅ **Completeness**: Entire task lifecycle manageable without UI
3. ✅ **Discoverability**: Agents can discover executors and capabilities
4. ✅ **Reliability**: Enterprise error handling with TurboMCP
5. ✅ **Performance**: <100ms latency for most operations

---

## Critical Blocker Resolution

### Problem We Encountered
During testing, we hit a "Service startup timeout, please manually run `ccr start`" error because:
- Executor profile was configured with `claude_code_router: true`
- Claude Code Router (CCR) wasn't installed on the system
- No way for agents to discover that CCR was unavailable

### Solution
**VIBEK-15: list_executor_profiles tool** (Phase 1, Day 2)

This tool enables agents to:
- Discover all available executors
- Check executor capabilities and settings
- Validate before attempting task execution
- Choose appropriate executor for the environment

**Result**: Prevents timeout errors and enables intelligent executor selection.

---

## Reference Documents

1. **Current Vibesync API Reference**: [../api/API.md](../api/API.md)
   - Active HTTP route catalog
   - Beads-backed project and issue APIs
   - Formula and molecule orchestration endpoints

2. **Historical Framework Decision**: [FRAMEWORK_DECISION.md](./FRAMEWORK_DECISION.md)
   - TurboMCP vs rmcp comparison
   - Implementation approach
   - Code examples and patterns

3. **Reference Implementation**: `/opt/stacks/letta-MCP-server/letta-server/`
   - Production TurboMCP implementation
   - 7 consolidated tools (97 operations)
   - Proven patterns and best practices

---

## Next Steps

1. **Review Issues**: Validate all 37 issues in Legacy project VIBEK
2. **Prioritize**: Confirm Phase 1 priority order
3. **Start Development**: Begin with VIBEK-16 (TurboMCP setup)
4. **Implement Blocker Fix**: VIBEK-15 (executor profiles) immediately after setup
5. **Iterate**: Complete Phase 1, test with real workflows, gather feedback

---

## Issue Breakdown by Priority

### Urgent (10 issues)
- Setup (1)
- Executor profiles (1)
- Task attempts (4)
- Execution processes (4)

### High (6 issues)
- Executor profiles (1)
- Task attempts (2)
- Execution processes (3)

### Medium (13 issues)
- Executor profiles (2)
- Task attempts (4)
- Execution processes (3)
- Phase 2 enhancements (3)
- Documentation (1)

### Low (8 issues)
- Executor profiles (1)
- Task attempts (2)
- Phase 3 features (3)
- Integration testing included in medium

---

**Total Tool Count**: 62 operations
- Existing: 7 tools
- Phase 1: 28 new tools (5 executor + 16 attempt + 7 process)
- Phase 2: 22 new tools (8 project + 6 task + 8 system)
- Phase 3: 12 new tools (4 approval + 5 tags + 3 auth)

**Coverage**: From 7 tools → 69 total operations (10x expansion)

---

**Document Version**: 1.0
**Created**: 2025-10-27
**Author**: OpenCode AI
**Status**: Ready for Implementation
