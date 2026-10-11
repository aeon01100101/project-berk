AeonCodeNet for Linux (Aeon OS Berk)
=====================================
Linux/Electron port of the AeonCodeNet Android app. Vanilla JS, Electron 32.3.3,
no build step — run directly from source.

Layout
------
  main.js            Electron main process (settings file, history store,
                     LLM HTTP via node http/https, native save dialog, clipboard)
  preload.js         window.aeon bridge (context isolation on, no nodeIntegration)
  common/llm.js      LLM logic: languages, request builder, fence stripping,
                     /chat/completions client. Plain CommonJS — shared by the
                     main process and the node test suite.
  common/store.js    Settings + history persistence. Settings live in a JSON
                     file with mode 0600 in the app userData dir.
  renderer/          index.html + app.js + style.css (Generate/History/Settings,
                     dark developer theme)
  tests/run-tests.js Unit + integration tests (node only, no Electron needed)
  run.sh             Launcher: uses node_modules/electron/dist/electron
  aeoncodenet.desktop  Desktop entry. Exec=/opt/aeoncodenet/run.sh — the distro
                     packager should adjust the prefix to the real install path.

Setup / run
-----------
  npm install            # installs electron 32.3.3 (linux-x64 ships it bundled)
  npm test               # node unit + mock-server tests
  npm run check          # node --check on every JS file
  ./run.sh               # normal launch
  ./run.sh --smoke-test  # prints SMOKE_OK once the renderer is ready, then quits

Notes / honest limits
---------------------
- No API key is bundled. You supply your own in Settings.
- The API key is stored in a 0600 file in the app config dir
  (~/.config/aeoncodenet/settings.json). There is no OS keyring
  (libsecret) integration yet — the Settings tab says so.
- The app talks to any OpenAI-compatible POST /chat/completions endpoint.
- When run as root (e.g. in a sandbox), the app disables the Chromium
  sandbox via --no-sandbox; normal user installs keep the sandbox on.
