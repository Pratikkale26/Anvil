#!/usr/bin/env bash
# sweep-orch.sh — serial, WSL-safe orchestrator for the Anvil internet sweep.
#
# Manifest (TSV, one program per line): name<TAB>srcPath<TAB>crateDir<TAB>mode
#   mode = A  -> Tier A only (parse+emit+validate+auto-scenario), no cargo.
#   mode = B  -> Tier A + byte-equal build (cargo-build-sbf x2), SERIAL.
#   crateDir = "-" means synthesize the Anchor Cargo.toml (single-file demos).
#
# Results: appends one JSON line per program to $RESULTS.
# Memory guard: before any Tier-B build, refuse to start if available RAM is
# below MIN_FREE_MB (protects WSL). Waits up to MAX_WAIT_S, else marks skipped.
set -u
cd "$(dirname "$0")/.." || exit 1   # api/

MANIFEST="${1:?usage: sweep-orch.sh <manifest> <results.jsonl>}"
RESULTS="${2:?usage: sweep-orch.sh <manifest> <results.jsonl>}"
MIN_FREE_MB="${MIN_FREE_MB:-2000}"
MAX_WAIT_S="${MAX_WAIT_S:-180}"
TIER_A_TIMEOUT="${TIER_A_TIMEOUT:-120}"
TIER_B_TIMEOUT="${TIER_B_TIMEOUT:-700}"

free_mb() { free -m | awk '/^Mem:/{print $7}'; }

total=$(grep -cve '^[[:space:]]*$' "$MANIFEST")
i=0
while IFS=$'\t' read -r name src crate mode; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue;; esac
  i=$((i+1))
  ts=$(date +%H:%M:%S)
  if [ "$mode" = "B" ]; then
    # memory guard
    waited=0
    while [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; do
      if [ "$waited" -ge "$MAX_WAIT_S" ]; then
        echo "[$ts] [$i/$total] $name — SKIP (low mem $(free_mb)MB < ${MIN_FREE_MB}MB after ${MAX_WAIT_S}s)"
        echo "{\"name\":\"$name\",\"stage\":\"skipped-low-mem\",\"freeMb\":$(free_mb)}" >> "$RESULTS"
        continue 2
      fi
      sleep 10; waited=$((waited+10))
    done
    args=(--byte-equal)
    [ "$crate" != "-" ] && args+=(--anchor-crate-dir "$crate")
    to="$TIER_B_TIMEOUT"
    echo "[$ts] [$i/$total] $name — byte-equal (free $(free_mb)MB)"
  else
    args=()
    to="$TIER_A_TIMEOUT"
    echo "[$ts] [$i/$total] $name — tier-A"
  fi

  out=$(timeout "$to" bun scripts/sweep-one.ts "$src" --name "$name" "${args[@]}" 2>/dev/null)
  rc=$?
  line=$(printf '%s\n' "$out" | grep -m1 '__SWEEP_RESULT__' | sed 's/^.*__SWEEP_RESULT__ //')
  if [ -z "$line" ]; then
    line="{\"name\":\"$name\",\"stage\":\"no-result\",\"rc\":$rc}"
  fi
  echo "$line" >> "$RESULTS"
  # brief verdict to stdout
  verdict=$(printf '%s' "$line" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin)
  be=d.get('byteEqual'); v=(be or {}).get('verdict') if isinstance(be,dict) else None
  em=(d.get('emit') or {}).get('outcome')
  print(f\"    -> stage={d.get('stage')} emit={em} auto={(d.get('autoScenario') or {}).get('ok')} byteEqual={v}\")
except Exception as e:
  print('    -> parse-err')" 2>/dev/null)
  echo "$verdict"
done < "$MANIFEST"
echo "DONE: $i programs -> $RESULTS"
