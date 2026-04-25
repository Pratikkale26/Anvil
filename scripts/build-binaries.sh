#!/usr/bin/env bash
# Build standalone Anvil binaries for linux-x64, darwin-x64, darwin-arm64,
# and windows-x64 using `bun build --compile`. Output goes to ./dist/.
#
# Run from the repo root or anywhere — the script resolves its own path.
#
#   bash scripts/build-binaries.sh
#
# Note: bun >= 1.1 is required for cross-target --compile.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENTRY="$ROOT_DIR/cli/anvil.ts"
OUT_DIR="$ROOT_DIR/dist"

if [ ! -f "$ENTRY" ]; then
  echo "error: cli entry not found at $ENTRY" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed or not on PATH" >&2
  echo "  install: https://bun.sh/" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# target triplets: bun-target  output-name
TARGETS=(
  "bun-linux-x64        anvil-linux-x64"
  "bun-darwin-x64       anvil-darwin-x64"
  "bun-darwin-arm64     anvil-darwin-arm64"
  "bun-windows-x64      anvil-win-x64.exe"
)

echo "Building Anvil binaries from $ENTRY"
echo "Output directory: $OUT_DIR"
echo

for entry in "${TARGETS[@]}"; do
  # shellcheck disable=SC2206
  parts=($entry)
  target="${parts[0]}"
  name="${parts[1]}"
  outfile="$OUT_DIR/$name"

  echo "  -> $target  ($name)"
  bun build "$ENTRY" \
    --compile \
    --target="$target" \
    --outfile="$outfile" \
    --minify
done

echo
echo "=== Build sizes ==="
# du -h works on linux + macOS; portable for both bash hosts.
for entry in "${TARGETS[@]}"; do
  # shellcheck disable=SC2206
  parts=($entry)
  name="${parts[1]}"
  outfile="$OUT_DIR/$name"
  if [ -f "$outfile" ]; then
    du -h "$outfile" | awk '{ printf "  %-12s %s\n", $1, $2 }'
  else
    echo "  (missing)    $outfile"
  fi
done
