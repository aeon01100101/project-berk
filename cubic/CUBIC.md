# Building the Aeon OS Berk ISO with Cubic

This is the exact, verified procedure. Cubic runs a chroot against the ISO
contents on a **real machine** — it cannot run in a container, which is why
the ISO is assembled here-by-instruction rather than built in this repo.

## 0. Prerequisites (host machine)

- A real PC running **Ubuntu 24.04** or **Linux Mint 22.x**, 64-bit,
  with ~25 GB free disk and a working internet connection.
- Install Cubic:
  ```bash
  sudo apt-add-repository -y ppa:cubic-wizard/release
  sudo apt update
  sudo apt install -y cubic
  ```
- Download the stock ISO: `linuxmint-22.x-cinnamon-64bit.iso` from
  https://linuxmint.com/download.php — **verify the sha256sum** against the
  signature file on the Mint site before continuing.

## 1. Create the Cubic project

1. Open Cubic → choose a project directory, e.g. `~/Cubic/berk`.
2. Select the downloaded Mint ISO when prompted.
3. Let Cubic extract it, then click through to the **Terminal** page.
   You are now root in a chroot of the future ISO's filesystem.

## 2. Get this repo into the chroot

The Cubic terminal has network, but this repo isn't published anywhere, so
copy it from the host. **On the host** (second terminal):

```bash
# The Cubic project directory IS the chroot root, so /tmp in the Cubic
# terminal is <project-dir>/tmp on the host. (If your Cubic version shows
# a different project layout, use the directory Cubic displays as the
# project location.)
sudo cp -r ~/workspace/aeonos-berk <project-dir>/tmp/aeonos-berk
```

Back in the **Cubic terminal**, sanity-check and run the customizer:

```bash
ls /tmp/aeonos-berk/cubic/customize.sh   # should exist
chmod +x /tmp/aeonos-berk/cubic/customize.sh
/tmp/aeonos-berk/cubic/customize.sh
```

`customize.sh` does, in order:
1. `apt-get update`
2. Installs everything in `packages-add.list`, purges `packages-remove.list`
   (this is where Mint's Software Manager is removed — the Aeon Store is
   the one and only app store on Berk)
3. Runs `scripts/harden-mint.sh --in-chroot --force` (the full Berk
   baseline; live service restarts are skipped — they apply on first boot)
4. Runs `berk-simple/apply-ux.sh` (the XP desktop per `UX.md`), then builds
   and installs the **Aeon Store** `.deb` (`store/make-store-deb.sh`)
5. Adds the Flathub remote and installs **Flatseal**
   (`com.github.tchx84.Flatseal` — not in the Ubuntu archives, hence Flatpak)
6. `apt-get autoremove` + `clean`

If the Flatseal step fails (no network in the chroot), it prints a
fallback one-liner to run after first boot. Everything else must succeed —
do not continue past an error without understanding it.

## 2b. Reference UX capture (first build only)

`apply-ux.sh` ships curated Cinnamon defaults (theme, icons, fonts) that are
safe to set blindly. The *exact* panel layout, applet order, and the menu
applet's custom `start` label can't be specified safely by hand — so the
first build captures them from a real configured desktop:

1. Build the ISO once with everything above, boot it in the test VM.
2. Arrange the desktop per `UX.md` §1 using the Cinnamon GUI: single bottom
   panel (~48px), menu applet bottom-left with **custom label `start`** and
   the green Berk orb icon (`berk-start`), window list, tray + clock right.
3. In a terminal in the VM: `dconf dump /org/cinnamon/ > /tmp/cinnamon-ux.dconf`
4. Copy `/tmp/cinnamon-ux.dconf` out of the VM and commit it as
   `cubic/berk-simple/cinnamon-ux.dconf` in this repo.
5. Rebuild: `apply-ux.sh` picks the capture up automatically (it installs
   as a dconf db drop-in on top of the curated defaults).

Later builds skip this — the capture is the source of truth from then on.

## 3. Kernel command line (Cubic Boot page)

On the **Boot** tab → **Kernel** tab, append to the `linux` line:

```
mitigations=auto slab_nomerge init_on_alloc=1 init_on_free=1 page_alloc.shuffle=1
```

(These are also written into `/etc/default/grub` by `harden-mint.sh`, so
installed systems keep them via `update-grub`.)

## 4. Generate and test

1. Click **Generate** and wait for the ISO.
2. **Test in a VM first** (VirtualBox or virt-manager, EFI firmware,
   Secure Boot enabled if your VM supports it):
   - Boot the ISO, confirm the desktop comes up.
   - Run the installer: choose **"Encrypt the new Linux Mint installation"**
     and confirm Secure Boot is on in the VM firmware.
   - After install + reboot, verify: `sudo ufw status` (active, deny
     incoming), `sudo aa-status` (profiles in enforce), `resolvectl status`
     (DNSOverTLS=yes, Quad9), `sysctl kernel.kptr_restrict` (= 2).
   - **UX verification (UX.md §6):** single bottom panel (~48px, XP-blue
     taskbar); Start button labeled `start` with the green orb; berk-xp
     XP theme (blue titlebars, red close button); Bliss wallpaper; menu
     shows Internet / Music / Games / Pictures / Write / Files / Advanced
     and nothing technical; Aeon apps appear under their plain-language
     names. If any of this is wrong, it's a build blocker — fix and rebuild.
3. Only then write it to USB (e.g. balenaEtcher, or `dd`) for bare metal.

## 5. Notes

- **Secure Boot**: we keep Mint's signed shim and stock kernel, so the ISO
  boots under Secure Boot with no custom signing. We do not replace the
  kernel — see SECURITY.md §16.
- **First boot**: `harden-mint.sh --in-chroot` skips live restarts, so the
  first boot applies sysctls, auditd rules, resolved DoT, and the dconf
  auto-lock via normal systemd ordering. Reboot once more after install to
  be certain everything (including the tmpfs `/tmp` and GRUB cmdline) is
  live, then re-run the verification commands from step 4.
- **usbguard** is installed but not enforced in the ISO. Enable per-machine
  after install (SECURITY.md §15).
- Point releases: repeat this procedure against the newest
  `linuxmint-22.x-cinnamon-64bit.iso` when Mint ships one.
