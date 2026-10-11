#!/bin/sh
# AeonCodeNet launcher for Linux (Aeon OS Berk).
# Runs the app from this directory using the bundled Electron runtime.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "AeonCodeNet: Electron runtime not found at $ELECTRON" >&2
  echo "Run 'npm install' in $DIR first (needs the electron 32.3.3 package)." >&2
  exit 1
fi
# Chromium refuses to start as root unless the sandbox is disabled.
# (main.js also requests this; the flag must be on the command line to
# take effect early enough, so the launcher adds it too.)
SANDBOX_FLAG=""
if [ "$(id -u)" = "0" ]; then
  SANDBOX_FLAG="--no-sandbox"
fi
# shellcheck disable=SC2086
exec "$ELECTRON" $SANDBOX_FLAG "$DIR" "$@"
