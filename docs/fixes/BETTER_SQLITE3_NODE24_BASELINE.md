# better-sqlite3 Node 24 reference-baseline fix (vibesync-jxri.20)

## Symptom

The jxri.15 reference baseline could not build/load `better-sqlite3` under
Node v24.18.0. `bun install --frozen-lockfile` fell through to `node-gyp`,
`build/Release/better_sqlite3.node` was never produced, and every Node-side
`new Database()` threw — 234 failures across the 4 DB/runtime unit files.

## Root cause

`package.json` pinned `better-sqlite3@^9.2.2` → the lockfile resolved
`9.6.0`. WiseLibs publishes **no prebuilt binary for Node 24 (ABI /
`NODE_MODULE_VERSION` 137)** at the 9.x line, so `prebuild-install` fell
through to a source compile via `node-gyp`. Node 24.18.0's bundled V8
headers **require C++20**:

```
/root/.cache/node-gyp/24.18.0/include/node/v8config.h:13:2:
  error: #error "C++20 or later required."
```

The `node-gyp` compile defaulted to C++17, so it hard-failed on
`std::ranges`, `requires`, and non-type class-template parameters. No
addon was produced.

Because `vitest.config.js` uses `environment: 'node'` + `pool: 'forks'`,
the test workers are Node processes (`typeof Bun === undefined`), so
`src/database.ts` selects the `better-sqlite3` module (not `bun:sqlite`) —
which is why the addon's absence produced the DB/runtime failures.

## Fix

Bump `better-sqlite3` `^9.2.2 → ^12.4.6` (lockfile resolves `12.11.1`).
The 12.x line ships an **ABI-137 (`node-v137`) linux-x64 prebuild** (and
`node-v141` for Node 25), so `prebuild-install` fetches the binary and
`node-gyp` is never invoked. The toolchain dependency is removed entirely.

- Only the common API subset is used across the codebase
  (`prepare` / `get` / `all` / `run` / `exec` / `pragma` / `transaction`);
  this is stable from 9.x → 12.x — no breaking change is touched.
- `@types/better-sqlite3@7.6.13` already covers the 12.x API.
- `engines.node: >=20.0.0` stays satisfied — 12.x ships prebuilds for
  `node-v115` (Node 20), `node-v127` (Node 22), `node-v137` (Node 24),
  `node-v141` (Node 25).
- No source change; no orchestration semantics changed; no silent
  fallback or duplicate persistence path.

## Pinned versions (reference baseline)

| Component        | Version                         |
|------------------|---------------------------------|
| Node.js          | v24.18.0 (ABI/`NODE_MODULE_VERSION` 137) |
| Bun              | 1.3.14                          |
| g++ (toolchain)  | 12.2.0 (Debian 12.2.0-14) — C++20-capable, but no longer on the install path |
| better-sqlite3   | 12.11.1 (prebuilt, ABI 137)     |
| @types/better-sqlite3 | 7.6.13                     |

## Verification

- `bun install --frozen-lockfile` from an **empty** `node_modules`: exit 0,
  791 packages, no `node-gyp`, `better_sqlite3.node` present via prebuild.
- Node-24 runtime `Database` smoke (WAL + `foreign_keys` pragma + prepared
  transaction + `.all()`): OK.
- `tsc --noEmit`: clean.
- `tests/unit/database.test.ts` (production `createSyncDatabase` path):
  178 passed in isolation.
- `tests/unit/database.test.ts` + `tests/unit/ProjectRegistry.test.ts` +
  `tests/unit/orchestration`: 21 files / 464 tests passed.

## Residual full-suite flakiness (out of scope — NOT this fix)

The full 78-file `tests/unit` run is **non-deterministically** flaky
(run A: 235 failed; run B: 1 failed). The residual failures are:

1. A native-addon **self-registration race** under vitest's reused fork
   workers (`Module did not self-register` / a misreported
   `NODE_MODULE_VERSION 115`) — the addon loads deterministically in
   isolation and small groups; it only races when a fork is recycled after
   many files churn through it. This is a `forks`-pool + native-module
   interaction, independent of the version bump.
2. Pre-existing infra flakiness unrelated to sqlite — Temporal activity
   failures, OpenAPI spec generation, and DoltHub port-fleet assertions
   (the known Dolt SIGKILL-on-restart `jxri-nl0l` and port-collision
   `jxri-devj` realities).

These are classified as separate concerns and deliberately **not** folded
into this P0 fix (which is strictly "restore better-sqlite3 loadability").
