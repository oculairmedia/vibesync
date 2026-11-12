#!/usr/bin/env bash
# Boot the REAL entry point (bun src/index.ts) with the orchestration plane ON,
# against a tracker whose Dolt server has been stopped, and fail unless the
# engine comes up (vibesync-9lzk.55.7).
#
# Why: scripts/ci/boot-check.sh runs with orchestration off, so it never opens
# the database. A service restart kills the engine's own Dolt server and leaves
# `.beads/dolt-server.port` behind; on 2026-11-11 a release that could not
# restart it passed every check and came up with `orchestration.ready: false`.
#
# What it does: makes a scratch server-mode tracker with the given bd, stops its
# Dolt server (the port file stays), starts the service from that directory, and
# requires the log line "Orchestration plane initialized" plus /health reporting
# orchestration ready. Nothing outside the scratch directory is read or written:
# HOME, the registry, the stacks dir, the tracker and the Iroh address all point
# into it, and no agent is ever dialled.
#
# Needs: bun, git, a `bd` binary (first argument or $VIBESYNC_TEST_BD) and
# `dolt` on PATH. Usage: scripts/ci/engine-boot-check.sh [/abs/path/to/bd] [budget_s]
set -euo pipefail

BD="${1:-${VIBESYNC_TEST_BD:-}}"
BUDGET_S="${2:-120}"
if [[ -z "$BD" || "$BD" != /* || ! -x "$BD" ]]; then
  echo "engine-boot-check: FAIL - pass an absolute path to an executable bd (argument 1 or VIBESYNC_TEST_BD)" >&2
  exit 1
fi
command -v dolt >/dev/null || { echo "engine-boot-check: FAIL - dolt is not on PATH" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
ROOT="$WORK/tracker"
LOG="$WORK/boot.log"
PORT="${BOOT_CHECK_PORT:-3298}"
mkdir -p "$ROOT" "$WORK/home" "$WORK/stacks"

# bd and git must not read this machine's config or any ambient BEADS_/BD_ setting.
while IFS='=' read -r name _; do
  case "$name" in BEADS_*|BD_*) unset "$name" ;; esac
done < <(env)
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="engine boot check" GIT_AUTHOR_EMAIL="boot-check@example.invalid"
export GIT_COMMITTER_NAME="engine boot check" GIT_COMMITTER_EMAIL="boot-check@example.invalid"
export BD_NON_INTERACTIVE=1
# The service starts Dolt through `bd` on PATH; make that the bd under test.
mkdir -p "$WORK/bin" && ln -s "$BD" "$WORK/bin/bd"
export PATH="$WORK/bin:$PATH"

PID=""
cleanup() {
  [[ -n "$PID" ]] && { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
  (cd "$ROOT" 2>/dev/null && "$BD" dolt stop >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "engine-boot-check: FAIL - $1" >&2
  [[ -f "$LOG" ]] && { echo "--- last service log lines ---" >&2; tail -40 "$LOG" >&2; }
  exit 1
}

free_port() {
  bun -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# 1. A scratch server-mode tracker with a running Dolt server.
git init -q "$ROOT"
DOLT_PORT="$(free_port)"
(cd "$ROOT" && "$BD" init --server --server-host=127.0.0.1 "--server-port=$DOLT_PORT" \
  --prefix=bootchk --database=bootchk --skip-hooks --skip-agents --non-interactive >"$WORK/init.log" 2>&1) \
  || { cat "$WORK/init.log" >&2; fail "bd init did not complete"; }
PORT_FILE="$ROOT/.beads/dolt-server.port"
[[ -s "$PORT_FILE" ]] || fail "bd init left no port file at .beads/dolt-server.port"
RECORDED="$(tr -d '[:space:]' <"$PORT_FILE")"
listening "$RECORDED" || fail "the Dolt server is not listening on port $RECORDED right after bd init"

# 2. Stop the server the way a service restart does: the process goes, the port file stays.
(cd "$ROOT" && "$BD" dolt stop >/dev/null 2>&1) || true
for _ in $(seq 1 50); do listening "$RECORDED" || break; sleep 0.2; done
listening "$RECORDED" && fail "the Dolt server is still listening on port $RECORDED after bd dolt stop"
# `bd dolt stop` may remove the port file; a killed server leaves it. Put it back so the stale-file path is the one tested.
[[ -s "$PORT_FILE" ]] || echo "$RECORDED" >"$PORT_FILE"
echo "engine-boot-check: Dolt server stopped; port file still says $RECORDED"

# 3. Boot the real entry point from the tracker directory with the engine on.
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  fail "port $PORT already serves /health before launch; pick a free BOOT_CHECK_PORT"
fi
export ENABLE_ORCHESTRATION=true
export ORCHESTRATION_BOOT_ATTEMPTS=1
export VIBESYNC_LETTA_CODE_PARENT_AGENT_ID="agent-00000000-0000-0000-0000-000000000000"
# Boot parses the Iroh host address but dials nothing until a step runs. Give it
# a syntactically valid address on a closed port and a key path that does not
# exist, so the check reads no address book or key from the machine it runs on
# (the first CI run failed here: "iroh address file not found: /root/.letta/...").
export VIBESYNC_IROH_HOST_ADDR="$(printf '0%.0s' $(seq 1 64))@127.0.0.1:9"
export VIBESYNC_IROH_SECRET_KEY_PATH="$WORK/no-such-iroh-key"
export VIBESYNC_IROH_PEER_NAME="engine-boot-check"
export VIBESYNC_SCHEDULER_ENABLED=false VIBESYNC_PM_WAKE_ENABLED=false VIBESYNC_WAITS_ENABLED=false
export HEALTH_PORT="$PORT" STACKS_DIR="$WORK/stacks" VIBESYNC_DB_PATH="$WORK/registry.db"
export VIBESYNC_PORT_SWEEP_INTERVAL_MS=0 NO_PRETTY_LOGS=1 LOG_LEVEL="${LOG_LEVEL:-info}"
unset VIBESYNC_ORCHESTRATION_PROVIDER TYPESAFE_API_KEY

(cd "$ROOT" && exec bun "$REPO/src/index.ts") >"$LOG" 2>&1 &
PID=$!

LAST_HEALTH=""
START=$SECONDS
while (( SECONDS - START < BUDGET_S )); do
  if grep -q 'Orchestration plane initialized' "$LOG"; then
    kill -0 "$PID" 2>/dev/null || fail "the engine logged that it started but the process is gone"
    # /health is pretty-printed; compare with whitespace removed.
    # The engine logs this line before the HTTP listener binds: keep asking
    # until /health answers ready or the budget runs out (the loop fails then).
    HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$HEALTH" != *'"orchestration":{"ready":true}'* ]]; then
      LAST_HEALTH="$HEALTH"
      sleep 1
      continue
    fi
    grep -q 'the Dolt server is down' "$LOG" || fail "the engine started without ever finding the server down: this check did not test the restart"
    NOW="$(tr -d '[:space:]' <"$PORT_FILE")"
    listening "$NOW" || fail "the port file says $NOW but nothing listens there"
    echo "engine-boot-check: engine up after $(( SECONDS - START ))s; Dolt restarted on port $NOW (was $RECORDED); /health reports orchestration ready"
    exit 0
  fi
  if grep -qE 'continuing without it|Orchestration plane NOT started|Fatal error' "$LOG"; then
    fail "the service gave up on the orchestration plane"
  fi
  kill -0 "$PID" 2>/dev/null || fail "the process exited before the engine started"
  sleep 1
done
fail "the engine did not start within ${BUDGET_S}s${LAST_HEALTH:+ (last /health: $LAST_HEALTH)}"
