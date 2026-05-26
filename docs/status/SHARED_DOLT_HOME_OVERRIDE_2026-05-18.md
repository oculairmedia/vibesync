# Ghost shared-server from HOME-override — incident postmortem (May 18, 2026)

**Status**: RESOLVED
**Impact**: mobile repo's `bd` writes silently went to an empty 0-issue DB; lcp shim-context bd writes had nowhere real to go
**Window**: 2026-05-17 22:44 EDT → 2026-05-18 13:18 EDT (~14h)
**Data loss**: None. The rogue/ghost DBs were never actually written to before detection. The real shared DB (1281 issues, in sync with `doltremoteapi.dolthub.com/oulair/letta_mobile`) was unaffected.
**Root cause**: `bd` auto-spawn of the shared Dolt SQL server under a `HOME=./home` override, creating a parallel empty data directory that camped the canonical shared-server port.

---

## What was wrong

`bd` discovers (or auto-spawns) its shared Dolt SQL server under `$HOME/.beads/shared-server/`. The lcp admin-shim (`/opt/stacks/letta-code-parallel`) sets `HOME=./home` in its env so it can sandbox letta-code state to `home/.letta/`. When any process descended from the shim invokes `bd` or `dolt`, that HOME override propagates. `bd` interprets the new path as a fresh install, creates an empty shared-server data directory at `<repo>/home/.beads/shared-server/dolt/`, and starts a `dolt sql-server` from there on the canonical shared-server port (3308) — silently shadowing the real shared server at `/root/.beads/shared-server/dolt/`.

After the real shared server (the one with the 1281-issue `letta_mobile` DB and the working DoltHub remote) stopped on 2026-05-17 22:44 EDT, the next bd auto-spawn under HOME-override at 2026-05-18 01:02 EDT replaced it on port 3308 with an empty DB. From that point onward:

- `letta-mobile` bd (which had `dolt.shared-server: false` in `.beads/config.yaml` — a separate misconfiguration) was already using a per-project empty Dolt server.
- Any other shared-mode bd call landed on the ghost server and saw zero project databases.
- The real DB at `/root/.beads/shared-server/dolt/letta_mobile/` was orphaned — still in sync with DoltHub via its own `.dolt/repo_state.json`, but no SQL server was serving it.

---

## How it was detected

A request to file beads issues in `/opt/stacks/letta-mobile` triggered the `PROJECT IDENTITY MISMATCH — refusing to connect` guard in bd 0.62.0:

```
Local project ID (metadata.json):  9d8d46c2-c475-4fff-b800-452d47841714
Database project ID:               723fc7d0-713c-4749-85a7-2bb9b9fd0b3d
```

That error pointed at metadata.json vs the per-project DB's `_project_id` — a real mismatch, but **misleading**: the deeper problem (no live server serving the actual data) was hidden one layer behind it.

---

## Resolution

### Sequence

1. **Inventory**: `ss -tlnp | grep :3308` → PID 669786. `readlink -f /proc/669786/cwd` → `/opt/stacks/letta-code-parallel/home/.beads/shared-server/dolt` (not the expected `/root/.beads/shared-server/dolt`). `SHOW DATABASES` over MySQL protocol → only `dolt`, `information_schema`, `mysql` (no `letta_mobile`).
2. **Confirm real data is safe**: directly opened `/root/.beads/shared-server/dolt/letta_mobile` with the local Dolt CLI → 1281 issues, `_project_id` matching the mobile repo's metadata.json, latest commit `g2v61beg…` ("bd: update letta-mobile-51xm.8") at 2026-05-17 22:43, `origin/main` (DoltHub) pointing at the same commit. Cloud sync was healthy through the moment of the previous server's death.
3. **Upgrade bd** 0.62.0 → 1.0.4. Skipped 0.63.3 because it requires `libicui18n.so.74` (ICU 74) not available on Debian 12 oldstable (which has ICU 72). bd 1.0.1+ removed the ICU runtime dependency, so 1.0.4 installs cleanly.
4. **Fix per-repo bd state**: `bd migrate --update-repo-id` on both `lcp` and `letta-mobile` to align metadata.json with the DB's stored `repo_id` (preexisting drift surfaced by bd 1.0.4's stricter doctor check).
5. **Flip mobile bd config**: `/opt/stacks/letta-mobile/.beads/config.yaml`: `dolt.shared-server: false` → `true`.
6. **Kill ghost servers**:
   - `kill 769552` — the stray per-project mobile Dolt server on port 40671 (empty DB).
   - `kill 669786` — the ghost shared server on port 3308 (empty DB, wrong cwd).
7. **Restart the real shared server** from the correct directory:
   ```
   cd /root/.beads/shared-server/dolt && \
     nohup dolt sql-server -H 127.0.0.1 -P 3308 \
       > /root/.beads/shared-server/dolt-server.log 2>&1 & disown
   ```
   The `-H` and `-P` flags had to be explicit — the new server did not pick up `config.yaml` automatically on first attempt and bound to the default port 3306.
8. **Verify**: `SHOW DATABASES` on port 3308 now returns `letta_mobile`. `cd /opt/stacks/letta-mobile && bd stats` → 1281 total issues, 210 open, 187 ready to work. `bd doctor` → 0 errors.

### Final state

| Item | Before | After |
| --- | --- | --- |
| bd CLI version | 0.62.0 | 1.0.4 (`bd.0.62.0.bak` preserved) |
| Shared server PID/cwd | 669786 in lcp `home/.beads/shared-server` | 1230851 in `/root/.beads/shared-server/dolt` |
| Stray mobile per-project | PID 769552 on :40671 | killed |
| mobile `dolt.shared-server` | `false` | `true` |
| mobile `bd stats` | 0 issues (silent) | 1281 issues |
| mobile repo_id mismatch | `c764961f` vs `49ccb4f4` | aligned to `49ccb4f4` |
| lcp repo_id mismatch | `0ca69ace` vs `73a10303` | aligned to `73a10303` |
| DoltHub remote on shared letta_mobile | configured, in sync at `g2v61beg…` | unchanged — no remote writes during recovery |
| lcp shared-server adoption | not migrated | still per-project (deferred to separate work) |

---

## Lessons learned + handling updates

### Add to `docs/guides/BEADS_DOLT_MIGRATION.md`

New failure-mode section:

> ### Ghost shared-server from HOME override
>
> **Symptom**: `bd ready` / `bd list` from a `dolt.shared-server: true` project returns `database not found: <name>` even though `$HOME/.beads/shared-server/dolt/<name>/` exists on disk with full data. Or worse: returns no error but reports zero issues.
>
> **Diagnose**:
> 1. `ss -tlnp | grep :3308` → identify the shared-server PID.
> 2. `readlink -f /proc/<pid>/cwd` — if the cwd is NOT `$HOME/.beads/shared-server/dolt` for the user whose data you expected, you're looking at a ghost.
> 3. `DOLT_USER=root DOLT_PASSWORD="" dolt --host=127.0.0.1 --port=3308 --no-tls sql -q "SHOW DATABASES;"` — a ghost has only `dolt`, `information_schema`, `mysql`.
>
> **Recover**:
> 1. Identify processes that may have spawned bd/dolt with overridden `HOME` (most likely culprit: lcp admin-shim with `HOME=./home`, but any sandboxed runtime with a HOME shim qualifies).
> 2. Kill the ghost server PID.
> 3. Restart dolt from the correct cwd with explicit host/port: `cd /root/.beads/shared-server/dolt && nohup dolt sql-server -H 127.0.0.1 -P 3308 > /root/.beads/shared-server/dolt-server.log 2>&1 & disown`.
> 4. Confirm `SHOW DATABASES` lists the expected project DBs.
> 5. Optionally `rm -rf <repo>/home/.beads/shared-server` to keep the bad location from being re-discovered on the next HOME-shadowed bd call.

### Process / convention changes worth landing

1. **admin-shim should not inherit `HOME=./home` into bd/dolt invocations**. Either set `BEADS_HOME=/root/.beads` (or unset `HOME` and provide an absolute path via env) when spawning subprocesses that might shell out to bd. File issue against lcp.
2. **A liveness watcher for the shared Dolt server**. The original server died at 22:44; nothing noticed until a human asked an unrelated question 14h later. A trivial systemd unit or healthcheck loop with auto-restart from the correct cwd would have prevented the entire incident.
3. **bd CLI upgrade pinned to ≥ 1.0.4 on this host**. v0.63.3 is unusable on Debian 12 due to ICU 74 dep. v1.0.4 also adds:
   - Named init flags (`--reinit-local` / `--discard-remote`) that close the failure class where AI agents pattern-matched on bd's own error output to silently destroy issues (changelog cites a real prior incident).
   - Stable exit codes on init refusals (10/11/12) usable from CI/scripts.
4. **Doctor should be part of vibesync's project-health probe**. The repo-fingerprint drift (`metadata.json` vs DB `repo_id`) on both `lcp` and `letta-mobile` was preexisting — bd 0.62.0 didn't check it. Running `bd doctor` periodically (or as part of vibesync's per-project sync sweep) would surface this drift early.
5. **vibesync should know how to detect HOME-shadowed bd state**. If vibesync calls bd inside a project workspace, it should sanity-check `$HOME` before doing so. A trivial guard: refuse to run bd if `$HOME` resolves under any registered project's path.

### Misleading UX worth filing upstream

- bd 1.0.4 prints `auto-importing N issues from .beads/issues.jsonl into empty database…` on `bd stats`, `bd migrate`, and a few other read-paths even when the DB is not actually empty (it has all N issues from the auto-import that already happened). This made every command look like a fresh recovery and made it hard to tell whether the actual DB was healthy. Worth filing at gastownhall/beads.
- `PROJECT IDENTITY MISMATCH` error text points at the metadata.json/DB project_id divergence but doesn't surface "the server may be serving a different data directory than you think" — which was the actual root cause here. Could be improved with a check on the running server's cwd vs the expected path.

---

## Cross-references

- `lcp-d5g` — admin-shim cron epic (the work request that surfaced this incident).
- `letta-mobile-d52f` — mobile sister epic. Filed once mobile bd was healthy again.
- `docs/guides/BEADS_DOLT_MIGRATION.md` — should be updated with the failure-mode section above.
- `docs/architecture/bd-conventions.md` — should reference the HOME-override constraint.
