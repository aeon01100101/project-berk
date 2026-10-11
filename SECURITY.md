# Aeon OS Berk — Security Manifest

Berk is the security-hardened edition of Aeon OS, built on **Linux Mint 22.x
Cinnamon** (Ubuntu 24.04 LTS "noble" base). This document is the complete,
concrete list of what Berk changes relative to stock Mint, why, and what it
deliberately does **not** claim. Everything here is implemented by
`scripts/harden-mint.sh` (for existing installs) and `cubic/customize.sh`
(for the ISO build).

## 1. Install-time (set in the installer, verified — not scripted)

These cannot be retrofitted safely by a script, so they are part of the
install procedure documented in `cubic/CUBIC.md`, and `harden-mint.sh`
warns if they look absent:

- **LUKS full-disk encryption** — choose "Encrypt the new Linux Mint
  installation" in the installer (LVM + LUKS). Berk treats unencrypted
  installs as non-compliant; the script refuses to pretend otherwise.
- **Secure Boot ON** in firmware. Berk keeps Mint's signed shim and stock
  Ubuntu kernel, so Secure Boot keeps working. No custom kernel is shipped,
  so no MOK enrollment dance is required.
- **LVM layout** (the installer's default when encryption is selected).

## 2. Kernel hardening (`/etc/sysctl.d/99-aeon-berk.conf`)

| Setting | Value | Why |
|---|---|---|
| `kernel.kptr_restrict` | 2 | Hide kernel symbol addresses from unprivileged users |
| `kernel.dmesg_restrict` | 1 | dmesg readable by root only (info leak) |
| `kernel.unprivileged_bpf_disabled` | 2 | No unprivileged BPF (major privesc vector class) |
| `kernel.perf_event_paranoid` | 3 | No unprivileged perf snooping across processes |
| `kernel.yama.ptrace_scope` | 2 | Only a process's descendants may ptrace it |
| `kernel.kexec_load_disabled` | 1 | Block kexec as a route to replacing the running kernel |
| `kernel.sysrq` | 16 | Magic SysRq = sync-only (full SysRq enables console tricks) |
| `dev.tty.ldisc_autoload` | 0 | Don't auto-load TTY line disciplines on demand |
| `vm.mmap_min_addr` | 65536 | Don't map the zero page (NULL-deref mitigation) |
| `fs.protected_hardlinks` / `protected_symlinks` | 1 | Classic /tmp link-attack mitigations |
| `fs.protected_fifos` / `protected_regular` | 2 | Stricter FIFO/regular-file creation rules |
| `fs.suid_dumpable` | 0 | No core dumps from setuid processes |
| `net.ipv4.conf.{all,default}.rp_filter` | 1 | Reverse-path filtering (spoofed-source mitigation) |
| `net.ipv4.conf.{all,default}.accept_redirects` | 0 | Ignore ICMP redirects |
| `net.ipv6.conf.{all,default}.accept_redirects` | 0 | Same for IPv6 |
| `net.ipv4.conf.{all,default}.send_redirects` | 0 | Never send ICMP redirects |
| `net.ipv4.icmp_echo_ignore_broadcasts` | 1 | Ignore broadcast ping (Smurf) |
| `net.ipv4.icmp_ignore_bogus_error_responses` | 1 | Ignore bogus ICMP errors |
| `net.ipv4.tcp_syncookies` | 1 | SYN-flood resistance |
| `net.ipv4.conf.{all,default}.log_martians` | 1 | Log packets with impossible source addresses |

Kernel boot parameters (GRUB `GRUB_CMDLINE_LINUX_DEFAULT`, also set on the
Cubic Boot page for the ISO):
`mitigations=auto slab_nomerge init_on_alloc=1 init_on_free=1 page_alloc.shuffle=1`
— automatic CPU-vulnerability mitigations, no slab merging (heap hardening),
zero-on-alloc/free, and freelist shuffling.

Note: `kernel.unprivileged_userns_clone` is deliberately **not** disabled —
Flatpak/bubblewrap needs unprivileged user namespaces to sandbox apps.

## 3. Uncommon network protocols (`/etc/modprobe.d/aeon-berk-blacklist.conf`)

`dccp`, `sctp`, `rds`, `tipc` are blacklisted and bound to `/bin/true`.
Desktop systems don't use them; each is historically a source of
remote/local kernel CVEs.

## 4. Firewall — UFW

- Default policy: **deny incoming, allow outgoing.**
- Safe on a desktop. If `sshd` is found listening when the script runs, the
  `OpenSSH` profile is allowed automatically and the run is logged; otherwise
  the script prints a warning to allow SSH **before** enabling if you need it.

Optional strict profile (documented, not default — it will break LAN
printing, Chromecast, etc.):
```
sudo ufw default deny outgoing
sudo ufw allow out 53,853/tcp   # DNS / DNS-over-TLS
sudo ufw allow out 80,443/tcp   # web
```

## 5. AppArmor

- `apparmor-profiles-extra` installed; every profile in `/etc/apparmor.d/`
  (except ones in `disable/`) is switched to **enforce** mode via `aa-enforce`.
- The `apparmor` service is enabled. Profiles that fail to enforce are left
  as-is and reported — check with `aa-status`.

## 6. Sandboxing — Flatpak-first

- `flatpak` installed; third-party applications ship as Flatpaks.
- **Flatseal** installed from Flathub in the ISO build
  (`com.github.tchx84.Flatseal` — it is not in the Ubuntu archives, so it
  cannot come from APT). Flatseal gives a GUI for per-app sandbox permissions.
- Aeon first-party apps ship as `.deb` packages from the Berk APT repo
  (`repo/`), not Flatpaks, so they integrate with the system normally.

## 7. Session — Wayland by default, X11 fallback

Berk selects the **Wayland session** as the default on the login screen
(isolated clients, no X11-style keylogging/screenshot-by-any-app).

**Honest caveat:** as of Mint 22.x, Cinnamon's Wayland session is
**experimental** — some applets, screen sharing, and global hotkeys misbehave
or break. The X11 session remains installed and selectable from the login
screen as a documented fallback. We do not claim Wayland is flawless here.

## 8. Browser — hardened Firefox

New user accounts get a skeleton Firefox profile (`/etc/skel/.mozilla`)
with a curated `user.js` hardening subset (tracking protection, fingerprinting
protection, query stripping, WebRTC disabled, TLS 1.2 minimum, telemetry off
— Safe Browsing stays **on**). It is a subset inspired by
[arkenfox/user.js](https://github.com/arkenfox/user.js); replacing the file
with the full arkenfox `user.js` gives the complete profile. Existing users
can copy `/etc/skel/.mozilla` into `$HOME` (back up first).

## 9. DNS-over-TLS — systemd-resolved → Quad9

`/etc/systemd/resolved.conf.d/aeon-berk.conf`:
`DNSOverTLS=strict` to `9.9.9.9` / `149.112.112.112` (+ IPv6) with
`#dns.quad9.net` SNI, `DNSSEC=yes`, Cloudflare as fallback. Strict mode means
DNS **fails closed** rather than leaking plaintext if TLS breaks.

## 10. NetworkManager — Wi-Fi privacy

`/etc/NetworkManager/conf.d/aeon-berk-wifi.conf`:
- `wifi.scan-rand-mac-address=yes` (probe requests don't carry the real MAC)
- `wifi.cloned-mac-address=random` and `ethernet.cloned-mac-address=random`
  (per-connection MAC randomization)
- `ipv6.ip6-privacy=2` (RFC 4941 temporary addresses preferred)

## 11. Updates

- `unattended-upgrades` configured for `-security` pockets (Ubuntu and
  LinuxMint origins), unused deps removed, no automatic reboot.
- `apport` and `whoopsie` (crash reporters that phone home) are purged.

## 12. Authentication & session policy

- `pam_pwquality`: minimum length **14**, at least **3** character classes,
  `maxrepeat=3`, dictionary + gecos checks, enforced for root too.
- `sudo`: `timestamp_timeout=5` (re-auth after 5 idle minutes),
  `passwd_tries=3`, `use_pty`.
- Cinnamon auto-lock: **5-minute** idle delay, screensaver lock enabled
  (`/etc/dconf/db/local.d/00-aeon-berk`).
- Core dumps: `* hard/soft core 0` in limits.d **plus**
  `fs.suid_dumpable=0` in sysctl.

## 13. Filesystem

- `/tmp` mounted as `tmpfs` with `nodev,nosuid,mode=1777` (fstab entry added
  only if no `/tmp` entry exists; takes effect after reboot — deliberately
  not mounted live on a running desktop).

## 14. Auditing — auditd baseline

`/etc/audit/rules.d/aeon-berk.rules`, immutable after load (`-e 2`):
- Identity files: `/etc/passwd`, `/etc/group`, `/etc/shadow`,
  `/etc/gshadow`, `/etc/sudoers`, `/etc/sudoers.d/` (write/attr).
- Time changes: `adjtimex`, `settimeofday`, `stime`, `clock_settime`,
  `/etc/localtime`.
- Kernel modules: `init_module` / `delete_module`.
- Privilege: execution of `/usr/bin/sudo`.
- Policy tampering: writes under `/etc/apparmor*`, `/etc/ufw/`.
Review with `ausearch -k <key>` (keys: `identity`, `time-change`,
`modules`, `privileged`, `mac-policy`, `firewall`).

## 15. USB — usbguard (opt-in)

`usbguard` is **installed but not enforced** by default — enforcing with the
wrong policy locks out your own keyboard. Opt in explicitly:
1. Plug in every USB device you trust.
2. Run `sudo scripts/harden-mint.sh --enable-usbguard` (generates a policy
   from currently attached devices and enables the service).

## 16. What we do NOT claim

- **No verified boot beyond Secure Boot.** We keep Mint's signed shim; there
  is no custom measured-boot / TPM-sealed-LUKS chain. Evil-maid attacks are
  mitigated by LUKS, not eliminated.
- **No reproducible-builds claim.** The ISO is assembled with Cubic on a real
  machine; builds are not bit-for-bit reproducible and we don't pretend they
  are.
- **Wayland is experimental** on Cinnamon 22.x (see §7) — the X11 fallback
  exists because we won't ship a login you can't use.
- **No MAC confinement of everything.** AppArmor covers shipped profiles;
  Flatpak covers third-party apps; your own binaries run unconfined like on
  any desktop distro.
- **Telemetry removal is best-effort.** apport/whoopsie are gone and Firefox
  telemetry is off, but Mint/Cinnamon still check for updates normally.
- **Threat model:** a hardened *desktop* for a single user — stolen laptop,
  malicious USB, hostile network, malicious website. Not a server, not
  Qubes, not Tails.
