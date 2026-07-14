<!-- VIBESYNC:adr:START -->

# ADR-0001 — VibeSync Orchestration Ownership & Kotlin Migration Boundary

| Field           | Value                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR ID          | 0001                                                                                                                                                               |
| Title           | Orchestration Ownership & Kotlin Migration Boundary                                                                                                                |
| Status          | Proposed (revised 2026-07-14 after REQUESTED CHANGES on commit 94fc8bc8)                                                                                           |
| Revision of     | 94fc8bc8fdcb4aaff3daf431df974eb54accd8b4 (initial ADR delivery)                                                                                                    |
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

## 0. Revision log

| Rev | Date       | SHA-prefix | Author      | Reason                                                                                                              |
| --- | ---------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-07-14 | `94fc8bc8` | PM-vibesync | Initial ADR delivery                                                                                                |
| 2   | 2026-07-14 | (this rev) | PM-vibesync | REQUESTED CHANGES from Meridian review of 94fc8bc8. Each numbered CHANGE is addressed below in §11 with the source. |

---

## 1. Context

VibeSync's orchestration plane has accumulated two years of
multi-agent patterns sourced from Gas Town, the Letta Teams SDK, and
the letta-code local backend. The `vibesync-jxri` epic exists to
finalize that plane as a **versioned executable reference** before
any Kotlin port may become authoritative. This ADR is the first
deliverable of that epic: the boundary contract.

Five forces drive the boundary:

1. **Five layering invariants** pinned in `AGENTS.md` and now load-bearing
   for both Bun and Kotlin paths.
2. **A second runtime path** (Kotlin App Server, single distribution
   target — Bun is the temporary reference and is retired after
   parity/rollback gates) that needs semantic equivalence without
   duplicating provider-specific debt.
3. **A clean release gate** (`jxri.14`) that downstream consumers
   (notably `letta-mobile-gx6ri`) treat as prerequisite evidence before
   cutting Kotlin over to authority.
4. **Cutover shape**: strangler/shadow with shared authoritative
   Beads/Dolt, endpoint/capability cutover, canary, rollback —
   not a fresh start or live migration.
5. **Current legacy persistence**: `projects` and `project_role_agents`
   tables still live in legacy SQLite `vibesync.db`. This ADR pins the
   migration target (Beads/Dolt authority) and acknowledges the
   current state.

The default branch is `main`, currently at `ce1f4e9` on
`feat/qk4a-github-pr-feedback-webhook`. This ADR is authored on a
fresh isolated worktree `docs/jxri-1-orchestration-ownership-adr`
branched from `origin/main` so the dirty primary checkout
(`feat/qk4a-github-pr-feedback-webhook` mid-rebase) is not disturbed.

---

## 2. Five Invariants (pinned verbatim from `AGENTS.md`)

These five rules are defects to violate even if the code appears to
work. Both Bun and Kotlin implementations MUST preserve them.

| #   | Invariant                                           | One-line test                                                                                                                                                                                                                            |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No upward dependencies**                          | Layer N never imports Layer N+1. `src/orchestration/runtime/` MUST NOT import `src/orchestration/formula/`; `formula/` MUST NOT import `dispatcher/`; lower layers call back through interfaces only.                                    |
| 2   | **Beads is the universal persistence substrate**    | All NEW domain state (human work + runtime work) goes through `bd`. Legacy `vibesync.db` SQLite registry is migration-bound; existing rows are migrated lazily as code paths get touched. No new domain state is added to legacy tables. |
| 3   | **EventBus is the universal observation substrate** | All cross-layer visibility goes through the bus. No direct status polling; no reading another layer's internal state.                                                                                                                    |
| 4   | **Config is the universal activation mechanism**    | Features turn on via config presence. Branches on env vars in core code are a smell; gate activation through project config.                                                                                                             |
| 5   | **Zero hardcoded roles**                            | No `if (role === "reviewer")` in core TypeScript/Kotlin. Roles live in pack TOML + prompt templates. `LettaConfig.controlAgentName` is the one tolerated escape hatch.                                                                   |

---

## 3. Decision

### 3.1 Controller vs Runtime ownership (REVISED)

This section was the source of REQUESTED CHANGES #1. The previous
draft conflated "controller" with the persistent PM agent; that is
not how the Letta App Server model works. The correct delineation is:

| Term                      | What it actually is                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Server** (process)  | A running Letta Code runtime process. One per host (or per container). Owns the Letta Code CLI subprocess and the on-disk agent store.                          |
| **Control session**       | The authenticated websocket session between a trusted client and the App Server. Issues `runtime_start`, `input`, and stream frames. Bound to a single client.  |
| **Controller**            | The trusted application/client that HOLDS the App Server control session. VibeSync's dispatcher / formula layer acts as a controller (one per control session). |
| **PM agent**              | A Letta agent identity inside the App Server. Has its own state, memory blocks, and conversation history. Outlives any single control session.                  |
| **Role agent / subagent** | A Letta agent identity spawned by the controller for a specific role (coder, reviewer, etc.). Created via the SDK; conversations scoped to that role.           |

**Normative rules (revised):**

1. **One active control session per App Server process.** The App
   Server is single-tenant at the control plane: opening a second
   control session while one is active is invalid and the App Server
   is permitted to reject the second connection. This is a
   control-plane invariant of the Letta Code websocket protocol.
2. **Controller ≠ PM agent.** A controller is a client; a PM agent
   is a Letta agent. They are different kinds of identity. The same
   PM agent may be reached across many control sessions; the same
   controller may drive many PM agents over its single control
   session.
3. **A control session does NOT require creating a new PM agent.**
   Creating a PM is a deliberate provisioning step that may happen
   before, during, or after a control session exists. Provisioning is
   orthogonal to control-plane lifecycle.
4. **Observer fanout is independent of control sessions.** The
   EventBus emits per molecule-step / per turn / per session event.
   Multiple observers (dispatcher subscriber, TUI, mobile projection,
   audit log) consume the same bus stream. Observers are
   subscribers, not control-session peers.
5. **DispatchInput carries `parentAgentId` (PM identity) and a
   control-session-scoped run token.** The run token is the
   dispatcher-minted proof that the dispatcher is the active
   controller for this control session; the PM identity is the
   Letta agent the controller drives.

**Incidental (current Bun code):**

- `LettaCodeSubagentProvider` is the closest Bun analog to a
  control session: each `start()` opens a per-step session over the
  local letta-code shim, with the parent agent acting as the PM
  identity. The terminology differs but the shape is correct.
- The shim's bearer-token auth is a placeholder for what becomes
  capability-token auth at the App Server layer in the Kotlin port.
  The Bun reference does not need to match capability tokens today.

### 3.2 RuntimeProvider v2 seam (REVISED — contract ownership moved to jxri.5)

REQUESTED CHANGES #2: the prior draft declared RuntimeProvider v2
"frozen" before its versioned contract was authored. This ADR pins
**the seam and the ownership**, NOT the contract. The contract is
versioned and finalized by `vibesync-jxri.5`. Concretely:

**Normative at this ADR (seam ownership):**

- `src/orchestration/runtime/provider.ts` is the orchestration plane's
  single session-management seam. Higher layers do not import any
  provider-specific module directly.
- The seam is **additive**: every implementation MUST implement the
  five canonical methods (`start`, `stop`, `prompt`, `nudge`,
  `observe`) and MUST honor the `SessionHandle` opaque-handle
  discipline. The handle's `providerKind` field is the routing key.
- The seam MUST NOT widen to include role-specific knowledge
  (memory-block mutation, conversation forking, A2UI negotiation,
  capability-token issuance). Those belong in provider-specific
  extensions (typed start-spec config, dedicated services called by
  the provider) or above the seam in formulas / role config.

**Deferred to jxri.5 (contract versioning):**

- The exact shape of `SessionSpec.extra` and which keys each provider
  documents. Until `jxri.5` lands, `extra` is **incidental**; new
  call sites MUST use typed contracts (e.g., `PersistentAgentPath`,
  `ConversationId`, `TurnTimeout`) that jxri.5 versions explicitly.
- The exact `SessionEvent` schema, including discriminator names and
  payload shapes. Until `jxri.5`, events are observed opaquely.
- Wire-format stability guarantees (which `kind` values are stable
  across a reference release, which can be added without bumping).

**Removed claim from prior draft:** Do NOT promise that Kotlin will
honor `SessionSpec.extra` key-for-key. The new contract is typed
extensions; the incidental `extra` map is compatibility only and
Kotlin is not bound to it.

**Kotlin narrow semantic equivalent:**

- Kotlin implements the same five-method seam.
- The typed extension contracts that jxri.5 pins are the wire-level
  surface. The Kotlin implementation translates them to the official
  Letta Agent SDK calls (Bun-side) and to Letta REST/OpenAPI +
  App Server v2 calls (Kotlin-side).
- Adapter classes (ACP, A2UI, A2A) sit **behind** the `RuntimeProvider`
  seam — they are implementations, not parallel surfaces plugged into
  EventBus. The ADR does not name an `EdgeProvider` interface
  because no such interface exists in this codebase today.

### 3.3 Beads / Dolt authority (REVISED — current vs target)

REQUESTED CHANGES #9: the prior draft's §3.3 implied all current
domain state already lives in Beads. It does not. The current
persistence substrate is **mixed**:

**Current state (acknowledged legacy):**

| Surface                                                                                                                                | Substrate                   | Owner                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `projects` (registry rows, including `provider_kind`, `letta_base_url`, `letta_agent_id`, `pack_dir`, `storage_dir`, `beads_remote_*`) | Legacy SQLite `vibesync.db` | `src/database.ts` `Projects` ORM          |
| `issues` (Huly/Vibe sync mirror)                                                                                                       | Legacy SQLite `vibesync.db` | `src/database.ts`                         |
| `project_role_agents` (per-project, per-role Letta agent ids)                                                                          | Legacy SQLite `vibesync.db` | `src/database.ts` `roleAgents` repository |
| Beads issue rows (`vibesync-*`)                                                                                                        | Dolt (via `bd`)             | Beads                                     |
| Beads molecule rows (runtime work)                                                                                                     | Dolt (via `bd`)             | Beads                                     |

**Migration target (this ADR's normative claim):**

- Beads is the **universal persistence substrate** for both
  human-curated work and runtime orchestration work.
- New domain state MUST go through `bd` (`molecule_root`,
  `molecule_step`, future `mail`, and typed human work via
  `bd create`). No new domain state is added to the legacy
  `vibesync.db` tables.
- Migration of the legacy rows is tracked by:
  - **`vibesync-jxri.2`** — inventory of observable contracts and
    migration debt (the inventory of `projects` /
    `project_role_agents` columns to be moved to Beads)
  - **`vibesync-jxri.6`** — modernize Letta runtime provider and
    retire the legacy SQLite registry; this bead is the migration
    executor.
- During cutover, both surfaces coexist. The Kotlin port reads
  per-project routing from Beads (via the dispatcher-resolver seam),
  not from legacy SQLite, from the first release that ships.

**Normative (this ADR):**

- The layering invariant #2 ("Beads is the universal persistence
  substrate") applies to NEW state. Legacy state is migrated lazily
  and explicitly, not extended.
- Schema migrations still go through `bd`'s migration path so the CLI
  stays compatible with whatever shape the daemon writes.
- Dolt history is the rollback substrate. Every reference release is
  tagged in git AND committed to Dolt so `bd dolt pull` recovers
  state.

**Incidental (do not replicate):**

- Legacy SQLite tables (`projects`, `issues`, `project_role_agents`,
  `sync_history`, `project_files`, `sync_metadata`). Migrate to
  Beads; do not add new domain state to them and do not port them to
  Kotlin.

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
secondary subscription to the letta-code shim's
`/v1/agents/<id>/messages/stream` SSE for the mobile active-subagent
bar. That second subscription is provider-specific and is NOT the
normative observation path. The normative path is `EventBus →
WorkActivityReporter`. The Kotlin port MUST NOT add a second external
SSE feed.

### 3.5 Role / Config ownership (REVISED — inline persona demoted)

REQUESTED CHANGES #7: inline persona path is compatibility/incidental,
not the final Kotlin behavior.

**Normative at this ADR:**

- Roles live in pack TOML: `packs/<pack>/roles/<role>.toml`. The
  shape is `[role]` with `name`, `description`, `model`,
  `system_prompt_template`, `tools`, plus optional
  `[[memory_blocks_policy]]` and `[[memory_blocks]]`. See existing
  `packs/gastown/roles/mayor.toml` for the canonical example.
- System-prompt templates live in
  `packs/<pack>/prompts/<role>-system.md`.
- **Persistent role agents** (the Letta agent created via
  `RoleAgentBootstrapper.createAgent` and stored in
  `project_role_agents`) own their system prompt in the SDK store.
  The controller drives them via `agent_id` and MUST NOT inline
  persona for them. This is the **normative Kotlin target** and the
  preferred Bun path.
- Per-project config (pack dir, storage dir, provider kind, parent
  agent id, letta base URL) lives in the `projects` table columns
  today (legacy) and will live in Beads after migration (jxri.6).
  Defaults: `packs/gastown` and `/root/.letta/lc-local-backend`.
- Feature activation (molecule writeback, work-activity reporter,
  drift audit) goes through `BootOrchestrationPlaneOptions` config,
  not env-var branches in core.

**Compatibility / incidental — inline persona:**

- Inline persona via `packs/<pack>/.letta/agents/<role>.md` is the
  **compatibility path** for projects whose role agent has not been
  bootstrapped yet (vibesync-mcz Phase C). The provider inlines the
  persona into the puppet prompt when `agentId` is null.
- This path exists to support legacy Letta Code SDK 0.25.11 that did
  not discover custom subagent types. It is **incidental** —
  documented in `LettaCodeSubagentProvider` (vibesync-s28) and
  retained for back-compat only.
- Kotlin port: the **inline persona path does not exist**. Kotlin
  uses persistent role agents exclusively, with persona / system
  prompt owned by the agent identity inside the App Server.

**Incidental — DO NOT PORT:**

- Hardcoded map defaults like `DEFAULT_PACK_DIR = 'packs/gastown'`
  inside `buildRoleAgentContextResolver` (lcp-kamu). The Kotlin port
  reads pack dir from the same column (legacy today; Beads post-`jxri.6`).
  The constant is a temporary fallback for tests, not a configuration
  default.

### 3.6 Letta Agent SDK / App Server v2 boundary (REVISED — exact Letta boundary)

REQUESTED CHANGES #3: the prior draft conflated REST with App Server
and invented a TBD App Server provisioning primitive. The corrected
boundary per the official Letta Agent SDK README
(`@letta-ai/letta-agent-sdk`) and the Letta Code / App Server
documents:

**Official packages (verified against npm registry 2026-07-14):**

| Package                             | Status                            | Purpose                                                                                    |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `@letta-ai/letta-agent-sdk` (0.2.6) | **Current official SDK**          | "SDK for programmatic control of Letta agents" — depends on `@letta-ai/letta-code` 0.27.30 |
| `@letta-ai/letta-code-sdk` (0.2.1)  | **DEPRECATED compatibility shim** | npm package description: "Deprecated compatibility shim for @letta-ai/letta-agent-sdk"     |
| `@letta-ai/letta-code` (0.28.7)     | Letta Code CLI                    | The CLI/runtime that the Agent SDK drives                                                  |
| `@letta-ai/letta-client` (1.12.1)   | **Letta REST/OpenAPI client**     | Official TypeScript library for the Letta API (V1 REST surface)                            |

The current VibeSync `package.json` pins the **deprecated shim**
(`@letta-ai/letta-code-sdk ^0.1.14`). Migration to
`@letta-ai/letta-agent-sdk` is tracked under `vibesync-jxri.6`.

**Exact Letta boundary per the official SDK README:**

| Concern                           | Surface                                     | Examples                                                |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| Agent provisioning / lifecycle    | **REST/OpenAPI** (`@letta-ai/letta-client`) | `client.createAgent`, identity, persona, memory blocks  |
| Conversation lifecycle            | **REST/OpenAPI** (`@letta-ai/letta-client`) | `client.resumeSession`, conversation metadata           |
| Execution / stream / sync / abort | **App Server v2** (websocket protocol)      | `runtime_start`, `input`, streaming deltas, sync, abort |
| Transport identity / reachability | App Server over loopback or remote          | Capability-token auth for non-loopback                  |

The prior draft incorrectly claimed "App Server v2 bootstrap
primitive" for provisioning. **There is no such primitive.** Agent
provisioning is REST/OpenAPI; App Server is execution. The prior
draft also conflated REST and App Server under one "REST/App Server
v2" surface — they are distinct surfaces with distinct protocols.

**Bun reference (this ADR's normative claim for today):**

- **Provisioning path**: Use `@letta-ai/letta-agent-sdk`
  (`createAgent`) for new code. The existing
  `RoleAgentBootstrapper` import of the deprecated
  `@letta-ai/letta-code-sdk` is migration-bound under `jxri.6`.
- **Runtime path**: The Bun reference today uses HTTP/SSE to the
  letta-code local backend (the shim). Per the Agent SDK README,
  the SDK also exposes a websocket transport (`backend: "remote"`).
  Migration to SDK-direct websocket transport is tracked under
  `jxri.6`. Until then, the shim is the de-facto runtime transport
  — incidental, not normative.
- **REST/OpenAPI surface**: `@letta-ai/letta-client` for any direct
  REST call (already used in `src/LettaService.ts`).

**Kotlin semantic adapter (revised):**

The Kotlin App Server port provides a narrow semantic equivalent of
the runtime layer. It uses **two distinct surfaces**:

| Concern                           | Kotlin surface                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Agent / conversation lifecycle    | **Letta REST/OpenAPI** semantic adapter (mirrors `@letta-ai/letta-client` semantics)                                           |
| Execution / stream / sync / abort | **App Server v2** semantic adapter (mirrors the websocket protocol exposed by `@letta-ai/letta-agent-sdk` `backend: "remote"`) |

The Kotlin adapter does NOT need the Bun shim's PM puppet-message
scaffold (workaround for SDK 0.25.11). It does NOT need the
SSE line-by-line parser. It does NOT need the
`tool_return_message → assistant_message` fallback. Those are all
incidental artifacts of the Bun shim path.

**The Kotlin App Server distribution itself** (the binary the
dispatcher drives) uses the official Letta App Server runtime under
the hood. The Kotlin binary is a controller that holds an App Server
control session — it does not reimplement the Letta runtime.

### 3.7 Iroh transport / discovery / auth role (REVISED — capability tokens layered over Iroh)

REQUESTED CHANGES #4: the prior draft asserted Iroh carries domain
authorization. It does not. Iroh is transport identity/reachability;
domain authorization is controller-owned.

**Normative:**

| Layer                   | Owner / Mechanism                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Transport identity      | **Iroh node IDs / tickets** — peer identity for NAT-traversing connectivity                             |
| Reachability            | **Iroh** — connection establishment between peers                                                       |
| Domain authorization    | **Controller-owned signed capabilities**, layered over Iroh transport                                   |
| App Server session auth | **Capability token** minted by the App Server / controller (`authToken` per the Letta Agent SDK README) |

**Authority layering (top to bottom):**

1. **Capability token** — issued by the controller (or App Server)
   to a client. Scoped to (project, role, conversation, expiry). The
   token is what the App Server validates on websocket connect.
2. **Iroh transport** — provides the authenticated connection
   between the client and the App Server. The App Server's
   `--ws-auth` mode validates the capability token; Iroh just
   delivers the bytes.
3. **Capability schema** — the format and signing scheme of
   capability tokens. **This schema does not yet exist as
   "Iroh behavior" and is not asserted by this ADR.** It is owned
   downstream: `vibesync-jxri.12` (discovery) and `vibesync-jxri.13`
   (shadow / differential harness) define the wire shape and
   signing scheme as part of their acceptance criteria.

**Incidental (current code, do not port verbatim):**

- `VIBESYNC_LETTA_CODE_SHIM_URL` / `LETTA_CODE_SHIM_URL` /
  `VIBESYNC_LETTA_CODE_PARENT_AGENT_ID` / `LETTA_CODE_PASSWORD` env
  vars are Bun-shim wiring. The Kotlin port uses capability tokens
  over Iroh; the env-var boot wiring is incidental.
- Hardcoded `http://localhost:3099` URL in the Bun CLI is a dev
  default. Discovery (`jxri.12`) is the normative path.

### 3.8 A2A, ACP, A2UI status — adapters behind RuntimeProvider (REVISED)

REQUESTED CHANGES #8: the prior draft described an `EdgeProvider`
plugged into EventBus. There is no such interface today; removing
that vocabulary.

**Normative:**

- `A2A`, `ACP`, and `A2UI` are **adapters / providers** — they are
  implementations of the `RuntimeProvider` seam (or service modules
  called by an implementation), NOT a parallel surface plugged into
  EventBus directly.
- `A2UIProvider` (`src/orchestration/runtime/a2ui-provider.ts`) is a
  server-side projection for letta-mobile / web UI. It implements the
  `RuntimeProvider` seam (or is called by a provider that does). It
  is NOT an `EdgeProvider`.
- `ACPProvider` is JSON-RPC over stdio for subprocess-backed
  runtimes. It implements the seam.
- `A2A` (Agent-to-Agent) protocol support is **not in core**. It
  becomes an implementation of the `RuntimeProvider` seam when
  there is a named need; until then, it does not exist.

**What this ADR does NOT add:**

- No `EdgeProvider` interface. None exists in the codebase.
- No "plug into EventBus" pattern for adapters — adapters plug into
  the RuntimeProvider seam, and the seam's events flow through
  EventBus as already pinned by §3.4.

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

| Removed (must not return)                         | Why it had to go                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@letta-teams-sdk/council` for code review        | Code review is owned by `formulas/code-review.toml` driving our own reviewer/coder/tester loop. The SDK's council module imposed a workflow we don't want.                                                                                                                                               |
| `@letta-teams-sdk/init` to populate memory blocks | Role packs in `packs/<name>/roles/*.toml` are the source of truth for memory. The SDK's built-in init prompts got in the way and were overridden anyway.                                                                                                                                                 |
| Teams' task-graph / dep semantics                 | Formulas (`src/orchestration/formula/`) and molecules (`.beads/` rows) own dep graphs, retry, and `wait_for`. Two graph models would conflict.                                                                                                                                                           |
| Second path to `@letta-ai/letta-code-sdk`         | `LettaCodeSubagentProvider` is the local-backend convergence point; a second path would split behavior. **And:** `@letta-ai/letta-code-sdk` itself is deprecated upstream in favor of `@letta-ai/letta-agent-sdk` (npm package description confirms). Migration to the current official SDK is `jxri.6`. |

**Lesson (normative):** Provider-coupling debt takes years to extract.
Gas Town accumulated two years of role-hardcoding debt before
extracting Gas City. VibeSync skips the cost by enforcing rule 5 from
day one. We commit in writing to the same posture for any future
provider SDK adoption: the integration is reviewed against the five
invariants BEFORE any code lands. Deprecated upstream packages are a
hard STOP — they are not "what works today," they are
"what's already scheduled for removal."

### 3.10 One-distribution target — Kotlin App Server, Bun retired (REVISED)

REQUESTED CHANGES #5: the prior draft described a permanent
one-binary-per-language architecture. That is wrong. The correct
target is ONE Kotlin App Server distribution; Bun is the temporary
reference and is retired.

**Normative (revised):**

- **Final target:** ONE Kotlin App Server distribution / process
  that contains both:
  - The **runtime-core module** (the App Server process, the Letta
    runtime, capability-token issuance, Iroh transport).
  - The **orchestration module** (the VibeSync controller, formula
    dispatcher, EventBus, HealthPatrol, molecule walker, role pack
    loader, Beads client, REST/OpenAPI client, App Server v2
    semantic adapter).
- The two modules share one binary and one process boundary.
- Module separation is enforced by the layering invariants (§2) and
  the package layout; **no runtime-core internals leak into the
  orchestration module** and vice versa.
- **Bun VibeSync is the temporary reference.** It exists today as a
  Bun/TypeScript implementation of the orchestration plane. Once
  `vibesync-jxri.14` (reference release gate) closes, the Kotlin
  App Server distribution takes authority and the Bun binary is
  **retired**.
- This is NOT a permanent one-binary-per-language product. The
  one-distribution target is Kotlin-only at the final state.

**Incidental (current Bun reality):**

- The current Bun binary is split between CLI (`src/cli.ts`) and
  server (`src/index.ts`) entry points, with the orchestration plane
  at `src/orchestration/`. The module boundaries inside `src/orchestration/`
  mirror the layering invariants today.
- The Bun binary ships as a single distribution artifact. The
  orchestrator and runtime are conceptually separate even though
  they live in one binary today.

### 3.11 Strangler / shadow / cutover / canary / rollback (REVISED — shared Beads)

REQUESTED CHANGES #6: the prior draft said "no live migration / Kotlin
starts fresh." That is incorrect. The approved cutover shape is
**strangler/shadow with shared authoritative Beads/Dolt**.

**Normative (revised):**

1. **Strangler pattern.** The Kotlin binary sits alongside the Bun
   binary during cutover. The dispatcher / controller code routes
   per-capability: which capabilities are answered by which
   implementation. Capabilities flip one at a time. The Bun
   implementation is never duplicated into Kotlin (no copy-paste
   port); Kotlin implements the typed contract that
   `vibesync-jxri.3` publishes and the dispatcher routes accordingly.
2. **Shadow harness** (`vibesync-jxri.13`). The Kotlin executor runs
   in parallel with the Bun executor on the same inputs. Outputs are
   compared semantically (formula parse, plan, readiness, transition
   validity) and by performance (latency, token usage, error rate).
   **No double-dispatch, no double-mutation.** The shadow path is
   read-only against the source-of-truth state.
3. **Shared authoritative Beads/Dolt.** Both Bun and Kotlin read and
   write the same authoritative Beads/Dolt store. There is one
   `vibesync` Dolt database (with the project-local `.beads/dolt/`
   shape per the Beads conventions); both implementations are
   clients of it. **No duplicate mutation surface.**
4. **Per-capability authority flags** (per `jxri.13`). Each
   capability (e.g., "agent provisioning", "step dispatch",
   "molecule writeback", "artifact storage") has an authority flag
   indicating which implementation owns it. Default: Bun. Flip to
   Kotlin after shadow parity + canary evidence.
5. **Endpoint / capability cutover.** Cutover is per-capability,
   not per-binary. A capability flips; the Bun implementation steps
   back; the Kotlin implementation steps in. There is no "big bang"
   flip.
6. **Canary** (`vibesync-jxri.17`). Bounded subset of real projects,
   behind a feature flag. Auto-rollback on regression thresholds.
   Sustained dogfood evidence accumulates over the canary window.
7. **Rollback.** Each capability has a documented rollback: flip
   the authority flag back to Bun. Dolt history + git tags + `bun.lock`
   are the rollback substrate for the Bun side; the Kotlin side
   rolls back by flipping the flag. To roll back the entire system,
   disable the Kotlin binary and revert authority flags to Bun.
8. **Bun retirement.** Once all capability authority flags have been
   flipped and `vibesync-jxri.14` closes, the Bun binary is
   retired. The Kotlin App Server distribution is the sole runtime.

**Removed claim from prior draft:**

- ~~"No live migration between Kotlin and Bun (Kotlin authority OFF
  until `jxri.14`)."~~ — Replaced by the strangler/shadow story
  above. There IS a controlled cutover; it is shared-Beads,
  per-capability, canaried, rollback-able.
- ~~"Kotlin starts fresh."~~ — Wrong. Kotlin is a new implementation
  but it shares authoritative state (Beads/Dolt) and capabilities
  flip in via the strangler pattern.

**Reference-release gate (`jxri.14`):** The Kotlin port MAY NOT be
marked authoritative until `jxri.14` closes. The gate's acceptance
criteria (clean-room runner reproduces corpus; no severity-1/2
findings; sustained dogfood / performance thresholds; rollback
runbook rehearsed) are the binary go/no-go for letting
`letta-mobile-gx6ri` and other downstream consumers cut over.

### 3.12 Compatibility & rollback policy

| Concern                                 | Policy                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeProvider` seam (this ADR)       | The seam and ownership are pinned at ADR-0001. The versioned contract (typed `SessionSpec.extra` keys, `SessionEvent` schema, wire-format stability) is owned by `vibesync-jxri.5` and may evolve.                                                 |
| `SessionEvent` wire shape               | Frozen in `jxri.3` (versioned schemas). Adds require a new event-kind version.                                                                                                                                                                     |
| Beads schema                            | Migration path through `bd`'s migration; runtime beads follow `docs/architecture/bd-conventions.md`.                                                                                                                                               |
| Pack TOML                               | Schema is additive; removing a key requires a deprecation cycle through at least one reference release.                                                                                                                                            |
| `provider_kind='letta-teams'` rows      | Treated as removed configuration; warn-and-fall-back to boot-level local backend. Migration shim planned under `jxri.6`.                                                                                                                           |
| Legacy `vibesync.db` SQLite registry    | Read-only access; no new domain state. Migration to Beads executed by `jxri.6`. Final removal only after `jxri.14` closes.                                                                                                                         |
| Bun ↔ Kotlin divergence                 | During cutover: shared Beads/Dolt authority, per-capability authority flags, no duplicate mutation. Bun is authoritative until its capability flag is flipped; Kotlin is shadow / canary only. After `jxri.14`: Kotlin authoritative, Bun retired. |
| Reference release cadence               | At least one reference release per epic-quarter. Hot-fix releases allowed for severity-1 regressions under `jxri.14` change control.                                                                                                               |
| `@letta-ai/letta-code-sdk` (deprecated) | STOP using. Migrate to `@letta-ai/letta-agent-sdk` per `jxri.6`. The deprecated shim is on the Bun reference's migration path.                                                                                                                     |

---

## 4. Normative vs Incidental behavior (comprehensive table)

| Behavior                                                                                                                                        | Class                                            | Notes / bead                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Five layering invariants                                                                                                                        | **Normative**                                    | `AGENTS.md`; load-bearing.                                                                                                   |
| `RuntimeProvider` seam and ownership (this ADR)                                                                                                 | **Normative**                                    | `src/orchestration/runtime/provider.ts`; versioning owned by `jxri.5`.                                                       |
| `SessionEvent` discriminated union + unknown-kind pass-through                                                                                  | **Normative (seam)**                             | Contract versioned by `jxri.5`.                                                                                              |
| `SessionHandle` opaque, provider-local                                                                                                          | **Normative**                                    | Same.                                                                                                                        |
| Beads as universal persistence (NEW state)                                                                                                      | **Normative**                                    | `AGENTS.md` rule 2; `docs/architecture/bd-conventions.md`; migration of legacy rows tracked by `jxri.2`/`jxri.6`.            |
| EventBus as universal observation                                                                                                               | **Normative**                                    | `AGENTS.md` rule 3; `src/orchestration/events/bus.ts`.                                                                       |
| Config activation (presence in `BootOrchestrationPlaneOptions`)                                                                                 | **Normative**                                    | `AGENTS.md` rule 4.                                                                                                          |
| Zero hardcoded roles in core                                                                                                                    | **Normative**                                    | `AGENTS.md` rule 5.                                                                                                          |
| Role TOML schema (`[role]`, `[[memory_blocks_policy]]`, `[[memory_blocks]]`)                                                                    | **Normative**                                    | `packs/gastown/roles/*.toml`.                                                                                                |
| **Persistent role agents** as the normative identity path                                                                                       | **Normative**                                    | The Letta agent created via SDK owns its system prompt; the controller drives it via `agent_id`.                             |
| Per-step turn timeout via typed contract (replacing `SessionSpec.extra.turnTimeoutMs` incidental key)                                           | **Normative**                                    | Owned by `jxri.5`.                                                                                                           |
| ConversationId / SessionId resume                                                                                                               | **Normative**                                    | Resume is part of the contract; survives session restart. Versioned by `jxri.5`.                                             |
| One active control session per App Server process                                                                                               | **Normative**                                    | Per Letta Code websocket protocol control-plane invariant.                                                                   |
| Controller = trusted client, NOT a Letta agent identity                                                                                         | **Normative**                                    | Controller ≠ PM; PM is a Letta agent identity inside the App Server.                                                         |
| **Inline persona path** (`packs/<pack>/.letta/agents/<role>.md`)                                                                                | **Compatibility / incidental**                   | Bun-only, for projects whose role agent has not been bootstrapped (vibesync-s28). Kotlin port does NOT have this path.       |
| **PM puppet-message scaffold** (`[ORCHESTRATION_SUBAGENT_DISPATCH]`, `buildPuppetMessage`, `<<<TASK_PROMPT_BEGIN>>>` markers)                   | **Incidental — DO NOT PORT**                     | Workaround for letta-code SDK 0.25.11 missing custom subagent discovery.                                                     |
| **SSE line-by-line parser** in `consumeSseBody`                                                                                                 | **Incidental — DO NOT PORT**                     | Shim-specific. Kotlin uses structured streaming client.                                                                      |
| **`tool_return_message` → `assistant_message` fallback**                                                                                        | **Incidental — DO NOT PORT**                     | Bridges shim version drift in event shape. REST/App Server v2 is normalized.                                                 |
| **Auto-heal phantom PM agent refs** (`ensureParentAgentExists`)                                                                                 | **Incidental — DO NOT PORT**                     | Recovery for shim store inconsistency. lcp-mj0h.                                                                             |
| **`requires_approval` parsing detail** (treat as non-terminal, wait for end_turn)                                                               | **Incidental — DO NOT PORT**                     | The contract is normative (don't end on requires_approval). The parser detail is bypassPermissions-mode-specific (lcp-ltrf). |
| **`provider_kind='letta-teams'` rows**                                                                                                          | **Incidental — DO NOT PORT**                     | Removed legacy; warn-and-fall-back. Don't bring back the SDK.                                                                |
| **Legacy SQLite `vibesync.db` registry tables** (`projects`, `issues`, `project_role_agents`, `sync_history`, `project_files`, `sync_metadata`) | **Incidental — DO NOT EXTEND, DO NOT REPLICATE** | Current state; migrate to Beads per `jxri.6`. No new domain state, no port to Kotlin.                                        |
| **`@letta-ai/letta-code-sdk` usage** (deprecated upstream package)                                                                              | **Incidental — STOP USING**                      | npm: "Deprecated compatibility shim for @letta-ai/letta-agent-sdk". Migrate to `@letta-ai/letta-agent-sdk` per `jxri.6`.     |
| **Provisioning-SDK + runtime-shim asymmetry**                                                                                                   | **Incidental — DO NOT PORT**                     | Will collapse to SDK-only in Bun (`jxri.6`). Kotlin uses one path.                                                           |
| **`buildDefaultRuntimeProvider` env-var branches in `boot.ts`**                                                                                 | **Incidental — DO NOT PORT**                     | Boot wiring choice; dispatcher MUST NOT read env vars directly.                                                              |
| **`DEFAULT_PACK_DIR = 'packs/gastown'` constant**                                                                                               | **Incidental**                                   | Test fallback; production reads `projects.pack_dir`.                                                                         |
| **Direct `WorkActivityReporter` subscription to shim SSE**                                                                                      | **Incidental**                                   | Legacy projection; normative path is bus-fed.                                                                                |
| **Hardcoded `http://localhost:3099` URL**                                                                                                       | **Incidental**                                   | Dev default; discovery (jxri.12) is normative.                                                                               |
| **Iroh carries domain authorization**                                                                                                           | **NOT TRUE**                                     | Iroh carries transport identity/reachability; domain authorization is controller-owned. (See §3.7.)                          |
| **App Server v2 provisioning primitive**                                                                                                        | **DOES NOT EXIST**                               | Provisioning is REST/OpenAPI; App Server is execution. (See §3.6.)                                                           |
| **`EdgeProvider` interface plugged into EventBus**                                                                                              | **DOES NOT EXIST**                               | A2A/ACP/A2UI are adapters/providers behind the RuntimeProvider seam. (See §3.8.)                                             |
| **Kotlin starts fresh / no live migration**                                                                                                     | **REPLACED**                                     | Cutover is strangler/shadow with shared Beads/Dolt. (See §3.11.)                                                             |

---

## 5. Explicit non-goals

The following are **out of scope** for VibeSync reference and the
Kotlin port. Naming them here so future contributors do not propose
them as scope creep:

1. **Reintroducing `letta-teams-sdk`** or any second provider SDK
   (`vibesync-6zj`; `AGENTS.md` rule).
2. **Adding a second Letta Code path** alongside
   `LettaCodeSubagentProvider` (rule: extend the existing provider).
3. **Continuing to use `@letta-ai/letta-code-sdk`** (deprecated
   upstream package; migrate to `@letta-ai/letta-agent-sdk`).
4. **Hardcoding role names in core TypeScript/Kotlin** (rule 5).
5. **Bypassing the EventBus for cross-layer visibility** (rule 3).
6. **Putting role memory blocks, conversation IDs, or A2UI capability
   negotiation inside the `RuntimeProvider` interface**.
7. **A2A protocol support in core**. A2A is an edge-provider concern
   activated only upon named need; when added, it implements the
   `RuntimeProvider` seam.
8. **Adding a new `EdgeProvider` interface** in core to plug
   adapters into EventBus. Adapters (ACP, A2UI, A2A) plug into
   the `RuntimeProvider` seam; no parallel interface is introduced.
9. **Two-implementation permanent architecture**. The final target
   is ONE Kotlin App Server distribution; Bun is retired.
10. **Kotlin "starts fresh" with its own database**. Kotlin shares
    authoritative Beads/Dolt with Bun during cutover.
11. **Replicating the legacy SQLite `vibesync.db` registry in
    Kotlin**. Migrate the rows to Beads; do not port the tables.
12. **Claiming App Server v2 has a provisioning primitive**. It does
    not; provisioning is REST/OpenAPI.
13. **Iroh carrying domain authorization**. Iroh is transport; domain
    authorization is controller-owned.

---

## 6. Cross-repo implications

- **letta-mobile-gx6ri.** Its ADR MUST cite this ADR as prerequisite
  evidence before cutting over to Kotlin authority. The dependency is
  tracked by reciprocal Beads comments because Beads relation edges
  are repository-local.
- **letta-MCP-server.** May consume the EventBus surface and the
  `RuntimeProvider.kind` discriminator but MUST NOT import from
  `src/orchestration/` directly. The MCP server talks to VibeSync via
  its public HTTP/CLI surface; internal coupling is a defect.
- **letta-code / letta-code-sdk / letta-agent-sdk.** VibeSync
  consumes the SDK as a black box. SDK shape changes are absorbed at
  the `RuntimeProvider` seam (Bun) or the typed contracts published
  by `jxri.3` (Kotlin).

---

## 7. Acceptance

This ADR closes (`vibesync-jxri.1` status → closed) when:

- [x] This document exists at `docs/architecture/ORCHESTRATION_OWNERSHIP_ADR.md`.
- [x] Normative vs incidental table is reviewed and accepted.
- [x] Compatibility / rollback policy is reviewed.
- [x] Explicit non-goals are listed (13 items in rev 2).
- [x] **AGENTS.md cross-link** is in place at the layering-invariants
      section (added in rev 2).
- [ ] **Reviewed and accepted by Meridian** — REMAIN UNCHECKED until
      Meridian signs off on rev 2.
- [ ] Cited from `jxri.2`, `jxri.3`, `jxri.5`, `jxri.6`, `jxri.10.4`,
      `jxri.12`, `jxri.13`, `jxri.14`, `jxri.17` (follow-up
      cross-references added by those beads).
- [ ] Reciprocal note posted in `letta-mobile-gx6ri` citing this ADR
      (coordination via Beads comments; not this repo's job).

The remaining acceptance items are tracked under this bead's
"open questions" section below until closed.

---

## 8. Open questions

1. **Capability token format / signing scheme** (owned by `jxri.12`
   discovery and `jxri.13` shadow harness). This ADR does not
   specify the schema — only that it is controller-owned, layered
   over Iroh, and versioned by jxri.3.
2. **Per-capability authority flags list.** Owned by `jxri.13`
   shadow harness.
3. **Inline-persona compatibility retirement schedule.** Owned by
   `jxri.6` (modernize Letta runtime provider). The path exists
   until all projects bootstrap a persistent role agent.
4. **Beads schema for projects / project_role_agents.** Owned by
   `jxri.2` (inventory) and `jxri.3` (schemas). Migration is
   `jxri.6`'s work.

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
- `docs/guides/BEADS_DOLT_MIGRATION.md` — 2026-05-11 migration findings;
  acknowledges 51/31/15 split of project Beads-backed state.
- `src/orchestration/runtime/provider.ts` — `RuntimeProvider` interface
  (seam; contract versioned by jxri.5).
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
  (vibesync-1ix; current code uses deprecated `letta-code-sdk`).
- `src/database.ts` — legacy SQLite registry (`projects`, `issues`,
  `project_role_agents`, `sync_history`, `project_files`,
  `sync_metadata`).
- `packs/gastown/roles/{mayor,coder,reviewer,tester,refinery}.toml` —
  role TOML canonical examples.
- `packs/gastown/.letta/agents/<role>.md` — inline persona path
  (legacy compatibility; bun-only).
- `packs/gastown/prompts/<role>-system.md` — system-prompt templates.
- `packs/gastown/formulas/{code-review,onboard-feature,refinery-sweep}.toml`
  — formula canonical examples.
- npm registry — `@letta-ai/letta-agent-sdk@0.2.6` (current),
  `@letta-ai/letta-code-sdk@0.2.1` (DEPRECATED),
  `@letta-ai/letta-code@0.28.7` (CLI),
  `@letta-ai/letta-client@1.12.1` (REST).
- `github.com/letta-ai/letta-agent-sdk` README — official SDK surface
  (`LettaAgentClient` with `local` / `remote` / `cloud` backends,
  capability-token auth for non-loopback, websocket control session).
- `github.com/letta-ai/letta` README — App Server is the execution
  surface; V1 client SDK is for REST; Agent SDK is for runtime.
- Gas City: https://github.com/gastownhall/gascity — role-as-data
  discipline; MEOW stack.
- Gas Town: https://github.com/steveyegge/gastown — origin patterns.
- A2UI protocol: https://a2ui.org · https://github.com/google/A2UI —
  projection reference (NOT in core).
- Beads epic: `vibesync-jxri`.
- Companion beads: `vibesync-jxri.2`, `.3`, `.5`, `.6`, `.7`, `.10.4`,
  `.12`, `.13`, `.14`, `.16`, `.17`.
- Downstream ADR: `letta-mobile-gx6ri` (cross-repo; prerequisite
  evidence for Kotlin authority cutover).

---

## 11. REQUESTED CHANGES traceability

This section maps each numbered item from Meridian's review of
commit `94fc8bc8` to the section in this revision that addresses it.
The mapping is for traceability only; the substantive content lives
in §3 and §4.

| #   | Meridian concern                                                                                                                                                                                    | Addressed in    | Notes                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| 1   | Controller ≠ PM; one active control session per App Server process; controller fanout                                                                                                               | §3.1            | Full rewrite of controller/runtime ownership.                                          |
| 2   | RuntimeProvider v2 not frozen pre-jxri.5; remove `extra` key-for-key claim                                                                                                                          | §3.2            | Seam pinned, contract owned by jxri.5; typed extensions replace incidental `extra`.    |
| 3   | Exact Letta boundary: official `letta-agent-sdk` in Bun; Kotlin uses REST/OpenAPI lifecycle + App Server v2 execution                                                                               | §3.6            | Two-surface table; no invented App Server provisioning primitive.                      |
| 4   | Iroh is transport identity/reachability; domain authorization is controller-owned signed capabilities layered over Iroh                                                                             | §3.7            | Authority layering table; schema deferred to jxri.12 / jxri.13.                        |
| 5   | Final target is ONE Kotlin App Server distribution with strict modules; Bun retired after parity/rollback gates                                                                                     | §3.10           | Bun demoted from "permanent one-binary-per-language product" to "temporary reference". |
| 6   | Remove "no live migration / Kotlin starts fresh"; approved is strangler/shadow with shared Beads/Dolt, endpoint/capability cutover, canary, rollback, no duplicate mutation                         | §3.11           | Strangler + shadow + per-capability flags + canary + rollback; shared Beads/Dolt.      |
| 7   | Inline persona path is compatibility/incidental, not normative final Kotlin behavior                                                                                                                | §3.5, §4        | Inline persona demoted to compatibility/incidental; Kotlin does not have this path.    |
| 8   | A2A, ACP, A2UI are adapters/providers behind RuntimeProvider; do not describe EdgeProvider plugged into EventBus unless such interface exists                                                       | §3.8            | "No `EdgeProvider`" stated explicitly; adapter model clarified.                        |
| 9   | Replace factual claim that all current domain state already goes through bd with normative target plus inventory/migration acknowledgment; current projects/project_role_agents still use legacy DB | §3.3            | Current-state table added; migration beads identified.                                 |
| 10  | Acceptance checkboxes: "reviewed and accepted" must remain unchecked until this review passes. Add AGENTS cross-link in same commit                                                                 | §7, `AGENTS.md` | Box remains unchecked in rev 2; AGENTS cross-link added in same branch.                |

---

**Document Version:** 2.0
**Status:** Proposed (revised)
**Created:** 2026-07-14
**Revised:** 2026-07-14
**Authors:** PM-vibesync (vibesync-jxri.1)

<!-- VIBESYNC:adr:END -->
