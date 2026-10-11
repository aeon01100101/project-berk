# AeonPhoto for Linux (Aeon OS Berk)

On-device AI image generator — faithful port of the Android AeonPhoto app.
Prompt input, style presets, shape options, history gallery, save / copy /
open-folder sharing.

MediaPipe's image generator is Android/iOS-only, so the Linux build talks to
a **local diffusion backend** instead:

1. **stable-diffusion.cpp server** (recommended) — probed first at
   `http://127.0.0.1:1234` (its default `--listen-port`), then
   `http://127.0.0.1:8080`. Detected via `GET /v1/models` (fingerprint:
   `id: "sd-cpp-local"`). Images via `POST /v1/images/generations`
   (OpenAI-compatible); steps/seed travel in the documented
   `<sd_cpp_extra_args>` prompt extension.
2. **Stable Diffusion WebUI API** — probed at `http://127.0.0.1:7860` via
   `GET /sdapi/v1/sd-models`. Images via `POST /sdapi/v1/txt2img`.

Overrides: `AEONPHOTO_SDCPP_URL`, `AEONPHOTO_WEBUI_URL`.

**Honest state:** if no backend answers, the Generate button is disabled and
the app shows a setup panel explaining exactly what to install. Nothing is
ever faked — no mock images, no simulated progress.

## Run

```sh
./run.sh
```

## Backend setup

- `download-model.sh` — resumable curl download of SD 1.5
  (`v1-5-pruned-emaonly.safetensors`, ~4 GB, CreativeML Open RAIL-M license)
  into `~/.local/share/aeonphoto/models/`.
- If `linux-x64/resources/server/sd-server` exists **and** a model file is
  present, AeonPhoto auto-starts the bundled server on launch.
- Or start your own:
  `sd-server -m /path/to/model.safetensors --listen-ip 127.0.0.1 --listen-port 1234`
- Or run SD WebUI with `./webui.sh --api`.

## Building the bundled sd-server (from source)

The `sd-server` binary is a build artifact (not stored in git). To rebuild:

```sh
git clone https://github.com/leejet/stable-diffusion.cpp
cd stable-diffusion.cpp
git submodule update --init
cmake -B build -DCMAKE_BUILD_TYPE=Release -DSD_SERVER_BUILD_FRONTEND=OFF
cmake --build build --target sd-server -j$(nproc)
# binary: build/bin/sd-server  (~39MB stripped; needs only system libgomp/stdc++)
```

Copy it to `linux-x64/resources/server/sd-server` (or `/opt/aeonphoto/resources/server/sd-server`
when installed) and the app will auto-start it when a model is present.
(The web frontend needs pnpm, so it is disabled — the server API is all the app uses.)

## Tests

```sh
node test-backend.js          # BackendManager vs mock servers (8 tests)
./run.sh --smoke-test         # xvfb: asserts honest no-backend UI, SMOKE_OK
```

## Layout

- `linux-src/` — source (`main.js` + `backend-manager.js` + `preload.js`,
  `renderer/`)
- `linux-x64/` — runnable packaged dir (Electron 32.3.3 linux-x64)
- `run.sh` — launcher
- `AeonPhoto.desktop` — desktop entry (install to `/opt/aeonphoto`)
