#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# linuxdeploy's GStreamer plugin needs it, and without it the build only says
# "failed to run linuxdeploy".
if ! command -v patchelf >/dev/null; then
  echo "patchelf not found; install it first (Arch: sudo pacman -S patchelf)" >&2
  exit 1
fi

env $(bash scripts/appimage-gstreamer.sh target/gstreamer) NO_STRIP=true npx tauri build --bundles appimage
