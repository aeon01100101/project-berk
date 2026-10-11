'use strict';
/** Preload bridge: safe, minimal API surface for the renderer. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeonPhoto', {
  getBackendState: () => ipcRenderer.invoke('get-backend-state'),
  checkBackend: () => ipcRenderer.invoke('check-backend'),
  generate: (req) => ipcRenderer.invoke('generate', req),
  onProgress: (cb) => ipcRenderer.on('gen-progress', (_e, v) => cb(v)),
  galleryList: () => ipcRenderer.invoke('gallery-list'),
  galleryDelete: (id) => ipcRenderer.invoke('gallery-delete', id),
  galleryFile: (id) => ipcRenderer.invoke('gallery-file', id),
  saveImage: (id) => ipcRenderer.invoke('save-image', id),
  copyClipboard: (id) => ipcRenderer.invoke('copy-clipboard', id),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  onBackendState: (cb) => ipcRenderer.on('backend-state', (_e, v) => cb(v)),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
});
