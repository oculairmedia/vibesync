#!/usr/bin/env bash
# Migration: rename "huly-vibe-sync" → "vibesync" across the bd database,
# the empty sqlite registry file, and remaining code references.
#
# Steps (in order, atomic where possible):
#   1. Stop the bd Dolt server
#   2. Rewrite every issue id in the bd Dolt schema
#      (issues + dependencies + events + labels + child_counters
#       + text columns: description, notes, close_reason)
#   3. Rename the Dolt database directory huly_vibe_sync → vibesync
#   4. Rename the empty sqlite registry file huly-vibe-sync.db → vibesync.db
#   5. Update the 3 code references to the sqlite filename
#   6. Restart bd (it spawns a fresh Dolt server pointed at the new dir name)
#   7. Verify bd CLI sees the migrated data
#
# Usage:
#   scripts/migrate/rename-huly-to-vibesync.sh --dry-run    # report only
#   scripts/migrate/rename-huly-to-vibesync.sh              # execute
#
# Idempotent: re-running after a successful migration is a no-op.
#
# Reversibility: each step is reversible in isolation (rename dirs back,
# rewrite SQL with the prefixes swapped). The destination state has no
# foreign-key constraints, so a partial run can be resumed by re-running.

set -euo pipefail

VIBESYNC_ROOT="${VIBESYNC_ROOT:-/opt/stacks/vibesync}"
OLD_PREFIX="huly-vibe-sync"
NEW_PREFIX="vibesync"
OLD_DB_DIR_NAME="huly_vibe_sync"
NEW_DB_DIR_NAME="vibesync"
OLD_SQLITE="huly-vibe-sync.db"
NEW_SQLITE="vibesync.db"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,/^$/p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

cd "$VIBESYNC_ROOT"

say() { printf '[migrate] %s\n' "$1"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

# --- step 0: preflight ----------------------------------------------------

beads_dir="$VIBESYNC_ROOT/.beads"
old_db_path="$beads_dir/dolt/$OLD_DB_DIR_NAME"
new_db_path="$beads_dir/dolt/$NEW_DB_DIR_NAME"
old_sqlite_path="$VIBESYNC_ROOT/$OLD_SQLITE"
new_sqlite_path="$VIBESYNC_ROOT/$NEW_SQLITE"

if [ ! -d "$beads_dir" ]; then
  echo "no .beads/ at $beads_dir — not a bd-backed project" >&2
  exit 2
fi

# Already migrated?
if [ ! -d "$old_db_path" ] && [ -d "$new_db_path" ]; then
  say "already migrated (Dolt dir is $new_db_path)"
  if [ -f "$old_sqlite_path" ]; then
    say "sqlite file still on old name — proceeding to finish that half"
  else
    say "sqlite file also already migrated — nothing to do"
    exit 0
  fi
fi

# --- step 1: stop bd Dolt server -----------------------------------------

if [ -f "$beads_dir/dolt-server.pid" ]; then
  say "stopping bd Dolt server"
  run "bd dolt stop || true"
  sleep 2
fi

# --- step 2: SQL prefix rewrite (only if old dir still exists) -----------

if [ -d "$old_db_path" ]; then
  say "rewriting issue ids in Dolt schema"
  cd "$old_db_path"
  if [ "$DRY_RUN" -eq 1 ]; then
    dolt sql -q "
      SELECT 'issues PK rows to update' AS what, COUNT(*) AS n FROM issues WHERE id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'deps issue_id', COUNT(*) FROM dependencies WHERE issue_id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'deps depends_on_id', COUNT(*) FROM dependencies WHERE depends_on_id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'events issue_id', COUNT(*) FROM events WHERE issue_id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'labels issue_id', COUNT(*) FROM labels WHERE issue_id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'child_counters parent_id', COUNT(*) FROM child_counters WHERE parent_id LIKE '$OLD_PREFIX-%'
      UNION ALL SELECT 'issues.description text', COUNT(*) FROM issues WHERE description LIKE '%$OLD_PREFIX-%'
      UNION ALL SELECT 'issues.notes text', COUNT(*) FROM issues WHERE notes LIKE '%$OLD_PREFIX-%'
      UNION ALL SELECT 'issues.close_reason text', COUNT(*) FROM issues WHERE close_reason LIKE '%$OLD_PREFIX-%';
    "
  else
    # Order: rewrite FK-shaped columns first, then the PK column.
    # No real FK constraints — but doing it this way means a partial run
    # still leaves a consistent graph.
    dolt sql -q "
      UPDATE dependencies SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE dependencies SET depends_on_id = REPLACE(depends_on_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE depends_on_id LIKE '$OLD_PREFIX-%';
      UPDATE events SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE labels SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE child_counters SET parent_id = REPLACE(parent_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE parent_id LIKE '$OLD_PREFIX-%';
      UPDATE comments SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE compaction_snapshots SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE interactions SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE issue_snapshots SET issue_id = REPLACE(issue_id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE issue_id LIKE '$OLD_PREFIX-%';
      UPDATE blocked_issues SET id = REPLACE(id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE id LIKE '$OLD_PREFIX-%';
      UPDATE ready_issues SET id = REPLACE(id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE id LIKE '$OLD_PREFIX-%';
      UPDATE issues SET description = REPLACE(description, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE description LIKE '%$OLD_PREFIX-%';
      UPDATE issues SET notes = REPLACE(notes, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE notes LIKE '%$OLD_PREFIX-%';
      UPDATE issues SET close_reason = REPLACE(close_reason, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE close_reason LIKE '%$OLD_PREFIX-%';
      UPDATE issues SET id = REPLACE(id, '$OLD_PREFIX-', '$NEW_PREFIX-')
        WHERE id LIKE '$OLD_PREFIX-%';
    "
    say "issue id rewrites committed (Dolt's auto-commit batched them)"
  fi
  cd "$VIBESYNC_ROOT"
fi

# --- step 3: rename Dolt database directory -------------------------------

if [ -d "$old_db_path" ] && [ ! -d "$new_db_path" ]; then
  say "renaming Dolt database dir $OLD_DB_DIR_NAME → $NEW_DB_DIR_NAME"
  run "mv '$old_db_path' '$new_db_path'"
fi

# --- step 4: rename empty sqlite registry file ----------------------------

if [ -f "$old_sqlite_path" ] && [ ! -f "$new_sqlite_path" ]; then
  say "renaming sqlite $OLD_SQLITE → $NEW_SQLITE"
  run "mv '$old_sqlite_path' '$new_sqlite_path'"
fi

# --- step 5: update sqlite-path code references ---------------------------

declare -a sqlite_ref_files=(
  "$VIBESYNC_ROOT/scripts/preflight/bd-registry-audit.ts"
  "$VIBESYNC_ROOT/AGENTS.md"
  "$VIBESYNC_ROOT/docs/architecture/bd-conventions.md"
)

for f in "${sqlite_ref_files[@]}"; do
  if [ -f "$f" ] && grep -q "$OLD_SQLITE" "$f"; then
    say "updating sqlite filename ref in $f"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] sed -i %s\n' "$f"
    else
      sed -i "s/$OLD_SQLITE/$NEW_SQLITE/g" "$f"
    fi
  fi
done

# --- step 6: restart bd ---------------------------------------------------

if [ "$DRY_RUN" -eq 0 ]; then
  say "starting bd Dolt server with new database name"
  bd dolt start || true
  sleep 2
fi

# --- step 7: verify -------------------------------------------------------

if [ "$DRY_RUN" -eq 0 ]; then
  say "verifying via bd CLI"
  if bd list --status closed --limit 5 2>&1 | grep -q "^✓.*$NEW_PREFIX-" ; then
    say "bd sees migrated IDs"
  else
    echo "[migrate] WARN: bd did not surface new prefix in 'bd list --status closed --limit 5'" >&2
  fi
  remaining_old=$(cd "$new_db_path" 2>/dev/null && dolt sql -q "SELECT COUNT(*) FROM issues WHERE id LIKE '$OLD_PREFIX-%'" 2>&1 | grep -oE '[0-9]+' | tail -1 || echo "?")
  remaining_new=$(cd "$new_db_path" 2>/dev/null && dolt sql -q "SELECT COUNT(*) FROM issues WHERE id LIKE '$NEW_PREFIX-%'" 2>&1 | grep -oE '[0-9]+' | tail -1 || echo "?")
  say "issues with old prefix: $remaining_old"
  say "issues with new prefix: $remaining_new"
fi

say "done"
