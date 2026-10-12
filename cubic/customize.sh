#!/usr/bin/env bash
#
# customize.sh — Run INSIDE the Cubic chroot terminal to turn a stock
# linuxmint-22.x-cinnamon-64bit.iso into Aeon OS Berk.
#
# Expected layout: this file lives at <repo>/cubic/customize.sh and the repo
# has been copied into the chroot (see CUBIC.md step 2), e.g.:
#   /tmp/aeonos-berk/cubic/customize.sh
#
# Does: APT package sets -> harden-mint.sh --in-chroot -> Berk Simple UX ->
#        Flatseal from Flathub.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARDEN="$REPO_ROOT/scripts/harden-mint.sh"

log()  { echo "[customize] $*"; }
warn() { echo "[customize][WARN] $*" >&2; }

[[ $EUID -eq 0 ]] || { warn "not root — the Cubic terminal should already be root"; exit 1; }
[[ -x "$HARDEN" ]] || { warn "harden-mint.sh not found/executable at $HARDEN"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

pkg_list() { grep -vE '^\s*(#|$)' "$1"; }

log "updating apt lists..."
apt-get update

log "installing Berk package set..."
# shellcheck disable=SC2046
apt-get install -y $(pkg_list "$SCRIPT_DIR/packages-add.list")

log "purging: $(pkg_list "$SCRIPT_DIR/packages-remove.list" | tr '\n' ' ')"
# shellcheck disable=SC2046
apt-get purge -y $(pkg_list "$SCRIPT_DIR/packages-remove.list") || warn "purge had issues; continuing"
apt-get autoremove -y || true

log "applying Berk hardening baseline (chroot mode)..."
bash "$HARDEN" --in-chroot --force

log "applying Berk Simple desktop customizations (UX.md)..."
bash "$SCRIPT_DIR/berk-simple/apply-ux.sh"

log "building + installing the Aeon Store (the one and only app store)..."
bash "$SCRIPT_DIR/../store/make-store-deb.sh" 1.0.0 --out /tmp
dpkg -i /tmp/aeon-store_1.0.0_amd64.deb

log "adding Flathub remote (system)..."
if flatpak remote-list --system 2>/dev/null | grep -q '^flathub'; then
    log "flathub remote already present"
else
    flatpak remote-add --system --if-not-exists flathub \
        https://flathub.org/repo/flathub.flatpakrepo \
        || warn "could not add flathub remote (no network in chroot?)"
fi

log "installing Flatseal from Flathub (not in Ubuntu archives)..."
if ! flatpak install --system -y com.github.tchx84.Flatseal; then
    warn "Flatseal install failed. After first boot, run:"
    warn "  flatpak remote-add --system --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo"
    warn "  flatpak install --system flathub com.github.tchx84.Flatseal"
fi

log "cleaning apt caches..."
apt-get clean

log "done. Next in Cubic: set the kernel cmdline on the Boot page (see CUBIC.md step 3), then Generate."
