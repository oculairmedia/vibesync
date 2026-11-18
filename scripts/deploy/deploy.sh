#!/usr/bin/env bash
# Stage origin/main as a release, check it, swap the service to it, and ROLL BACK
# AUTOMATICALLY if the engine is not ready afterwards.
#
#   scripts/deploy/deploy.sh <expected-main-sha7>     (refuses to deploy anything else)
#
# Run the copy that is on origin/main, not a stale checkout:
#   git -C /opt/stacks/vibesync fetch -q origin
#   git -C /opt/stacks/vibesync show origin/main:scripts/deploy/deploy.sh > /tmp/deploy.sh && bash /tmp/deploy.sh <sha7>
#
# Order: the engine must be ready and quiet (no open runs, running steps, open
# scheduler contexts or eligible beads); the release tree is staged with the live
# release's .env; config load, the boot check and the engine boot check must pass
# in that tree; then the swap. After the swap the service must be running from the
# staged release, systemd must be configured for it (loaded AND on disk), AND the
# engine must report ready, or the previous release is swapped back in.
# Nothing here prints an env value.
#
# Exit status: 0 deployed; 1 stopped before the swap, nothing changed; 2 the staged
# release did not come up and the rollback is complete: the previous release is
# serving, is what systemd has loaded, is what the drop-in on disk names, and is
# ready; 3 the rollback is not complete in one of those ways.
#
# Every check that can stop the deploy goes through `gate` or an explicit
# `|| fail`. Do not read a pipeline status from outside a ( subshell ): it is
# always 0 there, and a gate written that way cannot fail (it did, until
# 2026-11-15; tests/unit/deploy-script.test.ts pins both).
set -u
# Host tools: Node 20 for the native module build, Bun to run the service.
# VIBESYNC_DEPLOY_TOOL_PATH replaces them; tests point it at stand-ins so that no
# test can reach the real bun, npm, systemctl or tracker.
export PATH="${VIBESYNC_DEPLOY_TOOL_PATH:-/root/.nvm/versions/node/v20.20.2/bin:/root/.bun/bin}:$PATH" BEADS_ACTOR=pm-vibesync
EXPECT="${1:-}"
fail(){ echo "STOP (nothing swapped): $*"; exit 1; }

# gate <name> <command...>: run the command, show its last line, and stop the
# deploy unless it exits 0.
gate(){
  local name=$1; shift
  local out status
  out=$(mktemp)
  "$@" >"$out" 2>&1
  status=$?
  tail -1 "$out" | cut -c1-160
  rm -f "$out"
  [ "$status" = "0" ] || fail "$name failed (exit $status)"
}

# run_swap <release-dir> <lines>: point the service at that release and restart
# it. Shows the last lines of swap.sh's output and returns swap.sh's own status.
run_swap(){
  local dir=$1 lines=$2 out status
  out=$(mktemp)
  bash "$dir/scripts/deploy/swap.sh" "$dir" >"$out" 2>&1
  status=$?
  tail -"$lines" "$out"
  rm -f "$out"
  return "$status"
}

# serving: the directory the service's main process runs from (its release tree); empty when it has none.
serving(){
  local pid
  pid=$(systemctl show -p MainPID --value vibesync.service)
  [ -n "$pid" ] && [ "$pid" != "0" ] || return 0
  readlink "/proc/$pid/cwd" 2>/dev/null
}

# Which release systemd will start the service from has TWO records, and swap.sh changes them
# in two steps: it writes the drop-in on disk, then `daemon-reload` makes systemd load it. A swap
# that fails between the two leaves them disagreeing, and `systemctl show` reports only the
# loaded one; the next reload or reboot follows the file.
UNIT_DROPIN=${VIBESYNC_UNIT_DROPIN:-/etc/systemd/system/vibesync.service.d/release.conf}
# loaded: the release tree in systemd's loaded configuration.
loaded(){ systemctl show -p WorkingDirectory --value vibesync.service; }
# on_disk: the release tree the drop-in file names.
on_disk(){ sed -n 's/^WorkingDirectory=//p' "$UNIT_DROPIN" 2>/dev/null | tail -1; }

# ready: the engine answers /health with orchestration ready.
ready(){ curl -s --max-time 8 http://127.0.0.1:3099/health | tr -d '[:space:]' | grep -c '"orchestration":{"ready":true}'; }

# on_release <dir>: the service runs from that release, systemd has it loaded, the drop-in on
# disk names it, and the engine is ready.
on_release(){ [ "$(serving)" = "$1" ] && [ "$(loaded)" = "$1" ] && [ "$(on_disk)" = "$1" ] && [ "$(ready)" = "1" ]; }

# Sourced by tests with VIBESYNC_DEPLOY_LIB=1: define the helpers, deploy nothing.
if [ "${VIBESYNC_DEPLOY_LIB:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

REPO_DIR=${VIBESYNC_REPO_DIR:-/opt/stacks/vibesync}
STACKS_DIR=$(dirname "$REPO_DIR")
BD=${VIBESYNC_BD:-/usr/local/bin/bd}
# After a swap, how long to wait for the release to be serving and ready: tries x pause (seconds).
READY_TRIES=${VIBESYNC_DEPLOY_READY_TRIES:-60}
READY_PAUSE=${VIBESYNC_DEPLOY_READY_PAUSE:-2}
cd "$REPO_DIR" || exit 1
timeout 10 systemctl is-system-running >/dev/null 2>&1; [ $? -ne 124 ] || fail "systemctl does not answer"
git fetch -q origin || fail "git fetch origin failed: origin/main in this checkout may be stale"
M=$(git rev-parse --short origin/main); R="$REPO_DIR/.letta/worktrees/stage-$M"
[ -n "$EXPECT" ] && [ "$M" = "$EXPECT" ] || fail "origin/main is $M, expected ${EXPECT:-<none given>}"
P=$(systemctl show -p MainPID --value vibesync.service); LIVE=$(readlink /proc/$P/cwd)
echo "live: $(basename $LIVE) pid=$P -> staging $M"
git log --format='  %h %s' $(basename $LIVE | sed 's/stage-//')..origin/main | cut -c1-110
[ "$(basename $LIVE)" != "stage-$M" ] || fail "stage-$M is already live"
[ "$(ready)" = "1" ] || fail "the engine is not ready BEFORE the swap; fix that first"
quiet(){ echo "$("$BD" list --type molecule_root --status open,in_progress --json --limit 0 | jq length)/$("$BD" list --type molecule_step --status in_progress --json --limit 0 | jq length)/$("$BD" list --label vibesync:sling-context --status open --include-ephemeral --json --limit 0 2>/dev/null | jq length)/$("$BD" list --label scheduler:eligible --status open --json --limit 0 | jq length)"; }
Q=$(quiet); echo "quiet check (open roots/running steps/open contexts/eligible): $Q"; [ "$Q" = "0/0/0/0" ] || fail "engine not quiet"
BEADS_BEFORE_FILE=$(mktemp); ls -d "$STACKS_DIR"/*/.beads 2>/dev/null | LC_ALL=C sort > "$BEADS_BEFORE_FILE"
if [ -e "$R" ]; then
  [ "$(git -C "$R" rev-parse --short HEAD)" = "$M" ] && [ -z "$(git -C "$R" status --short | grep -v node_modules)" ] || fail "$R exists but is not a clean checkout of $M"
  echo "reusing existing release tree $R"
else
  git worktree add -q --detach "$R" "$M" || fail "worktree add"
fi
cp "$LIVE/.env" "$R/.env" && chmod --reference="$LIVE/.env" "$R/.env" || fail "env copy"
# The PM wake state must live outside the release tree, or every deploy starts with an empty one.
grep -qE '^VIBESYNC_PM_WAKE_STATE_PATH=/' "$R/.env" || fail "the release .env does not pin VIBESYNC_PM_WAKE_STATE_PATH to an absolute path"
(cd "$R" && bun install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 && { [ -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ] || npm rebuild better-sqlite3 >/dev/null 2>&1; }) || fail "install in the release tree"
CFG=$(cd "$R" && set -a && . ./.env && set +a && bun -e "import { loadConfig } from './src/app/config.ts'; loadConfig(); console.log('config ok');" 2>&1 | grep -v letta-code-patch | tail -1)
echo "config loader: $CFG"; [ "$CFG" = "config ok" ] || fail "config does not load"
ok=0; for p in 3571 3572 3573; do (cd "$R" && BOOT_CHECK_PORT=$p scripts/ci/boot-check.sh 60 >/dev/null 2>&1) && ok=$((ok+1)); [ $ok -ge 2 ] && break; done
echo "boot-check (orchestration off) passes: $ok"; [ "$ok" -ge 2 ] || fail "boot check"
gate "role persona check" bash -c 'cd "$1" && set -a && . ./.env && set +a && bun scripts/roles/check-role-agents.ts --project vibesync' _ "$R"
gate "engine boot check (orchestration on, Dolt stopped)" env BOOT_CHECK_PORT=3574 timeout 200 bash -c 'cd "$1" && scripts/ci/engine-boot-check.sh "$2" 120' _ "$R" "$BD"
(cd "$R" && git status --short | grep -v node_modules | grep -q .) && fail "release tree dirty after checks"
Q=$(quiet); [ "$Q" = "0/0/0/0" ] || fail "engine no longer quiet: $Q"
echo "ROLLBACK target: $LIVE"; echo "swapping at $(date -u +%H:%M:%SZ)"
run_swap "$R" 3 || echo "SWAP FAILED: swap.sh exited non-zero for $(basename "$R"); the engine check below decides whether to roll back"
# "Ready" is not enough, and neither is a new PID: the service can restart by itself on the PREVIOUS
# release while the swap fails. The ready process must be running from the staged release, and the
# staged release must be what systemd has loaded and what the drop-in on disk names.
STAGED=$(realpath "$R"); up=0
for i in $(seq 1 "$READY_TRIES"); do on_release "$STAGED" && { up=1; break; }; sleep "$READY_PAUSE"; done
NP=$(systemctl show -p MainPID --value vibesync.service)
J=$(journalctl -u vibesync.service _PID=$NP --no-pager -o cat 2>/dev/null)
echo "new pid=$NP cwd=$(readlink /proc/$NP/cwd 2>/dev/null | sed 's|.*/||'); engine ready after the swap: $([ $up = 1 ] && echo yes || echo NO)"
echo "boot lines: $(echo "$J" | grep -oE "Orchestration plane initialized|continuing without it|the Dolt server is down|Dolt server restarted and verified|retrying with backoff" | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
if [ $up != 1 ]; then
  echo "STAGED RELEASE NOT SERVING AND READY: rolling back to $(basename $LIVE) at $(date -u +%H:%M:%SZ)"
  echo "$J" | jq -rc 'select(.level=="warn" or .level=="error")|"  \(.time[11:19]) \(.msg[0:110]) :: \((.err.message // "")[0:90])"' 2>/dev/null | tail -6
  rolled=1
  run_swap "$LIVE" 2 || rolled=0
  back=0
  for i in $(seq 1 "$READY_TRIES"); do on_release "$LIVE" && { back=1; break; }; sleep "$READY_PAUSE"; done
  NOW=$(serving); SET=$(loaded); DISK=$(on_disk)
  echo "after rollback: serving=$(basename "${NOW:-nothing}"); systemd loaded=$(basename "${SET:-nothing}"); drop-in on disk=$(basename "${DISK:-nothing}"); previous release serving, configured and ready: $([ $back = 1 ] && echo yes || echo NO)"
  echo ".beads folders created by the rollback's scan: $(comm -13 "$BEADS_BEFORE_FILE" <(ls -d "$STACKS_DIR"/*/.beads 2>/dev/null | LC_ALL=C sort) | tr '\n' ';')"
  # Decided from what is observed, not from swap.sh's exit status:
  # 2 = the previous release is serving, is what systemd has loaded AND what the drop-in on disk names, and is ready.
  # 3 = any of those is not so: the service needs a person now.
  if [ "$back" = "1" ]; then exit 2; fi
  echo "ROLLBACK FAILED (swap.sh ok: $([ "$rolled" = "1" ] && echo yes || echo NO); serving: $(basename "${NOW:-nothing}"); systemd loaded: $(basename "${SET:-nothing}"); drop-in on disk: $(basename "${DISK:-nothing}")). Run: bash $LIVE/scripts/deploy/swap.sh $LIVE"
  exit 3
fi
echo "scan-time provisioning lines in the new process's log: $(echo "$J" | grep -ciE "Rig auto-provision")"
echo ".beads folders that appeared during the deploy: [$(comm -13 "$BEADS_BEFORE_FILE" <(ls -d "$STACKS_DIR"/*/.beads 2>/dev/null | LC_ALL=C sort) | tr '\n' ';')]"
WAKE=$(grep -E '^VIBESYNC_PM_WAKE_STATE_PATH=' "$R/.env" | cut -d= -f2-)
[ -n "$WAKE" ] && echo "pm-wake state: $WAKE holds projects $(jq -c 'keys' "$WAKE" 2>/dev/null)"
echo "DEPLOYED stage-$M pid=$NP at $(date -u +%H:%M:%SZ); rollback: bash scripts/deploy/swap.sh $LIVE"
