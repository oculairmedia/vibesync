#!/usr/bin/env bash
# Point vibesync.service at a staged release worktree and restart it.
#
#   scripts/deploy/swap.sh <release-dir>
#
# <release-dir> must be a git worktree with dependencies installed and its
# .env in place (stage first; this script does not build). The previous
# WorkingDirectory is printed before the swap; ROLLBACK is the same script
# with that path. Restart only when no formula runs are in flight.
set -euo pipefail

RELEASE_DIR=${1:?usage: swap.sh <release-dir>}
RELEASE_DIR=$(realpath "$RELEASE_DIR")
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
UNIT_DIR=/etc/systemd/system/vibesync.service.d
TEMPLATE="$REPO_DIR/deploy/systemd/vibesync.service.d/release.conf.template"
[ -f "$REPO_DIR/deploy/systemd/vibesync.service" ] || { echo "missing unit in $REPO_DIR" >&2; exit 2; }

[ -d "$RELEASE_DIR/.git" ] || [ -f "$RELEASE_DIR/.git" ] || { echo "not a git worktree: $RELEASE_DIR" >&2; exit 2; }
[ -f "$RELEASE_DIR/.env" ] || { echo "missing $RELEASE_DIR/.env" >&2; exit 2; }
[ -d "$RELEASE_DIR/node_modules" ] || { echo "missing node_modules in $RELEASE_DIR (stage first)" >&2; exit 2; }
[ -f "$TEMPLATE" ] || { echo "missing template $TEMPLATE" >&2; exit 2; }

PREV=$(systemctl show -p WorkingDirectory --value vibesync.service)
echo "release:  $RELEASE_DIR @ $(git -C "$RELEASE_DIR" rev-parse --short HEAD)"
echo "previous: $PREV"
echo "ROLLBACK: $0 $PREV"

install -m 0644 "$REPO_DIR/deploy/systemd/vibesync.service" /etc/systemd/system/vibesync.service
mkdir -p "$UNIT_DIR"
TMP=$(mktemp "$UNIT_DIR/.release.conf.XXXXXX")
sed "s#@RELEASE_DIR@#$RELEASE_DIR#g" "$TEMPLATE" > "$TMP"
mv "$TMP" "$UNIT_DIR/release.conf"
# The hand-written drop-in from 2026-07-21 sets the same keys; retire it so
# exactly one drop-in decides the release.
if [ -f "$UNIT_DIR/clean-main.conf" ]; then
  mv "$UNIT_DIR/clean-main.conf" "$UNIT_DIR/clean-main.conf.retired"
fi

systemctl daemon-reload
systemctl restart vibesync.service
PID=$(systemctl show -p MainPID --value vibesync.service)
echo "pid:      $PID"
echo "cwd:      $(readlink "/proc/$PID/cwd")"
