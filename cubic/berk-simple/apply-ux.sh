#!/usr/bin/env bash
#
# apply-ux.sh — Apply the "Berk Simple" desktop customizations.
# Runs INSIDE the Cubic chroot (called by ../customize.sh), or with --dry-run
# to preview. Idempotent: safe to re-run; backs up files it rewrites.
#
# Does:
#   1. Installs the Berk Simple dconf defaults (theme, icons, fonts) +
#      the optional full `dconf dump` capture from the reference build.
#   2. Installs the green "start" orb icon.
#   3. Installs plain-language .directory category overrides and tags
#      Nemo -> Files, admin tools -> Advanced.
#   4. Rewrites first-party Aeon .desktop display names to the exact
#      plain-language Name=/Comment= values from UX.md (packagers should
#      set these at build time; this is enforcement for what's installed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UX_DIR="$SCRIPT_DIR"
DRY_RUN=0
BACKUP_ROOT="/root/aeon-berk-backups"
BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-ux"

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log()  { echo "[berk-ux] $*"; }
warn() { echo "[berk-ux][WARN] $*" >&2; }
die()  { echo "[berk-ux][ERROR] $*" >&2; exit 1; }

if [[ $DRY_RUN -eq 0 && $EUID -ne 0 ]]; then
    die "apply mode requires root (or use --dry-run)"
fi

run() {
    if [[ $DRY_RUN -eq 1 ]]; then log "[dry-run] would run: $*"; return 0; fi
    log "run: $*"
    "$@"
}

backup_file() {
    local path="$1"
    [[ $DRY_RUN -eq 1 ]] && return 0
    [[ -e "$path" ]] || return 0
    local dest="$BACKUP_DIR/${path#/}"
    [[ -e "$dest" ]] && return 0
    mkdir -p "$BACKUP_DIR" "$(dirname "$dest")"
    cp -a "$path" "$dest"
    log "backed up $path"
}

# install_file <src> <dest> <mode>: copy only when content differs.
install_file() {
    local src="$1" dest="$2" mode="$3"
    [[ -f "$src" ]] || { warn "source missing: $src (skipping)"; return 0; }
    if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
        log "unchanged: $dest"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would install $dest (mode $mode)"
        return 0
    fi
    backup_file "$dest"
    mkdir -p "$(dirname "$dest")"
    install -m "$mode" "$src" "$dest"
    log "installed $dest"
}

# ensure_desktop_category <desktop-file> <category>: add Category if absent.
ensure_desktop_category() {
    local desktop="$1" category="$2"
    [[ -f "$desktop" ]] || { log "not installed, skipping: $desktop"; return 0; }
    if grep -qE "^Categories=.*${category}" "$desktop"; then
        log "already categorized: $(basename "$desktop")"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would tag $(basename "$desktop") with category $category"
        return 0
    fi
    backup_file "$desktop"
    if grep -qE "^Categories=" "$desktop"; then
        sed -i "s|^Categories=|Categories=${category};|" "$desktop"
    else
        printf 'Categories=%s;\n' "$category" >> "$desktop"
    fi
    log "tagged $(basename "$desktop") -> $category"
}

# set_desktop_names <match> <Name> <Comment>:
# for any installed .desktop whose filename or Name= contains <match>
# (case-insensitive), set the plain-language Name= and Comment=.
set_desktop_names() {
    local match="$1" newname="$2" newcom="$3"
    local f base name_line hit=0
    for f in /usr/share/applications/*.desktop /usr/local/share/applications/*.desktop; do
        [[ -f "$f" ]] || continue
        base="$(basename "$f")"
        name_line="$(grep -m1 -E '^Name=' "$f" | cut -d= -f2- || true)"
        if [[ "${base,,}" == *"${match,,}"* || "${name_line,,}" == *"${match,,}"* ]]; then
            hit=1
            if [[ "$name_line" == "$newname" ]]; then
                log "name already plain: $base"
                continue
            fi
            if [[ $DRY_RUN -eq 1 ]]; then
                log "[dry-run] would rename '$name_line' ($base) -> '$newname'"
                continue
            fi
            backup_file "$f"
            # Replace (or add) Name= and Comment= in the [Desktop Entry] group.
            if grep -qE '^Name=' "$f"; then
                sed -i "0,/^Name=/s|^Name=.*|Name=${newname}|" "$f"
            else
                sed -i "/^\[Desktop Entry\]/a Name=${newname}" "$f"
            fi
            if grep -qE '^Comment=' "$f"; then
                sed -i "0,/^Comment=/s|^Comment=.*|Comment=${newcom}|" "$f"
            else
                sed -i "/^\[Desktop Entry\]/a Comment=${newcom}" "$f"
            fi
            log "renamed '$name_line' -> '$newname' ($base)"
        fi
    done
    [[ $hit -eq 0 ]] && log "no installed .desktop matched '$match' (app .deb not installed yet — packagers: set names per UX.md)"
}

# ---------------------------------------------------------- 1. dconf --
log "== Berk Simple dconf defaults =="
install_file "$UX_DIR/10-berk-simple" /etc/dconf/db/local.d/10-berk-simple 0644
if [[ -s "$UX_DIR/cinnamon-ux.dconf" ]]; then
    install_file "$UX_DIR/cinnamon-ux.dconf" /etc/dconf/db/local.d/11-berk-simple-capture 0644
else
    log "no cinnamon-ux.dconf capture present (produced during first reference build — see CUBIC.md)"
fi
run dconf update || warn "'dconf update' failed"

# ------------------------------------------------------ 2. start orb --
log "== start button icon =="
install_file "$UX_DIR/start-orb.svg" /usr/share/icons/hicolor/scalable/apps/berk-start.svg 0644
run gtk-update-icon-cache -f -q /usr/share/icons/hicolor || warn "icon cache update failed (non-fatal)"

# ------------------------------------------- 3. plain-language menus --
log "== menu categories =="
for d in "$UX_DIR"/desktop-directories/*.directory; do
    [[ -f "$d" ]] || continue
    install_file "$d" "/usr/local/share/desktop-directories/$(basename "$d")" 0644
done
# Files: Nemo goes under "Files"
ensure_desktop_category /usr/share/applications/nemo.desktop X-Berk-Files
# Advanced: the one grown-up area
for app in /usr/share/applications/gnome-terminal.desktop \
           /usr/share/applications/cinnamon-settings.desktop \
           /usr/share/applications/mintinstall.desktop \
           /usr/share/applications/mintupdate.desktop; do
    ensure_desktop_category "$app" X-Berk-Advanced
done

# ----------------------------------------- 4. Aeon app display names --
log "== Aeon app display names (UX.md) =="
set_desktop_names "aeonradio"    "Music"        "Listen to radio stations"
set_desktop_names "aeoncodenet"  "Code Maker"   "Make computer programs"
set_desktop_names "aeonphoto"    "Picture Maker" "Make pictures"
set_desktop_names "aeonobj"      "3D Maker"     "Make 3D shapes"
set_desktop_names "aeoncraft"    "AeonCraft"    "Build and play"
set_desktop_names "enigma"       "Minecraft"    "Play Minecraft"
set_desktop_names "aeontv"       "TV"           "Watch TV shows"
set_desktop_names "classic"      "Cable TV"     "Watch cable TV"
set_desktop_names "quietbrowse"  "Internet"     "Browse the web"
set_desktop_names "aeonai"       "Assistant"    "Ask questions, get help"

log "done."
[[ $DRY_RUN -eq 0 ]] && log "Backups (if anything changed): $BACKUP_DIR"
