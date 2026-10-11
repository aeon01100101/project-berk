'use strict';
/**
 * AeonPhoto for Linux (Aeon OS Berk) — Electron main process.
 *
 * Faithful port of the Android app's UX: prompt input, style presets, shape
 * options, history gallery, per-generation metadata. On-device MediaPipe
 * diffusion is Android/iOS-only, so Linux uses a local diffusion backend
 * (stable-diffusion.cpp server or SD WebUI API) via BackendManager.
 *
 * Honest-state contract: if no backend is found the Generate button is
 * disabled and a setup panel is shown. Nothing is ever faked.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { BackendManager } = require('./backend-manager');

const SMOKE = process.argv.includes('--smoke-test');

const PHOTO_STYLES = [
  'cinematic photo',
  'watercolor painting',
  '3D render',
  'anime-inspired illustration',
  'editorial portrait',
];
const PHOTO_SHAPES = ['square', 'portrait', 'landscape', 'wide'];

function shapeToSize(shape) {
  switch (shape) {
    case 'portrait': return [768, 1152];
    case 'landscape': return [1152, 768];
    case 'wide': return [1344, 768];
    default: return [1024, 1024]; // square
  }
}

function buildPrompt(raw, style, shape) {
  return `Create a ${shape} ${style}: ${raw.trim()}. High detail, polished composition, no watermark.`;
}

// ---- history store (same schema as the Android app's HistoryStore) ----
function historyDir() {
  const d = path.join(app.getPath('userData'), 'generations');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function indexPath() { return path.join(historyDir(), 'index.json'); }
function listGenerations() {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.sort((a, b) => b.createdAt - a.createdAt) : [];
  } catch (_) { return []; }
}
function saveGeneration(pngBuffer, meta) {
  const dir = historyDir();
  fs.writeFileSync(path.join(dir, meta.fileName), pngBuffer);
  const all = listGenerations();
  all.unshift(meta);
  fs.writeFileSync(indexPath(), JSON.stringify(all, null, 2));
  return meta;
}
function deleteGeneration(id) {
  const all = listGenerations();
  const gone = all.filter((g) => g.id === id);
  const kept = all.filter((g) => g.id !== id);
  for (const g of gone) {
    try { fs.unlinkSync(path.join(historyDir(), g.fileName)); } catch (_) {}
  }
  fs.writeFileSync(indexPath(), JSON.stringify(kept, null, 2));
}

// ---- center-crop (mirrors Android's centerCrop: crop, never stretch) ----
function centerCrop(pngBuffer, targetW, targetH) {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const { width: sw, height: sh } = img.getSize();
  if (!sw || !sh) throw new Error('backend returned an unreadable image');
  const targetAspect = targetW / targetH;
  const srcAspect = sw / sh;
  let cw, ch;
  if (srcAspect > targetAspect) { ch = sh; cw = Math.round(sh * targetAspect); }
  else { cw = sw; ch = Math.round(sw / targetAspect); }
  const x = Math.max(0, Math.round((sw - cw) / 2));
  const y = Math.max(0, Math.round((sh - ch) / 2));
  let out = img.crop({ x, y, width: cw, height: ch });
  if (cw !== targetW || ch !== targetH) {
    out = out.resize({ width: targetW, height: targetH, quality: 'best' });
  }
  return out.toPNG();
}

// ---- bundled server paths ----
function bundledServerBin() {
  const candidates = [
    path.join(process.resourcesPath, 'server', 'sd-server'),
    path.join(__dirname, '..', 'server', 'sd-server'), // dev layout
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}
function modelDirs() {
  return [
    path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(os.homedir(), '.local', 'share', 'aeonphoto', 'models'),
  ];
}

const backend = new BackendManager({ onLog: (l) => console.log(l) });
let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: !SMOKE,
    backgroundColor: '#090b14',
    title: 'AeonPhoto',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.webContents.on('console-message', (_e, _lvl, msg) => {
    if (msg.startsWith('[aeonphoto]')) console.log('[renderer] ' + msg);
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

async function refreshBackend() {
  const st = await backend.detect();
  console.log('[aeonphoto] backend-state: ' + st.kind + (st.detail ? ' — ' + st.detail : ''));
  return st;
}

async function boot() {
  await app.whenReady();
  createWindow();

  // Auto-detect; if nothing is up and a bundled server+model exist, start it.
  let st = await backend.detect();
  if (st.kind === 'none' && !SMOKE) {
    const bin = bundledServerBin();
    if (bin) {
      await backend.autostartBundled({ serverBin: bin, modelDirs: modelDirs() });
      st = backend.state;
    }
  }
  console.log('[aeonphoto] backend-state: ' + st.kind + (st.detail ? ' — ' + st.detail : ''));
  if (mainWin) mainWin.webContents.send('backend-state', st);

  if (SMOKE) {
    // Safety: quit even if the renderer never reports ready.
    setTimeout(() => { console.log('SMOKE_TIMEOUT'); app.exit(2); }, 45000).unref();
  }
}

// ---- IPC ----
ipcMain.handle('get-backend-state', async () => backend.state);

ipcMain.handle('check-backend', async (event) => {
  let st = await backend.detect();
  if (st.kind === 'none') {
    const bin = bundledServerBin();
    if (bin) {
      const started = await backend.autostartBundled({ serverBin: bin, modelDirs: modelDirs() });
      if (started) st = backend.state;
    }
  }
  if (mainWin) mainWin.webContents.send('backend-state', st);
  return st;
});

ipcMain.handle('generate', async (event, req) => {
  const sender = event.sender;
  const say = (pct, msg) => { try { sender.send('gen-progress', { pct, msg }); } catch (_) {} };
  if (!backend.isReady()) throw new Error('no diffusion backend available');
  const { prompt, style, shape, steps, seed } = req;
  if (!prompt || !prompt.trim()) throw new Error('prompt is empty');
  const [tw, th] = shapeToSize(shape);
  say(0.02, 'Sending prompt to local backend…');
  let square;
  try {
    square = await backend.generateSquare({
      prompt: buildPrompt(prompt, style || PHOTO_STYLES[0], shape || 'square'),
      steps: Math.max(1, Math.min(150, steps | 0 || 20)),
      seed: (seed | 0) >>> 0,
    });
  } catch (e) {
    throw new Error('backend generation failed: ' + (e.message || e));
  }
  say(0.9, 'Finishing image…');
  // Non-square shapes are center-cropped from the square generation (same as Android).
  const finalPng = centerCrop(square, tw, th);
  const meta = {
    id: crypto.randomUUID(),
    prompt: prompt.trim(),
    style: style || PHOTO_STYLES[0],
    shape: shape || 'square',
    seed: seed | 0,
    steps: steps | 0,
    createdAt: Date.now(),
    fileName: '',
  };
  meta.fileName = meta.id + '.png';
  saveGeneration(finalPng, meta);
  say(1, 'Done');
  return meta;
});

ipcMain.handle('gallery-list', async () => listGenerations());
ipcMain.handle('gallery-delete', async (_e, id) => { deleteGeneration(id); return true; });
ipcMain.handle('gallery-file', async (_e, id) => {
  const g = listGenerations().find((x) => x.id === id);
  if (!g) return null;
  const p = path.join(historyDir(), g.fileName);
  try { fs.accessSync(p); return p; } catch (_) { return null; }
});
ipcMain.handle('save-image', async (event, id) => {
  const g = listGenerations().find((x) => x.id === id);
  if (!g) return null;
  const src = path.join(historyDir(), g.fileName);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin || undefined, {
    title: 'Save image',
    defaultPath: 'aeonphoto-' + g.id.slice(0, 8) + '.png',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.copyFileSync(src, filePath);
  return filePath;
});
ipcMain.handle('copy-clipboard', async (_e, id) => {
  const g = listGenerations().find((x) => x.id === id);
  if (!g) return false;
  const buf = fs.readFileSync(path.join(historyDir(), g.fileName));
  clipboard.writeImage(nativeImage.createFromBuffer(buf));
  return true;
});
ipcMain.handle('open-folder', async () => {
  await shell.openPath(historyDir());
  return true;
});

// ---- smoke test: renderer reports ready, main asserts honest no-backend UI ----
ipcMain.on('renderer-ready', async () => {
  if (!SMOKE) return;
  try {
    const res = await mainWin.webContents.executeJavaScript(`(() => ({
      genDisabled: document.getElementById('generate-btn').disabled,
      setupVisible: !document.getElementById('backend-setup').hidden,
      backendLabel: document.getElementById('backend-label').textContent,
      noBackendCard: !!document.getElementById('no-backend-card'),
    }))()`);
    const ok = res.genDisabled === true && res.setupVisible === true && res.noBackendCard === true;
    console.log('SMOKE_OK backend=none generateDisabled=' + res.genDisabled +
      ' setupVisible=' + res.setupVisible + ' noBackendCard=' + res.noBackendCard +
      ' label="' + res.backendLabel + '"' + (ok ? '' : ' UNEXPECTED_STATE'));
    app.exit(ok ? 0 : 3);
  } catch (e) {
    console.log('SMOKE_FAIL ' + e.message);
    app.exit(3);
  }
});

app.on('window-all-closed', () => {
  backend.stopBundled();
  app.quit();
});
app.on('before-quit', () => backend.stopBundled());

boot().catch((e) => { console.error('boot failed: ' + (e && e.message)); app.exit(1); });
