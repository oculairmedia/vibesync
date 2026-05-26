# Gas Town Role Catalog (Research)

Reference catalog of the roles Gas Town ships, gathered from Gas City's
[migration guide](https://github.com/gastownhall/gascity/blob/main/docs/getting-started/coming-from-gastown.md)
and surrounding docs. Used as input for the `vibesync-ulp` role-pack bead.

**Crucial framing** (from Gas City's doc):

> Gas City has no baked-in role names in Go. These are pack conventions,
> not SDK primitives.

This applies to VibeSync verbatim — layering invariant #5. The roles
described here are EXAMPLES of how to compose VibeSync teammates +
formulas to mimic Gas Town's operating model. None of them are
hardcoded in core; all live in a pack.

## The roles

### Mayor

**Purpose:** Top-level director / orchestrator. Coordinates other roles,
makes architectural decisions, owns the "what's the plan" framing.

**Model recommendation:** A strong reasoning model — `letta/auto` or a
top-tier reasoning model handle. Mayor decisions cascade through the
work; quality matters more than latency.

**Key tools:** Access to memory blocks across the city, ability to
dispatch to other roles (sling-equivalent), read project state.

**System prompt anchor:** "You are the Mayor. You think strategically
about the whole project. You delegate execution to specialists; you
own decisions about what should happen and in what order. You do not
do detailed implementation work yourself."

**Maps to VibeSync:** A persistent teammate with broad memory access.
Probably the agent that receives external requests (from VibeSync's
project registry API, from PM-agent reports). Dispatches molecules
that compose the other roles.

### Deacon

**Purpose:** Watchdog / supervisor / health-patrol. Catches stalls,
restarts misbehaving sessions, manages the order queue.

**Translation per Gas City:** "Deacon watchdog logic" → controller +
supervisor, NOT a role-agent. In VibeSync this maps to
`HealthPatrol` (vibesync-458), not a teammate.

**Recommendation:** Do NOT ship a "Deacon" role-pack teammate. The
infrastructure handles this. If a user wants a Deacon-themed
dashboard surface, build it as a thin TUI/CLI projection of the
HealthPatrol events — not a role.

### Polecat

**Purpose:** Disposable / ephemeral worker for short-running tasks.
"A polecat is what you sic at a problem."

**Translation per Gas City:** An operating mode (scalable session
config), not a hard type.

**Maps to VibeSync:** Use `LettaCodeSubagentProvider` sessions for
ephemeral worker conversations. Polecats are short-lived runtime
sessions dispatched through the same provider chokepoint as other
Gastown role work, not a separate provider.

**Recommendation:** Polecats are a pattern, not a role. Add a `polecat`
formula that wraps "spawn an ephemeral worker, dispatch one message,
collect the result, archive" rather than a role TOML.

### Witness

**Purpose:** Observes the city, records what happens, surfaces
patterns. Lifecycle management for crew + polecats.

**Translation per Gas City:** Witness lifecycle logic → waits +
formulas + session scale config + controller wake/sleep.

**Maps to VibeSync:** Mostly the EventBus + HealthPatrol +
vibesync-uxx walker. A "Witness" role-pack teammate might be
useful as a query/dashboard surface that reads the event bus and
narrates city state, but the SUBSTANCE is in the infrastructure.

**Recommendation:** Optional. Ship a `witness` role IF the gastown pack
benefits from a conversational summary surface; otherwise omit.

### Refinery

**Purpose:** Background processing — compaction, summarization, archive
sweeps, cost optimization.

**Maps to VibeSync:** A scheduled formula that dispatches a
`refinery` teammate (or runs as an order without an LLM session
when no judgment is needed — Gas City notes this is often a non-LLM
job).

**Recommendation:** Ship a `refinery` formula that runs daily,
processes accumulated molecule_step beads, archives closed ones older
than retention threshold (per bd-conventions.md). The LLM teammate is
optional; the work is mostly mechanical.

### Crew

**Purpose:** Operating style — a set of co-working persistent agents
in a city. Not a single role; a collection.

**Translation per Gas City:** Crew is a pack convention; the SDK only
knows agent config + session behavior. Gas City describes crew as
"persistent sessions" listed in `city.toml`.

**Maps to VibeSync:** The set of teammates a project keeps spawned at
all times. Probably configured per-project in vibesync.yaml or
equivalent. Pack doesn't ship "crew" — pack ships roles you might
configure into crew.

### Dog

**Purpose:** Infrastructure helper for repetitive non-judgment tasks
(file sync, git ops, build kickoffs).

**Translation per Gas City:** "Dog" is usually better as an exec order
than an LLM session — most dog work is mechanical.

**Maps to VibeSync:** Use a non-LLM step type in a formula (TBD —
formulas today assume LLM steps). Or shell out from a teammate's
tool call when the operation is small enough. Roll dog work into the
relevant formula rather than a standalone role.

## What to ship in the gastown pack

Concrete recommendation for vibesync-ulp:

| Asset | Type | Reason |
|---|---|---|
| `roles/mayor.toml` | role | Anchors the orchestration story |
| `roles/refinery.toml` | role | Useful periodic cleanup teammate |
| `roles/reviewer.toml` | role | Real code-review use case; ships with the formula |
| `roles/coder.toml` | role | Counterpart to reviewer for code-review formula |
| `roles/tester.toml` | role | Closes the code-review loop |
| `formulas/onboard-feature.toml` | formula | Demonstrates Mayor → Reviewer → Coder → Tester chain |
| `formulas/code-review.toml` | formula | Already authored at formulas/code-review.toml |
| `formulas/refinery-sweep.toml` | formula | Periodic refinery teammate dispatch |
| `prompts/mayor-system.md` | prompt | Mayor system prompt template |
| `prompts/reviewer-system.md` | prompt | Reviewer system prompt template |
| `prompts/coder-system.md` | prompt | Coder system prompt template |
| `prompts/tester-system.md` | prompt | Tester system prompt template |
| `prompts/refinery-system.md` | prompt | Refinery system prompt template |

**Do NOT ship:**
- `roles/deacon.toml` — HealthPatrol covers this
- `roles/polecat.toml` — pattern not a role
- `roles/witness.toml` — optional, defer to need
- `roles/dog.toml` — most dog work is exec orders, not LLM

## Open questions for the implementer

1. Does the formula schema need a non-LLM step type to model "dog"
   work cleanly? If yes, file a follow-up bead extending the formula
   grammar.
2. Should refinery work be a formula or a recurring cron-style
   schedule? Gas City uses a controller / orders model; VibeSync
   doesn't have a cron primitive yet.
3. Mayor decisions can fan out into multiple parallel molecules. Does
   the molecule walker need a "spawn child molecule" verb, or is a
   formula expressive enough?

## References

- Gas City migration guide:
  https://github.com/gastownhall/gascity/blob/main/docs/getting-started/coming-from-gastown.md
- Gas Town origin: https://github.com/steveyegge/gastown
- VibeSync orchestration plan: `docs/architecture/gastown-orchestration.md`
- Layering invariants: `AGENTS.md` (rule 5 specifically)
