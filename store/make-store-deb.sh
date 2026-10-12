#!/bin/bash
# make-store-deb.sh — package the Aeon Store itself as an installable .deb.
#
# Usage: make-store-deb.sh <version> [--out DIR]
#   version: e.g. 1.0.0
#
# Layout of the produced .deb:
#   /opt/aeon-store/aeon-store.py        the store (executable)
#   /opt/aeon-store/aeon_github.py      shared GitHub machinery
#   /opt/aeon-store/apps.json          app catalog (bundled copy)
#   /opt/aeon-store/store-bag.svg      icon
#   /usr/share/applications/berk-aeon-store.desktop
#
# The store prefers /usr/share/berk-updater/apps.json when the Updates app
# is installed (freshest catalog) and falls back to its bundled copy.
#
# Requires: dpkg-deb. Validates the result with dpkg-deb --info.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <version> [--out DIR]" >&2
    exit 2
fi

VERSION="$1"
OUT_DIR="debs"
if [ "${2:-}" = "--out" ]; then
    OUT_DIR="$3"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
UPDATER="$HERE/../updater"
WORK="$(mktemp -d)"
chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT

for f in "$HERE/aeon-store.py" "$HERE/aeon-store.desktop" "$HERE/store-bag.svg" \
         "$UPDATER/aeon_github.py" "$UPDATER/apps.json"; do
    [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
done

STAGE="$WORK/stage"
OPTDIR="$STAGE/opt/aeon-store"
mkdir -p "$OPTDIR" "$STAGE/DEBIAN" "$STAGE/usr/share/applications"
chmod 755 "$STAGE" "$STAGE/DEBIAN"

install -m 755 "$HERE/aeon-store.py" "$OPTDIR/aeon-store.py"
install -m 644 "$UPDATER/aeon_github.py" "$OPTDIR/aeon_github.py"
install -m 644 "$UPDATER/apps.json" "$OPTDIR/apps.json"
install -m 644 "$HERE/store-bag.svg" "$OPTDIR/store-bag.svg"

DESKTOP_OUT="$STAGE/usr/share/applications/berk-aeon-store.desktop"
grep -v -E '^(Exec=|Icon=)' "$HERE/aeon-store.desktop" > "$DESKTOP_OUT"
{
    echo "Exec=/opt/aeon-store/aeon-store.py"
    echo "Icon=/opt/aeon-store/store-bag.svg"
} >> "$DESKTOP_OUT"
chmod 644 "$DESKTOP_OUT"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: berk-aeon-store
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Aeon OS Berk
Description: Aeon Store for Aeon OS Berk
 The one and only app store for Aeon OS Berk. Get more apps with
 one tap; every download is safety-checked before installing.
 .
 Installs to /opt/aeon-store.
EOF

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/aeon-store_${VERSION}_amd64.deb"
dpkg-deb --build "$STAGE" "$DEB" >/dev/null
echo "Built: $DEB"
dpkg-deb --info "$DEB"
echo "--- contents ---"
dpkg-deb --contents "$DEB" | awk '{print $6}'
