const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enigma', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveServers: (servers) => ipcRenderer.invoke('config:saveServers', servers),
  saveSettings: (settings) => ipcRenderer.invoke('config:saveSettings', settings),
  ping: (host, port) => ipcRenderer.invoke('server:ping', { host, port }),
  play: (server, settings) => ipcRenderer.invoke('game:play', { server, settings }),
  prepare: (server, settings) => ipcRenderer.invoke('game:prepare', { server, settings }),
  stop: () => ipcRenderer.invoke('game:stop'),
  isRunning: () => ipcRenderer.invoke('game:running'),
  onLog: (cb) => ipcRenderer.on('game:log', (event, line) => cb(line)),
  onExit: (cb) => ipcRenderer.on('game:exit', (event, code) => cb(code)),
});
