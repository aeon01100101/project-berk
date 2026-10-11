#!/bin/sh
# Aeon Radio launcher — runs the packaged Electron app.
# Passes all arguments through (e.g. --smoke-test for QA).
# Set AEONRADIO_NO_SANDBOX=1 when running in a container without userns.
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=""
if [ "$AEONRADIO_NO_SANDBOX" = "1" ]; then
  EXTRA="--no-sandbox"
fi
exec "$HERE/linux-x64/aeonradio" $EXTRA "$@"
