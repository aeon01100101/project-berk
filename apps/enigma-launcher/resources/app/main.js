const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { findBundledJava, javaVersionOk } = require('./java-detect');
const { pingServer } = require('./mc-ping');

const APP_DIR = __dirname;                       // dev: .../enigma-launcher/app | packaged: .../resources/app
// In dev, main.js lives in <project>/app so the project root is one level up.
// In the packaged app, resources/app IS the app root (jar + config ship inside it).
const PROJECT_ROOT = app.isPackaged ? APP_DIR : path.join(APP_DIR, '..');
const CORE_JAR = path.join(PROJECT_ROOT, 'launcher-core', 'launcher-core.jar');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'servers.json');

let mainWindow = null;
let gameProcess = null;

const DEFAULT_SERVERS = {
  servers: [
    {
      id: 'httyd-normal',
      name: 'HTTYD 1.18.2 Normal',
      tagline: 'The classic Berk experience. Build, explore, and train your dragon.',
      host: '192.0.2.10',
      port: 25565,
      mcVersion: '1.18.2',
      autoJoin: true,
      modpack: { name: '', url: '', sha1: '', loader: '' },
    },
    {
      id: 'httyd-horror',
      name: 'HTTYD-multiverse horror',
      tagline: 'A darker multiverse. Not for the faint of heart - bring a light.',
      host: '192.0.2.11',
      port: 25565,
      mcVersion: '1.18.2',
      autoJoin: true,
      modpack: { name: '', url: '', sha1: '', loader: '' },
    },
    {
      id: 'httyd-alt',
      name: 'HTTYD 1.18.2 Alternative',
      tagline: 'An alternate Berk timeline. Same dragons, different story.',
      host: '192.0.2.12',
      port: 25565,
      mcVersion: '1.18.2',
      autoJoin: true,
      modpack: { name: '', url: '', sha1: '', loader: '' },
    },
  ],
};

const DEFAULT_SETTINGS = { username: '', ram: '4G', gameDir: '', dataDir: '', javaPath: '' };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function ensureServersConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_SERVERS, null, 2));
  }
  return loadJson(CONFIG_PATH, DEFAULT_SERVERS);
}

function loadSettings() {
  return loadJson(settingsPath(), DEFAULT_SETTINGS);
}

/** Bundled Java 17+ runtime shipped with the app (jre-win on Windows, jre-linux on Linux).
 *  The Windows candidate set is unchanged; Linux uses the same layout with a
 *  `jre-linux` directory and a plain `java` binary. */
function bundledJava() {
  return findBundledJava({
    resourcesPath: process.resourcesPath,
    projectRoot: PROJECT_ROOT,
    platform: process.platform,
  });
}

/** Linux-only Java resolution: prefer the bundled jre-linux if it reports
 *  Java 17+, else use `java` on PATH after verifying 17+, else show a clear
 *  error dialog and return null. Windows keeps its old behavior. */
function resolveLinuxJava() {
  const bundled = bundledJava();
  if (bundled) {
    if (javaVersionOk(bundled, 17)) return bundled;
    dialog.showErrorBox('Java 17 required',
      'The bundled Java runtime reports an older version than 17.\n\n' +
      'Install a Java 17 (or newer) JRE, or set a custom Java path in the launcher Settings.');
    return null;
  }
  if (javaVersionOk('java', 17)) return 'java';
  dialog.showErrorBox('Java 17 required',
    'Enigma Launcher needs a Java 17 (or newer) JRE to launch Minecraft.\n\n' +
    'Install one with your package manager, for example:\n' +
    '    sudo apt install openjdk-17-jre\n\n' +
    'You can also bundle a JRE as resources/jre-linux/bin/java,\n' +
    'or set a custom Java path in the launcher Settings.');
  return null;
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ------------------------------------------------------------ window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    title: 'Enigma Launcher',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(APP_DIR, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ------------------------------------------------------------ game process

function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:log', line);
  }
}

function dataDirFor(settings) {
  const d = (settings.dataDir || '').trim();
  return d || path.join(os.homedir(), '.enigma');
}

function buildLaunchArgs(server, settings, prepareOnly) {
  const dataDir = dataDirFor(settings);
  const gameDir = (settings.gameDir || '').trim()
    || path.join(dataDir, 'instances', server.id);
  const args = [
    '-jar', CORE_JAR,
    'play',
    '--username', settings.username || 'Player',
    '--host', server.host,
    '--port', String(server.port || 25565),
    '--mc-version', server.mcVersion || '1.18.2',
    '--ram', settings.ram || '4G',
    '--data-dir', dataDir,
    '--game-dir', gameDir,
    '--server-id', server.id,
  ];
  if (!server.autoJoin) args.push('--no-join');
  if (prepareOnly) args.push('--prepare-only');
  const mp = server.modpack || {};
  if (mp.url && mp.url.trim()) {
    args.push('--modpack-url', mp.url.trim());
    if (mp.sha1 && mp.sha1.trim()) args.push('--modpack-sha1', mp.sha1.trim());
    if (mp.loader && mp.loader.trim()) args.push('--modpack-loader', mp.loader.trim());
  }
  return args;
}

function spawnJava(server, settings, prepareOnly) {
  if (!fs.existsSync(CORE_JAR)) {
    return { ok: false, error: 'launcher-core.jar not found. Build it with launcher-core/build.sh first.' };
  }
  if (gameProcess) {
    return { ok: false, error: 'Minecraft is already running.' };
  }
  if (!settings.username || !settings.username.trim()) {
    return { ok: false, error: 'Enter a username first.' };
  }

  const customJava = settings.javaPath && settings.javaPath.trim();
  let javaBin;
  if (customJava) {
    javaBin = customJava;
  } else if (process.platform === 'win32') {
    javaBin = bundledJava() || 'java';
  } else {
    // Linux: bundled jre-linux, else verified PATH java, else clear error dialog.
    javaBin = resolveLinuxJava();
    if (!javaBin) {
      return { ok: false, error: 'Java 17+ is required. Install a Java 17 JRE or set a custom Java path in Settings.' };
    }
  }
  if (process.platform !== 'win32' && !javaVersionOk(javaBin, 17)) {
    dialog.showErrorBox('Java 17 required',
      'The selected Java runtime does not report version 17 or newer:\n' + javaBin);
    return { ok: false, error: 'The selected Java runtime is older than 17.' };
  }
  const env = { ...process.env, ENIGMA_JAVA: javaBin };

  const args = buildLaunchArgs(server, settings, prepareOnly);
  sendLog(`[Enigma] Starting Java core: ${javaBin} ${args.join(' ')}`);

  gameProcess = spawn(javaBin, args, { env });
  gameProcess.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && sendLog(l)));
  gameProcess.stderr.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && sendLog(l)));
  gameProcess.on('error', (err) => {
    sendLog('[Enigma] Failed to start Java: ' + err.message);
    gameProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game:exit', -1);
  });
  gameProcess.on('close', (code) => {
    sendLog(`[Enigma] Process exited with code ${code}`);
    gameProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game:exit', code);
  });
  return { ok: true };
}

// ------------------------------------------------------------ IPC

ipcMain.handle('config:get', () => ({
  servers: ensureServersConfig().servers,
  settings: loadSettings(),
}));

ipcMain.handle('config:saveServers', (event, servers) => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers }, null, 2));
  return { ok: true };
});

ipcMain.handle('config:saveSettings', (event, settings) => {
  saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  return { ok: true };
});

ipcMain.handle('server:ping', (event, { host, port }) => pingServer(host, port));

ipcMain.handle('game:play', (event, { server, settings }) => spawnJava(server, settings, false));

ipcMain.handle('game:prepare', (event, { server, settings }) =>
  spawnJava(server, settings, true));

ipcMain.handle('game:stop', () => {
  if (gameProcess) {
    gameProcess.kill();
    return { ok: true };
  }
  return { ok: false, error: 'Nothing is running.' };
});

ipcMain.handle('game:running', () => ({ running: !!gameProcess }));
