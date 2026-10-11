# Aeon OS Berk

**Aeon OS Berk** is a security-hardened Linux distribution based on
**Linux Mint 22.x (Cinnamon)**, built for Isaiah. Familiar Mint desktop on
the outside; a serious hardening baseline underneath — and simple enough
for a 1st grader to use.

## The two pillars

1. **Super secure.** LUKS full-disk encryption, Secure Boot, restrictive
   kernel sysctls, UFW default-deny, AppArmor enforce, auditd, automatic
   security updates, DNS-over-TLS, and more. The full concrete manifest is
   [SECURITY.md](SECURITY.md) — including what Berk deliberately does *not*
   claim.
2. **Berk Simple — Windows XP level simple.** One bottom panel, one big
   friendly `start` button, plain-language menu categories (Internet,
   Music, Games, Pictures, Write, Files) and app names ("Music" not
   "Aeon Radio"), big buttons, readable fonts, zero jargon, no terminal
   needed for daily use, and a big-button first-run wizard. The complete
   spec is [UX.md](UX.md).

Security never interrupts the user: hardening runs at build/install time,
updates are automatic, and the only visible security feature is the
screen auto-lock.

## Why Linux Mint 22.x as the base

- **Ubuntu 24.04 LTS underneath** — 5 years of security updates (until 2029),
  the largest hardware-support and driver ecosystem in Linux.
- **Familiarity** — Cinnamon is a calm, Windows-like desktop. No relearning
  curve, no GNOME extension fragility.
- **No Snap dependence** — Mint ships Flatpak-first and disables Snap by
  default, which matches Berk's sandboxing story (§6 of SECURITY.md).
- **Secure Boot just works** — Mint's signed shim boots on locked-down
  firmware with no MOK enrollment.

## What the "Berk" edition changes

Everything is specified in [SECURITY.md](SECURITY.md) and implemented by
[`scripts/harden-mint.sh`](scripts/harden-mint.sh). In short:

- Install-time: **LUKS full-disk encryption** enforced, Secure Boot on, LVM.
- Kernel: restrictive sysctls (`kptr_restrict=2`, `dmesg_restrict=1`,
  `unprivileged_bpf_disabled=2`, `perf_event_paranoid=3`,
  `yama.ptrace_scope=2`, …), uncommon protocols blacklisted, hardened boot
  cmdline (`mitigations=auto slab_nomerge init_on_alloc=1 …`).
- **UFW** default-deny incoming, **AppArmor** enforce mode, **auditd**
  baseline, `unattended-upgrades` for security updates.
- **DNS-over-TLS** to Quad9, Wi-Fi MAC randomization, IPv6 privacy
  extensions, Wayland-by-default session.
- Hardened Firefox skeleton profile, 14-char password policy, 5-minute
  sudo re-auth and screen auto-lock, no core dumps, tmpfs `/tmp`,
  crash reporters (apport/whoopsie) removed, usbguard available opt-in.

Read [SECURITY.md](SECURITY.md) §16 for what Berk deliberately does **not**
claim (no verified boot beyond Secure Boot, no reproducible builds,
Wayland-on-Cinnamon is experimental).

## Repo layout

```
aeonos-berk/
├── README.md            this file
├── SECURITY.md          the hardening manifest (concrete, no hand-waving)
├── scripts/
│   └── harden-mint.sh   idempotent lockdown script for a stock Mint 22 install
├── cubic/
│   ├── CUBIC.md         exact steps to build the bootable ISO on a real machine
│   ├── customize.sh     runs inside the Cubic chroot (APT sets + harden-mint.sh + UX)
│   ├── berk-simple/     "Berk Simple" desktop bundle: dconf defaults, start orb
│   │                    icon, plain-language menu categories, Aeon app renamer
│   │                    (apply-ux.sh), per the UX.md spec
│   ├── packages-add.list    } verified Ubuntu 24.04 "noble" package names
│   └── packages-remove.list }
├── repo/
│   ├── build-repo.sh    builds the first-party APT repo from .debs in pool/
│   ├── conf/            client sources entry + notes
│   ├── pool/            drop Aeon .deb packages here
│   └── dists/           generated repo metadata (do not hand-edit)
└── apps/
    ├── README.md        where Linux app builds land
    └── APP_SUPPORT.md   per-app Linux support matrix (DRAFT)
```

## Quickstart

**Harden an existing Linux Mint 22 install** (preview first — always):
```bash
sudo ./scripts/harden-mint.sh --dry-run   # see everything it would do
sudo ./scripts/harden-mint.sh             # apply (reboot after)
```

**Build the ISO**: follow [`cubic/CUBIC.md`](cubic/CUBIC.md) on a real
Ubuntu 24.04 / Mint 22 machine with Cubic installed.

## Honest statement about the ISO

The bootable ISO itself is **assembled with Cubic on a real machine** —
that step is documented in `cubic/CUBIC.md`, not performed here. This repo
contains everything that goes *into* the ISO (hardening scripts, package
lists, repo scaffold) plus the exact, verified procedure to produce it.
Nothing here pretends the ISO already exists.

## Aeon apps on Berk

All Aeon applications get Linux builds for Berk, shipped as `.deb`
packages through the first-party APT repo (`repo/`). Status per app lives
in [`apps/APP_SUPPORT.md`](apps/APP_SUPPORT.md) (draft — the build
coordinator finalizes it as Linux builds land in `apps/`).

Packagers: the exact plain-language `Name=` / `Comment=` values for every
Aeon app's `.desktop` file are specified in [UX.md](UX.md) §2 ("Berk
Simple"). Set them at build time; `cubic/berk-simple/apply-ux.sh` enforces
them again at ISO build time.
