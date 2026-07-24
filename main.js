const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const DATA_DIR = path.join(app.getPath('userData'), 'kris-music');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const LYRICS_CACHE_FILE = path.join(DATA_DIR, 'lyrics-cache.json');

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
function loadLyricsCache() {
  try { return JSON.parse(fs.readFileSync(LYRICS_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveLyricsCache(c) {
  fs.writeFileSync(LYRICS_CACHE_FILE, JSON.stringify(c, null, 2));
}

// ── 가사(lrclib.net) ──────────────────────────────────────────────────────────
// 유튜브 영상 제목에서 "아티스트 - 곡명" 형태를 최대한 추측해서 뽑아낸다.
// 괄호 없이 제목 끝에 그냥 붙는 "M/V", "Official Audio" 같은 꼬리표 — 이런 게 남아있으면
// lrclib 검색어 자체가 원곡 제목과 달라져서 실제로 등록된 가사가 있어도 0건으로 검색됨
// (2026-07-20, BIGBANG "맨정신(SOBER) M/V"에서 발견 — 괄호 "(SOBER)"는 지워지는데 뒤의 "M/V"는 안 지워짐).
const TRAILING_TAG_RE = /\s*(?:(?:Official\s*)?(?:M\s?\/\s?V|MV|Music\s*Video|Lyrics?\s*Video|Video|Audio|Visualizer))+\s*$/i;

function parseArtistTitle(rawTitle, channel) {
  let t = rawTitle
    .replace(/[\(\[［【][^)\]］】]*[\)\]］】]/g, ' ') // 괄호류 전부 제거 (Official Video, MV, Lyrics 등 잡음)
    .replace(/\s*[|｜]\s*.*/g, '') // "| 채널명" 꼬리표 제거
    .replace(/\s+/g, ' ')
    .trim();

  const sepMatch = t.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (sepMatch) {
    return { artist: sepMatch[1].trim(), title: sepMatch[2].trim().replace(TRAILING_TAG_RE, '').trim() };
  }
  // 구분자가 없으면 채널명을 아티스트로 추정 (채널명 뒤의 "- Topic" 등은 제거)
  const artist = (channel || '').replace(/\s*-\s*Topic$/i, '').trim();
  return { artist, title: t.replace(TRAILING_TAG_RE, '').trim() };
}

// syncedLyrics 안에서 실제로 타임스탬프가 붙은 줄의 비율(0~1) — lrclib은 크라우드소스라
// "앞 몇 줄만 싱크 맞추고 나머지는 그냥 붙여넣은" 불완전한 항목이 섞여있음
function syncedLineRatio(item) {
  if (!item.syncedLyrics) return 0;
  const lines = item.syncedLyrics.split('\n').filter(l => l.trim());
  if (!lines.length) return 0;
  const tagged = lines.filter(l => /^\[\d+:\d+(?:\.\d+)?\]/.test(l)).length;
  return tagged / lines.length;
}

async function fetchLyricsFromLrclib(artist, title, durationSec) {
  const search = async (withArtist) => {
    const params = { track_name: title };
    if (withArtist && artist) params.artist_name = artist;
    const url = `https://lrclib.net/api/search?` + new URLSearchParams(params).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);
    return res.json();
  };

  let list = await search(true);
  let usedFallback = false;
  // lrclib은 K-pop 아티스트를 로마자 표기(예: "Park Hyo Shin")로만 저장해둔 경우가 많아서,
  // 유튜브 제목에서 뽑은 한글 아티스트명("박효신")으로 검색하면 실제 곡이 있어도 0건이 됨
  // (2026-07-20, 박효신 "해줄 수 없는 일" 수동검색에서 발견 — artist_name 빼고 검색하면 4건 잡힘).
  // 아티스트 필터 없이 제목만으로 재검색해서 이 경우를 구제한다.
  if ((!Array.isArray(list) || !list.length) && artist) {
    list = await search(false);
    usedFallback = true;
  }
  if (!Array.isArray(list) || !list.length) return null;

  // ⚠️ 아티스트 필터를 뺀 재검색은 "Show Your Love"처럼 세계적으로 흔한 제목일 때 완전히
  // 다른 가수들의 동명곡이 잔뜩 섞여 들어오는 문제가 있음(2026-07-20, 박효신 "Show Your Love"에서
  // 발견 — 20개 후보가 전부 다른 가수, 정작 박효신 버전은 lrclib에 아예 없었음). duration 근접도만으론
  // 이걸 못 걸러낼 수 있어서(우연히 비슷한 길이의 남의 곡이 있으면 그대로 통과됨), 후보군의 아티스트명이
  // 소수(≤2그룹)로 몰려있을 때만(=같은 실제 가수를 표기만 다르게 올린 경우로 추정) 신뢰하고, 그 이상 여러
  // 가수가 뒤섞여 있으면 "흔한 제목에 남의 곡들이 낀 것"으로 판단해 아예 못 찾은 걸로 처리한다.
  if (usedFallback) {
    const normalizeArtist = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const distinctArtists = new Set(list.map(item => normalizeArtist(item.artistName)));
    if (distinctArtists.size > 2) return null;
  }

  // 아티스트 필터 없이 재검색하면 "제목은 같은데 다른 가수가 부른 곡"(커버, 리메이크 등)이
  // 후보에 섞여 들어올 수 있음 — 박효신 "해줄 수 없는 일"(262초) 검색 시 신용재 커버(349초, 87초 차이)가
  // 태그비율 1.0이라는 이유만으로 진짜 후보들(전부 ratio 0)을 이겨버린 사례 발견(2026-07-20).
  // duration이 너무 동떨어진 후보는 아예 점수 계산 대상에서 제외해서 다른 곡이 뽑히는 걸 막는다.
  const DURATION_TOLERANCE = 15;
  const candidates = durationSec
    ? list.filter(item => Math.abs((item.duration || 0) - durationSec) <= DURATION_TOLERANCE)
    : list;
  const pool = candidates.length ? candidates : list; // 근접 후보가 하나도 없으면 어쩔 수 없이 전체에서 최선을 고름

  // 싱크 완성도(태그 비율)를 절대 우선으로 두고, duration 근접도는 동률일 때만 타이브레이커로 사용.
  // duration만 보고 고르면 "타임스탬프 2줄만 있고 나머지는 평문인" 불완전 항목이
  // duration 딱 맞는다는 이유만으로 뽑혀서, 곡 초반 몇 초 이후로는 가사가 안 넘어가는 문제가 있었음.
  let best = pool[0];
  let bestScore = -Infinity;
  for (const item of pool) {
    const ratio = syncedLineRatio(item);
    const durDiff = durationSec ? Math.abs((item.duration || 0) - durationSec) : 0;
    const score = ratio * 1000 - durDiff;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return {
    synced: best.syncedLyrics || null,
    plain: best.plainLyrics || null,
    trackName: best.trackName,
    artistName: best.artistName
  };
}

// 매칭/선별 로직을 고칠 때마다 이 숫자를 올리면, 예전 버전이 골랐던 캐시가
// 자동으로 무효화되고 새 로직으로 다시 검색된다(사용자가 캐시 파일을 직접 지울 필요 없음).
const LYRICS_MATCHER_VERSION = 5;

async function getLyrics(ytUrl, title, channel, durationSec) {
  const cache = loadLyricsCache();
  const cached = cache[ytUrl];
  if (cached && cached._v === LYRICS_MATCHER_VERSION) return cached;

  const { artist, title: guessTitle } = parseArtistTitle(title, channel);
  let result;
  try {
    const found = await fetchLyricsFromLrclib(artist, guessTitle, durationSec);
    result = found
      ? { found: true, synced: found.synced, plain: found.plain, artist, title: guessTitle }
      : { found: false, artist, title: guessTitle };
  } catch (e) {
    result = { found: false, error: e.message, artist, title: guessTitle };
  }
  result._v = LYRICS_MATCHER_VERSION;
  cache[ytUrl] = result;
  saveLyricsCache(cache);
  return result;
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
// 유튜브뮤직(music.youtube.com) 검색을 직접 걸어봤는데, 일반 유튜브 검색보다 관련성 랭킹이
// 훨씬 부실해서(엉뚱한 설교/방송 영상이 위로 올라옴) 오히려 결과가 나빠짐 — 그래서 검색 자체는
// 기존 일반 유튜브 검색을 그대로 쓰고, 그 위에 "제목에 방송성 키워드 있으면 뒤로 밀기"만 적용
// (형 요청, 2026-07-20 — lrclib 매칭 정확도를 높이려는 목적. 완전히 숨기지 않고 뒤로만 미는 이유는
// 정식 음원이 없는 곡도 여전히 찾을 수 있게 하기 위함).
const LIVE_BROADCAST_RE = /(방송|라이브|직캠|live|broadcast)/i;

async function searchYoutube(query, limit = 10) {
  const json = await ytdlp([
    `ytsearch${limit * 2}:${query}`,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--flat-playlist'
  ]);
  const items = json.split('\n').filter(Boolean).map(line => {
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

  items.sort((a, b) => LIVE_BROADCAST_RE.test(a.title) - LIVE_BROADCAST_RE.test(b.title));
  return items.slice(0, limit);
}

let mainWin = null;
let settingsWin = null;
let tray = null;
let forceQuit = false;

function getTrayIcon() {
  const trayIconPath = path.join(__dirname, 'assets', 'icon_tray.png');
  if (fs.existsSync(trayIconPath)) {
    return nativeImage.createFromPath(trayIconPath);
  }
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
autoUpdater.on('update-not-available', () => {
  mainWin?.webContents.send('update-not-available');
});
autoUpdater.on('error', (err) => {
  mainWin?.webContents.send('update-error', err?.message || String(err));
});
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('check-for-updates', () => {
  if (!app.isPackaged) return 'dev';
  autoUpdater.checkForUpdates();
  return 'checking';
});
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
ipcMain.handle('get-lyrics', async (_, ytUrl, title, channel, durationSec) => {
  try {
    return await getLyrics(ytUrl, title, channel, durationSec);
  } catch (e) {
    return { found: false, error: e.message };
  }
});

// 동기화 데이터가 없는 곡에서 형이 직접 한 줄 탭해서 맞춘 타이밍을 저장 — 같은 곡 다음에
// 틀 때도 자동으로 그 타이밍을 그대로 써먹기 위함(2026-07-20, 김범수 "끝사랑" 등 lrclib에
// 동기화 자체가 없는 곡 대응).
ipcMain.handle('save-manual-sync', async (_, ytUrl, syncLines) => {
  const cache = loadLyricsCache();
  if (cache[ytUrl]) {
    cache[ytUrl].manualSyncLines = syncLines;
    saveLyricsCache(cache);
  }
  return true;
});

ipcMain.handle('search-lyrics-manual', async (_, ytUrl, artist, title, durationSec) => {
  try {
    const found = await fetchLyricsFromLrclib(artist, title, durationSec);
    const result = found
      ? { found: true, synced: found.synced, plain: found.plain, artist, title }
      : { found: false, artist, title };
    result._v = LYRICS_MATCHER_VERSION;
    const cache = loadLyricsCache();
    cache[ytUrl] = result;
    saveLyricsCache(cache);
    return result;
  } catch (e) {
    return { found: false, error: e.message };
  }
});

ipcMain.handle('check-ytdlp', async () => {
  try {
    const v = await ytdlp(['--version']);
    return { ok: true, version: v };
  } catch {
    return { ok: false };
  }
});
