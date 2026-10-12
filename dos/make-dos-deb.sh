#!/bin/bash
# make-dos-deb.sh — package D0S (the DOS-style terminal) as a .deb.
#
# Usage: make-dos-deb.sh <version> [--out DIR]
#   version: e.g. 1.0.0
#
# Layout of the produced .deb:
#   /opt/d0s/d0s.py     the terminal (executable)
#   /opt/d0s/ansi.py    VT100 parser + screen model
#   /opt/d0s/d0s.svg    icon
#   /usr/share/applications/berk-d0s.desktop
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
WORK="$(mktemp -d)"
chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT

for f in "$HERE/d0s.py" "$HERE/ansi.py" "$HERE/d0s.desktop" "$HERE/d0s.svg"; do
    [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
done

STAGE="$WORK/stage"
OPTDIR="$STAGE/opt/d0s"
mkdir -p "$OPTDIR" "$STAGE/DEBIAN" "$STAGE/usr/share/applications"
chmod 755 "$STAGE" "$STAGE/DEBIAN"

install -m 755 "$HERE/d0s.py" "$OPTDIR/d0s.py"
install -m 644 "$HERE/ansi.py" "$OPTDIR/ansi.py"
install -m 644 "$HERE/d0s.svg" "$OPTDIR/d0s.svg"

DESKTOP_OUT="$STAGE/usr/share/applications/berk-d0s.desktop"
grep -v -E '^(Exec=|Icon=)' "$HERE/d0s.desktop" > "$DESKTOP_OUT"
{
    echo "Exec=/opt/d0s/d0s.py"
    echo "Icon=/opt/d0s/d0s.svg"
} >> "$DESKTOP_OUT"
chmod 644 "$DESKTOP_OUT"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: berk-d0s
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Aeon OS Berk
Description: D0S terminal for Aeon OS Berk
 A DOS-style terminal: a real shell behind a phosphor screen.
 .
 Installs to /opt/d0s.
EOF

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/d0s_${VERSION}_amd64.deb"
dpkg-deb --build "$STAGE" "$DEB" >/dev/null
echo "Built: $DEB"
dpkg-deb --info "$DEB"
echo "--- contents ---"
dpkg-deb --contents "$DEB" | awk '{print $6}'
