# Berk Updates — auto-update via GitHub

The friendly updater for Aeon OS Berk. One window called **Updates**:
a big "Check for updates" button, each app listed with a plain status
("Up to date" / "Update ready"), one big "Install updates" button, and a
progress bar that speaks plainly ("Getting Music…", "All done!").

## Files

| File | What it is |
|---|---|
| `berk-updater.py` | The updater. Python 3, **standard library only** (tkinter + urllib + hashlib + json). No third-party packages. |
| `apps.json` | Which apps to check, and where. **Isaiah: set `github_owner` to your real GitHub name — the one place it appears.** |
| `make-deb.sh` | Builds the installable `.deb` for one app: `./make-deb.sh music 1.0.6 --out debs/` |
| `berk-updater.desktop` | Menu entry: **Updates** — "Keep everything up to date" (lives under Advanced). |
| `autostart/berk-updater-check.desktop` | Runs `berk-updater.py --auto` at login: silent check, desktop notification only if updates are ready. |
| `RELEASES.md` | The release playbook: exact steps to ship an update so the updater picks it up. |
| `tests/test_updater.py` | 27 tests, all mocked/local — no real network. |

## How it stays safe (the Berk pillar)

- **SHA256SUMS is mandatory.** Every release must attach one; the updater
  verifies the download's hash *before* installing. Missing or mismatched
  sums = refused, with a plain-language message. Never a traceback.
- **Only `.deb` files are ever installed**, only over HTTPS, only after the
  hash check.
- Installs go through `pkexec` (the normal graphical permission prompt).
- `--dry-run` does everything except install — use it to test a release.

## Install layout on Berk

- Program: `/opt/berk-updater/berk-updater.py` + `apps.json`
- Menu: `/usr/share/applications/berk-updater.desktop`
- Autostart: `/etc/xdg/autostart/berk-updater-check.desktop`

## Quick self-test

```bash
python3 -m py_compile berk-updater.py
xvfb-run -a python3 tests/test_updater.py   # 27 tests, ~5s
./make-deb.sh music 1.0.5 --out /tmp/debs   # real .deb, dpkg-deb validates it
```
