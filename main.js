const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const DATA_DIR = path.join(app.getPath('userData'), 'kris-music');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const LYRICS_CACHE_FILE = path.join(DATA_DIR, 'lyrics-cache.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

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

// ── 계정(로그인) ──────────────────────────────────────────────────────────────
// 2026-08-07 오푸스 설계(kmusic_login_spec.md) 기반. accounts는 지금 1명이라도 배열로 두고
// activeAccountId를 배열 밖 필드로 분리 — 계정 전환 = 필드 하나 교체(계정 안에 isActive를
// 두면 둘 다 true가 되는 버그가 필연적으로 생김). id는 이름과 분리된 불변 키라 이름을
// 바꿔도 재생기록(history/<id>.json)이 끊기지 않는다.
// PIN은 진짜 보안이 아니라 "같은 PC 쓰는 다른 사람과 기록을 안 섞기 위한 칸막이" 수준이라고
// 설계 문서/등록 화면 문구에 명시했음 — 그래서 초기화도 별도 신원확인 없이 허용한다.
function uid() { return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(salt + pin).digest('hex');
  return `sha256$${salt}$${digest}`;
}
function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'sha256') return false;
  const digest = crypto.createHash('sha256').update(parts[1] + pin).digest('hex');
  // 타이밍 공격 자체가 의미 없는 로컬 단일사용자 앱이지만, 길이가 다르면 timingSafeEqual이
  // 예외를 던지므로 그 경우만 가드
  if (digest.length !== parts[2].length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(parts[2]));
}

// 쓰는 도중 앱이 죽어도 파일이 반쪽짜리로 깨지지 않게 임시파일에 쓰고 rename
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (!Array.isArray(data.accounts)) return null;
    return data;
  } catch { return null; }
}
function saveAccounts(data) { writeJsonAtomic(ACCOUNTS_FILE, data); }

function historyFile(accountId) { return path.join(HISTORY_DIR, `${accountId}.json`); }
function loadHistory(accountId) {
  try { return JSON.parse(fs.readFileSync(historyFile(accountId), 'utf8')); } catch {
    return { schemaVersion: 1, accountId, updatedAt: new Date().toISOString(), tracks: {}, channels: {}, mixSeeds: {} };
  }
}
function saveHistory(h) { writeJsonAtomic(historyFile(h.accountId), h); }

function getActiveAccount() {
  const data = loadAccounts();
  if (!data) return null;
  return data.accounts.find(a => a.id === data.activeAccountId) || null;
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
let tabWin = null;
let tray = null;
let forceQuit = false;

// Smoothly tweens mainWin's bounds instead of snapping instantly (setBounds()
// on its own jumps in a single frame). easeOutCubic over ~260ms.
// Tick rate deliberately throttled below display refresh rate (~25ms/40fps
// instead of 16ms/60fps): each native SetWindowPos on Windows forces a real
// repaint of the whole page, and issuing them faster than Chromium can paint
// causes the previous frame's pixels to still be on screen when the next
// bounds change lands — visible as trailing/ghosting. Giving each step more
// real time to fully paint before the next one arrives reduces that, even
// though each individual jump is a bit larger.
let boundsAnimTimer = null;
function animateBounds(from, to, duration = 260) {
  if (boundsAnimTimer) { clearInterval(boundsAnimTimer); boundsAnimTimer = null; }
  const start = Date.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  boundsAnimTimer = setInterval(() => {
    if (!mainWin || mainWin.isDestroyed()) { clearInterval(boundsAnimTimer); boundsAnimTimer = null; return; }
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = ease(t);
    mainWin.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.round(from.width + (to.width - from.width) * e),
      height: Math.round(from.height + (to.height - from.height) * e)
    });
    if (t >= 1) { clearInterval(boundsAnimTimer); boundsAnimTimer = null; }
  }, 25);
}

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
    { label: '열기', click: () => { mainWin?.show(); mainWin?.focus(); moveTabBeside(); } },
    { type: 'separator' },
    { label: '설정', click: () => { mainWin?.show(); mainWin?.focus(); moveTabBeside(); mainWin?.webContents.send('open-settings'); } },
    { label: '프로그램 정보', click: () => { mainWin?.show(); mainWin?.focus(); moveTabBeside(); mainWin?.webContents.send('open-about'); } },
    { type: 'separator' },
    { label: '프로그램 종료', click: () => { forceQuit = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWin?.show(); mainWin?.focus(); moveTabBeside(); });
  tray.on('click', () => { mainWin?.show(); mainWin?.focus(); moveTabBeside(); });
}

// ── 화면 옆 엣지탭 (창 왼쪽 도킹 기본값 기준, 창 오른쪽 가장자리에 붙는 탭) ──────────
const TAB_W = 26, TAB_H = 104;

const MAIN_MIN_HEIGHT = 884; // createMainWindow()의 minHeight와 동일

// 라벨을 위아래로 드래그해서 옮길 수 있는 범위 — 지금 창 높이가 얼마든 상관없이,
// 창을 최소 높이로 줄였을 때도 라벨이 창 밖으로 벗어나지 않도록 그 기준으로 제한.
function clampTabOffset(offset) {
  const maxOffset = Math.max(0, (MAIN_MIN_HEIGHT - TAB_H) / 2);
  return Math.max(-maxOffset, Math.min(maxOffset, offset));
}

function getTabPos(offsetOverride) {
  const wa = screen.getPrimaryDisplay().workArea;
  const offset = clampTabOffset(offsetOverride != null ? offsetOverride : (loadConfig().tabOffsetY || 0));
  const b = mainWin && !mainWin.isDestroyed() ? mainWin.getBounds() : null;
  let x;
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) {
    x = b.x + b.width;
  } else {
    x = wa.x; // 창이 숨겨지면 화면 실제 가장자리로 바짝 붙음
  }
  const winY = b ? b.y : wa.y;
  const winHeight = b ? b.height : MAIN_MIN_HEIGHT;
  const y = Math.round(winY + winHeight / 2 - TAB_H / 2 + offset);
  return { x, y };
}

function createTabWindow() {
  const { x, y } = getTabPos();
  tabWin = new BrowserWindow({
    x, y, width: TAB_W, height: TAB_H,
    frame: false, transparent: true, backgroundColor: '#00000000',
    focusable: false,
    // 항상위 여부는 mainWin과 항상 같은 값으로 맞춤 — 안 그러면 mainWin이 항상위가 아닐 때
    // 다른 창에 포커스가 가서 mainWin은 뒤로 숨어도 탭만 계속 맨 위에 떠서 따로 노는 것처럼 보임.
    alwaysOnTop: !!loadConfig().alwaysOnTop, skipTaskbar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  tabWin.loadFile('renderer/tab.html');
  tabWin.setVisibleOnAllWorkspaces(true);
  tabWin.webContents.once('did-finish-load', () => {
    tabWin?.webContents.send('set-theme', loadConfig().theme || 'default');
  });
}

function moveTabBeside(offsetOverride) {
  if (!tabWin || tabWin.isDestroyed()) return;
  const { x, y } = getTabPos(offsetOverride);
  tabWin.setPosition(x, y);
}

let tabDragStartOffset = null;
ipcMain.handle('tab-drag-start', () => {
  tabDragStartOffset = loadConfig().tabOffsetY || 0;
});
ipcMain.handle('tab-drag-move', (_, dy) => {
  if (tabDragStartOffset == null) return;
  moveTabBeside(tabDragStartOffset + (dy || 0));
});
ipcMain.handle('tab-drag-end', (_, dy) => {
  if (tabDragStartOffset == null) return;
  const finalOffset = clampTabOffset(tabDragStartOffset + (dy || 0));
  saveConfig({ ...loadConfig(), tabOffsetY: finalOffset });
  tabDragStartOffset = null;
  moveTabBeside(finalOffset);
});

ipcMain.handle('toggle-main-window', () => {
  if (mainWin?.isVisible()) {
    mainWin.hide();
  } else {
    mainWin?.show();
    mainWin?.focus();
  }
  moveTabBeside();
  return true;
});

function createMainWindow() {
  const cfg0 = loadConfig();
  const savedHeight = cfg0.windowHeight;
  const maxUsableHeight = screen.getPrimaryDisplay().workAreaSize.height;
  const validSaved = typeof savedHeight === 'number' && savedHeight >= 884 && savedHeight <= maxUsableHeight;

  // 종료 시점 위치 복원 — 그 사이 모니터 구성이 바뀌어 화면 밖으로 나갈 좌표면 무시하고 기본(가운데) 위치 사용.
  const savedX = cfg0.windowX, savedY = cfg0.windowY;
  let posOpts = {};
  if (typeof savedX === 'number' && typeof savedY === 'number') {
    const onScreen = screen.getAllDisplays().some(d => (
      savedX >= d.bounds.x - 50 && savedX < d.bounds.x + d.bounds.width &&
      savedY >= d.bounds.y - 50 && savedY < d.bounds.y + d.bounds.height
    ));
    if (onScreen) posOpts = { x: savedX, y: savedY };
  }

  mainWin = new BrowserWindow({
    width: 400,
    height: validSaved ? savedHeight : 884,
    ...posOpts,
    minHeight: 884,
    minWidth: 400,
    maxWidth: 400,
    resizable: true,
    maximizable: false,
    frame: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.loadFile('renderer/index.html');

  // ── "Fill height" double-click toggle ────────────────────────────────────────
  // We drive this feature ENTIRELY from our own double-click detection in the
  // renderer (renderer/app.js sends 'toggle-fill-height' over IPC) plus a plain
  // setBounds() here — never native OS maximize. `maximizable: false` above stops
  // Windows from ALSO trying to run its own SC_MAXIMIZE on the same double-click;
  // without it, the native maximize attempt and our own setBounds() raced each
  // other (the OS's own unmaximize/restore was clobbering our fill immediately
  // after we applied it — the "fills then instantly reverts" symptom).

  // filled = are we currently in the "filled to work-area height" state.
  // preFillBounds = the exact bounds to restore to when toggling back off.
  let filled = false;
  let preFillBounds = null;
  let dragUnsnapTimer = null;
  const toggleFillHeight = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (dragUnsnapTimer) { clearTimeout(dragUnsnapTimer); dragUnsnapTimer = null; }
    if (mainWin.isMaximized()) mainWin.unmaximize(); // paranoia; should never be true
    if (!filled) {
      // Fill branch: remember where we are, then snap to the LEFT edge of
      // whichever monitor the window currently sits on and grow to that
      // display's full work-area height. width stays 400. workArea excludes
      // the taskbar on whichever edge/monitor it's docked.
      const cur = mainWin.getBounds();
      const wa = screen.getDisplayMatching(cur).workArea;
      preFillBounds = cur;
      filled = true;
      // 채움 상태에선 move/resize 핸들러가 저장을 건너뛰므로, 채우기 직전의 "일반" 위치/높이를
      // 여기서 한 번 명시적으로 저장해둠 — 채운 채로 종료해도 다음 실행 때 채운 상태로 복원 가능.
      saveConfig({ ...loadConfig(), windowFilled: true, windowX: cur.x, windowY: cur.y, windowHeight: cur.height });
      animateBounds(cur, { x: wa.x, y: wa.y, width: 400, height: wa.height });
    } else {
      // Restore branch: go back to exactly where we were before filling.
      const cur = mainWin.getBounds();
      const restoreTo = preFillBounds || cur;
      preFillBounds = null;
      filled = false;
      saveConfig({ ...loadConfig(), windowFilled: false, windowX: restoreTo.x, windowY: restoreTo.y, windowHeight: restoreTo.height });
      animateBounds(cur, restoreTo);
    }
  };

  if (cfg0.windowFilled) toggleFillHeight();
  ipcMain.handle('toggle-fill-height', () => { toggleFillHeight(); });

  // If the user drags the window away while it's filled (instead of
  // double-clicking to restore), treat that like Windows' own "unsnap":
  // shrink back to the pre-fill height right where the drag left it, forget the
  // old remembered spot, and let wherever it lands become the new "normal"
  // position. Next double-click then does a fresh fill from there.
  //
  // ⚠️ CRITICAL — why we WAIT for the drag to stop instead of resizing on the
  // first 'move' tick (2026-07-25, fixes the "flashes + jumps to left edge
  // first" bug on real Windows hardware):
  //   Dragging the -webkit-app-region:drag header is a NATIVE Windows title-bar
  //   (HTCAPTION) drag. For the whole time the mouse button is held, Windows runs
  //   its OWN modal move loop that OWNS the window rectangle: every mouse move it
  //   recomputes the window origin from a grab-offset it cached at mouse-down and
  //   drives the window with its own SetWindowPos. If WE call setBounds() in the
  //   middle of that loop (which is exactly what a 'move'-triggered resize does —
  //   'move' fires from WM_MOVE, i.e. mid-drag), two writers fight over the same
  //   rect within one drag: the OS loop's cached anchor no longer matches the
  //   window we just resized, so it yanks toward its stale reference (the visible
  //   left-edge snap) and the back-and-forth reconciliation shows up as flicker.
  //   So we DON'T touch bounds while movement is happening. We only (re)arm a short
  //   timer on every 'move'; a real drag emits a continuous stream, so the timer
  //   keeps resetting and never fires mid-motion. It only fires once movement goes
  //   quiet — mouse released, OR held still — and at THAT moment the OS move loop
  //   is idle, so a single setBounds() lands cleanly with no fight, no flicker, and
  //   no detour to the left edge. Height-only shrink with x/y preserved also keeps
  //   the OS grab-offset (cursor→top-left) valid if the user resumes after a pause.
  // 항상위가 아닐 때는 tabWin도 항상위가 아니라서, 작업표시줄 클릭 등으로 mainWin이
  // 다시 앞으로 나올 때 탭도 즉시 같이 따라와야 함 — 3초 주기 moveTop() 타이머만 믿으면
  // 최대 3초까지 탭이 뒤에 남아있다가 뒤늦게 튀어나오는 것처럼 보임.
  mainWin.on('show', () => { tabWin?.moveTop(); moveTabBeside(); });
  mainWin.on('focus', () => { tabWin?.moveTop(); moveTabBeside(); });
  mainWin.on('restore', () => { tabWin?.moveTop(); moveTabBeside(); });

  let moveSaveTimer = null;
  mainWin.on('move', () => {
    moveTabBeside();

    // 창 위치 저장(디바운스) — 다음 실행 때 마지막 위치로 복원하기 위함. 채움 상태의
    // 임시 좌표나 우리 자체 애니메이션 중간값은 저장하지 않음(windowHeight 저장 로직과 동일 원칙).
    if (!boundsAnimTimer && !filled) {
      clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(() => {
        if (!mainWin || mainWin.isDestroyed() || filled) return;
        const [x, y] = mainWin.getPosition();
        saveConfig({ ...loadConfig(), windowX: x, windowY: y });
      }, 400);
    }

    if (boundsAnimTimer) return; // our own animateBounds() is driving this move, ignore
    if (!filled) return;
    const targetHeight = preFillBounds ? preFillBounds.height : mainWin.getBounds().height;
    if (dragUnsnapTimer) clearTimeout(dragUnsnapTimer);
    dragUnsnapTimer = setTimeout(() => {
      dragUnsnapTimer = null;
      if (!mainWin || mainWin.isDestroyed()) return;
      if (boundsAnimTimer) return; // an animation started in the meantime; let it own the bounds
      if (!filled) return;         // toggled off some other way in the meantime
      filled = false;
      preFillBounds = null;
      const cur = mainWin.getBounds();
      // 더블클릭 원복 경로(toggleFillHeight)엔 이 저장이 있었는데 드래그로 풀리는 이 경로엔
      // 빠져있었음 — 채운 채로 종료 안 해도 windowFilled가 true로 남아 다음 실행 때 다시
      // 채워진 채로 뜨던 버그(오푸스 리뷰 발견, 2026-08-02).
      saveConfig({ ...loadConfig(), windowFilled: false, windowX: cur.x, windowY: cur.y, windowHeight: targetHeight });
      mainWin.setBounds({ x: cur.x, y: cur.y, width: 400, height: targetHeight });
    }, 140);
  });

  let resizeSaveTimer = null;
  mainWin.on('resize', () => {
    // 아래쪽 모서리로만 높이를 조절하면 x/y는 안 바뀌어서 'move' 이벤트가 안 뜨고, 그래서
    // 엣지탭이 안 따라오고 예전 자리에 남아있던 버그(오푸스 리뷰 발견, 2026-08-02) — resize
    // 때도 위치를 다시 계산해야 함.
    moveTabBeside();
    if (filled) return; // don't persist the temporary filled height
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      if (filled) return;
      const [, h] = mainWin.getSize();
      saveConfig({ ...loadConfig(), windowHeight: h });
    }, 400);
  });

  mainWin.on('close', e => {
    if (!forceQuit) {
      e.preventDefault();
      mainWin.hide();
      moveTabBeside();
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
    createTabWindow();
    setInterval(() => {
      if (tabWin && !tabWin.isDestroyed()) tabWin.moveTop();
      // 윈도우 자체 화면 캡처 도구 등 외부 요인이 mainWin의 항상위 상태를 우리 모르게 풀어버리는
      // 경우가 있어서(형 리포트 2026-08-02 — 캡처 후 라벨만 떠있고 앱은 다른 창 밑으로 감), tabWin과
      // 같은 방식으로 주기적으로 재확인해서 어긋나 있으면 다시 맞춰준다.
      if (mainWin && !mainWin.isDestroyed() && loadConfig().alwaysOnTop && !mainWin.isAlwaysOnTop()) {
        mainWin.setAlwaysOnTop(true);
      }
    }, 3000);
    if (app.isPackaged) {
      // allowPrerelease=false 없으면 테스트빌드(버전 -N 접미사)가 자동으로 allowPrerelease=true가
      // 되고, 그 상태에서는 GitHubProvider가 정식(비프리릴리즈) 릴리즈를 찾지 못해 "업데이트 확인"이
      // 영구 실패한다(K-Tube 2026-08-06 실측, check_electron_autoupdate_safeguard.py 훅 근거).
      // 반대로 이 값을 켜두고 시작 시 자동확인까지 그대로 두면, 테스트빌드가 이미 배포된 정식판을
      // "새 버전"으로 착각해서 자동으로 덮어써버리는 사고가 K-Memo에서 실제로 났었다(2026-08-07,
      // 1.4.2-1이 앱 켜자마자 1.4.2로 자동 다운그레이드됨) — 그래서 시작 시 자동확인은 테스트빌드일
      // 때만 건너뛰고, 수동 "업데이트 확인" 버튼은 그대로 둔다.
      autoUpdater.allowPrerelease = false;
      const isTestBuild = /-\d+$/.test(app.getVersion());
      if (isTestBuild) {
        console.log('[autoUpdater] 테스트빌드(' + app.getVersion() + ') — 시작 시 자동 업데이트 확인 건너뜀');
      } else {
        autoUpdater.checkForUpdatesAndNotify();
      }
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
  // 렌더러는 앱 시작 시 한 번 읽은 config 사본을 계속 들고 있다가 매번 통째로 다시 보냄(재생위치
  // 자동저장 등). tabOffsetY/windowX/windowY/windowHeight/windowFilled는 메인 프로세스(탭 드래그·
  // 창 이동/크기/채움토글)만 갱신하는 값이라 렌더러의 낡은 사본으로 덮어써지면 안 됨 — 항상 최신
  // (prev) 값을 유지. (windowFilled 누락으로 재생 중 5초 자동저장이 채움상태를 계속 되돌리던
  // 버그를 오푸스 리뷰에서 발견, 2026-08-02)
  const { tabOffsetY, windowX, windowY, windowHeight, windowFilled, ...rendererCfg } = cfg;
  saveConfig({
    ...prev, ...rendererCfg,
    tabOffsetY: prev.tabOffsetY, windowX: prev.windowX, windowY: prev.windowY, windowHeight: prev.windowHeight,
    windowFilled: prev.windowFilled
  });
  if (cfg.theme) tabWin?.webContents.send('set-theme', cfg.theme);
  return true;
});
ipcMain.handle('get-playlists', () => loadPlaylists());
ipcMain.handle('save-playlists', (_, pl) => { savePlaylists(pl); return true; });

// ── 계정 IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('account-get-active', () => {
  const account = getActiveAccount();
  if (!account) return null;
  // pinHash는 렌더러로 절대 내보내지 않는다
  const { pinHash, ...safe } = account;
  return safe;
});

ipcMain.handle('account-register', (_, name, pin) => {
  name = String(name || '').trim().slice(0, 12);
  pin = String(pin || '');
  if (!name) return { ok: false, error: '이름을 입력해 주세요.' };
  if (!/^[0-9]{4,6}$/.test(pin)) return { ok: false, error: '간편 비밀번호는 숫자 4~6자리예요.' };

  let data = loadAccounts();
  if (!data) data = { schemaVersion: 1, activeAccountId: null, accounts: [] };
  const now = new Date().toISOString();
  const id = uid();
  const account = {
    id, name, pinHash: hashPin(pin),
    pinSetAt: now, createdAt: now, lastActiveAt: now,
    prefs: { personalizeRecommendations: true, requirePinOnLaunch: false }
  };
  data.accounts.push(account);
  data.activeAccountId = id;
  saveAccounts(data);
  saveHistory({ schemaVersion: 1, accountId: id, updatedAt: now, tracks: {}, channels: {}, mixSeeds: {} });

  const { pinHash, ...safe } = account;
  return { ok: true, account: safe };
});

ipcMain.handle('account-change-name', (_, newName) => {
  newName = String(newName || '').trim().slice(0, 12);
  if (!newName) return { ok: false, error: '이름을 입력해 주세요.' };
  const data = loadAccounts();
  const account = data && data.accounts.find(a => a.id === data.activeAccountId);
  if (!account) return { ok: false, error: '등록된 계정이 없어요.' };
  account.name = newName;
  saveAccounts(data);
  return { ok: true };
});

// resetMode가 true면 currentPin 검증을 건너뛴다("비밀번호를 잊으셨나요? 초기화" 경로 —
// 로컬 전용 앱이라 이메일 인증 같은 진짜 복구 수단이 없고, 4~6자리 PIN 자체가 애초에
// "같은 PC 다른 사람과 안 섞이기" 수준의 칸막이라 신원확인 없는 초기화도 설계상 허용함)
ipcMain.handle('account-change-pin', (_, currentPin, newPin, resetMode) => {
  newPin = String(newPin || '');
  if (!/^[0-9]{4,6}$/.test(newPin)) return { ok: false, error: '새 비밀번호는 숫자 4~6자리예요.' };
  const data = loadAccounts();
  const account = data && data.accounts.find(a => a.id === data.activeAccountId);
  if (!account) return { ok: false, error: '등록된 계정이 없어요.' };
  if (!resetMode && !verifyPin(String(currentPin || ''), account.pinHash)) {
    return { ok: false, error: '현재 비밀번호가 맞지 않아요.' };
  }
  account.pinHash = hashPin(newPin);
  account.pinSetAt = new Date().toISOString();
  saveAccounts(data);
  return { ok: true };
});

ipcMain.handle('account-set-personalize', (_, on) => {
  const data = loadAccounts();
  const account = data && data.accounts.find(a => a.id === data.activeAccountId);
  if (!account) return false;
  account.prefs.personalizeRecommendations = !!on;
  saveAccounts(data);
  return true;
});

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
ipcMain.handle('close-app', () => { mainWin?.hide(); moveTabBeside(); });
ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('toggle-always-on-top', () => {
  const next = !mainWin?.isAlwaysOnTop();
  mainWin?.setAlwaysOnTop(next);
  tabWin?.setAlwaysOnTop(next);
  return next;
});
ipcMain.handle('get-always-on-top', () => mainWin?.isAlwaysOnTop() ?? false);
ipcMain.handle('set-always-on-top', (_, val) => { mainWin?.setAlwaysOnTop(val); tabWin?.setAlwaysOnTop(val); });
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
