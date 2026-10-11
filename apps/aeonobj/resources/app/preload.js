// Preload: minimal safe bridge between renderer and main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeon', {
  saveModel: (payload) => ipcRenderer.invoke('save-model', payload),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  winMin: () => ipcRenderer.invoke('win-min'),
  winMax: () => ipcRenderer.invoke('win-max'),
  winClose: () => ipcRenderer.invoke('win-close')
});
