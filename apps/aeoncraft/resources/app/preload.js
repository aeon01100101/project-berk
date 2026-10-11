// Preload: minimal safe bridge between renderer and main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeoncraft', {
  saveWorldFile: (name, json) => ipcRenderer.invoke('save-world', { name, json }),
  openWorldFile: () => ipcRenderer.invoke('open-world')
});
