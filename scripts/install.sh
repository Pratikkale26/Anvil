#!/usr/bin/env bash
# One-line installer for Anvil.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/pratikkale26/anvil/main/scripts/install.sh | bash
#
# Detects the host platform via `uname`, downloads the matching prebuilt
# binary from the latest GitHub release, drops it at /usr/local/bin/anvil,
# and prints `anvil --version` to confirm.

set -euo pipefail

# TODO: a release has not been cut yet — once Pratik publishes one, this
# URL will resolve. Until then the download will 404 and the script will
# exit non-zero with a helpful message.
RELEASE_BASE="https://github.com/pratikkale26/anvil/releases/latest/download"
INSTALL_DIR="/usr/local/bin"
INSTALL_PATH="$INSTALL_DIR/anvil"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Linux)
    case "$uname_m" in
      x86_64|amd64) asset="anvil-linux-x64" ;;
      *) echo "error: unsupported linux arch: $uname_m" >&2; exit 1 ;;
    esac
    ;;
  Darwin)
    case "$uname_m" in
      x86_64) asset="anvil-darwin-x64" ;;
      arm64|aarch64) asset="anvil-darwin-arm64" ;;
      *) echo "error: unsupported darwin arch: $uname_m" >&2; exit 1 ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "error: on Windows, download anvil-win-x64.exe directly from $RELEASE_BASE" >&2
    exit 1
    ;;
  *)
    echo "error: unsupported OS: $uname_s" >&2
    exit 1
    ;;
esac

url="$RELEASE_BASE/$asset"

echo "Installing Anvil"
echo "  platform: $uname_s $uname_m"
echo "  asset:    $asset"
echo "  url:      $url"
echo "  target:   $INSTALL_PATH"
echo

# Need root to write to /usr/local/bin on most systems.
if [ -w "$INSTALL_DIR" ]; then
  SUDO=""
else
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    echo "  $INSTALL_DIR is not writable; will use sudo for the install step."
  else
    echo "error: $INSTALL_DIR is not writable and sudo is not available." >&2
    exit 1
  fi
fi

tmp="$(mktemp -t anvil.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
  if ! curl -fsSL --output "$tmp" "$url"; then
    echo "error: download failed from $url" >&2
    echo "  hint: a binary release may not have been published yet." >&2
    echo "        build locally with: bash scripts/build-binaries.sh" >&2
    exit 1
  fi
elif command -v wget >/dev/null 2>&1; then
  if ! wget -q -O "$tmp" "$url"; then
    echo "error: download failed from $url" >&2
    exit 1
  fi
else
  echo "error: need curl or wget on PATH to download" >&2
  exit 1
fi

$SUDO mv "$tmp" "$INSTALL_PATH"
$SUDO chmod +x "$INSTALL_PATH"
trap - EXIT

echo
echo "Installed to $INSTALL_PATH"
echo

if command -v anvil >/dev/null 2>&1; then
  anvil --version
else
  echo "warn: anvil installed at $INSTALL_PATH but $INSTALL_DIR is not on your PATH."
  echo "      add this to your shell rc file:"
  echo "        export PATH=\"$INSTALL_DIR:\$PATH\""
fi
