#!/usr/bin/env bash
# Boot the REAL entry point (what vibesync.service runs: bun src/index.ts) and
# fail unless /health answers. Unit tests never start the process, so a change
# that stops main() from running passes every other check (vibesync-9lzk.28:
# PR #84 guarded main() by script path and the service would have done nothing).
#
# Runs against an empty stacks dir and a fresh registry, with orchestration off,
# so it needs no Dolt, bd, Letta or network. Usage: scripts/ci/boot-check.sh [budget_s]
set -euo pipefail

BUDGET_S="${1:-60}"
WORK="$(mktemp -d)"
PORT="${BOOT_CHECK_PORT:-3299}"
LOG="$WORK/boot.log"
mkdir -p "$WORK/stacks"

export ENABLE_ORCHESTRATION=false
export HEALTH_PORT="$PORT"
export STACKS_DIR="$WORK/stacks"
export VIBESYNC_DB_PATH="$WORK/registry.db"
export VIBESYNC_PORT_SWEEP_INTERVAL_MS=0
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Something else answering on this port would make a broken boot look healthy.
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "boot-check: FAIL - port $PORT already serves /health before launch; pick a free BOOT_CHECK_PORT" >&2
  exit 1
fi

bun src/index.ts >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

for ((i = 1; i <= BUDGET_S; i++)); do
  # --max-time: a server that accepts but never answers must not hang the loop.
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >"$WORK/health.json" 2>/dev/null; then
    # The answer must come from the process we started, not from a server
    # that grabbed the port after the pre-launch check.
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "boot-check: FAIL - /health answered but the launched process is gone" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    # Matches both log formats: pino JSON ("msg":"API server running") and
    # pino-pretty text ("INFO: ... API server running").
    if ! grep -q 'API server running' "$LOG"; then
      echo "boot-check: FAIL - /health answered but the launched process never logged 'API server running'" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    echo "boot-check: /health answered after ${i}s: $(cat "$WORK/health.json")"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "boot-check: FAIL - the process exited before /health answered" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

echo "boot-check: FAIL - /health did not answer within ${BUDGET_S}s ($(wc -l <"$LOG") log lines)" >&2
tail -40 "$LOG" >&2
exit 1
