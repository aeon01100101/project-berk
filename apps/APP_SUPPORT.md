# Aeon app support on Aeon OS Berk (Linux)

Every Aeon app, and how it runs on Berk. "Menu name" is the plain-language
name shown in the Berk start menu (see `../UX.md` §2 — a 1st grader should
understand every entry).

| App | Menu name | Linux (Berk) status | Notes |
|---|---|---|---|
| AeonPhoto (new Linux port) | Picture Maker | ✅ `apps/aeonphoto/` — Electron, SMOKE_OK | Needs a local diffusion backend: bundled `sd-server` (stable-diffusion.cpp) auto-starts when a model is present; also detects SD WebUI on :7860. Honest "no backend" state if neither exists. Model not bundled (~4GB) — `download-model.sh` fetches SD 1.5. |
| AeonCodeNet (new Linux port) | Code Maker | ✅ `apps/aeoncodenet/linux-x64/` — Electron, SMOKE_OK, 35/35 unit tests | Same OpenAI-compatible API as Android; key stored in a 0600 file. No key bundled. |
| Aeon Radio (new Linux port) | Music | ✅ `apps/aeonradio/` — Electron, SMOKE_OK | All 141 built-in stations, Radio Browser directory, real ICY now-playing, HLS support. Verified against live streams. |
| AeonObj | 3D Maker | ✅ `apps/aeonobj/` — Electron linux-x64, 20s+ smoke run | Same app as Windows build, no code changes needed. |
| AeonCraft | AeonCraft | ✅ `apps/aeoncraft/` — Electron linux-x64, all node test suites pass | v1.2.0 (crafting, mobs, tools, armor). Same as Windows build. |
| Enigma Launcher | Minecraft | ✅ `apps/enigma-launcher/` — Electron linux-x64, 20s+ smoke run, 24/24 java-detect tests | Needs a Java 17 JRE on the system (`sudo apt install openjdk-17-jre`) or dropped into `resources/jre-linux/`; the app says so plainly if none is found. Server IPs still configured in-app Settings. |
| AeonTV | TV | ✅ Linux server build exists | Needs `.deb` packaging for the Berk APT repo (build exists at `~/workspace/aeontv-publish/`). |
| Classic Cable | Cable TV | ✅ Linux x64 build exists | Needs `.deb` packaging (build exists at `~/workspace/classiccable/publish/`). |
| Sovereign Essentials | — (no menu entry; Minecraft server mod) | ✅ runs on Linux already | Forge 1.18.2 server-side jar; Java 17. |
| QuietBrowse98 | Internet | ⚠️ Win32-only → runs under Wine | 48KB native exe; Berk can ship a Wine launcher wrapper. No native Linux port yet. |
| AeonObj98 | 3D Maker | ⚠️ Win32-only → runs under Wine | Same approach as QuietBrowse98. The Electron AeonObj above is the native Berk 3D app. |
| AeonAI | Assistant | ❌ Android-only (APK) | Chat backend URL is dead (offline mode); no Linux port planned until the backend question is settled with Isaiah. |
| ATS WWII Economy mod | — | ❌ N/A | Windows game mod (def files are platform-independent and work wherever the game runs). |
| Qwen3 + Ollama setup | — | ✅ Ollama runs natively on Linux | Setup scripts are Windows-oriented; a Berk-native guide is a small follow-up. |
| Berk updater | Updates | ✅ `updater/` — Python/tkinter, stdlib only | Checks each app's GitHub releases, SHA256SUMS-verifies every download before install, installs `.deb`s via graphical permission prompt. Auto-check on login via `--auto`. |

**Bottom line:** 9 of 10 user-facing Aeon apps run on Berk today (6 built and
smoke-tested this session, 2 more with existing Linux builds awaiting `.deb`
packaging, 1 via Wine). AeonAI is the only one with no Linux path yet.
