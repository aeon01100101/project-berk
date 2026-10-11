'use strict';
/**
 * BackendManager — local diffusion backend detection, generation and
 * (optional) bundled-server lifecycle for AeonPhoto on Linux.
 *
 * Backend priority (in order):
 *   1. stable-diffusion.cpp server mode  (http://127.0.0.1:8080)
 *      probed via GET /health, images via POST /v1/images/generations
 *      (OpenAI-compatible endpoint provided by sd.cpp's server mode).
 *   2. Stable Diffusion WebUI API       (http://127.0.0.1:7860)
 *      probed via GET /sdapi/v1/sd-models, images via POST /sdapi/v1/txt2img.
 *
 * Honest-state contract (Isaiah's zero-tolerance policy): detection returns
 * the real state. If nothing answers, the UI disables Generate and shows a
 * setup panel. This module NEVER synthesizes an image.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SDCPP_URLS = (process.env.AEONPHOTO_SDCPP_URL
  ? [process.env.AEONPHOTO_SDCPP_URL]
  : ['http://127.0.0.1:1234', 'http://127.0.0.1:8080']);
// Port 1234 is sd.cpp's server default (--listen-port); 8080 is kept as a
// fallback for users who started it with an explicit --listen-port 8080.
const DEFAULT_WEBUI_URL = process.env.AEONPHOTO_WEBUI_URL || 'http://127.0.0.1:7860';
const PROBE_TIMEOUT_MS = 2500;

function requestJson(urlStr, { method = 'GET', body = null, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { reject(new Error('bad url: ' + urlStr)); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON body */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function probeSdcpp(baseUrl) {
  // sd.cpp server mode answers GET /v1/models with
  // {"data":[{"id":"sd-cpp-local","object":"model","owned_by":"local"}]}
  // (see examples/server/routes_openai.cpp). The id fingerprint proves it is
  // sd.cpp and not some other OpenAI-compatible server.
  try {
    const r = await requestJson(baseUrl + '/v1/models');
    const items = r.body && r.body.data;
    if (r.status === 200 && Array.isArray(items) && items.some((m) => m && m.id === 'sd-cpp-local')) {
      return { ok: true, detail: 'sd.cpp server (sd-cpp-local)' };
    }
    return { ok: false, detail: 'unexpected /v1/models response (http ' + r.status + ')' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function probeWebui(baseUrl) {
  // SD WebUI API answers GET /sdapi/v1/sd-models with a JSON model list.
  try {
    const r = await requestJson(baseUrl + '/sdapi/v1/sd-models');
    if (r.status === 200 && Array.isArray(r.body)) {
      const names = r.body.slice(0, 3).map(m => m.model_name || m.title).filter(Boolean);
      return { ok: true, detail: 'SD WebUI API' + (names.length ? ' (' + names.join(', ') + ')' : '') };
    }
    return { ok: false, detail: 'unexpected /sdapi/v1/sd-models response (http ' + r.status + ')' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

class BackendManager {
  constructor(opts = {}) {
    this.sdcppUrls = opts.sdcppUrls || opts.sdcppUrl && [opts.sdcppUrl] || DEFAULT_SDCPP_URLS;
    this.webuiUrl = opts.webuiUrl || DEFAULT_WEBUI_URL;
    this.state = { kind: 'none', url: null, detail: 'not checked yet' };
    this.serverProc = null;      // child_process handle of auto-started bundled server
    this.serverLog = [];
    this.onLog = opts.onLog || (() => {});
  }

  log(msg) {
    const line = '[backend] ' + msg;
    this.serverLog.push(line);
    if (this.serverLog.length > 200) this.serverLog.shift();
    this.onLog(line);
  }

  /** Detect backends in priority order. Returns state {kind, url, detail}. */
  async detect() {
    for (const url of this.sdcppUrls) {
      const sd = await probeSdcpp(url);
      if (sd.ok) {
        this.state = { kind: 'sdcpp', url, detail: sd.detail };
        return this.state;
      }
    }
    const wu = await probeWebui(this.webuiUrl);
    if (wu.ok) {
      this.state = { kind: 'webui', url: this.webuiUrl, detail: wu.detail };
      return this.state;
    }
    this.state = { kind: 'none', url: null, detail: 'no sd.cpp or WebUI backend answered' };
    return this.state;
  }

  isReady() { return this.state.kind !== 'none'; }

  /**
   * Generate a 1024x1024 PNG buffer from the active backend.
   * Always generates square; the caller center-crops for non-square shapes.
   */
  async generateSquare({ prompt, steps = 20, seed = 0 }) {
    if (this.state.kind === 'sdcpp') return this._genSdcpp({ prompt, steps, seed });
    if (this.state.kind === 'webui') return this._genWebui({ prompt, steps, seed });
    throw new Error('no diffusion backend available');
  }

  async _genSdcpp({ prompt, steps, seed }) {
    // OpenAI-compatible endpoint served by sd.cpp server mode. It only takes
    // prompt/n/size/output_format top-level; steps and seed travel via the
    // <sd_cpp_extra_args> extension (see examples/server/api.md).
    const extra = JSON.stringify({ seed: seed >>> 0, sample_params: { sample_steps: steps } });
    const r = await requestJson(this.state.url + '/v1/images/generations', {
      method: 'POST',
      timeoutMs: 30 * 60 * 1000,
      body: {
        prompt: prompt + ' <sd_cpp_extra_args>' + extra + '</sd_cpp_extra_args>',
        n: 1,
        size: '1024x1024',
        output_format: 'png',
      },
    });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data) || !r.body.data[0]) {
      throw new Error('sd.cpp generation failed (http ' + r.status + ')');
    }
    const b64 = r.body.data[0].b64_json;
    if (!b64) throw new Error('sd.cpp returned no image data');
    return Buffer.from(b64, 'base64');
  }

  async _genWebui({ prompt, steps, seed }) {
    const r = await requestJson(this.state.url + '/sdapi/v1/txt2img', {
      method: 'POST',
      timeoutMs: 30 * 60 * 1000,
      body: {
        prompt,
        steps,
        seed: seed < 0 ? -1 : seed,
        width: 1024,
        height: 1024,
        sampler_name: 'DPM++ 2M Karras',
        cfg_scale: 7,
        n_iter: 1,
        batch_size: 1,
      },
    });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.images) || !r.body.images[0]) {
      throw new Error('WebUI txt2img failed (http ' + r.status + ')');
    }
    return Buffer.from(r.body.images[0], 'base64');
  }

  // ---- bundled sd.cpp server auto-start ---------------------------------

  static findModelFile(dirs) {
    const exts = ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth'];
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
          return path.join(dir, e.name);
        }
      }
    }
    return null;
  }

  /**
   * If a bundled sd.cpp server binary + model file exist and no backend is
   * already answering, start the bundled server and re-detect.
   * Returns true if the bundled server became the active backend.
   */
  async autostartBundled({ serverBin, modelDirs, port = 1234, waitMs = 180000 }) {
    if (!serverBin || !fs.existsSync(serverBin)) {
      this.log('no bundled server binary at ' + serverBin);
      return false;
    }
    const model = BackendManager.findModelFile(modelDirs);
    if (!model) {
      this.log('bundled server present but no model file found in: ' + modelDirs.join(', '));
      return false;
    }
    const already = await this.detect();
    if (already.kind !== 'none') {
      this.log('backend already running (' + already.kind + '), not starting bundled server');
      return false;
    }
    this.log('starting bundled sd.cpp server: ' + serverBin);
    this.log('model: ' + model);
    // sd-server CLI (examples/server): -m/--model, --listen-ip, --listen-port.
    const args = ['-m', model, '--listen-ip', '127.0.0.1', '--listen-port', String(port)];
    this.serverProc = spawn(serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.serverProc.stdout.on('data', (d) => this.log('[sd-server] ' + d.toString().trim()));
    this.serverProc.stderr.on('data', (d) => this.log('[sd-server] ' + d.toString().trim()));
    this.serverProc.on('exit', (code, sig) => {
      this.log('bundled sd.cpp server exited (code=' + code + ' sig=' + sig + ')');
      this.serverProc = null;
    });
    // Probe the just-started port first while waiting.
    this.sdcppUrls = ['http://127.0.0.1:' + port, ...this.sdcppUrls.filter((u) => u !== 'http://127.0.0.1:' + port)];
    // Wait until /v1/models answers or timeout.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await this.detect();
      if (st.kind === 'sdcpp') {
        this.log('bundled sd.cpp server is up at ' + this.sdcppUrl);
        return true;
      }
      if (!this.serverProc) { this.log('bundled server died before becoming ready'); return false; }
    }
    this.log('timed out waiting for bundled server');
    return false;
  }

  stopBundled() {
    if (this.serverProc) {
      try { this.serverProc.kill('SIGTERM'); } catch (_) {}
      this.serverProc = null;
    }
  }
}

module.exports = { BackendManager, probeSdcpp, probeWebui, requestJson, DEFAULT_SDCPP_URLS, DEFAULT_WEBUI_URL };
