#!/bin/bash
# Packages AeonObj, AeonCraft and Enigma Launcher for Linux x64 (Aeon OS Berk).
#
# Output layout per app: ~/workspace/aeonos-berk/apps/<name>/
#   <name>/electron            (Electron 32.3.3 linux-x64 runtime)
#   <name>/resources/app/     (app files; package.json has "main": "main.js")
#   <name>/run.sh             (launcher script; adds --no-sandbox only when run as root)
#   <name>/<name>.desktop     (desktop entry, relocatable via %k)
#   <name>/README.txt
#
# Enigma additionally ships launcher-core.jar + config/servers.json inside
# resources/app/, and documents where to drop a bundled JRE (resources/jre-linux).
#
# Mirrors the package-win.sh scripts: reuses a cached Electron 32.3.3 build
# (here the linux-x64 dist installed under enigma-launcher/node_modules),
# never touches the existing Windows dist/ outputs.
set -e
cd "$(dirname "$0")"

ELECTRON_VERSION="32.3.3"
ELECTRON_DIST="$HOME/workspace/enigma-launcher/node_modules/electron/dist"
APPS_DIR="$HOME/workspace/aeonos-berk/apps"

[ -d "$ELECTRON_DIST" ] || { echo "Electron dist missing at $ELECTRON_DIST"; exit 1; }
[ -x "$ELECTRON_DIST/electron" ] || { echo "$ELECTRON_DIST/electron not executable"; exit 1; }
INST_VER="$(node -e "console.log(require('$HOME/workspace/enigma-launcher/node_modules/electron/package.json').version)")"
[ "$INST_VER" = "$ELECTRON_VERSION" ] || { echo "Electron version mismatch: $INST_VER != $ELECTRON_VERSION"; exit 1; }
echo "Using cached Electron $INST_VER (linux-x64) from $ELECTRON_DIST"

# stage_app <name> <version> <description> <srcdir> <appfiles...>
# <appfiles...> are paths relative to <srcdir>; "vendor/" (trailing slash) copies a dir.
stage_app() {
  local name="$1" version="$2" desc="$3" srcdir="$4"; shift 4
  local outdir="$APPS_DIR/$name" appres="$APPS_DIR/$name/resources/app"
  echo "=== $name ==="
  rm -rf "$outdir"
  mkdir -p "$appres"
  echo "Copying Electron runtime..."
  cp -r "$ELECTRON_DIST/." "$outdir/"
  echo "Copying app files..."
  for f in "$@"; do
    if [ "${f%/}" != "$f" ]; then
      # directory (trailing slash): copy its contents
      mkdir -p "$appres/${f%/}"
      cp -r "$srcdir/${f%/}/." "$appres/${f%/}/"
    else
      cp "$srcdir/$f" "$appres/"
    fi
  done
  # Packaged package.json: main MUST be "main.js" relative to resources/app.
  cat > "$appres/package.json" <<EOF
{
  "name": "$name",
  "version": "$version",
  "description": "$desc",
  "main": "main.js"
}
EOF
  # Launcher script.
  cat > "$outdir/run.sh" <<'EOF'
#!/bin/bash
# Launches this app's bundled Electron runtime.
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=()
if [ "$(id -u)" -eq 0 ]; then
  # Electron refuses to run sandboxed as root (only relevant when testing as root).
  EXTRA+=(--no-sandbox)
fi
exec "$HERE/electron" "${EXTRA[@]}" "$@"
EOF
  chmod +x "$outdir/run.sh" "$outdir/electron"
  # Desktop entry (relocatable: resolves its own directory via %k).
  cat > "$outdir/$name.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$desc
Comment=$desc - Linux x64 build for Aeon OS Berk
Exec=bash -c 'cd "\$(dirname "\$(readlink -f "%k")")" && exec ./run.sh %U'
Terminal=false
Categories=Game;
EOF
  chmod +x "$outdir/$name.desktop"
}

WS="$HOME/workspace"

stage_app "aeonobj" "1.0.0" "AeonObj" "$WS/aeonobj-win/AeonObjWin/app" \
  main.js preload.js renderer.js mesh.js index.html styles.css
cat > "$APPS_DIR/aeonobj/README.txt" <<'EOF'
AeonObj v1.0.0 (Linux x64 - Aeon OS Berk)
=========================================
Turns a PNG (or a web search result) into a textured 3D model (.obj).

1. Run ./run.sh (or double-click aeonobj.desktop).
2. Pick a PNG, paste an image URL, or search the web (Wikimedia Commons).
3. Choose a mesh type: Flat card / Relief / Extruded cutout.
4. Export -> saves model.obj + model.mtl + texture PNG next to each other.

No accounts, no API keys, no telemetry.
EOF

stage_app "aeoncraft" "1.2.0" "AeonCraft" "$WS/aeoncraft/AeonCraftWin/app" \
  main.js preload.js game.js index.html styles.css vendor/
cat > "$APPS_DIR/aeoncraft/README.txt" <<'EOF'
AeonCraft v1.2.0 (Linux x64 - Aeon OS Berk)
===========================================
An original fan-made voxel sandbox game. All code, textures and names are
original - no Mojang code or assets.

1. Run ./run.sh (or double-click aeoncraft.desktop).
2. Enter a world name and seed (blank = random), click Play.
3. Click the game to capture the mouse. Esc pauses.

Controls: WASD move, mouse look, HOLD left-click to mine, left-click a mob
to hit it, right-click place (right-click a Crafting Table to open it),
E inventory + crafting + armor, Space jump, F toggle fly, 1-9/0 or wheel
select, H help, F3 debug.

Fully offline - no accounts, no telemetry.
EOF

stage_app "enigma-launcher" "1.0.0" "Enigma Launcher" "$WS/enigma-launcher/app" \
  main.js preload.js renderer.js mc-ping.js java-detect.js index.html styles.css
mkdir -p "$APPS_DIR/enigma-launcher/resources/app/config" \
         "$APPS_DIR/enigma-launcher/resources/app/launcher-core"
cp "$WS/enigma-launcher/config/servers.json" "$APPS_DIR/enigma-launcher/resources/app/config/"
cp "$WS/enigma-launcher/launcher-core/launcher-core.jar" "$APPS_DIR/enigma-launcher/resources/app/launcher-core/"
cat > "$APPS_DIR/enigma-launcher/README.txt" <<'EOF'
Enigma Launcher v1.0.0 (Linux x64 - Aeon OS Berk)
=================================================
Offline-mode Minecraft 1.18.2 launcher for private whitelisted servers.

1. Run ./run.sh (or double-click enigma-launcher.desktop).
2. Enter the real server hosts in Settings (defaults are placeholders),
   set your username, then Play.

Java: this build needs a Java 17+ JRE. It looks in this order:
  1. Settings -> custom Java path (if set),
  2. a bundled JRE at resources/jre-linux/bin/java (not included - drop a
     Linux x64 Temurin/OpenJDK 17+ JRE here to bundle one),
  3. `java` on PATH, verified to report version 17 or newer.
Otherwise it shows an error telling you to install one, e.g.:
  sudo apt install openjdk-17-jre
EOF
mkdir -p "$APPS_DIR/enigma-launcher/resources/jre-linux"
cat > "$APPS_DIR/enigma-launcher/resources/jre-linux/JRE-README.txt" <<'EOF'
Optional: drop a Linux x64 Java 17+ JRE here so the launcher works without
a system Java. Expected binary path:
  resources/jre-linux/bin/java
(A full Temurin 17 JRE, e.g. extracted from the Adoptium tarball.)
EOF

echo "---"
du -sh "$APPS_DIR"/*
echo "Done."
