<!-- VIBESYNC:adr:START -->

# ADR-0001 — VibeSync Orchestration Ownership & Kotlin Migration Boundary

| Field           | Value                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR ID          | 0001                                                                                                                                                               |
| Title           | Orchestration Ownership & Kotlin Migration Boundary                                                                                                                |
| Status          | Proposed (2026-07-14)                                                                                                                                              |
| Authors         | PM-vibesync (vibesync-jxri.1)                                                                                                                                      |
| Deciders        | Meridian (Director of Engineering)                                                                                                                                 |
| Bead            | `vibesync-jxri.1`                                                                                                                                                  |
| Epic            | `vibesync-jxri` — VibeSync reference implementation hardening before Kotlin convergence                                                                            |
| Parent baseline | `origin/main @ ce1f4e9fc39d67fbdcc915b1e70c9135f7af4dbd`                                                                                                           |
| Supersedes      | none                                                                                                                                                               |
| Cross-repo      | `letta-mobile-gx6ri` (downstream consumer; this ADR is prerequisite for its ADR)                                                                                   |
| Companion docs  | `AGENTS.md` (five invariants) · `docs/architecture/gastown-orchestration.md` · `docs/architecture/bd-conventions.md` · `docs/architecture/gastown-role-catalog.md` |

> This ADR is the reference decision for what VibeSync owns versus what
> stays in the runtime layer. It is binding for both the Bun reference
> implementation and the future Kotlin App Server port. The Kotlin port
> MUST NOT be marked authoritative until `vibesync-jxri.14` (reference
> release gate) closes against this ADR.

---

## 1. Context

VibeSync's orchestration plane has accumulated two years of
multi-agent patterns sourced from Gas Town, the Letta Teams SDK, and
the letta-code local backend. The `vibesync-jxri` epic exists to
finalize that plane as a **versioned executable reference** before
any Kotlin port may become authoritative. This ADR is the first
deliverable of that epic: the boundary contract.

Three forces drive the boundary:

1. **Five layering invariants** pinned in `AGENTS.md` and now load-bearing
   for both Bun and Kotlin paths.
2. **A second runtime path** (Kotlin on Iroh App Server) that needs
   semantic equivalence without duplicating provider-specific debt.
3. **A clean release gate** (`jxri.14`) that downstream consumers
   (notably `letta-mobile-gx6ri`) treat as prerequisite evidence before
   cutting Kotlin over to authority.

The default branch is `main`, currently at `ce1f4e9` on
`feat/qk4a-github-pr-feedback-webhook`. This ADR is authored on a
fresh isolated worktree `docs/jxri-1-orchestration-ownership-adr`
branched from `origin/main` so the dirty primary checkout
(`feat/qk4a-github-pr-feedback-webhook` mid-rebase) is not disturbed.

---

## 2. Five Invariants (pinned verbatim from `AGENTS.md`)

These five rules are defects to violate even if the code appears to
work. Both Bun and Kotlin implementations MUST preserve them.

| #   | Invariant                                           | One-line test                                                                                                                                                                                         |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No upward dependencies**                          | Layer N never imports Layer N+1. `src/orchestration/runtime/` MUST NOT import `src/orchestration/formula/`; `formula/` MUST NOT import `dispatcher/`; lower layers call back through interfaces only. |
| 2   | **Beads is the universal persistence substrate**    | All domain state (human work + runtime work) goes through `bd`. Legacy `vibesync.db` SQLite registry MUST NOT be extended.                                                                            |
| 3   | **EventBus is the universal observation substrate** | All cross-layer visibility goes through the bus. No direct status polling; no reading another layer's internal state.                                                                                 |
| 4   | **Config is the universal activation mechanism**    | Features turn on via config presence. Branches on env vars in core code are a smell; gate activation through project config.                                                                          |
| 5   | **Zero hardcoded roles**                            | No `if (role === "reviewer")` in core TypeScript. Roles live in pack TOML + prompt templates. `LettaConfig.controlAgentName` is the one tolerated escape hatch.                                       |

---

## 3. Decision

### 3.1 Controller vs Runtime ownership

| Concern                   | Owner                                         | Notes                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session lifecycle         | `RuntimeProvider`                             | `start` / `stop` / `prompt` / `nudge` / `observe` — five methods, opaque handles, no role semantics.                                                                                                                             |
| Prompt content            | Formula dispatcher + role config              | Dispatcher renders formula templates; role config supplies persona / system prompt. Neither layer hard-codes the other.                                                                                                          |
| Turn observation          | `RuntimeProvider.observe`                     | Streams `SessionEvent`. The dispatcher translates to bus events. Subscribers MUST NOT bypass the bus to poll the provider directly.                                                                                              |
| Cross-session correlation | `EventBus` + `MoleculeWalker`                 | All molecule-step state derives from `bd` rows + bus events. The walker reads Beads, the bus emits transitions.                                                                                                                  |
| Control session topology  | One controller per App Server control session | The persistent PM agent IS the controller. There is exactly ONE controller per App Server session; spawned role sessions are subagents, not controllers. Observers fan out via EventBus; they do not spawn parallel controllers. |

**Normative:** A control session owns at most one persistent controller.
All cross-session visibility flows through `EventBus`. A new control
session requires a new PM agent; it does not reparent the existing
one.

**Incidental:** Current code instantiates `LettaCodeSubagentProvider`
directly in `src/orchestration/boot.ts` and reads env vars
(`VIBESYNC_LETTA_CODE_SHIM_URL`, `VIBESYNC_LETTA_CODE_PARENT_AGENT_ID`)
at boot. These are boot-level wiring choices — they MUST NOT be
re-imported by `dispatcher` or `formula` layers.

### 3.2 RuntimeProvider v2 seam

`src/orchestration/runtime/provider.ts` is the chokepoint. The
five-method contract is normative and frozen for the lifetime of a
reference release:

```ts
interface RuntimeProvider {
  readonly kind: string; // provider identity
  start(spec: SessionSpec): Promise<SessionHandle>; // opaque handle
  stop(handle: SessionHandle): Promise<void>; // idempotent
  prompt(handle: SessionHandle, content: readonly ContentBlock[]): Promise<PromptResult>;
  nudge(handle: SessionHandle): Promise<void>; // no-op for many providers
  observe(handle: SessionHandle): AsyncIterable<SessionEvent>; // stream until turn-done / stopped
}
```

**Normative rules:**

- `SessionHandle.id` is provider-stable and safe to log / persist on
  a bead. Cross-provider handle exchange is a defect.
- `SessionEvent` is a discriminated union by `kind`. Unknown kinds
  pass through opaquely (consumers MUST NOT throw on unrecognized shapes).
- The interface MUST NOT widen to include role-specific methods
  (`setMemoryBlock`, `forkConversation`, A2UI negotiation, etc.).
  Those belong in provider-specific start-spec extensions or in code
  above the seam.
- `SessionSpec.extra` is the documented escape hatch for
  provider-specific config (e.g. `parentAgentId`,
  `personaContent`, `conversationId`, `turnTimeoutMs`). The provider
  documents which keys it accepts.

**Reference implementations (Bun):**

- `LettaCodeSubagentProvider` — primary; uses letta-code local backend
  over HTTP/SSE today.
- `LettaPMAgentProvider` — persistent PM-agent path; stays above the seam.
- `A2UIProvider` — server-side projection for letta-mobile / web UI.
- `ACPProvider` — JSON-RPC over stdio for subprocess-backed runtimes.
- `FakeProvider` — in-memory, for tests.

**Kotlin port (narrow semantic equivalent):**

- Implements the same five-method contract.
- Replaces the letta-code HTTP/SSE path with a client to the Iroh App
  Server REST/App Server v2 surface.
- Discriminated `SessionEvent` is preserved verbatim (the on-wire
  contract per `jxri.3`).
- SessionHandle stays opaque and provider-local; `id` is still safe
  to log.
- SessionSpec.extra is honored key-for-key for the keys listed in
  the Bun reference doc-comments.

**Incidental — DO NOT PORT:**

- The PM puppet-message scaffold (`[ORCHESTRATION_SUBAGENT_DISPATCH]`
  marker, `buildPuppetMessage`, `<<<TASK_PROMPT_BEGIN>>>` block) is a
  workaround for letta-code SDK 0.25.11's missing custom subagent
  discovery (vibesync-s28). The Kotlin narrow equivalent talks to
  REST/App Server v2 directly and does NOT need this scaffold.
- The SSE line-by-line parser in `consumeSseBody` is shim-specific.
  The Kotlin path uses structured streaming clients.
- The `tool_return_message` → `assistant_message` fallback exists
  because the letta-code shim returns inconsistent event shapes across
  versions. The Kotlin REST/App Server v2 surface is normalized; the
  fallback is unnecessary.

### 3.3 Beads / Dolt authority

**Normative:**

- All domain state — both human-curated work (tasks, bugs, features,
  epics, decisions) and runtime work (molecule_root, molecule_step,
  mail) — goes through `bd` (Dolt). See `docs/architecture/bd-conventions.md`.
- The Dolt schema is the only source of truth. `vibesync.db` SQLite
  registry is **legacy** and MUST NOT be extended. Existing data is
  migrated lazily as code paths get touched (no big-bang migration).
- Runtime work uses the same `bd` schema with structured labels under
  `exec.*` and sidecar tables for execution payloads.
- Dolt history is the rollback substrate. Every reference release is
  tagged in git AND committed to Dolt so `bd dolt pull` recovers
  state.

**Incidental — DO NOT PORT:**

- `vibesync.db` legacy schema. Migrate; do not replicate.
- Pre-`bd` registry tables. Same posture.

### 3.4 EventBus authority

**Normative:**

- `src/orchestration/events/bus.ts` is the single observation seam.
  All cross-layer state transitions emit a typed event.
- Subscribers receive events from the bus; they MUST NOT poll the
  producing layer's internal state directly.
- The bus is append-only from the perspective of observers (causal
  observation log per `jxri.7`). `noPersist` is a debug toggle, not a
  deployment posture.
- Bus events feed `HealthPatrol`, `WorkActivityReporter`, and the
  molecule writeback hook. No path bypasses the bus to talk to
  dispatch state directly.

**Incidental:** Today `WorkActivityReporter` (vibesync-ryhc) has a
secondary subscription to the letta-code shim's `/v1/agents/<id>/messages/stream`
SSE for the mobile active-subagent bar. That second subscription is
provider-specific and is NOT the normative observation path. The
normative path is `EventBus → WorkActivityReporter`. The Kotlin port
MUST NOT add a second external SSE feed.

### 3.5 Role / Config ownership

**Normative:**

- Roles live in pack TOML: `packs/<pack>/roles/<role>.toml`. The
  shape is `[role]` with `name`, `description`, `model`,
  `system_prompt_template`, `tools`, plus optional
  `[[memory_blocks_policy]]` and `[[memory_blocks]]`. See existing
  `packs/gastown/roles/mayor.toml` for the canonical example.
- System-prompt templates live in `packs/<pack>/prompts/<role>-system.md`.
- Inline-persona path uses `packs/<pack>/.letta/agents/<role>.md` with
  YAML frontmatter (`name`, `description`, `tools`, `model`,
  `memoryBlocks`). This is the **legacy inline path** for projects that
  have NOT been bootstrapped onto persistent role agents
  (vibesync-mcz Phase A); persistent role agents own their system
  prompt in the SDK store and the dispatcher does NOT inline persona
  for them.
- Per-project config (pack dir, storage dir, provider kind, parent
  agent id, letta base URL) lives in the `projects` table columns
  (`pack_dir`, `storage_dir`, `provider_kind`, `letta_base_url`,
  `letta_agent_id`). Defaults: `packs/gastown` and
  `/root/.letta/lc-local-backend`. Hardcoded maps
  (`packDirsByProject`, `storageDirsByProject`) are deprecated and
  exist only for tests.
- Feature activation (molecule writeback, work-activity reporter,
  drift audit) goes through `BootOrchestrationPlaneOptions` config,
  not env-var branches in core.

**Incidental — DO NOT PORT:**

- Hardcoded map defaults like `DEFAULT_PACK_DIR = 'packs/gastown'`
  inside `buildRoleAgentContextResolver` (lcp-kamu). The Kotlin port
  reads pack dir from the same `projects.pack_dir` column. The
  constant is a temporary fallback for tests, not a configuration
  default.

### 3.6 Letta Agent SDK / App Server v2 boundary

The Bun reference uses the **official Letta Agent SDK**
(`@letta-ai/letta-code-sdk` for provisioning; HTTP/SSE to the
letta-code local backend for runtime, since the SDK's streaming API
in the current release is not yet complete enough to subsume the
shim path without behavior changes). Provisioning goes through
`RoleAgentBootstrapper.createAgent` (vibesync-1ix).

The Kotlin App Server port provides a **narrow semantic equivalent**
of the runtime layer over REST/App Server v2 — only the operations
needed to satisfy the five `RuntimeProvider` methods. It does NOT
re-implement provisioning; provisioning in the Kotlin world goes
through whatever agent-bootstrap primitive the Iroh App Server exposes
in its v2 surface.

| Surface         | Bun reference today                                                                      | Kotlin port                                                      |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Provisioning    | `@letta-ai/letta-code-sdk.createAgent`                                                   | App Server v2 bootstrap primitive (TBD; jxri.6)                  |
| Session runtime | letta-code HTTP/SSE (`/v1/conversations`)                                                | REST/App Server v2 client (narrow equivalent)                    |
| Wire format     | SSE JSON frames (shim-specific)                                                          | App Server v2 envelope (normalized; schema frozen in `jxri.3`)   |
| Persona         | Inline `packs/<pack>/.letta/agents/<role>.md` OR persistent agent's stored system prompt | Persistent agent's system prompt only (no inline path in Kotlin) |
| Step timeout    | `turnTimeoutMs` extra → AbortController                                                  | App Server v2 step timeout parameter                             |
| Resume          | ConversationId reuse                                                                     | SessionId reuse (semantic equivalent)                            |

**Incidental — DO NOT PORT:**

- The provisioning-via-SDK + runtime-via-shim asymmetry. The Bun
  reference SHOULD collapse to SDK-only once the SDK's streaming
  surface is complete (tracked under `jxri.6`). The Kotlin port MUST
  NOT replicate the asymmetry — it uses ONE path (REST/App Server v2)
  for both provisioning and runtime.

### 3.7 Iroh transport / discovery / auth role

The Kotlin App Server is the runtime layer in the port; **Iroh** is
the transport / discovery / auth plane beneath it.

- **Transport:** Iroh provides NAT-traversing connectivity between
  the App Server and clients (mobile, web, sibling servers). It is
  NOT in the Bun reference today.
- **Discovery:** Iroh node IDs + capability announcement replace
  the hardcoded `http://localhost:3099` URL. Discovery queries return
  App Server capabilities per `jxri.12`.
- **Auth:** Iroh's auth ticket / capability token is the session
  credential. It scopes a session to a specific (project, role,
  conversation) tuple; tokens are minted at session-start and
  revoked at session-stop. Bearer-token auth in the Bun reference
  (the `password` option on `LettaCodeSubagentProvider`) is the
  legacy equivalent and stays there.

**Normative:** The Bun reference does NOT gain Iroh. Iroh is the
Kotlin transport. Cross-implementation discovery uses capability
metadata exposed by both Bun (over its current REST surface) and
Kotlin (over Iroh) — see `jxri.12` for the discovery contract.

**Incidental:** Today, `src/api/routes/...` hardcodes
`http://localhost:3099` (or `process.env.API_URL`). That URL is
incidental to the architecture; the discovery mechanism (jxri.12) is
the normative path. The Bun CLI default of `http://localhost:3099`
is kept for dev convenience.

### 3.8 A2A status — explicitly deferred

A2A (Agent-to-Agent) protocol is **NOT in the core**. It is an
**edge-provider concern** activated only upon named need.

- The core orchestration plane treats agents as opaque providers.
  Two agents collaborating is two `RuntimeProvider` instances and an
  external coordinator, not a core feature.
- `A2UIProvider` (server-side A2UI projection for letta-mobile / web)
  is the only A2*-shaped provider today. It is a server-side renderer,
  not an A2A peer.
- When a real A2A need arises (named requirement, not speculation),
  it is implemented as an `EdgeProvider` plugged into the bus — same
  shape as `ACPProvider` or `A2UIProvider`. The core does NOT change.

**Normative:** No A2A import in core. No A2A types in the
`SessionEvent` union. No A2A capability negotiation in
`SessionSpec.extra`.

### 3.9 Letta Teams adoption / removal lessons

The Letta Teams SDK (`@letta-teams-sdk`) was the original
multi-agent substrate for VibeSync. Its adoption and removal
(vibesync-6zj, vibesync-1ix) are explicit lessons:

| Adopted (kept after removal)                       | Why we kept it                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider abstraction (`RuntimeProvider` interface) | Already had multi-runtime pressure; abstraction was load-bearing.           |
| Role concept + role pack conventions               | Roles as data (TOML), not as code, scaled across gas-town, letta-code, etc. |
| Molecule workflow (root + steps + dep graph)       | Same shape across every runtime we tried; the right level of abstraction.   |
| EventBus-as-observation pattern                    | Cheap to keep; high cost to re-derive later.                                |

| Removed (must not return)                         | Why it had to go                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@letta-teams-sdk/council` for code review        | Code review is owned by `formulas/code-review.toml` driving our own reviewer/coder/tester loop. The SDK's council module imposed a workflow we don't want. |
| `@letta-teams-sdk/init` to populate memory blocks | Role packs in `packs/<name>/roles/*.toml` are the source of truth for memory. The SDK's built-in init prompts got in the way and were overridden anyway.   |
| Teams' task-graph / dep semantics                 | Formulas (`src/orchestration/formula/`) and molecules (`.beads/` rows) own dep graphs, retry, and `wait_for`. Two graph models would conflict.             |
| Second path to `@letta-ai/letta-code-sdk`         | `LettaCodeSubagentProvider` is the local-backend convergence point; a second path would split behavior.                                                    |

**Lesson (normative):** Provider-coupling debt takes years to extract.
Gas Town accumulated two years of role-hardcoding debt before
extracting Gas City. VibeSync skips the cost by enforcing rule 5 from
day one. We commit in writing to the same posture for any future
provider SDK adoption: the integration is reviewed against the five
invariants BEFORE any code lands.

### 3.10 One-distribution target with strict module separation

**Normative:**

- VibeSync ships **one binary** per implementation language:
  `vibesync` (Bun, today) and `vibesync-app-server` (Kotlin, future).
- The single binary's module boundaries inside `src/orchestration/`
  mirror the layering invariants: `boot` → `dispatcher` → `formula`,
  `molecule`, `events`, `health`, `packs`, `runtime`, `store`.
- No module imports upward (rule 1). No module reaches into another
  module's internal state — public types only.
- The Bun binary is the reference implementation for the Kotlin
  binary's behavior. They MUST emit equivalent `SessionEvent`
  streams under equivalent inputs (verified by the shadow harness in
  `jxri.9` / `jxri.13`).

**Incidental:** The legacy `manage-agents.js`, `migrate-agents-*.js`,
and `compare-agents.js` scripts in the repo root are tooling glue
around the SQLite registry. They will be removed as the legacy
registry migrates to Beads.

### 3.11 Shadow / canary / rollback

Three rollout strategies pin the path from "Kotlin runs in parallel"
to "Kotlin is authoritative":

1. **Shadow (`jxri.13`).** The Kotlin executor runs in parallel with
   the Bun executor. Same inputs, captured deterministically. Outputs
   are compared semantically (formula parse, plan, readiness, transition
   validity) and by performance (latency, token usage, error rate).
   No double-dispatch, no double-mutation. Mismatch → alert; per-
   capability authority flag gates cutover.
2. **Canary (`jxri.17`).** Bounded subset of real projects, behind a
   feature flag. Auto-rollback on regression thresholds. Sustained
   dogfood evidence accumulates over the canary window.
3. **Rollback.** Dolt history + git tags + `bun.lock` are the rollback
   substrate. To roll back, check out the previous reference-release
   tag, `bun install`, `bd dolt pull` to the prior Dolt commit, restart.
   The Kotlin binary, once shipped, rolls back by flipping the
   feature flag — no live migration is required, and none is supported.

**Reference-release gate (`jxri.14`):** The Kotlin port MAY NOT be
marked authoritative until `jxri.14` closes. The gate's acceptance
criteria (clean-room runner reproduces corpus; no severity-1/2
findings; sustained dogfood / performance thresholds; rollback
runbook rehearsed) are the binary go/no-go for letting
`letta-mobile-gx6ri` and other downstream consumers cut over.

### 3.12 Compatibility & rollback policy

| Concern                            | Policy                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RuntimeProvider v2 contract        | Stable within a reference release (tagged `vx.y.z`). Behavior changes require a new reference release.                               |
| SessionEvent wire shape            | Frozen in `jxri.3` (versioned schemas). Adds require a new event-kind version.                                                       |
| SessionSpec.extra keys             | Each provider documents accepted keys. Removing a documented key is a breaking change for that provider.                             |
| Beads schema                       | Migration path through `bd`'s migration; runtime beads follow `docs/architecture/bd-conventions.md`.                                 |
| Pack TOML                          | Schema is additive; removing a key requires a deprecation cycle through at least one reference release.                              |
| `provider_kind='letta-teams'` rows | Treated as removed configuration; warn-and-fall-back to boot-level local backend. Migration shim planned under `jxri.6`.             |
| `vibesync.db` SQLite registry      | Read-only access; new domain state goes in `bd`. Final removal planned under `jxri.6` once all readers migrate.                      |
| Bun ↔ Kotlin divergence            | Kotlin authority OFF until `jxri.14`. Until then, Bun is authoritative; Kotlin is shadow-only.                                       |
| Reference release cadence          | At least one reference release per epic-quarter. Hot-fix releases allowed for severity-1 regressions under `jxri.14` change control. |

---

## 4. Normative vs Incidental behavior (comprehensive table)

| Behavior                                                                                                                      | Class                        | Notes / bead                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five layering invariants                                                                                                      | **Normative**                | `AGENTS.md`; load-bearing.                                                                                                                                                    |
| `RuntimeProvider` five-method contract                                                                                        | **Normative**                | `src/orchestration/runtime/provider.ts`                                                                                                                                       |
| `SessionEvent` discriminated union + unknown-kind pass-through                                                                | **Normative**                | Same.                                                                                                                                                                         |
| `SessionHandle` opaque, provider-local                                                                                        | **Normative**                | Same.                                                                                                                                                                         |
| Beads as universal persistence                                                                                                | **Normative**                | `AGENTS.md` rule 2; `docs/architecture/bd-conventions.md`.                                                                                                                    |
| EventBus as universal observation                                                                                             | **Normative**                | `AGENTS.md` rule 3; `src/orchestration/events/bus.ts`.                                                                                                                        |
| Config activation (presence in `BootOrchestrationPlaneOptions`)                                                               | **Normative**                | `AGENTS.md` rule 4.                                                                                                                                                           |
| Zero hardcoded roles in core                                                                                                  | **Normative**                | `AGENTS.md` rule 5.                                                                                                                                                           |
| Role TOML schema (`[role]`, `[[memory_blocks_policy]]`, `[[memory_blocks]]`)                                                  | **Normative**                | `packs/gastown/roles/*.toml`.                                                                                                                                                 |
| Inline persona path (`packs/<pack>/.letta/agents/<role>.md`)                                                                  | **Normative**                | Legacy bootstrap path; persistent-agent path is also normative.                                                                                                               |
| Persistent role-agent path (`project_role_agents` table + AgentIdResolver)                                                    | **Normative**                | vibesync-mcz Phase C.                                                                                                                                                         |
| Per-step `turnTimeoutMs` via `SessionSpec.extra`                                                                              | **Normative**                | AbortController / step-timeout parameter; consistent across runtimes.                                                                                                         |
| ConversationId resume                                                                                                         | **Normative**                | Resume is part of the contract; survives session restart.                                                                                                                     |
| `first-token` event deduplication (one per session turn)                                                                      | **Normative**                | Avoids spammy observability on multi-tool-call turns.                                                                                                                         |
| `stop_reason='requires_approval'` non-terminal handling (Bun)                                                                 | **Normative**                | The CONTRACT (don't end a turn on requires_approval) is normative. The shim parsing detail is incidental.                                                                     |
| `WorkActivityReporter` subscribes to EventBus (Bun)                                                                           | **Normative**                | Mobile active-subagent bar.                                                                                                                                                   |
| **PM puppet-message scaffold** (`[ORCHESTRATION_SUBAGENT_DISPATCH]`, `buildPuppetMessage`, `<<<TASK_PROMPT_BEGIN>>>` markers) | **Incidental — DO NOT PORT** | Workaround for letta-code SDK 0.25.11 missing custom subagent discovery (vibesync-s28).                                                                                       |
| **SSE line-by-line parser** in `consumeSseBody`                                                                               | **Incidental — DO NOT PORT** | Shim-specific. Kotlin uses structured streaming client.                                                                                                                       |
| **`tool_return_message` → `assistant_message` fallback**                                                                      | **Incidental — DO NOT PORT** | Bridges shim version drift in event shape. REST/App Server v2 is normalized.                                                                                                  |
| **Auto-heal phantom PM agent refs** (`ensureParentAgentExists`)                                                               | **Incidental — DO NOT PORT** | Recovery for shim store inconsistency. lcp-mj0h. Kotlin REST/App Server v2 doesn't have the same drift surface.                                                               |
| **`requires_approval` parsing detail** (treat as non-terminal, wait for end_turn)                                             | **Incidental — DO NOT PORT** | The contract is normative (don't end on requires_approval). The parser detail is bypassPermissions-mode-specific (lcp-ltrf). Kotlin doesn't need the bypassPermissions dance. |
| **`provider_kind='letta-teams'` rows**                                                                                        | **Incidental — DO NOT PORT** | Removed legacy; warn-and-fall-back. Don't bring back the SDK.                                                                                                                 |
| **`vibesync.db` SQLite registry tables**                                                                                      | **Incidental — DO NOT PORT** | Legacy; migrate to `bd`. No new domain state in SQLite.                                                                                                                       |
| **Provisioning-via-SDK + runtime-via-shim asymmetry**                                                                         | **Incidental — DO NOT PORT** | Will collapse to SDK-only in Bun (`jxri.6`). Kotlin uses one path.                                                                                                            |
| **`buildDefaultRuntimeProvider` env-var branches in `boot.ts`**                                                               | **Incidental — DO NOT PORT** | Boot wiring choice; dispatcher MUST NOT read env vars directly.                                                                                                               |
| **`DEFAULT_PACK_DIR = 'packs/gastown'` constant**                                                                             | **Incidental**               | Test fallback; production reads `projects.pack_dir`.                                                                                                                          |
| **Direct `WorkActivityReporter` subscription to shim SSE**                                                                    | **Incidental**               | Legacy projection; normative path is bus-fed.                                                                                                                                 |
| **Hardcoded `http://localhost:3099` URL**                                                                                     | **Incidental**               | Dev default; discovery (jxri.12) is normative.                                                                                                                                |

---

## 5. Explicit non-goals

The following are **out of scope** for VibeSync reference and the
Kotlin port. Naming them here so future contributors do not propose
them as scope creep:

1. **Reintroducing `letta-teams-sdk`** or any second provider SDK
   (`vibesync-6zj`; `AGENTS.md` rule).
2. **Adding a second Letta Code path** alongside
   `LettaCodeSubagentProvider` (rule: extend the existing provider).
3. **Hardcoding role names in core TypeScript** (rule 5).
4. **Bypassing the EventBus for cross-layer visibility** (rule 3).
5. **Putting role memory blocks, conversation IDs, or A2UI capability
   negotiation inside the `RuntimeProvider` interface**.
6. **A2A protocol support in core**. A2A is an edge-provider concern
   activated only upon named need.
7. **Direct service-to-service runtime calls that bypass the
   `RuntimeProvider` seam**.
8. **Live migration from Bun to Kotlin**. The Kotlin binary starts
   fresh; Bun is the reference. Authority flips when `jxri.14` closes.
9. **Iroh in the Bun reference**. Iroh is the Kotlin transport; Bun
   keeps its local-backend HTTP/SSE surface.
10. **Auto-porting the PM puppet-message scaffold**. The Kotlin
    narrow equivalent talks to REST/App Server v2 directly and does
    NOT need the workaround.
11. **Tightly coupling to a specific SDK version**. The `RuntimeProvider`
    interface absorbs SDK churn; providers translate at the seam.

---

## 6. Cross-repo implications

- **letta-mobile-gx6ri.** Its ADR MUST cite this ADR as prerequisite
  evidence before cutting over to Kotlin authority. The dependency is
  tracked by reciprocal Beads comments because Beads relation edges
  are repository-local.
- **letta-MCP-server.** May consume the EventBus surface and the
  `RuntimeProvider.kind='letta-code-subagent'` discriminator but MUST
  NOT import from `src/orchestration/` directly. The MCP server talks
  to VibeSync via its public HTTP/CLI surface; internal coupling is
  a defect.
- **letta-code / letta-code-sdk.** VibeSync consumes the SDK as a
  black box. SDK shape changes are absorbed at the `RuntimeProvider`
  seam (Bun) or REST/App Server v2 client (Kotlin).

---

## 7. Acceptance

This ADR closes (`vibesync-jxri.1` status → closed) when:

- [x] This document exists at `docs/architecture/ORCHESTRATION_OWNERSHIP_ADR.md`.
- [x] Normative vs incidental table is reviewed and accepted.
- [x] Compatibility / rollback policy is reviewed.
- [x] Explicit non-goals are listed.
- [ ] Linked from `AGENTS.md` layering-invariants section (follow-up `chore/jxri-1-link-from-agents-md`).
- [ ] Cited from `jxri.2`, `jxri.3`, `jxri.6`, `jxri.10.4`, and `jxri.13` (follow-up
      cross-references added by those beads).
- [ ] Reviewed by Meridian.
- [ ] Reciprocal note posted in `letta-mobile-gx6ri` citing this ADR
      (coordination via Beads comments; not this repo's job).

The remaining acceptance items are tracked under this bead's
"open questions" section below until closed.

---

## 8. Open questions

1. **Does the bun runtime path collapse to `@letta-ai/letta-code-sdk`-only?**
   Tracked under `jxri.6`. If yes, `LettaCodeSubagentProvider` is
   rewritten against the SDK's streaming surface and the shim is no
   longer the runtime transport. The Kotlin port's REST/App Server v2
   client is unaffected (different runtime entirely).
2. **Does the molecule writeback hook need an explicit
   `provider_kind` discriminator on the molecule_root metadata?**
   Tracked under `jxri.3`. Current implementation assumes a single
   active provider per molecule; cross-provider handoff is not yet
   defined.
3. **Should the boot-level default provider be selectable via
   `projects.provider_kind='default'`?** Today the boot-level default
   is the `letta-code-subagent` fallback. A `default` sentinel row
   would let operators pin the boot provider without code edits.
   Tracked under `jxri.6`.
4. **What's the Iroh capability announcement schema for VibeSync?**
   Tracked under `jxri.12`. Until that's pinned, the Kotlin port
   can't advertise its surface to mobile / web clients.

---

## 9. References

- `AGENTS.md` — five invariants, runtime provider discipline,
  BookStack convention, session completion workflow.
- `docs/architecture/gastown-orchestration.md` — current architecture
  shape, RuntimeProvider interface preamble, formula/molecule model,
  non-goals.
- `docs/architecture/bd-conventions.md` — Beads as universal persistence;
  type discriminator; runtime vs human type sets; sidecar conventions;
  retention.
- `docs/architecture/gastown-role-catalog.md` — role catalog and the
  rationale for keeping roles in packs (rule 5 lineage).
- `docs/architecture/FRAMEWORK_DECISION.md` — predecessor decision
  document format (informal reference).
- `src/orchestration/runtime/provider.ts` — `RuntimeProvider` interface
  (frozen contract).
- `src/orchestration/runtime/letta-code-subagent-provider.ts` — Bun
  reference implementation; documents the shim workarounds that are
  classified as incidental in §4.
- `src/orchestration/boot.ts` — `bootOrchestrationPlane` and the
  per-project provider resolver; the boot-level wiring.
- `src/orchestration/events/bus.ts` — `EventBus` (canonical
  observation substrate).
- `src/orchestration/health/patrol.ts` — `HealthPatrol` (deacon
  pattern, not a role).
- `src/letta/RoleAgentBootstrapper.ts` — provisioning via SDK
  (vibesync-1ix).
- `packs/gastown/roles/{mayor,coder,reviewer,tester,refinery}.toml` —
  role TOML canonical examples.
- `packs/gastown/.letta/agents/<role>.md` — inline persona path
  (legacy bootstrap).
- `packs/gastown/prompts/<role>-system.md` — system-prompt templates.
- `packs/gastown/formulas/{code-review,onboard-feature,refinery-sweep}.toml`
  — formula canonical examples.
- Gas City: https://github.com/gastownhall/gascity — role-as-data
  discipline; MEOW stack.
- Gas Town: https://github.com/steveyegge/gastown — origin patterns.
- A2UI protocol: https://a2ui.org · https://github.com/google/A2UI —
  projection reference (NOT in core).
- Beads epic: `vibesync-jxri`.
- Companion beads: `vibesync-jxri.2`, `.3`, `.6`, `.7`, `.10.4`, `.12`,
  `.13`, `.14`, `.16`, `.17`.
- Downstream ADR: `letta-mobile-gx6ri` (cross-repo; prerequisite
  evidence for Kotlin authority cutover).

---

**Document Version:** 1.0
**Status:** Proposed
**Created:** 2026-07-14
**Authors:** PM-vibesync (vibesync-jxri.1)

<!-- VIBESYNC:adr:END -->
