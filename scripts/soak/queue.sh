#!/usr/bin/env bash
set -u

refuse() { echo "Refused: $*; no writes made, bead not labelled" >&2; exit 1; }
partial() { echo "Failed: $*; worktree/branch may exist at $worktree ($branch), tracker updates and report removal may have occurred; label may have been attempted. Inspect before cleanup." >&2; exit 2; }

[ "$#" -eq 3 ] || refuse 'usage: queue.sh <bead-id> <brief-file> <branch-name>'
bead=$1 brief=$2 branch=$3
[[ "$bead" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuse 'invalid bead id'
[[ "$brief" = /* ]] || brief="$PWD/$brief"
repo=${VIBESYNC_REPO_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
bd=${VIBESYNC_BD:-bd}
health=${VIBESYNC_HEALTH_URL:-http://127.0.0.1:3099/health}
report_dir=${VIBESYNC_SOAK_REPORT_DIR:-/tmp}
worktree="$repo/.letta/worktrees/q-$bead"
cd "$repo" || refuse 'repository unavailable'
[ -s "$brief" ] && [ -f "$brief" ] || refuse 'brief missing or empty'
response=$(curl -fsS --max-time 8 "$health") || refuse 'health unavailable'
jq -e '.orchestration.ready == true' <<<"$response" >/dev/null || refuse 'health not ready or malformed'
roots=$("$bd" list --type molecule_root --status open,in_progress --json --limit 0) || refuse 'cannot query molecules'
jq -e 'type == "array" and all(.[]; type == "object" and (.metadata | type == "object"))' <<<"$roots" >/dev/null || refuse 'malformed molecules'
jq -e --arg bead "$bead" 'any(.[]; .metadata.exec.motivating_bead == $bead)' <<<"$roots" >/dev/null && refuse 'open molecule for bead'
contexts=$("$bd" list --label vibesync:sling-context --status open --include-ephemeral --json --limit 0) || refuse 'cannot query sling contexts'
jq -e 'type == "array" and all(.[]; type == "object" and (.description | type == "string") and ((.description | (try fromjson catch null) | type) == "object"))' <<<"$contexts" >/dev/null || refuse 'malformed sling contexts'
jq -e --arg bead "$bead" 'any(.[]; (.description | fromjson | .work_bead_id) == $bead)' <<<"$contexts" >/dev/null && refuse 'open sling context for bead'
issue=$("$bd" show "$bead" --json) || refuse 'cannot query bead'
jq -e --arg bead "$bead" 'type == "array" and length == 1 and .[0].id == $bead and (.[0].labels == null or (.[0].labels | type == "array"))' <<<"$issue" >/dev/null || refuse 'malformed bead'
jq -e '.[0].labels // [] | index("scheduler:eligible") != null' <<<"$issue" >/dev/null && refuse 'bead already eligible'
[ ! -e "$worktree" ] && [ ! -L "$worktree" ] || refuse 'worktree exists'
git check-ref-format --branch "$branch" >/dev/null 2>&1 || refuse 'invalid branch'
git show-ref --verify --quiet "refs/heads/$branch"
status=$?
[ "$status" -eq 1 ] || { [ "$status" -eq 0 ] && refuse 'branch exists'; refuse 'cannot check branch'; }

git fetch origin || partial 'fetch failed'
base=$(git rev-parse origin/main) || partial 'cannot resolve origin/main'
git worktree add -b "$branch" "$worktree" origin/main || partial 'worktree creation failed'
(cd "$worktree" && bun install --frozen-lockfile --ignore-scripts && npm rebuild better-sqlite3) || partial 'dependency installation failed'
[ -f "$worktree/node_modules/vitest/vitest.mjs" ] || partial 'vitest missing'
"$bd" update "$bead" --body-file "$brief" || partial 'brief update failed'
issue=$("$bd" show "$bead" --json) || partial 'brief read-back failed'
jq -e --rawfile brief "$brief" 'length == 1 and (.[0].description | type == "string") and ((.[0].description | sub("\\s+$"; "")) == ($brief | sub("\\s+$"; "")))' <<<"$issue" >/dev/null || partial 'brief read-back differs'
"$bd" update "$bead" --set-metadata "workdir=$worktree" --set-metadata step_timeout_ms=1500000 || partial 'metadata update failed'
issue=$("$bd" show "$bead" --json) || partial 'metadata read-back failed'
jq -e --arg worktree "$worktree" 'length == 1 and .[0].metadata.workdir == $worktree and (.[0].metadata.step_timeout_ms | tostring) == "1500000"' <<<"$issue" >/dev/null || partial 'metadata read-back differs'
rm -f -- "$report_dir/vitest-$bead.json" || partial 'report removal failed'
"$bd" update "$bead" --add-label scheduler:eligible || partial 'label update failed'
printf '%s %s %s %s\n' "$bead" "$worktree" "$branch" "$base"
