# Durable waits (vibesync-9g24)

A wait is one bd bead (`issue_type=gate`, label `vibesync:wait`) whose JSON
metadata names the beads it waits on (`on`), the mode (`any`|`all`), an optional
`note`, the `waiter` to wake, an optional `expiresAt`, and the lifecycle `state`
(`pending` → `ready` → `closed`, or `canceled` / `expired` / `failed`).
Code: `src/orchestration/waits/`. Verified against bd **1.3.2**
(`MIN_BD_VERSION_FOR_WAITS`).

Activation: `VIBESYNC_WAITS_ENABLED=true` (default false). With it off nothing is
constructed. Wakes go to a `WaitWakeSink` (default: log only); the real waker is
vibesync-2bgv / x38j.

## Why not `bd gate --type=bead` alone

| Need | bd native bead gate (1.3.2) | Verdict |
| --- | --- | --- |
| Block a bead until another closes | `bd gate create --blocks W --type bead --await-id X`; `bd gate check --type=bead` closes it when X closes | works |
| `all` over N beads | N gates on one waiter | works |
| `any` over N beads | one `await_id` per gate, every gate must close | **gap** |
| Note as wake reason | `--reason` is flattened into free-text description; no metadata | **gap** |
| Waiter / who to wake | `add-waiter` stores an address string; nothing delivers a wake | **gap** |
| Expired state for a bead gate | `--timeout` is stored but `gate check --type=bead` never expires it; only `timer` gates expire | **gap** |
| Failed state (target vanished) | gate stays `pending - not found` forever | **gap** |
| Event-driven | none: `gate check` is a poll | same as ours (we add a bus hint + reconcile) |

Evidence: `tests/integration/orchestration/waits.test.ts`, tests G1–G4.
