#!/bin/bash
# make-deb.sh — wrap one Berk app folder into an installable .deb.
#
# Usage: make-deb.sh <app-id> <version> [--out DIR]
#
#   app-id:  music | code-maker | picture-maker | 3d-maker | aeoncraft | minecraft
#   version: e.g. 1.0.5  (this becomes the deb version AND version.txt,
#            which the updater reads to know what is installed)
#
# Layout of the produced .deb:
#   /opt/<app>/...            program files
#   /opt/<app>/version.txt    installed version (updater reads this)
#   /usr/share/applications/berk-<app-id>.desktop   (plain-language Name,
#            Exec rewritten to the absolute /opt path)
#
# Requires: dpkg-deb. Validates the result with dpkg-deb --info.

set -euo pipefail

if [ $# -lt 2 ]; then
    echo "Usage: $0 <app-id> <version> [--out DIR]" >&2
    echo "app-id: music | code-maker | picture-maker | 3d-maker | aeoncraft | minecraft" >&2
    exit 2
fi

APP_ID="$1"
VERSION="$2"
OUT_DIR="debs"
if [ "${3:-}" = "--out" ]; then
    OUT_DIR="$4"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
APPS="$HERE/../apps"
WORK="$(mktemp -d)"
chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# --- per-app source layout -------------------------------------------------
case "$APP_ID" in
    music)
        PKG="berk-music";         INSTALLDIR="aeonradio"
        SRC="$APPS/aeonradio";    DESKTOP_SRC="$SRC/aeonradio.desktop"
        MENU_NAME="Music";        DESC="Listen to radio stations"
        COPY_ITEMS=("linux-x64" "run.sh")
        ;;
    code-maker)
        PKG="berk-code-maker";    INSTALLDIR="aeoncodenet"
        SRC="$APPS/aeoncodenet/linux-x64"; DESKTOP_SRC="$SRC/aeoncodenet.desktop"
        MENU_NAME="Code Maker";   DESC="Make computer programs"
        COPY_ITEMS=(".")
        ;;
    picture-maker)
        PKG="berk-picture-maker"; INSTALLDIR="aeonphoto"
        SRC="$APPS/aeonphoto";    DESKTOP_SRC="$SRC/AeonPhoto.desktop"
        MENU_NAME="Picture Maker"; DESC="Make pictures"
        COPY_ITEMS=("linux-x64" "run.sh" "download-model.sh" "icon.png")
        ;;
    3d-maker)
        PKG="berk-3d-maker";      INSTALLDIR="aeonobj"
        SRC="$APPS/aeonobj";      DESKTOP_SRC="$SRC/aeonobj.desktop"
        MENU_NAME="3D Maker";     DESC="Make 3D shapes"
        COPY_ITEMS=(".")
        ;;
    aeoncraft)
        PKG="berk-aeoncraft";     INSTALLDIR="aeoncraft"
        SRC="$APPS/aeoncraft";    DESKTOP_SRC="$SRC/aeoncraft.desktop"
        MENU_NAME="AeonCraft";    DESC="Build and play"
        COPY_ITEMS=(".")
        ;;
    minecraft)
        PKG="berk-minecraft";     INSTALLDIR="enigma-launcher"
        SRC="$APPS/enigma-launcher"; DESKTOP_SRC="$SRC/enigma-launcher.desktop"
        MENU_NAME="Minecraft";    DESC="Play Minecraft"
        COPY_ITEMS=(".")
        ;;
    *)
        echo "Unknown app-id: $APP_ID" >&2
        exit 2
        ;;
esac

[ -d "$SRC" ] || { echo "Source dir missing: $SRC" >&2; exit 1; }
[ -f "$DESKTOP_SRC" ] || { echo "Desktop file missing: $DESKTOP_SRC" >&2; exit 1; }

STAGE="$WORK/stage"
OPTDIR="$STAGE/opt/$INSTALLDIR"
mkdir -p "$OPTDIR" "$STAGE/DEBIAN" "$STAGE/usr/share/applications"
chmod 755 "$STAGE" "$STAGE/DEBIAN"

# --- copy program files ------------------------------------------------------
for item in "${COPY_ITEMS[@]}"; do
    if [ "$item" = "." ]; then
        cp -a "$SRC/." "$OPTDIR/"
        # never ship a stray .desktop from inside the program dir; the
        # packaged one goes to /usr/share/applications instead
        rm -f "$OPTDIR"/*.desktop
    else
        [ -e "$SRC/$item" ] || { echo "Missing expected item: $SRC/$item" >&2; exit 1; }
        cp -a "$SRC/$item" "$OPTDIR/"
    fi
done

# the .desktop file itself must not ride along inside /opt
rm -f "$OPTDIR"/*.desktop

# --- permissions ---------------------------------------------------------------
find "$OPTDIR" -type d -exec chmod 755 {} +
find "$OPTDIR" -type f -exec chmod 644 {} +
# executables: runtimes, launchers, helpers, crash handler
for exe in electron aeonradio run.sh download-model.sh chrome_crashpad_handler sd-server; do
    find "$OPTDIR" -name "$exe" -type f -exec chmod 755 {} + 2>/dev/null || true
done
# node_modules/.bin links etc. inside aeoncodenet: keep any existing +x
find "$OPTDIR" -type f -name "*.sh" -exec chmod 755 {} +
# chrome-sandbox wants setuid root like every Electron deb ships it
find "$OPTDIR" -name chrome-sandbox -type f -exec chmod 4755 {} + 2>/dev/null || true

# --- version stamp (this is what the updater reads) -----------------------------
printf '%s' "$VERSION" > "$OPTDIR/version.txt"
chmod 644 "$OPTDIR/version.txt"

# --- desktop entry ---------------------------------------------------------------
DESKTOP_OUT="$STAGE/usr/share/applications/berk-$APP_ID.desktop"
grep -v -E '^(Exec=|Icon=|Path=)' "$DESKTOP_SRC" > "$DESKTOP_OUT"
{
    echo "Exec=/opt/$INSTALLDIR/run.sh"
    if [ -f "$OPTDIR/icon.png" ]; then
        echo "Icon=/opt/$INSTALLDIR/icon.png"
    fi
} >> "$DESKTOP_OUT"
chmod 644 "$DESKTOP_OUT"

# --- control file ------------------------------------------------------------------
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Aeon OS Berk
Description: $MENU_NAME for Aeon OS Berk
 $DESC.
 .
 Installs to /opt/$INSTALLDIR.
EOF

# --- build ---------------------------------------------------------------------------
mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/${PKG}_${VERSION}_amd64.deb"
dpkg-deb --build "$STAGE" "$DEB" >/dev/null
echo "Built: $DEB"
dpkg-deb --info "$DEB"
echo "--- contents (top level) ---"
dpkg-deb --contents "$DEB" | awk '{print $6}' | cut -d/ -f2-4 | sort -u | head -20
