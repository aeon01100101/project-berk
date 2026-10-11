#!/usr/bin/env bash
#
# harden-mint.sh — Apply the Aeon OS "Berk" hardening baseline to a running
# Linux Mint 22.x (Cinnamon) installation.
#
# Idempotent: safe to re-run; every file touched is backed up under
# /root/aeon-berk-backups/<timestamp>/ before it is modified.
#
# Usage:
#   sudo ./harden-mint.sh                 # apply the baseline
#   ./harden-mint.sh --dry-run            # print what would change; change nothing
#   sudo ./harden-mint.sh --in-chroot     # apply inside a Cubic chroot
#                                         # (skips live service restarts/pokes)
#   sudo ./harden-mint.sh --force         # skip the Linux Mint 22 OS check
#   sudo ./harden-mint.sh --enable-usbguard
#                                         # also enforce a usbguard policy (opt-in;
#                                         # plug in your trusted USB devices first)
#
# What it does (see ../SECURITY.md for the full manifest and rationale):
#   sysctl hardening - uncommon-protocol blacklist - GRUB cmdline hardening -
#   UFW default-deny - AppArmor enforce - unattended-upgrades - DNS-over-TLS
#   (Quad9 via systemd-resolved) - NetworkManager MAC randomization + IPv6
#   privacy - pam_pwquality policy - sudo timestamp_timeout=5 - no core dumps -
#   tmpfs /tmp - auditd baseline - Cinnamon auto-lock - hardened Firefox
#   skeleton profile - purge apport/whoopsie.
#
# What it does NOT do (must happen at install time, see ../SECURITY.md):
#   LUKS full-disk encryption, Secure Boot enablement, LVM layout.
#   The script checks and warns if these look absent; it cannot retrofit them.
#
# Non-interactive guarantee (UX.md §5): this script never prompts. No `read`,
# DEBIAN_FRONTEND=noninteractive everywhere, `ufw --force`, and everything it
# prints goes to the admin running it — never to a desktop user. It runs at
# build/install time; the person using the computer never sees it.

set -euo pipefail

VERSION="1.0.0"
DRY_RUN=0
IN_CHROOT=0
FORCE=0
ENABLE_USBGUARD=0
BACKUP_ROOT="/root/aeon-berk-backups"
BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"

usage() {
    cat <<'USAGE'
Usage: harden-mint.sh [--dry-run] [--in-chroot] [--force] [--enable-usbguard]

  --dry-run          Print every change that would be made; write nothing.
  --in-chroot        Apply inside a Cubic chroot (skips live service restarts,
                     sysctl --system, update-grub, etc.).
  --force            Skip the Linux Mint 22 OS check.
  --enable-usbguard  Opt-in: generate and enforce a usbguard policy from
                     currently attached USB devices. Plug in trusted devices
                     first, or you will lock out your own keyboard/mouse.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --in-chroot) IN_CHROOT=1 ;;
        --force) FORCE=1 ;;
        --enable-usbguard) ENABLE_USBGUARD=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage; exit 2 ;;
    esac
    shift
done

log()  { echo "[berk] $*"; }
warn() { echo "[berk][WARN] $*" >&2; }
die()  { echo "[berk][ERROR] $*" >&2; exit 1; }

if [[ $DRY_RUN -eq 0 && $EUID -ne 0 ]]; then
    die "apply mode requires root — run with sudo (or use --dry-run to preview)"
fi

# run: execute a command, or just print it in dry-run mode.
run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would run: $*"
        return 0
    fi
    log "run: $*"
    "$@"
}

# backup_file <path>: copy an existing file into this run's backup dir (once).
backup_file() {
    local path="$1"
    [[ $DRY_RUN -eq 1 ]] && return 0
    [[ -e "$path" ]] || return 0
    local rel="${path#/}"
    local dest="$BACKUP_DIR/$rel"
    [[ -e "$dest" ]] && return 0
    mkdir -p "$BACKUP_DIR" "$(dirname "$dest")"
    cp -a "$path" "$dest"
    log "backed up $path -> $dest"
}

# write_file <path> <mode> <<'EOF' ... EOF
# Idempotent: writes only when content differs; backs up first.
write_file() {
    local path="$1" mode="$2"
    local content lines
    content="$(cat)"
    lines="$(printf '%s' "$content" | wc -l)"
    # normalize: exactly one trailing newline
    local want
    want="$(printf '%s\n' "$content")"
    if [[ -f "$path" && "$(cat "$path")" == "$want" ]]; then
        log "unchanged: $path"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        if [[ -f "$path" ]]; then
            log "[dry-run] would update $path (mode $mode, ~$lines lines, content differs)"
        else
            log "[dry-run] would create $path (mode $mode, ~$lines lines)"
        fi
        return 0
    fi
    backup_file "$path"
    mkdir -p "$(dirname "$path")"
    local tmp
    tmp="$(mktemp)"
    printf '%s\n' "$content" > "$tmp"
    chmod "$mode" "$tmp"
    chown root:root "$tmp"
    mv "$tmp" "$path"
    log "wrote $path"
}

# apt_install <pkg...>: install only the ones missing (idempotent).
apt_install() {
    local missing=()
    local p
    for p in "$@"; do
        if dpkg -s "$p" >/dev/null 2>&1; then
            log "package already installed: $p"
        else
            missing+=("$p")
        fi
    done
    [[ ${#missing[@]} -eq 0 ]] && return 0
    run apt-get update
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

# ---------------------------------------------------------------- OS check --
check_os() {
    local id="" version=""
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        id="${ID:-}" version="${VERSION_ID:-}"
    fi
    if [[ "$id" == "linuxmint" && "$version" == 22* ]]; then
        log "OS check: Linux Mint $version — OK"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        warn "OS check: this looks like '$id $version', not Linux Mint 22 — continuing because --dry-run changes nothing"
        return 0
    fi
    if [[ $FORCE -eq 1 ]]; then
        warn "OS check bypassed by --force (detected '$id $version')"
        return 0
    fi
    die "this script targets Linux Mint 22.x (detected '$id $version'); use --force to override"
}

# ------------------------------------------------- install-time sanity warn --
check_install_time() {
    # LUKS: root on device-mapper strongly suggests LUKS/LVM from the installer.
    local src
    src="$(findmnt -no SOURCE / 2>/dev/null || echo unknown)"
    if [[ "$src" == /dev/mapper/* ]]; then
        log "install-time: root is on $src (device-mapper — LUKS/LVM likely present)"
    else
        warn "install-time: root is $src, not on /dev/mapper — full-disk encryption may be ABSENT."
        warn "Berk requires LUKS at install time; it cannot be retrofitted safely by this script."
    fi
    # Secure Boot
    if command -v mokutil >/dev/null 2>&1; then
        if mokutil --sb-state 2>/dev/null | grep -qi enabled; then
            log "install-time: Secure Boot is enabled"
        else
            warn "install-time: Secure Boot does not look enabled — enable it in firmware setup."
        fi
    else
        warn "install-time: mokutil not found; could not verify Secure Boot state."
    fi
}

# ------------------------------------------------------------ sysctl base --
harden_sysctl() {
    log "== kernel sysctls =="
    write_file /etc/sysctl.d/99-aeon-berk.conf 0644 <<'EOF'
# Aeon OS Berk — kernel/network hardening (managed by harden-mint.sh)
# Applied at boot by systemd-sysctl; re-apply live with: sysctl --system

# Hide kernel pointers and restrict dmesg to root
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1

# No unprivileged BPF, no perf snooping across processes
kernel.unprivileged_bpf_disabled = 2
kernel.perf_event_paranoid = 3

# Only a process's own descendants may ptrace it (breaks debuggers attaching
# to unrelated processes; use "sudo gdb -p" workflows instead)
kernel.yama.ptrace_scope = 2

# No kexec (blocks one route to replacing the running kernel)
kernel.kexec_load_disabled = 1

# Magic SysRq: sync-only (16). Full SysRq (1) allows console password bypass tricks.
kernel.sysrq = 16

# Do not auto-load TTY line disciplines on demand
dev.tty.ldisc_autoload = 0

# Do not map the zero page (NULL-deref exploit mitigation)
vm.mmap_min_addr = 65536

# Hardlink/symlink/FIFO/regular-file creation restrictions (CVE-class mitigations)
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2

# No core dumps from setuid processes (ulimit side lives in limits.d)
fs.suid_dumpable = 0

# --- IPv4/IPv6 network hardening ---
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        log "in chroot: skipping live 'sysctl --system' (applies on first boot)"
    else
        run sysctl --system || warn "'sysctl --system' reported errors; check output above"
    fi
}

# ------------------------------------------- uncommon protocol blacklist --
blacklist_protocols() {
    log "== modprobe blacklist (dccp/sctp/rds/tipc) =="
    write_file /etc/modprobe.d/aeon-berk-blacklist.conf 0644 <<'EOF'
# Aeon OS Berk — disable uncommon network protocols (managed by harden-mint.sh)
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
blacklist dccp
blacklist sctp
blacklist rds
blacklist tipc
EOF
}

# ------------------------------------------------------- GRUB cmdline --
harden_grub() {
    log "== GRUB kernel cmdline =="
    local grub="/etc/default/grub"
    if [[ ! -f "$grub" ]]; then
        warn "$grub not found; skipping kernel cmdline hardening"
        return 0
    fi
    local add="mitigations=auto slab_nomerge init_on_alloc=1 init_on_free=1 page_alloc.shuffle=1"
    local line
    line="$(grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' "$grub" || true)"
    local missing=() tok
    for tok in $add; do
        [[ "$line" == *"$tok"* ]] || missing+=("$tok")
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
        log "GRUB_CMDLINE_LINUX_DEFAULT already hardened"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would append to GRUB_CMDLINE_LINUX_DEFAULT: ${missing[*]}"
        return 0
    fi
    backup_file "$grub"
    if [[ -n "$line" ]]; then
        # append inside the existing quotes
        sed -i 's|^\([[:space:]]*GRUB_CMDLINE_LINUX_DEFAULT="[^"]*\)"|\1 '"${missing[*]}"'"|' "$grub"
    else
        printf '\nGRUB_CMDLINE_LINUX_DEFAULT="%s"\n' "${missing[*]}" >> "$grub"
    fi
    log "updated GRUB_CMDLINE_LINUX_DEFAULT (+ ${missing[*]})"
    if [[ $IN_CHROOT -eq 1 ]]; then
        log "in chroot: skipping update-grub (Cubic regenerates boot config)"
    else
        run update-grub || warn "update-grub failed; run it manually before rebooting"
    fi
}

# ------------------------------------------------------------------- UFW --
harden_ufw() {
    log "== UFW firewall =="
    warn "UFW policy: DENY incoming / ALLOW outgoing. If you SSH into this box, allow it FIRST: sudo ufw allow OpenSSH"
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ':(22|2222)[[:space:]]'; then
        log "sshd appears to be listening; allowing OpenSSH through UFW automatically"
        run ufw allow OpenSSH
    fi
    run ufw default deny incoming
    run ufw default allow outgoing
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        log "UFW already active"
    else
        run ufw --force enable
    fi
}

# -------------------------------------------------------------- AppArmor --
harden_apparmor() {
    log "== AppArmor enforce =="
    if [[ ! -d /etc/apparmor.d ]]; then
        warn "/etc/apparmor.d missing; is apparmor installed?"
        return 0
    fi
    if ! command -v aa-enforce >/dev/null 2>&1; then
        warn "aa-enforce not found (install apparmor-utils); skipping per-profile enforce"
    else
        local profiles=() p base
        for p in /etc/apparmor.d/*; do
            [[ -f "$p" ]] || continue
            base="$(basename "$p")"
            [[ -e "/etc/apparmor.d/disable/$base" ]] && continue
            profiles+=("$p")
        done
        if [[ $DRY_RUN -eq 1 ]]; then
            log "[dry-run] would set ${#profiles[@]} AppArmor profiles to enforce mode"
        else
            local ok=0 fail=0
            for p in "${profiles[@]}"; do
                if aa-enforce "$p" >/dev/null 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); fi
            done
            log "AppArmor: $ok profiles set to enforce, $fail failed (left as-is)"
            [[ $fail -gt 0 ]] && warn "$fail profiles could not be enforced; inspect with aa-status"
        fi
    fi
    if [[ $IN_CHROOT -eq 1 ]]; then
        run systemctl enable apparmor || warn "could not enable apparmor service"
    else
        run systemctl enable --now apparmor || warn "could not start apparmor service"
    fi
}

# ----------------------------------------------------- unattended-upgrades --
harden_upgrades() {
    log "== unattended-upgrades =="
    write_file /etc/apt/apt.conf.d/51aeon-berk-unattended-upgrades 0644 <<'EOF'
// Aeon OS Berk — automatic security updates (managed by harden-mint.sh)
Unattended-Upgrade::Origins-Pattern {
        "origin=Ubuntu,archive=${distro_codename}-security";
        "origin=LinuxMint,archive=${distro_codename}-security";
};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::SyslogEnable "true";
EOF
    write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOF'
// Aeon OS Berk — enable the periodic update timers (managed by harden-mint.sh)
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        run systemctl enable apt-daily.timer apt-daily-upgrade.timer || warn "could not enable apt timers"
    else
        run systemctl enable --now apt-daily.timer apt-daily-upgrade.timer || warn "could not start apt timers"
    fi
}

# ---------------------------------------------------------- DNS-over-TLS --
harden_dns() {
    log "== DNS-over-TLS via systemd-resolved (Quad9) =="
    write_file /etc/systemd/resolved.conf.d/aeon-berk.conf 0644 <<'EOF'
# Aeon OS Berk — DNS-over-TLS to Quad9 (managed by harden-mint.sh)
[Resolve]
DNS=9.9.9.9#dns.quad9.net 149.112.112.112#dns.quad9.net 2620:fe::fe#dns.quad9.net 2620:fe::9#dns.quad9.net
FallbackDNS=1.1.1.1#cloudflare-dns.com 1.0.0.1#cloudflare-dns.com
DNSOverTLS=strict
DNSSEC=yes
Cache=yes
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        log "in chroot: skipping systemd-resolved restart (applies on first boot)"
    else
        run systemctl restart systemd-resolved || warn "could not restart systemd-resolved"
    fi
}

# --------------------------------------------- NetworkManager wifi privacy --
harden_networkmanager() {
    log "== NetworkManager: MAC randomization + IPv6 privacy =="
    write_file /etc/NetworkManager/conf.d/aeon-berk-wifi.conf 0644 <<'EOF'
# Aeon OS Berk — Wi-Fi privacy (managed by harden-mint.sh)
[device]
wifi.scan-rand-mac-address=yes

[connection]
# Randomize MAC per connection (Wi-Fi and Ethernet)
wifi.cloned-mac-address=random
ethernet.cloned-mac-address=random
# RFC 4941 IPv6 privacy extensions: prefer temporary addresses
ipv6.ip6-privacy=2
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        log "in chroot: skipping NetworkManager reload (applies on first boot)"
    else
        run systemctl reload NetworkManager || warn "NetworkManager reload failed; reboot to apply"
    fi
}

# ------------------------------------------------------------ pwquality --
harden_pwquality() {
    log "== password policy (pam_pwquality) =="
    write_file /etc/security/pwquality.conf.d/aeon-berk.conf 0644 <<'EOF'
# Aeon OS Berk — password quality policy (managed by harden-mint.sh)
minlen = 14
minclass = 3
maxrepeat = 3
maxclassrepeat = 4
gecoscheck = 1
dictcheck = 1
enforce_for_root
EOF
}

# ------------------------------------------------------------------ sudo --
harden_sudo() {
    log "== sudo defaults =="
    write_file /etc/sudoers.d/10-aeon-berk 0440 <<'EOF'
# Aeon OS Berk — sudo hardening (managed by harden-mint.sh)
Defaults use_pty
Defaults passwd_tries=3
Defaults timestamp_timeout=5
EOF
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would validate with: visudo -c -f /etc/sudoers.d/10-aeon-berk"
    else
        run visudo -c -f /etc/sudoers.d/10-aeon-berk || die "sudoers validation failed; refusing to continue"
    fi
}

# -------------------------------------------------------------- core dumps --
harden_coredumps() {
    log "== core dumps disabled =="
    write_file /etc/security/limits.d/10-aeon-berk.conf 0644 <<'EOF'
# Aeon OS Berk — no core dumps (managed by harden-mint.sh)
# (sysctl fs.suid_dumpable=0 is set in 99-aeon-berk.conf)
* hard core 0
* soft core 0
EOF
}

# ----------------------------------------------------------------- auditd --
harden_auditd() {
    log "== auditd baseline rules =="
    write_file /etc/audit/rules.d/aeon-berk.rules 0640 <<'EOF'
# Aeon OS Berk — auditd baseline (managed by harden-mint.sh)
# Delete all existing rules first so re-runs are idempotent.
-D
# Bigger backlog so bursts don't drop events
-b 8192
# Failure mode: 1 = print failure, keep going (2 would panic the box)
-f 1

# Identity: who can log in / escalate
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/sudoers -p wa -k identity
-w /etc/sudoers.d/ -p wa -k identity

# Time changes (anti-forensics / Kerberos skew)
-a always,exit -F arch=b64 -S adjtimex -S settimeofday -k time-change
-a always,exit -F arch=b32 -S adjtimex -S settimeofday -S stime -k time-change
-a always,exit -F arch=b64 -S clock_settime -k time-change
-w /etc/localtime -p wa -k time-change

# Kernel module load/unload
-a always,exit -F arch=b64 -S init_module -S delete_module -k modules
-a always,exit -F arch=b32 -S init_module -S delete_module -k modules

# Privileged execution
-w /usr/bin/sudo -p x -k privileged

# MAC / firewall tampering
-w /etc/apparmor/ -p wa -k mac-policy
-w /etc/apparmor.d/ -p wa -k mac-policy
-w /etc/ufw/ -p wa -k firewall

# Make the ruleset immutable until next reboot
-e 2
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        run systemctl enable auditd || warn "could not enable auditd"
        log "in chroot: auditd rules load on first boot (augenrules)"
    else
        run systemctl enable --now auditd || warn "could not start auditd"
        run augenrules --load || warn "augenrules --load failed; rules apply after reboot"
    fi
}

# -------------------------------------------------------------- /tmp tmpfs --
harden_tmp() {
    log "== /tmp as tmpfs (nodev,nosuid) =="
    if grep -Eq '^[[:space:]]*[^#[:space:]]+[[:space:]]+/tmp[[:space:]]' /etc/fstab 2>/dev/null; then
        log "/tmp already has an fstab entry; leaving it alone"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would append to /etc/fstab: tmpfs /tmp tmpfs defaults,nodev,nosuid,mode=1777 0 0"
        return 0
    fi
    backup_file /etc/fstab
    printf '%s\n' "tmpfs /tmp tmpfs defaults,nodev,nosuid,mode=1777 0 0  # Aeon OS Berk (harden-mint.sh)" >> /etc/fstab
    log "added tmpfs /tmp to /etc/fstab (takes effect after reboot; not mounted live on purpose)"
}

# --------------------------------------------------------- screen auto-lock --
harden_autolock() {
    log "== Cinnamon screen auto-lock (5 min) =="
    write_file /etc/dconf/db/local.d/00-aeon-berk 0644 <<'EOF'
# Aeon OS Berk — session auto-lock (managed by harden-mint.sh)
[org/cinnamon/desktop/session]
idle-delay=uint32 300

[org/cinnamon/desktop/screensaver]
idle-activation-enabled=true
lock-enabled=true
lock-delay=uint32 0
EOF
    if [[ $IN_CHROOT -eq 1 ]]; then
        log "in chroot: skipping 'dconf update' (runs on first boot via packaging triggers)"
    else
        run dconf update || warn "'dconf update' failed"
    fi
}

# ------------------------------------------------------- Firefox skeleton --
harden_firefox() {
    log "== hardened Firefox skeleton profile =="
    local skel="/etc/skel/.mozilla/firefox"
    write_file "$skel/profiles.ini" 0644 <<'EOF'
# Aeon OS Berk — default Firefox profile wiring (managed by harden-mint.sh)
[Profile0]
Name=berk
IsRelative=1
Path=berk.default
Default=1

[General]
StartWithLastProfile=1
Version=2
EOF
    write_file "$skel/berk.default/user.js" 0644 <<'EOF'
// Aeon OS Berk — curated Firefox hardening subset (inspired by arkenfox/user.js).
// Applies to NEW user accounts via /etc/skel. Existing users: copy
// /etc/skel/.mozilla into $HOME (back up your profile first).
// For the complete profile, replace this file with the full user.js from
// https://github.com/arkenfox/user.js

// --- tracking / fingerprinting ---
user_pref("privacy.trackingprotection.enabled", true);
user_pref("privacy.trackingprotection.socialtracking.enabled", true);
user_pref("privacy.fingerprintingProtection", true);
user_pref("privacy.query_stripping.enabled", true);

// --- safe browsing stays ON (phishing/malware protection) ---
user_pref("browser.safebrowsing.enabled", true);
user_pref("browser.safebrowsing.phishing.enabled", true);
user_pref("browser.safebrowsing.malware.enabled", true);

// --- network privacy ---
user_pref("network.http.referer.XOriginPolicy", 2);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.prefetch-next", false);
user_pref("browser.urlbar.speculativeConnect.enabled", false);
user_pref("browser.send_pings", false);
user_pref("media.peerconnection.enabled", false); // disables WebRTC (LAN IP leak vector); re-enable for video calls
user_pref("geo.enabled", false);
user_pref("webgl.disabled", true); // breaks some 3D sites; re-enable if needed
user_pref("dom.battery.enabled", false);

// --- TLS: 1.2 minimum ---
user_pref("security.tls.version.min", 3);

// --- telemetry off ---
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("browser.discovery.enabled", false);
user_pref("extensions.pocket.enabled", false);
EOF
}

# ------------------------------------------------------- remove reporters --
remove_crash_reporters() {
    log "== removing crash reporters (apport, whoopsie) =="
    local present=()
    local p
    for p in apport whoopsie; do
        if dpkg -s "$p" >/dev/null 2>&1; then
            present+=("$p")
        else
            log "already absent: $p"
        fi
    done
    [[ ${#present[@]} -eq 0 ]] && return 0
    run env DEBIAN_FRONTEND=noninteractive apt-get purge -y "${present[@]}"
    run apt-get autoremove -y || true
}

# ---------------------------------------------------------------- usbguard --
maybe_usbguard() {
    log "== usbguard =="
    if [[ $ENABLE_USBGUARD -eq 0 ]]; then
        log "usbguard left DISABLED (opt-in). To enforce later, plug in your trusted USB"
        log "devices, then run: sudo $0 --enable-usbguard"
        return 0
    fi
    warn "Generating a usbguard policy from CURRENTLY ATTACHED devices."
    warn "If your keyboard/mouse are USB and not attached right now, you WILL lock yourself out."
    if [[ $DRY_RUN -eq 1 ]]; then
        log "[dry-run] would run: usbguard generate-policy > /etc/usbguard/rules.conf && systemctl enable --now usbguard"
        return 0
    fi
    if [[ $IN_CHROOT -eq 1 ]]; then
        warn "in chroot: cannot generate a meaningful device policy; skipping enforce"
        return 0
    fi
    backup_file /etc/usbguard/rules.conf
    usbguard generate-policy > /etc/usbguard/rules.conf
    chmod 0600 /etc/usbguard/rules.conf
    run systemctl enable --now usbguard || warn "could not start usbguard"
}

# ================================================================== main ==
main() {
    log "Aeon OS Berk hardening v$VERSION (dry-run=$DRY_RUN, chroot=$IN_CHROOT)"
    [[ $DRY_RUN -eq 1 ]] && log "DRY RUN — nothing will be written, installed, or restarted"
    check_os
    check_install_time
    apt_install ufw apparmor-profiles-extra unattended-upgrades flatpak usbguard auditd libpam-pwquality
    harden_sysctl
    blacklist_protocols
    harden_grub
    harden_ufw
    harden_apparmor
    harden_upgrades
    harden_dns
    harden_networkmanager
    harden_pwquality
    harden_sudo
    harden_coredumps
    harden_auditd
    harden_tmp
    harden_autolock
    harden_firefox
    remove_crash_reporters
    maybe_usbguard
    log "done."
    if [[ $DRY_RUN -eq 0 ]]; then
        log "Backups (if anything changed): $BACKUP_DIR"
        [[ $IN_CHROOT -eq 0 ]] && warn "REBOOT to activate: sysctls, /tmp tmpfs, GRUB cmdline, auditd immutable rules."
    fi
}

main "$@"
