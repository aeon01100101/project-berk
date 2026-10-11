/**
 * Aeon Radio — Linux desktop (Electron) main process.
 * Port of the Android app (com.aeonradio.app) v1.0.5.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const playlist = require('./lib/playlist');
const radiobrowser = require('./lib/radiobrowser');
const { startTap } = require('./lib/icy');

const SMOKE = process.argv.includes('--smoke-test');
if (process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox');
}

// ---------------------------------------------------------------- store ---
const storePath = path.join(app.getPath('userData'), 'aeonradio.json');
let store = { favs: {}, streams: [], recents: [], volume: 1.0 };

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (o.favs && typeof o.favs === 'object') store.favs = o.favs;
      if (Array.isArray(o.streams)) store.streams = o.streams.filter(s => s && s.url);
      if (Array.isArray(o.recents)) store.recents = o.recents.filter(s => s && s.url).slice(0, 20);
      if (typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1) store.volume = o.volume;
    }
  } catch (_) { /* first run */ }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
  } catch (_) { /* non-fatal */ }
}

// ------------------------------------------------------------- stations ---
let stationsCache = null;
function getStations() {
  if (!stationsCache) {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'stations.json'), 'utf8');
    stationsCache = JSON.parse(raw);
  }
  return stationsCache;
}

// ----------------------------------------------------------------- icy ---
// Real ICY metadata: open a parallel connection with `Icy-MetaData: 1` (the
// <audio> element cannot set custom headers), parse the icy-metaint
// StreamTitle blocks, and push "now playing" updates to the renderer.
// When the server sends no ICY data we report icy:false and the renderer
// honestly shows the station name.
let stopIcyTap = null;

function stopIcy() {
  if (stopIcyTap) { try { stopIcyTap(); } catch (_) {} stopIcyTap = null; }
}

function startIcy(win, url) {
  stopIcy();
  stopIcyTap = startTap(url, (payload) => {
    if (!win.isDestroyed()) win.webContents.send('radio.now-playing', payload);
  });
}

// ---------------------------------------------------------- sleep timer ---
let sleepTimer = null;
let sleepDeadline = 0;

function sleepRemainingMin() {
  if (!sleepTimer) return null;
  return Math.max(1, Math.ceil((sleepDeadline - Date.now()) / 60000));
}

function cancelSleep() {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  sleepDeadline = 0;
}

// ------------------------------------------------------------------ ipc ---
ipcMain.handle('store.load', () => store);
ipcMain.handle('store.save', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    for (const k of ['favs', 'streams', 'recents', 'volume']) {
      if (patch[k] !== undefined) store[k] = patch[k];
    }
    store.recents = Array.isArray(store.recents) ? store.recents.slice(0, 20) : [];
    saveStore();
  }
  return store;
});
ipcMain.handle('stations.get', () => getStations());
ipcMain.handle('radio.resolve', (_e, url) => playlist.resolve(url));
ipcMain.handle('browser.search', (_e, q) => radiobrowser.search(q));
ipcMain.handle('browser.topClicks', () => radiobrowser.topClicks());
ipcMain.handle('browser.topVotes', () => radiobrowser.topVotes());
ipcMain.handle('browser.byTag', (_e, tag) => radiobrowser.byTag(tag));
ipcMain.handle('browser.byCountry', (_e, code) => radiobrowser.byCountry(code));
ipcMain.handle('browser.countries', () => radiobrowser.countries());

ipcMain.on('radio.icy-start', (e, url) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) startIcy(win, url);
});
ipcMain.on('radio.icy-stop', () => stopIcy());

ipcMain.on('sleep.start', (e, minutes) => {
  cancelSleep();
  const ms = Math.max(1, minutes) * 60000;
  sleepDeadline = Date.now() + ms;
  const win = BrowserWindow.fromWebContents(e.sender);
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    sleepDeadline = 0;
    if (win && !win.isDestroyed()) win.webContents.send('sleep.fired');
  }, ms);
});
ipcMain.on('sleep.cancel', () => cancelSleep());
ipcMain.handle('sleep.status', () => sleepRemainingMin());

// --------------------------------------------------------------- window ---
let win = null;
let smokeTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0B0E17',
    title: 'Aeon Radio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.on('smoke.ready', () => {
  if (!SMOKE) return;
  if (smokeTimer) clearTimeout(smokeTimer);
  process.stdout.write('SMOKE_OK\n');
  stopIcy();
  cancelSleep();
  app.quit();
});

app.whenReady().then(() => {
  loadStore();
  createWindow();
  if (SMOKE) {
    smokeTimer = setTimeout(() => {
      process.stdout.write('SMOKE_FAIL: renderer never signaled ready\n');
      app.exit(1);
    }, 30000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopIcy();
  cancelSleep();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { stopIcy(); cancelSleep(); saveStore(); });

// Container/orchestrator kills arrive as SIGTERM; quit gracefully instead of
// letting Chromium die mid-shutdown.
process.on('SIGTERM', () => { app.quit(); });
