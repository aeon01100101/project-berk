# Aeon OS Berk — "Berk Simple" UX Spec

**Design pillar:** Aeon OS Berk must be usable by a **1st grader** — Windows XP
level simple. This sits alongside security as a first-class pillar: the
system is locked down *and* a six-year-old can use it without help.

Nothing here is aspirational decoration. Every item is either applied at
build time by `cubic/berk-simple/apply-ux.sh`, enforced in Aeon app
packaging, or captured during the first test-VM build (documented in
`cubic/CUBIC.md`).

## 1. The desktop: XP-style Cinnamon

- **One bottom panel**, full width, ~48px tall. No top bar, no docks, no
  second panels.
- **One big friendly Start button**, bottom-left, labeled **`start`**
  (lowercase, plain). Implemented via the Cinnamon menu applet's custom
  label; icon is the green Berk orb (`berk-simple/start-orb.svg`).
- **Large icons** everywhere: panel launchers, desktop, and menu.
- **Window list** on the panel (big task buttons, XP-style), system tray and
  clock bottom-right. Nothing else on the panel.
- **Theme: first-party XP "Luna" (`berk-xp`), bright Little Tikes colors:**
  - Cinnamon desktop theme: `berk-xp` — Luna-blue taskbar, green Start
    button, XP-style task buttons and Start menu
  - Window borders: `berk-xp` — Luna-blue gradient titlebars, red close
    button
  - Wallpaper: `berk-bliss.jpg` — Bliss-style green hill under blue sky
  - GTK theme: `Mint-Y-Blue` (unchanged — friendly blue, already stocked;
    the XP look lives in the shell, window borders, and wallpaper, which is
    what a 1st grader actually sees)
  - Icon theme: `Mint-Y-Blue`
  - UI font: `Noto Sans 12`

  Why first-party: a theme shipped in this repo
  (`cubic/berk-simple/berk-xp/`) has no third-party download and no
  supply-chain risk — unlike fetching an XP theme off the internet.
  Applied system-wide via dconf in `cubic/berk-simple/10-berk-simple`,
  installed by `apply-ux.sh`. Verified visually in the test VM
  (CUBIC.md step 4); if it doesn't read "Windows XP", that's a build
  blocker, not a shrug.
- **Readable + high contrast by default:** 12pt UI font minimum, large
  targets. Cinnamon's Accessibility → High Contrast remains available under
  Advanced for anyone who needs it; it is not the default.
- **No terminal needed for daily use.** Updates are automatic
  (unattended-upgrades), the firewall needs no interaction, DNS/DoT is
  preconfigured. The Terminal lives only under Advanced (§4).

## 2. Plain-language menu: categories and app names

### Menu categories (exact)

| Shown | Covers |
|---|---|
| Internet | web, network tools |
| Music | audio players, radio |
| Games | games |
| Pictures | image viewers/editors, photo tools |
| Write | documents, office |
| Files | file manager |
| Advanced | the one grown-up area (§4) |

Implemented with freedesktop `.directory` overrides installed to
`/usr/local/share/desktop-directories/` (which shadows `/usr/share` per the
XDG spec — a real, standard mechanism):
`Network.directory`→Internet, `Audio.directory`→Music,
`Game.directory`→Games, `Graphics.directory`→Pictures,
`Office.directory`→Write. `Files` and `Advanced` are custom categories
(`X-Berk-Files.directory`, `X-Berk-Advanced.directory`); Nemo is tagged
`X-Berk-Files`, and Terminal / System Settings / Software Manager / Update
Manager are tagged `X-Berk-Advanced`, by `apply-ux.sh`.

Known v1 tradeoff, stated plainly: LibreOffice Calc/Impress appear under
"Write" alongside Writer. Acceptable for v1; revisit if Isaiah wants them
split.

### First-party Aeon app display names (exact)

Packagers: these `Name=` values go in the `.deb`'s `.desktop` file **at
build time**. `apply-ux.sh` also enforces them on anything already
installed (belt and suspenders). Filenames stay technical — the user never
sees them.

| App | `Name=` | `Comment=` |
|---|---|---|
| Aeon Radio | **Music** | Listen to radio stations |
| AeonCodeNet | **Code Maker** | Make computer programs |
| AeonPhoto | **Picture Maker** | Make pictures |
| AeonObj / AeonObj98 | **3D Maker** | Make 3D shapes |
| AeonCraft | **AeonCraft** | Build and play |
| Enigma Launcher | **Minecraft** | Play Minecraft |
| AeonTV | **TV** | Watch TV shows |
| Classic Cable | **Cable TV** | Watch cable TV |
| QuietBrowse | **Internet** | Browse the web |
| Berk updater | **Updates** | Keep everything up to date |
| AeonAI | **Assistant** | Ask questions, get help |
| Sovereign Essentials | *(no desktop entry — Minecraft server mod)* | — |

Rules: `Name=` is 1–2 plain words, never a codename, never an acronym.
`Comment=` is a short sentence a 1st grader understands. No version numbers
in names.

## 3. First-run setup wizard (spec)

A full-screen, big-button wizard runs **once** on first boot, before the
desktop. Implementation later (Python 3 + Tkinter recommended — stdlib only,
no new ISO dependencies; Electron acceptable if preferred). This spec is
the contract it must implement.

**Autostart mechanism (concrete):**
`/etc/xdg/autostart/berk-first-run.desktop` launches
`/usr/lib/berk-first-run/berk-first-run.py`, which exits immediately if
`~/.config/berk/first-run-done` exists, and writes that sentinel file on
completion. `OnlyShowIn=X-Cinnamon;`, `NoDisplay=true`.

**Screens (one question per screen, no exceptions):**

1. **Welcome** — "Hi! Let's set up your computer." One giant button:
   "Start". Language is preselected from the install locale; a small
   "Change language" link opens the language list (big buttons, native
   names, e.g. "Español", "Deutsch"). 
2. **Wi-Fi** — "Pick your Wi-Fi." Big list of network names with signal
   bars (no dBm, no "SSID"). Tap a network → big password box with a
   show/hide toggle → "Connect". Always a "Skip for now" button.
3. **Your name** — "What's your name?" One big text field (on-screen
   keyboard hint on touch devices). Optional: pick a picture — six big
   animal faces. "Next".
4. **Done** — big green checkmark. "All done, {name}!" One giant button:
   "Start using Berk".

**Hard rules for the wizard:**
- Buttons ≥ 64px tall, primary action biggest and bottom-right.
- Progress dots at the bottom; "Back" on every screen; no timeouts, no
  pressure.
- **Zero jargon.** Banned words (nowhere in wizard or desktop UI):
  `terminal, kernel, partition, repository, daemon, SSID, UTC, sudo, root,
  mount, package, dependency, bootloader`. Say "Wi-Fi" not "SSID",
  "picture" not "avatar", "Start" not "proceed".
- **Password interaction with the security pillar:** the account setup
  offers "Stay logged in" ON by default (auto-login — a 1st grader should
  not type a 14-character password every boot). The 14-character
  `pam_pwquality` policy still applies whenever a password *is* set
  (e.g. by a parent under Advanced). Security default stays strict;
  the child's daily path stays simple.
- The wizard never opens a terminal, never shows a log, never asks a
  question with more than one concept in it.

## 4. Simple vs Advanced — the principle

**Simple defaults for everything. Advanced options live behind exactly one
clearly-labeled "Advanced" area, never in the user's face.**

- The application menu has **one** "Advanced" category containing:
  Terminal, System Settings, Software Manager, Update Manager.
  Everything else the user sees is plain-language (§2).
- Inside Aeon apps: at most **one** "Advanced" button per app, and the main
  flow must never require it.
- Error and confirmation dialogs use plain language ("Something didn't
  work. Try again." — never a stack trace, never "exit code 1").
- Destructive actions (delete, reset) always get a plain-language
  confirmation with the safe choice as the big default button.

## 5. Hardening is invisible

The security baseline (SECURITY.md) must never interrupt the person using
the computer:

- `scripts/harden-mint.sh` is **fully non-interactive-safe**: no `read`
  prompts, `DEBIAN_FRONTEND=noninteractive` everywhere, `ufw --force`,
  and every message it prints goes to the admin running it — never to the
  desktop user. (It runs at build/install time; the 1st grader never sees
  it. Verified: the script contains zero interactive prompts.)
- UFW default-deny needs no popups. Unattended-upgrades need no clicks.
  Auditd, AppArmor, sysctls, DoT: all silent.
- The one visible security feature is the **5-minute screen auto-lock** —
  unlocking just asks for the password, like waking any computer.

## 6. What "done" looks like (acceptance)

- Boot → wizard → desktop with zero typed commands.
- A 1st grader can find Music, Games, Pictures, and Internet from the
  `start` menu without being told what they're called.
- Nothing on screen says "terminal", "repository", "daemon", or any other
  banned word.
- The Advanced area exists, is findable by an adult, and is never needed
  for daily use.
