#!/usr/bin/env bash
#
# build-repo.sh — Assemble the Aeon Berk first-party APT repository.
#
# Drops .deb packages in pool/, then generates Packages + Release metadata
# under dists/ with apt-ftparchive. Optionally signs with GPG.
#
# Usage:
#   ./build-repo.sh                  # build unsigned metadata
#   GPGKEY=<key-id-or-email> ./build-repo.sh   # also produce Release.gpg + InRelease
#
# Environment overrides: CODENAME (default: berk), COMPONENT (default: main),
# ARCH (default: amd64).
#
# Serve the repo/ directory over HTTPS (any static web server) and point
# clients at it with conf/aeon-berk.sources (see conf/README.md).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODENAME="${CODENAME:-berk}"
COMPONENT="${COMPONENT:-main}"
ARCH="${ARCH:-amd64}"
DISTDIR="$REPO/dists/$CODENAME"
BINDIR="$DISTDIR/$COMPONENT/binary-$ARCH"
GPGKEY="${GPGKEY:-}"

log()  { echo "[repo] $*"; }
warn() { echo "[repo][WARN] $*" >&2; }
die()  { echo "[repo][ERROR] $*" >&2; exit 1; }

command -v apt-ftparchive >/dev/null 2>&1 || die "apt-ftparchive not found (install apt)"
command -v dpkg-scanpackages >/dev/null 2>&1 || die "dpkg-scanpackages not found"

mkdir -p "$BINDIR" "$REPO/pool"

shopt -s nullglob
debs=("$REPO"/pool/*.deb)
shopt -u nullglob
if [[ ${#debs[@]} -eq 0 ]]; then
    log "no .deb files in $REPO/pool — nothing to do"
    exit 0
fi
log "found ${#debs[@]} .deb package(s) in pool/"

# Validate every .deb before it goes near the metadata.
for d in "${debs[@]}"; do
    dpkg-deb --info "$d" >/dev/null || die "invalid .deb: $d"
done
log "all .debs pass dpkg-deb --info"

cd "$REPO"
# Packages index (pool/ paths are relative to the repo root by design).
apt-ftparchive packages pool > "$BINDIR/Packages"
gzip -kf "$BINDIR/Packages"
log "wrote $BINDIR/Packages (+ .gz)"

# Release file via an apt-ftparchive release config.
cat > "$DISTDIR/apt-ftparchive-release.conf" <<EOF
APT::FTPArchive::Release::Origin "Aeon";
APT::FTPArchive::Release::Label "Aeon Berk";
APT::FTPArchive::Release::Suite "$CODENAME";
APT::FTPArchive::Release::Codename "$CODENAME";
APT::FTPArchive::Release::Architectures "$ARCH";
APT::FTPArchive::Release::Components "$COMPONENT";
APT::FTPArchive::Release::Description "Aeon OS Berk first-party packages";
EOF
apt-ftparchive -c "$DISTDIR/apt-ftparchive-release.conf" release "$DISTDIR" > "$DISTDIR/Release"
log "wrote $DISTDIR/Release"

if [[ -n "$GPGKEY" ]]; then
    command -v gpg >/dev/null 2>&1 || die "gpg not found but GPGKEY was set"
    gpg --batch --yes --local-user "$GPGKEY" --detach-sign --armor \
        -o "$DISTDIR/Release.gpg" "$DISTDIR/Release"
    gpg --batch --yes --local-user "$GPGKEY" --clearsign \
        -o "$DISTDIR/InRelease" "$DISTDIR/Release"
    log "signed Release with key $GPGKEY (Release.gpg + InRelease)"
else
    warn "unsigned repo: re-run with GPGKEY=<key-id> to produce Release.gpg/InRelease"
fi

log "repo ready at $REPO — serve this directory over HTTPS."
