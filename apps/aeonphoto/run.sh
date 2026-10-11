#!/bin/sh
# Launch AeonPhoto for Linux (Aeon OS Berk).
# Optional env overrides: AEONPHOTO_SDCPP_URL, AEONPHOTO_WEBUI_URL
# Flags are passed through (e.g. --smoke-test).
HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX=""
if [ "$(id -u)" = "0" ]; then
  # Chromium refuses to run sandboxed as root; Aeon OS Berk ships a
  # dedicated unprivileged user, but fall back gracefully here.
  SANDBOX="--no-sandbox"
fi
exec "$HERE/linux-x64/electron" $SANDBOX "$@" --app="$HERE/linux-x64/resources/app"
