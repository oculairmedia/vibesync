#!/usr/bin/env bash
# Model-check the TLA+ specs in specs/ with TLC (vibesync-6zos.3).
#
#   scripts/ci/tlc.sh [path-to-tla2tools.jar]
#
# Runs every specs/*.cfg against specs/MC.tla and compares the result with
# specs/EXPECTED. Exits 0 only when every configuration ends exactly as listed
# there: the ones that must pass pass, and the ones that must fail report the
# named invariant or property. A configuration that is not listed, or a listed
# one that is missing, is a failure too.
#
# Without an argument the pinned tla2tools.jar is downloaded; either way its
# checksum is verified before it is run. Needs Java 11 or newer on PATH (or
# JAVA=/path/to/java).
set -u

TLA2TOOLS_VERSION=1.7.4
TLA2TOOLS_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
SPECS=${TLC_SPECS_DIR:-$REPO_DIR/specs}
EXPECTED=${TLC_EXPECTED:-$SPECS/EXPECTED}
JAVA=${JAVA:-java}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die(){ echo "tlc: $*" >&2; exit 2; }

command -v "$JAVA" >/dev/null 2>&1 || die "no Java found ($JAVA)"
[ -f "$EXPECTED" ] || die "missing $EXPECTED"

JAR=${1:-}
if [ -z "$JAR" ]; then
  JAR="$WORK/tla2tools.jar"
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA2TOOLS_VERSION/tla2tools.jar" || die "could not download tla2tools $TLA2TOOLS_VERSION"
fi
[ -s "$JAR" ] || die "no jar at $JAR"
# Absolute before anything changes directory: TLC runs from specs/, and a relative jar path would point there.
JAR=$(realpath "$JAR")
echo "$TLA2TOOLS_SHA256  $JAR" | sha256sum --check --quiet >/dev/null 2>&1 || die "checksum mismatch for $JAR (expected $TLA2TOOLS_SHA256)"

# The two lists must name the same configurations.
listed=$(grep -vE '^\s*(#|$)' "$EXPECTED" | awk '{print $1}' | LC_ALL=C sort)
present=$(cd "$SPECS" && ls *.cfg 2>/dev/null | sed 's/\.cfg$//' | LC_ALL=C sort)
[ -n "$present" ] || die "no *.cfg in $SPECS"
if [ "$listed" != "$present" ]; then
  echo "tlc: FAIL - specs/EXPECTED and the *.cfg files do not name the same configurations:" >&2
  diff <(echo "$listed") <(echo "$present") | sed 's/^</  only in EXPECTED:/; s/^>/  only as a .cfg:/' | grep -E '^  only' >&2
  exit 1
fi

bad=0
count=0
while read -r config want name; do
  count=$((count + 1))
  out="$WORK/$config.out"
  # One worker: the search order, and so the violation reported first, is the same on every run.
  (cd "$SPECS" && "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config "$config.cfg" -workers 1 -deadlock -metadir "$WORK/states-$config" MC.tla) >"$out" 2>&1
  status=$?
  if grep -q 'Model checking completed. No error has been found.' "$out" && [ "$status" = "0" ]; then
    got="pass"
  else
    violated=$(grep -oE '(Invariant|property) [A-Za-z0-9_]+ is violated' "$out" | head -1 | awk '{print $2}')
    if [ -n "$violated" ]; then got="fail $violated"; else got="error (TLC exit $status: $(grep -m1 -E 'Error|Exception' "$out" | cut -c1-120))"; fi
  fi
  expect="$want${name:+ $name}"
  states=$(grep -oE '[0-9]+ distinct states found' "$out" | tail -1)
  if [ "$got" = "$expect" ]; then
    echo "tlc: ok    $config: $got (${states:-no state count})"
  else
    echo "tlc: WRONG $config: expected '$expect', got '$got'" >&2
    grep -E '^State [0-9]+:' "$out" | sed -E 's/^State ([0-9]+): <([A-Za-z]+).*/\2/' | tr '\n' '>' | sed 's/^/        trace: /; s/>$/\n/' >&2
    bad=$((bad + 1))
  fi
done < <(grep -vE '^\s*(#|$)' "$EXPECTED")

if [ "$bad" != "0" ]; then
  echo "tlc: FAIL - $bad of $count configurations did not end as specs/EXPECTED says" >&2
  exit 1
fi
echo "tlc: all $count configurations ended as expected"
