#!/bin/bash
# Launches this app's bundled Electron runtime.
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=()
if [ "$(id -u)" -eq 0 ]; then
  # Electron refuses to run sandboxed as root (only relevant when testing as root).
  EXTRA+=(--no-sandbox)
fi
exec "$HERE/electron" "${EXTRA[@]}" "$@"
