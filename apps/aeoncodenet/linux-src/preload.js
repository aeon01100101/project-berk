'use strict';
/**
 * AeonCodeNet preload bridge. The renderer gets a narrow, explicit API
 * (window.aeon) — no nodeIntegration, context isolation stays on.
 */
const { contextBridge, ipcRenderer } = require('electron');
const llm = require('./common/llm');

contextBridge.exposeInMainWorld('aeon', {
  ready: () => ipcRenderer.send('renderer:ready'),

  languages: llm.LANGUAGES.map((l) => ({
    id: l.id,
    displayName: l.displayName,
    extension: l.extension,
  })),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (config) => ipcRenderer.invoke('settings:set', config),

  listHistory: () => ipcRenderer.invoke('history:list'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  readHistoryCode: (id) => ipcRenderer.invoke('history:read', id),

  generate: (prompt, languageId) => ipcRenderer.invoke('code:generate', { prompt, languageId }),

  saveCodeDialog: (code, languageId) =>
    ipcRenderer.invoke('code:save-dialog', { code, languageId }),

  copy: (text) => ipcRenderer.send('clipboard:write', text),

  log: (msg) => ipcRenderer.send('renderer:log', String(msg)),
});
