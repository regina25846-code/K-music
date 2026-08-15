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
// config.json/playlists.json은 재생 중 5초마다·큐 보충마다 자주 쓰이는 파일인데도 계정/기록
// 파일(writeJsonAtomic)과 달리 예전부터 그냥 writeFileSync였다 — 쓰는 도중 앱이 강제종료되면
// 테마/볼륨/API키/재생목록이 반쪽짜리 파일로 깨질 수 있었다(오푸스 검토, 2026-08-16). 아래
// writeJsonAtomic으로 통일(임시파일에 쓰고 완성되면 rename).
function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}
function loadPlaylists() {
  try { return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch {
    return [{ id: 'default', name: 'My Playlist', tracks: [] }];
  }
}
function savePlaylists(pl) {
  writeJsonAtomic(PLAYLISTS_FILE, pl);
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
  let h;
  try { h = JSON.parse(fs.readFileSync(historyFile(accountId), 'utf8')); } catch {
    h = { schemaVersion: 1, accountId, updatedAt: new Date().toISOString(), tracks: {}, channels: {}, mixSeeds: {} };
  }
  // artists/decades는 2026-08-07에 추가된 필드라, 그 전에 생성된 history 파일엔 없을 수 있음 —
  // 없으면 빈 객체로 채워서 이후 코드가 undefined 접근으로 죽지 않게 함(하위호환).
  h.tracks ||= {}; h.channels ||= {}; h.artists ||= {}; h.decades ||= {}; h.mixSeeds ||= {};
  return h;
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

  // "ARTIST _ 제목" 형식(1theK 같은 MV 채널이 대시 대신 언더스코어를 구분자로 씀 — 형 실사용 중
  // 발견: "[MV] ZICO(지코) _ Any song?"이 아티스트를 채널명("1theK")으로 잘못 뽑아서 가사 검색이
  // 안 됨, 2026-08-08). 언더스코어는 단어 중간에도 흔히 쓰이니 대시(공백 없어도 매치)와 달리
  // 앞뒤에 공백이 실제로 있을 때만 구분자로 인정해서 오탐을 줄인다.
  const sepMatch = t.match(/^(.+?)\s*[-–—]\s*(.+)$/) || t.match(/^(.+?)\s+_\s+(.+)$/);
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
// "재생 실패: no supported source" 근본 원인 조사(2026-08-16, 형 신고) — 라이브방송/프리미어성
// 영상은 yt-dlp가 info.url에 HLS(m3u8) 매니페스트 주소를 돌려주는데, 이건 <audio> 태그가
// 네이티브로 재생 못 하는 형식이라 브라우저가 곧바로 "no supported source"를 던진다. 기존
// 재시도(force refetch)는 같은 영상을 다시 받아도 여전히 같은 HLS 주소라 무의미했음 — 이걸
// 미리 감지해서 명확한 에러로 구분해준다(추천곡이 쌓일수록 라이브/프리미어 영상이 섞일 확률이
// 올라가는 것과 패턴이 일치).
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
  if (info.is_live || info.live_status === 'is_live' || (info.protocol || '').includes('m3u8')) {
    const err = new Error('라이브방송/프리미어 영상이라 재생할 수 없어요');
    err.code = 'UNSUPPORTED_LIVE_SOURCE';
    throw err;
  }
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
// 기존 일반 유튜브 검색을 그대로 쓴다. 방송성 클립("비긴어게인"/"유희열의 스케치북"류 라이브
// 무대 클립, 직캠, 버스킹 등)은 원래 "뒤로만 밀기"였는데(2026-07-20, lrclib 매칭 정확도 목적),
// 형이 특정 프로그램 클립이 검색 결과를 도배한다고 리포트(2026-08-16)해서 강화 — 정식 음원 등
// 깨끗한 결과가 limit개 이상 있으면 방송 클립은 아예 제외하고, 그 곡이 방송 클립으로만 존재하는
// 경우(정식 음원이 없어서 깨끗한 결과가 부족한 경우)에만 부족한 만큼 채워 넣는다.
// 영문 키워드는 반드시 \b(단어 경계)로 감싼다 — 안 그러면 "live"가 Alive/Olive/Delivery를,
// "best"가 Bestie를 오탐하는 걸 실측으로 확인했다(오푸스 검토, 2026-08-16). 한글 키워드는
// 애초에 이런 식의 우연한 부분일치 위험이 낮아서 그대로 둔다. 's?'로 복수형(livestream 앞의
// "lives"류, broadcasts 등)까지만 허용 — \b 하나만으론 "livestream"/"broadcasts" 같은 흔한
// 변형을 놓친다는 걸 오푸스 2차 검증에서 재확인.
const LIVE_BROADCAST_RE = /(방송|라이브|직캠|버스킹|비긴어게인|스케치북)|\b(begin\s*again|live|broadcast|busking)s?\b/i;

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
        duration: d.duration,
        releaseYear: d.release_year || null
      };
    } catch { return null; }
  }).filter(Boolean);

  const isLive = it => LIVE_BROADCAST_RE.test(it.title) || BROADCAST_CHANNEL_RE.test(it.channel);
  const clean = items.filter(it => !isLive(it));
  const live = items.filter(isLive);
  const picks = clean.length >= limit ? clean : clean.concat(live);
  return picks.slice(0, limit);
}

// ── 추천 재정렬(개인화 믹스) ────────────────────────────────────────────────────
// 2026-08-07, 형 요청. 유튜브가 자체 계산하는 "믹스(Mix)" 재생목록(watch?v=<id>&list=RD<id>)을
// 그대로 가져오되, 순서만 형 계정의 재생기록(채널/곡 단위 집계)으로 다시 매긴다 — 추천 알고리즘을
// 새로 만드는 게 아니라 유튜브 결과를 재료로 재정렬하는 방식(실측: yt-dlp로 릭애슬리 시드 테스트
// 시 관련도 높은 80년대 팝 곡들이 그대로 나옴, 2026-08-07).
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v');
  } catch { return null; }
}

async function getMixForVideo(videoId, limit = 20) {
  const json = await ytdlp([
    `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`,
    '--dump-json',
    '--no-warnings',
    '--flat-playlist',
    '--playlist-end', String(limit)
  ]);
  const items = json.split('\n').filter(Boolean).map(line => {
    try {
      const d = JSON.parse(line);
      return {
        id: d.id,
        ytUrl: d.url || `https://www.youtube.com/watch?v=${d.id}`,
        title: d.title,
        channel: d.uploader || d.channel || d.uploader_id || '',
        thumbnail: d.thumbnail || (d.thumbnails && d.thumbnails[d.thumbnails.length - 1]?.url) || '',
        duration: d.duration,
        releaseYear: d.release_year || null
      };
    } catch { return null; }
  }).filter(Boolean);
  return items.filter(it => it.id && it.id !== videoId); // 시드곡 자기 자신은 제외
}

// 추천 후보에서만 방송클립/모음/베스트 영상을 아예 걸러낸다(형 요청, 2026-08-07) — 검색
// 기능의 LIVE_BROADCAST_RE는 "정식 음원이 없을 수도 있으니 숨기지 말고 뒤로만 밀자"는
// 목적이라 그대로 두고, 이건 완전히 별개의 상수다. 추천은 대체 후보가 늘 넉넉해서
// 완전히 제외해도 손해가 없고, 형이 검색으로 직접 그런 영상을 듣는 습관과도 안 부딪힌다.
// "클립"/"무대" 추가(2026-08-16, 형 스크린샷 리포트 — "[리무진서비스 클립]"류가 안 걸러짐).
// 영문 키워드는 \b로 감싼다 — "clip"이 Eclipse를, "live"가 Alive를 오탐하던 걸 실측 확인
// (오푸스 검토, 2026-08-16). 한글은 부분일치 위험이 낮아서 그대로 둔다. 's?'로 복수형(Clips/
// Playlists/Broadcasts)까지 커버 — \b만으론 이런 흔한 복수형을 놓친다는 걸 오푸스 2차 검증에서
// 재확인(단, livestream처럼 다른 단어에 곧바로 붙는 합성어까지는 못 잡음 — 잔여 한계로 수용).
const MIX_EXCLUDE_RE = /(방송|라이브|직캠|모음|베스트|플레이리스트|클립|무대)|\b(live|broadcast|best|playlist|clip)s?\b/i;
// 방송사/엔터 클립 전문 채널은 제목에 "라이브"/"방송" 단어가 아예 없는 경우가 많아서(형 스크린샷
// 실측, 2026-08-16 — "[DJ티비씨] 김필(Feel Kim...)"처럼 채널 브랜딩만 있고 제목엔 방송 신호가
// 없음) 위 제목 필터만으론 못 잡는다. 실제로 도배 원인으로 지목된 채널명 패턴을 별도로 검사.
// 새 방송클립 채널이 계속 생길 수 있어 완벽하진 않음 — 여기 안 걸리는 채널은 우클릭 채널차단 병행.
const BROADCAST_CHANNEL_RE = /(kbs\s*kpop|sbs\s*kpop|mbc\s*kpop|jtbc\s*music|디티비씨|dj\s*티비씨|스브스|디스패치|텐아시아|예능맛집|어디든\s*가요)/i;

// 곡 단위 기록만으론 순위를 못 매긴다 — 믹스에 뜨는 곡은 대부분 한 번도 안 튼 새 곡이라서,
// "이 채널/아티스트를 얼마나 좋아하나"라는 집계가 재정렬의 실질적인 핵심 신호다. 채널은
// "가요톱10 아카이브"류 잡탕 채널이면 신뢰도가 낮아지므로(형이 실제 사례로 확인, 2026-08-07),
// 제목에서 뽑아낸 아티스트명(parseArtistTitle, 가사매칭에 쓰던 함수 재사용)을 더 강한 신호로
// 취급한다. 발매연도(시대)는 보조 신호라 가중치를 약하게 둔다. completeCount(끝까지 들음)를
// playCount(그냥 재생됨, 자동재생으로 스쳐간 것도 포함)보다 신뢰도 높은 신호로 취급.
function scoreCandidate(item, history) {
  const t = history.tracks[item.id];
  if (t?.blocked) return -Infinity;
  let score = 0;

  const ch = item.channel && history.channels[item.channel];
  if (ch?.blocked) return -Infinity;
  if (ch) {
    score += (ch.playCount || 0) * 1.5;
    score -= (ch.skipCount || 0) * 1.5;
    score += (ch.favoriteCount || 0) * 5;
  }

  const ar = item.artist && history.artists?.[item.artist];
  if (ar) {
    score += (ar.playCount || 0) * 2.5;
    score -= (ar.skipCount || 0) * 2;
    score += (ar.favoriteCount || 0) * 6;
  }

  const dc = item.decade && history.decades?.[item.decade];
  if (dc) {
    score += (dc.playCount || 0) * 0.8;
    score -= (dc.skipCount || 0) * 0.8;
  }

  if (t) {
    score += (t.completeCount || 0) * 3;
    score -= (t.skipCount || 0) * 2;
    if (t.favorite) score += 8;
  }
  return score;
}

// 반복방지 창이 재생목록에 남아있는 최근 ~13곡(약 1시간)뿐이라 인기곡이 금방 다시 순환하던
// 문제(형 리포트, 2026-08-16) — history.tracks/channels/artists에 이미 쌓이고 있던
// lastPlayedAt을 실제로 읽어서, 재생목록을 갈아타거나 앱을 재시작해도 유지되는 시간 기준
// 쿨다운을 추가한다. 곡 자체는 3일간 사실상 배제(형 확정, 2026-08-16), 가수/채널은 완전
// 차단이 아니라 시간이 지나며 자연히 풀리는 감점만 줘서 후보가 말라 stale 폴백을 다시
// 타는 역효과(원인 3, 채널 15개 차단 시 겪었던 문제)를 반복하지 않게 한다.
const COOLDOWN_MS = { track: 3 * 24 * 3600e3, artist: 6 * 3600e3, channel: 3 * 3600e3 };
function cooldownPenalty(item, history, now = Date.now()) {
  let penalty = 0;
  const ageMs = iso => iso ? now - Date.parse(iso) : Infinity;

  const trackAge = ageMs(history.tracks[item.id]?.lastPlayedAt);
  if (trackAge < COOLDOWN_MS.track) penalty -= 1000;

  const arAge = ageMs(item.artist && history.artists?.[item.artist]?.lastPlayedAt);
  if (arAge < COOLDOWN_MS.artist) penalty -= 20 * (1 - arAge / COOLDOWN_MS.artist);

  const chAge = ageMs(item.channel && history.channels?.[item.channel]?.lastPlayedAt);
  if (chAge < COOLDOWN_MS.channel) penalty -= 10 * (1 - chAge / COOLDOWN_MS.channel);

  return penalty;
}

// 시드/후보 아이템에 아티스트명과 시대(연대) 라벨을 붙인다. reorderByHistory에 넘기기 전에
// 한 번만 호출하면 됨 — record-play-event 쪽에서도 같은 규칙으로 붙여야 스코어링과 기록이 어긋나지 않는다.
function enrichItem(item) {
  const { artist } = parseArtistTitle(item.title || '', item.channel || '');
  const decade = item.releaseYear ? `${Math.floor(item.releaseYear / 10) * 10}s` : null;
  return { ...item, artist: artist || null, decade };
}

// ── 조회수 기반 인기도 가산점(YouTube Data API, 사용자 개인 키 필요) ────────────────
// 형 요청(2026-08-08): "동시대 중 조회수 높은 곡"에 가산점, 장르/성별은 별도 다양성 신호로.
// 처음엔 yt-dlp로 영상 페이지를 직접 긁어서 조회수를 뽑으려 했는데, 실측해보니(개당 12초,
// 3개 동시 요청 시 개당 23~25초로 오히려 느려짐 + 10개 완전동시 요청은 전부 타임아웃)
// 유튜브가 동시 요청을 감지해서 늦추는 걸로 보여 실용성이 없었다. 유튜브 공식 Data API
// (videos.list)는 최대 50개 id를 한 번에 배치 조회해서 초 단위로 응답하므로 이 방식으로
// 교체. 단 앱에 키를 내장하면 안 됨 — K-Music은 asar:false라 main.js가 설치 폴더에 평문
// 그대로 노출되고(K-Tube/K-Memo도 동일하게 확인됨), 형이 "공개배포 전제로 보안 문제 될
// 만한 건 안 만들었으면 좋겠다"고 명시 요청해서, 사용자가 설정 화면에서 자기 키를 직접
// 입력하는 방식으로만 지원한다. 키가 없으면 이 함수는 호출되지 않고 기존 취향 기반
// 순서가 그대로 유지된다(기능 저하는 있어도 추천 자체가 막히진 않음).
async function fetchViewCounts(ids, apiKey) {
  if (!apiKey || !ids.length) return {};
  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube Data API HTTP ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const item of data.items || []) {
    map[item.id] = Number(item.statistics?.viewCount) || 0;
  }
  return map;
}

// 절대 조회수로 비교하면 최신곡이 무조건 유리해지므로(형 요청: "동시대 중에 조회수 높은
// 거"), 반드시 같은 decade 그룹 안에서만 상대 비교한다. 조회수는 자릿수 차이가 커도 체감
// 인기 차이는 훨씬 완만해서 로그 스케일로 정규화하고, 그룹 내 최댓값 대비 비율로 최대
// +3점까지만 가산 — 기존 채널/가수 취향 신호(최대 ±6~8점대)를 밀어내지 않는 보조 신호로만
// 작동하게 가중치를 낮게 잡았다.
function popularityScore(it, viewCounts, maxLogByDecade) {
  const vc = viewCounts[it.id];
  if (!vc) return 0;
  const key = it.decade || '_unknown';
  const m = maxLogByDecade[key];
  if (!m) return 0;
  return (Math.log10(vc + 1) / m) * 3;
}
function buildMaxLogByDecade(ranked, viewCounts) {
  const maxLog = {};
  for (const it of ranked) {
    const vc = viewCounts[it.id];
    if (!vc) continue;
    const key = it.decade || '_unknown';
    const lg = Math.log10(vc + 1);
    if (!maxLog[key] || lg > maxLog[key]) maxLog[key] = lg;
  }
  return maxLog;
}

// Array.prototype.sort는 안정 정렬(V8 기준)이라, 기록이 전혀 없는(점수 0) 곡들끼리는 원래
// 유튜브가 준 순서 그대로 유지된다 — 즉 계정을 막 만들었을 때(콜드스타트)는 사실상 유튜브
// 기본 순서 그대로 나오고, 재생기록이 쌓일수록 그 위로 형 취향 신호가 얹히는 구조다.
function reorderByHistory(items, history) {
  return items
    .map(it => ({ it, score: scoreCandidate(it, history) + cooldownPenalty(it, history) }))
    .filter(x => x.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map(x => x.it);
}

// 같은 노래가 업로더만 바뀐 채 여러 영상으로 믹스에 섞여 들어오는 걸 걸러낸다(형 실사용
// 중 발견, 2026-08-08 — "풀하우스 OST Why"가 업로더 다른 두 영상으로 연달아 추천됨). 영상
// ID는 서로 달라서 excludeIds로는 못 걸러지고, parseArtistTitle의 "|" 뒤 잘라내기는 채널
// 태그가 항상 title 맨 뒤에만 붙는다는 가정이라 title 중간에 곡정보가 있는 경우 오히려 곡
// 정보를 날려버려서(예: "Full House Ost | Rain - Why...") 이 용도로는 못 씀. 그래서 괄호만
// 지우고 나머지는 그대로 토큰화한 뒤, "재생시간이 사실상 같다(±1초) + 의미있는 단어가
// 하나라도 겹친다"는 실사용 케이스 기준의 느슨한 판정만 쓴다 — 재업로드는 오디오가 그대로라
// 길이가 초 단위까지 거의 일치하는 반면, 서로 다른 두 곡이 우연히 길이까지 같을 확률은
// 낮다는 전제. 완벽한 동일곡 판정기는 아니고, 이번처럼 뚜렷한 경우만 잡아내는 실용적 필터.
const TITLE_NOISE_WORDS = new Set(['ost', 'video', 'clip', 'official', 'mv', 'm/v', 'audio', 'lyrics', 'lyric', 'ver', 'live']);
function titleTokens(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[\(\[［【][^)\]］】]*[\)\]］】]/g, ' ') // 괄호류만 제거 (파이프는 안 건드림)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length >= 2 && !TITLE_NOISE_WORDS.has(w));
}
// strict=true면 재생시간 완전일치 단축판정을 안 쓴다 — 20개 안팎인 믹스 내부 중복제거
// (dedupeSimilarSongs)에서는 초단위 완전일치가 우연일 확률이 낮아 안전했지만, 재생목록
// 전체(형처럼 오래 쓰면 수십~수백곡)와 대조하는 alreadyQueued 쪽에 그대로 쓰면 정수초
// 길이가 우연히 겹치는 서로 다른 곡까지 대량으로 "같은 곡"으로 오판해서 추천 후보가
// 말라버리는 문제가 있었다(오푸스 검토, 2026-08-16 — 재생목록 200곡 기준 오탐률 74% 시뮬레이션
// 확인). 그런 넓은 대조에는 제목 토큰 겹침을 반드시 요구하는 기존 판정만 쓴다.
function looksLikeSameSong(a, b, strict = false) {
  const durA = a.duration || 0, durB = b.duration || 0;
  const durDiff = Math.abs(durA - durB);
  // 같은 음원 재업로드는 재생시간이 초 단위까지 완전히 일치하는 경우가 흔한데(실측: 성시경
  // "희재" 282/282초, 엠씨더맥스 "행복하지 말아요" 359/359초), 공식채널판은 제목이 로마자
  // 표기("HeeJae")라 아래 토큰 겹침이 0이 되어 위 케이스가 전부 놓쳐지고 있었다(형 리포트,
  // 2026-08-16 — 채널을 차단해도 같은 곡이 다른 채널로 계속 반복 추천됨). 60초 넘는 곡에서
  // 오차 0초로 겹칠 확률은 사실상 무시할 만해서 토큰 겹침 여부와 무관하게 동일곡으로 인정한다.
  if (!strict && durA > 60 && durDiff === 0) return true;
  const ta = titleTokens(a.title);
  const tbArr = titleTokens(b.title);
  const tb = new Set(tbArr);
  const shared = ta.filter(w => tb.has(w)).length;
  if (!shared) return false; // 겹치는 단어 자체가 없으면 무조건 다른 곡

  // 단어 하나만 겹치는 느슨한 경우엔 길이도 거의 같아야 한다(±4초 — 페인킬러 6:09/6:06
  // 실사례로 완화, 2026-08-08). 반면 "(2015 Remaster)"류는 리마스터판이 원곡보다 몇~십 초씩
  // 더 긴 경우가 흔해서(형 실사용 중 재발견: "2 Minutes to Midnight" 6:10/6:04, 6초 차이로
  // ±4초도 못 잡음), 제목 단어가 대부분(과반) 겹치는 강한 매치일 땐 길이 기준을 ±15초까지
  // 넓게 봐준다 — 제목 유사도가 이미 충분히 강한 증거라 오판 위험은 낮다.
  const overlapRatio = shared / Math.min(ta.length, tbArr.length);
  const durLimit = overlapRatio >= 0.6 ? 15 : 4;
  return durDiff <= durLimit;
}
function dedupeSimilarSongs(items) {
  const kept = [];
  for (const it of items) {
    if (!kept.some(k => looksLikeSameSong(k, it))) kept.push(it);
  }
  return kept;
}

// 한 번의 추천 호출(같은 시드) 안에서만 겹치는지 보는 dedupeSimilarSongs와 달리, 이미
// 재생목록에 올라와 있는 곡(과거에 지나간 것 포함, 영상 ID는 서로 다를 수 있음)까지 넓혀서
// "이미 나온 노래"인지 본다 — 형이 큐를 여러 번 넘기면서 확인할 때마다 매번 새로 추천 호출이
// 일어나는데, 그때마다 같은 노래의 다른 업로드가 반복 추천되는 걸 막기 위함(2026-08-08).
function excludesAsSongList(excludeItems) {
  return (excludeItems || []).filter(x => x && x.title);
}

// "최근 자동추천 10곡" 창(=pruneOldAutoTracks가 유지하는 범위, 렌더러가 넘겨준 전체 재생목록
// 중 source==='auto'인 것들) 안에 같은 채널/가수 곡이 1곡이라도 이미 있으면 "질렸다"고 보고
// 새 추천에서 아예 제외한다 — 다른 후보가 진짜 하나도 없을 때만 최후 수단으로 허용
// (형 요청, 2026-08-08: "10개 연속된 것 중에서는 겹치는 게 없게" — 처음엔 3개까지 봐주고
// 순서만 뒤로 미는 느슨한 버전이었는데, 형이 직접 1개 기준 + 완전 제외로 강화 요청함. 영구
// 차단은 아니고 그 곡이 최근 10곡 창에서 밀려나면 자연히 다시 추천 후보로 돌아온다).
const OVERUSE_CAP = 1;
function findOverused(excludeItems) {
  const recentAuto = (excludeItems || []).filter(x => x && x.source === 'auto');
  const channelCounts = {};
  const artistCounts = {};
  for (const x of recentAuto) {
    if (x.channel) channelCounts[x.channel] = (channelCounts[x.channel] || 0) + 1;
    const artist = parseArtistTitle(x.title || '', x.channel || '').artist;
    if (artist) artistCounts[artist] = (artistCounts[artist] || 0) + 1;
  }
  return {
    channels: new Set(Object.keys(channelCounts).filter(c => channelCounts[c] >= OVERUSE_CAP)),
    artists: new Set(Object.keys(artistCounts).filter(a => artistCounts[a] >= OVERUSE_CAP))
  };
}
function partitionOverused(ranked, overused) {
  const fresh = [], stale = [];
  for (const it of ranked) {
    const over = (it.channel && overused.channels.has(it.channel)) || (it.artist && overused.artists.has(it.artist));
    (over ? stale : fresh).push(it);
  }
  return { fresh, stale };
}

// 추천 후보를 앞에서부터 "채널+가수 둘 다 처음 보는" 것만 먼저 뽑고, need만큼 안 모이면
// 그때만 겹치는 것도 허용한다(형 실사용 중 발견, 2026-08-08 — 처음엔 아이유 전용 채널이
// 도배됐고, 채널만 기준으로 막았더니 이번엔 "1theK"처럼 여러 가수를 모아 올리는 공용 채널
// 안에서 멜로망스 한 가수 노래만 도배됨). 채널만으론 공용 채널 안의 가수 쏠림을 못 막아서
// 가수(parseArtistTitle로 뽑은 값)도 같은 기준으로 같이 본다. 완전한 다양성 보장은 아니고,
// 한 번의 추천 호출에서 같은 채널/가수가 뭉텅이로 쏟아지는 것만 막는 실용적 수준의 개선이다.
function pickDiverseChannels(ranked, need) {
  const picked = [];
  const usedChannels = new Set();
  const usedArtists = new Set();
  const leftover = [];
  for (const it of ranked) {
    if (picked.length >= need) break;
    const ch = it.channel || '';
    const ar = it.artist || '';
    if ((ch && usedChannels.has(ch)) || (ar && usedArtists.has(ar))) { leftover.push(it); continue; }
    picked.push(it);
    if (ch) usedChannels.add(ch);
    if (ar) usedArtists.add(ar);
  }
  for (const it of leftover) {
    if (picked.length >= need) break;
    picked.push(it);
  }
  return picked;
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
// https만 허용 — 렌더러가 임의로 file:// 등 다른 스킴을 열게 하는 걸 막기 위한 최소한의 가드
ipcMain.handle('open-external', (_, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

// 설정 화면 "확인" 버튼용 — 저장 여부와 무관하게 지금 입력창에 있는 값을 바로 테스트한다.
// 아무 유효한 영상 id 하나(dQw4w9WgXcQ)로 videos.list를 호출해서, 키가 유효하면 200으로
// 응답이 오고(그 영상이 실제로 존재하는지는 중요하지 않음) 무효면 400이 온다는 점만 이용
// — 형이 "저장 눌러야만 확인되는 게 불편하다"고 지적해서 추가(2026-08-08).
ipcMain.handle('test-yt-api-key', async (_, apiKey) => {
  try {
    const viewCounts = await fetchViewCounts(['dQw4w9WgXcQ'], apiKey);
    return { ok: Object.keys(viewCounts).length > 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
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
  saveHistory({ schemaVersion: 1, accountId: id, updatedAt: now, tracks: {}, channels: {}, artists: {}, decades: {}, mixSeeds: {} });

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

// 특정 채널을 추천에서 완전히 제외한다(-Infinity 처리는 scoreCandidate에 있음) — 형이
// 의도하지 않았는데 알고리즘이 계속 같은 채널만 재생시켜서 그 재생기록이 다시 취향 점수로
// 쌓이는 눈덩이 현상을 형이 직접 끊을 수 있게 하는 수동 제어 장치(형 요청, 2026-08-08).
ipcMain.handle('toggle-channel-block', (_, channel) => {
  channel = String(channel || '').trim();
  const account = getActiveAccount();
  if (!account || !channel) return null;
  const history = loadHistory(account.id);
  history.channels[channel] ||= { playCount: 0, skipCount: 0, favoriteCount: 0 };
  const next = !history.channels[channel].blocked;
  history.channels[channel].blocked = next;
  saveHistory(history);
  return next;
});

ipcMain.handle('get-blocked-channels', () => {
  const account = getActiveAccount();
  if (!account) return [];
  const history = loadHistory(account.id);
  return Object.keys(history.channels || {}).filter(ch => history.channels[ch]?.blocked);
});

// ── 추천 IPC ───────────────────────────────────────────────────────────────────
// excludeItems: [{ id, title, duration }] — 재생목록에 이미 올라와 있는 곡들(과거+현재+미래 전부).
// 예전엔 id 배열만 받았는데, 같은 노래의 다른 업로드(다른 id)까지 걸러내려면 제목/길이가
// 필요해서 객체 배열로 바꿨다(2026-08-08).
ipcMain.handle('get-recommendations', async (_, seedYtUrl, excludeItems, count) => {
  const account = getActiveAccount();
  if (!account) return [];
  const seedId = extractVideoId(seedYtUrl);
  if (!seedId) return [];
  try {
    const mix = (await getMixForVideo(seedId, 20))
      .filter(it => !MIX_EXCLUDE_RE.test(it.title) && !BROADCAST_CHANNEL_RE.test(it.channel))
      .map(enrichItem);
    const history = loadHistory(account.id);
    const exclude = new Set((excludeItems || []).map(x => x?.id).filter(Boolean));
    const alreadyQueued = excludesAsSongList(excludeItems);
    let ranked = reorderByHistory(mix, history).filter(it => !exclude.has(it.id));
    ranked = dedupeSimilarSongs(ranked);
    ranked = ranked.filter(it => !alreadyQueued.some(ex => looksLikeSameSong(it, ex, true)));

    // 조회수 인기도 가산점 — 사용자가 설정에서 유튜브 API 키를 넣어둔 경우에만 시도.
    // 후보가 이미 20개 이하로 추려진 상태라 배치 1회 호출로 전부 조회 가능(50개까지 배치 지원).
    const cfg = loadConfig();
    if (cfg.ytApiKey && ranked.length) {
      try {
        const viewCounts = await fetchViewCounts(ranked.map(it => it.id), cfg.ytApiKey);
        const maxLogByDecade = buildMaxLogByDecade(ranked, viewCounts);
        // cooldownPenalty도 다시 더해야 한다 — 안 그러면 API 키를 넣어둔 계정에서는 이 재정렬이
        // 위 reorderByHistory에서 적용한 시간기반 반복방지를 그대로 지워버리게 된다.
        ranked = ranked
          .map(it => ({ it, score: scoreCandidate(it, history) + cooldownPenalty(it, history) + popularityScore(it, viewCounts, maxLogByDecade) }))
          .sort((a, b) => b.score - a.score)
          .map(x => x.it);
      } catch { /* API 실패해도 조용히 기존 취향 순서 유지 — 추천 자체가 막히면 안 됨 */ }
    }

    const need = count || 3;
    const { fresh, stale } = partitionOverused(ranked, findOverused(excludeItems));
    let picks = pickDiverseChannels(fresh, need);
    if (picks.length < need) picks = picks.concat(stale.slice(0, need - picks.length)); // 다른 후보가 진짜 없을 때만 최후 수단
    return picks;
  } catch {
    return []; // 네트워크 실패 등은 조용히 빈 목록 — 추천 실패로 재생 자체가 막히면 안 됨
  }
});

// eventType: 'play' | 'complete' | 'skip'. meta: { title, channel, duration, listenedSec?, releaseYear? }
ipcMain.handle('record-play-event', (_, ytUrl, meta, eventType) => {
  const account = getActiveAccount();
  if (!account) return false;
  const vid = extractVideoId(ytUrl);
  if (!vid) return false;

  const history = loadHistory(account.id);
  const now = new Date().toISOString();
  if (!history.tracks[vid]) {
    history.tracks[vid] = {
      ytUrl, title: meta?.title || '', channel: meta?.channel || '',
      playCount: 0, completeCount: 0, skipCount: 0, totalListenedSec: 0,
      durationSec: meta?.duration || 0, firstPlayedAt: now, lastPlayedAt: now,
      favorite: false, favoritedAt: null, blocked: false
    };
  }
  const t = history.tracks[vid];
  t.lastPlayedAt = now;
  if (meta?.channel) t.channel = meta.channel;

  const chName = t.channel || '(알 수 없음)';
  if (!history.channels[chName]) {
    history.channels[chName] = { playCount: 0, skipCount: 0, favoriteCount: 0, totalListenedSec: 0, lastPlayedAt: now };
  }
  const ch = history.channels[chName];
  ch.lastPlayedAt = now;

  // 아티스트/시대는 채널과 별개로 제목에서 뽑아서 집계(가요톱10류 잡탕 채널이어도 정확한
  // 아티스트 단위 취향 반영, 2026-08-07 형 확인 사례 기반)
  const { artist } = parseArtistTitle(t.title, t.channel);
  let arObj = null;
  if (artist) {
    if (!history.artists[artist]) history.artists[artist] = { playCount: 0, skipCount: 0, favoriteCount: 0, totalListenedSec: 0, lastPlayedAt: now };
    arObj = history.artists[artist];
    arObj.lastPlayedAt = now;
  }
  const decade = meta?.releaseYear ? `${Math.floor(meta.releaseYear / 10) * 10}s` : null;
  let dcObj = null;
  if (decade) {
    if (!history.decades[decade]) history.decades[decade] = { playCount: 0, skipCount: 0, favoriteCount: 0 };
    dcObj = history.decades[decade];
  }

  if (eventType === 'play') { t.playCount++; ch.playCount++; if (arObj) arObj.playCount++; if (dcObj) dcObj.playCount++; }
  else if (eventType === 'complete') { t.completeCount++; }
  else if (eventType === 'skip') {
    // 'skip'은 항상 그 재생의 'play' 기록 위에 추가로 발생하는데, 예전엔 skipCount만 올리고
    // playCount는 그대로 둬서 채널/아티스트 점수가 playCount*가중치 - skipCount*가중치로
    // 계산될 때 가중치 차이(아티스트 2.5 vs 2.0) 때문에 스킵할수록 오히려 점수가 순증가하는
    // 버그가 있었다(형 실사용 리포트, 2026-08-16 — 자주 넘기는 곡의 가수가 계속 더 나옴).
    // 스킵은 해당 재생을 "취소"하는 의미로 보고, 직전 play 가산을 되돌린 뒤 페널티를 적용한다.
    t.skipCount++;
    ch.skipCount++; ch.playCount = Math.max(0, ch.playCount - 1);
    if (arObj) { arObj.skipCount++; arObj.playCount = Math.max(0, arObj.playCount - 1); }
    if (dcObj) { dcObj.skipCount++; dcObj.playCount = Math.max(0, dcObj.playCount - 1); }
  }

  if (typeof meta?.listenedSec === 'number' && meta.listenedSec > 0) {
    t.totalListenedSec += meta.listenedSec;
    if (arObj) arObj.totalListenedSec += meta.listenedSec;
    ch.totalListenedSec += meta.listenedSec;
  }

  history.updatedAt = now;
  saveHistory(history);
  return true;
});

ipcMain.handle('get-stream', async (_, ytUrl, quality) => {
  try {
    // 음질 설정 UI를 없앤 뒤(2026-08-16, 유튜브가 애초에 129kbps 이상 오디오를 안 줘서
    // 320k가 죽어있던 설정이었음)에도 config.json에 예전에 저장된 quality 값(특히 128)이
    // 남아있으면 계속 최저음질에 고정되는 채로 UI로는 바꿀 방법이 없어지는 문제가 있었다
    // (오푸스 검토, 2026-08-16). 저장된 값을 더는 참조하지 않고 항상 고정 기본값만 쓴다.
    return await getStreamInfo(ytUrl, quality || '192');
  } catch (e) {
    return { error: e.message, code: e.code };
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
      duration: d.duration,
      releaseYear: d.release_year || null // 2026-08-07 추천 개인화의 "시대별" 신호용
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
