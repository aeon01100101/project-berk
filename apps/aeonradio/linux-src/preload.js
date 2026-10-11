'use strict';
// Preload: minimal, audited IPC bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeon', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_event, ...args) => fn(...args)),
});
