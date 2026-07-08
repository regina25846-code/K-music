const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const DATA_DIR = path.join(app.getPath('userData'), 'kris-music');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function loadPlaylists() {
  try { return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch {
    return [{ id: 'default', name: 'My Playlist', tracks: [] }];
  }
}
function savePlaylists(pl) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(pl, null, 2));
}

// yt-dlp binary path
function getYtDlpPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'yt-dlp.exe');
  }
  const candidates = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(__dirname, 'bin', 'yt-dlp'),
    'yt-dlp'
  ];
  for (const c of candidates) {
    try { require('child_process').execFileSync(c, ['--version'], { timeout: 5000 }); return c; } catch {}
  }
  return 'yt-dlp';
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    execFile(bin, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// Get audio stream URL + metadata for a YouTube URL
async function getStreamInfo(ytUrl, quality = '192') {
  const formatStr = quality === '320' ? 'bestaudio[abr>=256]/bestaudio'
    : quality === '128' ? 'bestaudio[abr<=128]/worstaudio'
    : 'bestaudio[abr<=192]/bestaudio';

  const json = await ytdlp([
    '--no-playlist',
    '--dump-json',
    '-f', formatStr,
    '--no-warnings',
    ytUrl
  ]);
  const info = JSON.parse(json);
  return {
    streamUrl: info.url,
    title: info.title,
    channel: info.uploader || info.channel || '',
    thumbnail: info.thumbnail,
    duration: info.duration,
    ytUrl
  };
}

// Search YouTube, return list of results
async function searchYoutube(query, limit = 10) {
  const json = await ytdlp([
    `ytsearch${limit}:${query}`,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--flat-playlist'
  ]);
  return json.split('\n').filter(Boolean).map(line => {
    try {
      const d = JSON.parse(line);
      return {
        ytUrl: d.url || `https://www.youtube.com/watch?v=${d.id}`,
        title: d.title,
        channel: d.uploader || d.channel || d.uploader_id || '',
        thumbnail: d.thumbnail || (d.thumbnails && d.thumbnails[0]?.url) || '',
        duration: d.duration
      };
    } catch { return null; }
  }).filter(Boolean);
}

let mainWin = null;
let settingsWin = null;
let tray = null;
let forceQuit = false;

function getTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    return img;
  }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('K-Music Player');
  const menu = Menu.buildFromTemplate([
    { label: '열기', click: () => { mainWin?.show(); mainWin?.focus(); } },
    { type: 'separator' },
    { label: '설정', click: () => { mainWin?.show(); mainWin?.focus(); mainWin?.webContents.send('open-settings'); } },
    { label: '프로그램 정보', click: () => { mainWin?.show(); mainWin?.focus(); mainWin?.webContents.send('open-about'); } },
    { type: 'separator' },
    { label: '프로그램 종료', click: () => { forceQuit = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWin?.show(); mainWin?.focus(); });
  tray.on('click', () => { mainWin?.show(); mainWin?.focus(); });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 400,
    height: 680,
    minHeight: 680,
    minWidth: 400,
    maxWidth: 400,
    resizable: true,
    frame: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.loadFile('renderer/index.html');

  mainWin.on('close', e => {
    if (!forceQuit) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
  app.whenReady().then(() => {
    createMainWindow();
    createTray();
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });
}

autoUpdater.on('update-available', () => {
  mainWin?.webContents.send('update-available');
});
autoUpdater.on('update-downloaded', () => {
  mainWin?.webContents.send('update-downloaded');
});
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
app.on('window-all-closed', () => { if (forceQuit) app.quit(); });

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => {
  const prev = loadConfig();
  saveConfig({ ...prev, ...cfg });
  return true;
});
ipcMain.handle('get-playlists', () => loadPlaylists());
ipcMain.handle('save-playlists', (_, pl) => { savePlaylists(pl); return true; });

ipcMain.handle('get-stream', async (_, ytUrl, quality) => {
  try {
    return await getStreamInfo(ytUrl, quality || loadConfig().quality || '192');
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('search', async (_, query) => {
  try {
    return await searchYoutube(query);
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-video-info', async (_, ytUrl) => {
  try {
    const json = await ytdlp(['--dump-json', '--no-playlist', '--no-warnings', '--skip-download', ytUrl]);
    const d = JSON.parse(json);
    return {
      ytUrl,
      title: d.title,
      channel: d.uploader || d.channel || '',
      thumbnail: d.thumbnail,
      duration: d.duration
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('open-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 360,
    height: 420,
    resizable: false,
    frame: false,
    parent: mainWin,
    modal: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile('renderer/settings.html');
});

ipcMain.handle('close-settings', () => {
  settingsWin?.close();
  settingsWin = null;
  mainWin?.webContents.send('settings-closed');
});

ipcMain.handle('minimize', () => mainWin?.minimize());
ipcMain.handle('close-app', () => mainWin?.hide());
ipcMain.handle('toggle-always-on-top', () => {
  const next = !mainWin?.isAlwaysOnTop();
  mainWin?.setAlwaysOnTop(next);
  return next;
});
ipcMain.handle('get-always-on-top', () => mainWin?.isAlwaysOnTop() ?? false);
ipcMain.handle('set-always-on-top', (_, val) => { mainWin?.setAlwaysOnTop(val); });
ipcMain.handle('get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-login-item', (_, val) => {
  app.setLoginItemSettings({ openAtLogin: val, path: app.getPath('exe') });
});
ipcMain.handle('quit-app', () => { forceQuit = true; app.quit(); });
ipcMain.handle('check-ytdlp', async () => {
  try {
    const v = await ytdlp(['--version']);
    return { ok: true, version: v };
  } catch {
    return { ok: false };
  }
});
