// AeonCraft (Windows/Electron) - main process.
// Same security posture as AeonObjWin: context isolation, no node in renderer.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0B0E1A',
    title: 'AeonCraft',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Save a world JSON file via save dialog.
ipcMain.handle('save-world', async (event, { name, json }) => {
  const safe = (name || 'world').replace(/[^A-Za-z0-9_.-]/g, '_') || 'world';
  const res = await dialog.showSaveDialog({
    title: 'Export AeonCraft world',
    defaultPath: safe + '.aeoncraft.json',
    filters: [{ name: 'AeonCraft world', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, json, 'utf8');
    return { ok: true, filePath: res.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Open a world JSON file via open dialog.
ipcMain.handle('open-world', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import AeonCraft world',
    filters: [{ name: 'AeonCraft world', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const json = fs.readFileSync(res.filePaths[0], 'utf8');
    return { ok: true, filePath: res.filePaths[0], json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
