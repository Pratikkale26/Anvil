#!/usr/bin/env bash
# Stage-2: cargo build each scaffold under /tmp/anvil-batch/<contract>/<target>/.
# Runs N builds in parallel. Writes per-build status to <dir>/.build-status
# and per-build log tail to <dir>/.build-log.

set -u
ROOT="/tmp/anvil-batch"
PARALLEL="${PARALLEL:-4}"
TIMEOUT="${TIMEOUT:-300}"

build_one() {
  local dir="$1"
  local label="${dir#$ROOT/}"
  if [ ! -f "$dir/Cargo.toml" ]; then
    echo "$label: SKIP (no Cargo.toml)"
    echo "skip" > "$dir/.build-status"
    return
  fi
  local log="$dir/.build-log"
  if timeout "$TIMEOUT" cargo build --manifest-path "$dir/Cargo.toml" >"$log" 2>&1; then
    echo "$label: PASS"
    echo "pass" > "$dir/.build-status"
  else
    local rc=$?
    echo "$label: FAIL (rc=$rc)"
    echo "fail rc=$rc" > "$dir/.build-status"
    # keep only last 60 lines of log
    tail -60 "$log" > "$log.tmp" && mv "$log.tmp" "$log"
  fi
}

export -f build_one
export ROOT TIMEOUT

# Find all scaffolds with Cargo.toml
mapfile -t DIRS < <(find "$ROOT" -mindepth 2 -maxdepth 2 -type d | sort)

echo "Building ${#DIRS[@]} scaffolds, parallel=$PARALLEL, timeout=${TIMEOUT}s"
printf '%s\n' "${DIRS[@]}" | xargs -n1 -P "$PARALLEL" -I{} bash -c 'build_one "$@"' _ {}

echo
echo "=== Summary ==="
pass=0; fail=0; skip=0
for d in "${DIRS[@]}"; do
  s=$(cat "$d/.build-status" 2>/dev/null || echo "?")
  case "$s" in
    pass) pass=$((pass+1)) ;;
    skip) skip=$((skip+1)) ;;
    *) fail=$((fail+1)) ;;
  esac
done
echo "PASS=$pass FAIL=$fail SKIP=$skip TOTAL=${#DIRS[@]}"
