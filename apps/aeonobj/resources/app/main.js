// AeonObj (Windows/Electron) - main process.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#008080',
    title: 'AeonObj - Image to 3D',
    frame: false, // custom Windows 98 title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.handle('win-min', () => win.minimize());
  ipcMain.handle('win-max', () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.handle('win-close', () => win.close());
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

// Save model.obj + model.mtl + texture PNG (+ optional rig .py) next to the chosen .obj path.
ipcMain.handle('save-model', async (event, { name, obj, mtl, pngBuffer, rigScript }) => {
  const safe = (name || 'model').replace(/[^A-Za-z0-9_.-]/g, '_') || 'model';
  const res = await dialog.showSaveDialog({
    title: 'Save textured OBJ model',
    defaultPath: safe + '.obj',
    filters: [{ name: 'Wavefront OBJ', extensions: ['obj'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    const dir = path.dirname(res.filePath);
    const base = path.basename(res.filePath, '.obj') || safe;
    const objPath = path.join(dir, base + '.obj');
    const mtlPath = path.join(dir, base + '.mtl');
    const texPath = path.join(dir, base + '_tex.png');
    const files = [objPath, mtlPath, texPath];
    fs.writeFileSync(objPath, obj, 'utf8');
    // MTL references the texture file name written alongside it.
    const mtlFixed = mtl.replace(/^map_Kd .*$/m, 'map_Kd ' + path.basename(texPath));
    fs.writeFileSync(mtlPath, mtlFixed, 'utf8');
    fs.writeFileSync(texPath, Buffer.from(pngBuffer));
    if (rigScript) {
      const rigPath = path.join(dir, base + '_rig.py');
      fs.writeFileSync(rigPath, rigScript, 'utf8');
      files.push(rigPath);
    }
    return { ok: true, dir, files };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('open-path', async (event, p) => {
  await shell.openPath(p);
  return true;
});
