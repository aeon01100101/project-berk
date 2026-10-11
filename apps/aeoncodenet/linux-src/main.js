'use strict';
/**
 * AeonCodeNet for Linux (Aeon OS Berk) — Electron main process.
 *
 * Tabs: Generate / History / Settings (renderer handles the UI).
 * The main process owns: settings file, history store, the LLM HTTP
 * request (avoids CORS from the renderer), native save dialog, clipboard.
 */

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const llm = require('./common/llm');
const { makeSettingsStore, makeHistoryStore } = require('./common/store');

// Running as root (e.g. inside a build/validation sandbox) requires this,
// otherwise Chromium refuses to start at all.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

const SMOKE_TEST = process.argv.includes('--smoke-test');
let mainWindow = null;
let rendererReady = false;

function settingsStore() {
  return makeSettingsStore(app.getPath('userData'));
}

function historyStore() {
  return makeHistoryStore(app.getPath('userData'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 720,
    minHeight: 540,
    title: 'AeonCodeNet',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 32 defaults sandbox:true, in which preload require() cannot
      // resolve relative paths. This app needs require('./common/llm') in the
      // preload, so opt out; the renderer still gets no Node access and only
      // the explicit window.aeon bridge (contextIsolation stays on).
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error(`RENDERER_FAIL_LOAD: ${code} ${desc}`);
    if (SMOKE_TEST) app.exit(2);
  });
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[console:${level}] ${message} @${sourceId}:${line}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`RENDERER_GONE: ${details.reason}`);
    if (SMOKE_TEST) app.exit(3);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- IPC: settings -------------------------------------------------------

ipcMain.handle('settings:get', () => settingsStore().load());

ipcMain.handle('settings:set', (event, config) => settingsStore().save(config || {}));

// ---- IPC: history --------------------------------------------------------

ipcMain.handle('history:list', () => historyStore().list());

ipcMain.handle('history:delete', (event, id) => historyStore().remove(id));

ipcMain.handle('history:read', (event, id) => {
  const meta = historyStore().list().find((g) => g.id === id);
  return meta ? historyStore().readText(meta) : '';
});

// ---- IPC: generation ------------------------------------------------------

ipcMain.handle('code:generate', async (event, payload) => {
  const { prompt, languageId } = payload || {};
  const req = (prompt || '').trim();
  if (!req) {
    throw new Error('Describe the program you want first.');
  }
  const config = settingsStore().load();
  const language = llm.languageById(languageId);
  const code = await llm.generateCode(config, language, req);
  const meta = historyStore().save(code, req, language, config.model.trim());
  return { meta, code };
});

// ---- IPC: save-as-file (native dialog) ------------------------------------

ipcMain.handle('code:save-dialog', async (event, payload) => {
  const { code, languageId } = payload || {};
  const language = llm.languageById(languageId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save program as…',
    defaultPath: path.join(app.getPath('documents'), `aeoncode-${stamp}.${language.extension}`),
    filters: [
      { name: `${language.displayName} source`, extensions: [language.extension] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  fs.writeFileSync(result.filePath, code || '', 'utf8');
  return { saved: true, path: result.filePath };
});

// ---- IPC: clipboard -------------------------------------------------------

ipcMain.on('clipboard:write', (event, text) => {
  clipboard.writeText(String(text || ''));
});

// ---- IPC: renderer diagnostics ------------------------------------------------
ipcMain.on('renderer:log', (event, msg) => {
  console.log(`[renderer] ${msg}`);
});

// ---- IPC: renderer ready (drives --smoke-test) ----------------------------

ipcMain.on('renderer:ready', () => {
  rendererReady = true;
  if (SMOKE_TEST) {
    console.log('SMOKE_OK');
    // Let the log flush, then quit cleanly.
    setImmediate(() => app.quit());
  }
});

app.whenReady().then(() => {
  createWindow();

  if (SMOKE_TEST) {
    // If the renderer never reports ready, fail loudly instead of hanging.
    setTimeout(() => {
      if (!rendererReady) {
        console.error('SMOKE_FAIL: renderer did not report ready in time');
        app.exit(1);
      }
    }, 20000).unref();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Quit on all platforms once the window is gone (desktop app, no tray).
  app.quit();
});
