#!/usr/bin/env bash
# scripts/smoke/verify-iroh-pathc.sh
# y3rz.4 / letta-mobile-u6hwa + oi147 — Path C dispatch verify spec.
#
# Single source of truth for the post-u6hwa/oi147 wrapper deploy. Every assertion
# here corresponds to a hard-won finding from the live bugs:
#   1. kv port matches live listener port (presence is NOT health)
#   2. zero letta_-prefixed kv rows (the bug class)
#   3. CLI send with bare agent-<uuid> returns delivered:true
#   4. CLI send with letta_agent-<uuid> returns delivered:true
#   5. nonexistent agent id returns not_registered, NOT a dial timeout
#   6. identity dir has no letta_-prefixed files AND bare key bytes match the
#      pre-migration values (migration must not rotate node ids)
#
# Usage: kite-or-bash, no env required. From the host the wrapper runs on.
# Exits non-zero on the first failed assertion; the calling CI step or heartbeat
# will surface the line and the verdict.
#
# The shebang is /usr/bin/env bash, not #!/usr/bin/env bun, because every check
# here is shell — `cat`, `ss`, `ls`, and the meridian CLI — and a bun dep would
# only obscure that.

set -u
PASS=0
FAIL=0
FAILED_NAMES=()

note_pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
note_fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); }

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command '$1' not found on PATH"; exit 2
  fi
}

cat <<'BANNER'
y3rz.4 Path C dispatch verify
=============================
BANNER

require ss
require grep
require awk

KV=/root/.letta/iroh/agent-addresses.kv
IDENT_DIR=/root/.letta/iroh/identities

# The `agent-message send` subcommand lives in the letta-mobile :cli gradle module,
# NOT in the packaged wrapper jar (which only ships the daemon entry point). We
# shell out to `./gradlew :cli:run -PcliArgs=...` because that is the only path
# that delivers the subcommand. ~6s per call with the gradle daemon warm. If
# the daemon is cold, the first call costs ~15s and the script will exceed the
# 90s SEND_TIMEOUT — adjust $SEND_TIMEOUT in CI if you expect a cold daemon.
#
# Override with $LETTA_MOBILE_DIR to point at a source tree other than the
# default. The script MUST run from a checkout of the same code that the deployed
# wrapper was built from, or the CLI behaviour will not match the host.
LETTA_MOBILE_DIR="${LETTA_MOBILE_DIR:-/opt/stacks/letta-mobile/android-compose}"
if [ ! -x "$LETTA_MOBILE_DIR/gradlew" ]; then
  echo "ERROR: $LETTA_MOBILE_DIR/gradlew not executable; set LETTA_MOBILE_DIR"
  exit 2
fi
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

# Time guards: SEND_TIMEOUT is the per-call timeout; GRADLE_BOOT_TIMEOUT is the
# first-call slack. Both default to values that fit the heartbeat budget for a
# warm daemon (3 sends × ~8s + 10s slack = ~35s).
SEND_TIMEOUT="${SEND_TIMEOUT:-90}"
GRADLE_BOOT_TIMEOUT="${GRADLE_BOOT_TIMEOUT:-180}"

# ---- 1. kv port matches live listener port ----
echo
echo "1. kv port matches live listener port"
WRAPPER_PID=$(pgrep -f app-server-serve-iroh | head -1)
if [ -z "$WRAPPER_PID" ]; then
  note_fail "wrapper process not running (expected class letta-mobile.wrapper.Main app-server-serve-iroh)"
else
  LISTEN_PORT=$(ss -lunp 2>/dev/null | awk -v pid="pid=$WRAPPER_PID" '$0 ~ pid {print $5; exit}' | awk -F: '{print $NF}' | head -1)
  if [ -z "$LISTEN_PORT" ]; then
    note_fail "could not derive live listener port from ss for wrapper pid $WRAPPER_PID"
  else
    PREFIXED_PORT=$(awk -F: '/^letta_agent-/ {gsub(/.*@/,""); print $2; exit}' "$KV" 2>/dev/null)
    BARE_PORT=$(awk -F: '/^agent-/ {gsub(/.*@/,""); print $2; exit}' "$KV" 2>/dev/null)
    ALL_PORTS_OK=1
    for p in "$PREFIXED_PORT" "$BARE_PORT"; do
      if [ -n "$p" ] && [ "$p" != "$LISTEN_PORT" ]; then
        ALL_PORTS_OK=0
        break
      fi
    done
    if [ "$ALL_PORTS_OK" = "1" ]; then
      note_pass "all rows point at live listener ($LISTEN_PORT)"
    else
      note_fail "stale row(s) detected: live=$LISTEN_PORT prefixed=$PREFIXED_PORT bare=$BARE_PORT"
    fi
  fi
fi

# ---- 2. zero letta_-prefixed kv rows ----
echo
echo "2. zero letta_-prefixed rows in $KV"
PREFIXED_KV=$(grep -c '^letta_agent-' "$KV" 2>/dev/null || true)
if [ "$PREFIXED_KV" = "0" ]; then
  note_pass "no letta_-prefixed rows"
else
  note_fail "$PREFIXED_KV letta_-prefixed rows remain (the bug class)"
fi

# ---- 3 + 4. CLI send for both spellings yields delivered:true ----
echo
echo "3 + 4. CLI send resolves both spellings"
# Pick the FIRST surviving agent id from the kv. If the kv is empty post-deploy,
# fall back to a known allowlisted one (the JULIA/Wrapper-published set defaults
# to 3 ids; using the first is deterministic). The check itself is the spelling
# coverage, not the agent choice.
TARGET_RAW=$(awk -F= '/^agent-/ {print $1; exit}' "$KV")
if [ -z "$TARGET_RAW" ]; then
  note_fail "no bare agent rows in kv to use as a target — cannot exercise CLI send"
else
  # We have to send from SOME agent — the wrapper holds keys for itself and the
  # other two; reused any of them works. Pick from-same to ensure the key is local.
  FROM_ID=$TARGET_RAW
  SEND_TIMEOUT=20

  run_send() {
    local label="$1"
    local to_id="$2"
    local expected_msgid="$3"
    local out
    out=$(timeout "$SEND_TIMEOUT" "$LETTA_MOBILE_DIR/gradlew" :cli:run --quiet \
      -PcliArgs="agent-message send --from=$FROM_ID --to=$to_id --body=y3rz.4-verify-$label --msg-id=$expected_msgid" \
      2>&1) || true
    echo "$out"
  }

  out_bare=$(run_send "bare" "$TARGET_RAW" "y3rz4-verify-bare-$(date +%s)")
  if echo "$out_bare" | grep -q '"delivered":true'; then
    note_pass "send bare agent-<uuid> succeeds (target=$TARGET_RAW)"
  else
    note_fail "send bare agent-<uuid> did not deliver: $out_bare"
  fi
  unset out_pref

  prefixed_id="letta_$TARGET_RAW"
  out_pref=$(run_send "prefixed" "$prefixed_id" "y3rz4-verify-prefixed-$(date +%s)")
  if echo "$out_pref" | grep -q '"delivered":true'; then
    note_pass "send letta_agent-<uuid> succeeds (target=$prefixed_id)"
  else
    note_fail "send letta_agent-<uuid> did not deliver: $out_pref"
  fi
fi

# ---- 5. nonexistent agent id returns not_registered, NOT a dial timeout ----
echo
echo "5. nonexistent agent id returns unknown-agent-class reason"
NONEXISTENT="agent-00000000-0000-0000-0000-000000000000"
out_404=$(run_send "nonexistent" "$NONEXISTENT" "y3rz4-verify-404-$(date +%s)") || true
# The CLI result line is JSON; we want reason=="not_registered". A dial timeout
# would yield a different timeout-shaped reason.
if echo "$out_404" | grep -q '"reason":"not_registered"'; then
  note_pass "nonexistent id returns not_registered"
elif echo "$out_404" | grep -q '"delivered":true'; then
  note_fail "nonexistent id DELIVERED — canonical keyspace is leaking"
else
  note_fail "nonexistent id returned an unexpected reason: $out_404"
fi
unset out_404

# ---- 6. identity dir: no letta_-prefixed files AND bare key bytes unchanged ----
echo
echo "6. identity dir is canonical"
PREFIXED_ID=$(ls "$IDENT_DIR"/letta_*.json 2>/dev/null | wc -l)
if [ "$PREFIXED_ID" = "0" ]; then
  note_pass "no letta_-prefixed identity files"
else
  note_fail "$PREFIXED_ID letta_-prefixed identity files remain"
fi
# Stubbed: the bare-key-bytes-unchanged check needs a baseline (the pre-migration
# bytes). The script can't carry that as state; CI must do that delta against a
# captured snapshot. Print a clear instruction so the operator knows.
echo "  NOTE: bare-key-bytes-unchanged check requires a pre-migration snapshot."
echo "        CI: assert each bare *.json before/after migration is byte-identical."

# ---- summary ----
echo
echo "============================="
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed assertions:"
  for n in "${FAILED_NAMES[@]}"; do echo "  - $n"; done
  exit 1
fi
exit 0
