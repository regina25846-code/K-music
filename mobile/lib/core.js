// ⚠️ 이 파일은 자동 생성됩니다 — 직접 고치지 마세요.
// 생성기: mobile/build_core.js  (원본: main.js)
// 고쳐야 할 내용이 있으면 main.js를 고치고 `node mobile/build_core.js`를 다시 돌리세요.
//
// 아래 본문은 main.js에서 electron 의존성이 없는 구간만 글자 그대로 잘라낸 것입니다.
// 주석까지 원본 그대로라, 왜 이렇게 짜여 있는지는 전부 원본 주석이 설명합니다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// 데스크톱 앱은 electron의 app.getPath('userData') 아래에 데이터를 두지만, 이 서버는
// electron 없이 맥미니에서 도는 순수 Node 프로세스라 경로를 직접 정한다.
// ⚠️ 이 폴더는 형이 윈도우 PC에서 쓰는 데스크톱 앱의 데이터와 별개다 — 재생목록/재생기록이
// 자동으로 공유되지 않는다는 뜻이고, 동기화 방식은 아직 정해지지 않은 별도 과제다.
const DATA_DIR = process.env.KMUSIC_DATA_DIR || path.join(os.homedir(), '.openclaw', 'kris-music-mobile');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const LYRICS_CACHE_FILE = path.join(DATA_DIR, 'lyrics-cache.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// main.js의 getYtDlpPath는 app.isPackaged로 "설치된 앱 안의 yt-dlp.exe"를 먼저 보는데,
// 서버는 항상 맥미니에서 도니까 그 분기가 의미가 없다. 맥용 후보만 순서대로 확인한다.
let _ytDlpPathCache = null;
function getYtDlpPath() {
  if (_ytDlpPathCache) return _ytDlpPathCache;
  const candidates = [
    process.env.KMUSIC_YTDLP,
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(__dirname, '..', '..', 'bin', 'yt-dlp'),
    'yt-dlp'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      require('child_process').execFileSync(c, ['--version'], { timeout: 5000, stdio: 'ignore' });
      _ytDlpPathCache = c;
      return c;
    } catch {}
  }
  _ytDlpPathCache = 'yt-dlp';
  return _ytDlpPathCache;
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    execFile(bin, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// 데스크톱은 "지금 PC 앞에 앉은 사람"이 곧 활성 계정이라 getActiveAccount() 하나로 충분하지만,
// 서버는 여러 기기가 동시에 붙을 수 있어서 요청마다 어느 계정인지 명시해야 한다(로그인 세션에
// 박힌 accountId). activeAccountId는 서버에서는 아무 의미가 없다.
function getAccountById(accountId) {
  const data = loadAccounts();
  if (!data) return null;
  return data.accounts.find(a => a.id === accountId) || null;
}

// ────────────────────────────────────────────────────────────────────────────────
// 여기부터 main.js에서 그대로 잘라온 구간
// ────────────────────────────────────────────────────────────────────────────────

// ── [저장소(config/playlists/계정/재생기록 로드·저장)] main.js에서 그대로 옮겨옴 ──────────────────────────
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

// ── [가사(lrclib 검색·매칭·캐시)] main.js에서 그대로 옮겨옴 ──────────────────────────
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

// ── [스트림 정보 + 유튜브 검색] main.js에서 그대로 옮겨옴 ──────────────────────────
// Get audio stream URL + metadata for a YouTube URL
// "재생 실패: no supported source" 근본 원인 조사(2026-08-16, 형 신고) — 라이브방송/프리미어성
// 영상은 yt-dlp가 info.url에 HLS(m3u8) 매니페스트 주소를 돌려주는데, 이건 <audio> 태그가
// 네이티브로 재생 못 하는 형식이라 브라우저가 곧바로 "no supported source"를 던진다. 기존
// 재시도(force refetch)는 같은 영상을 다시 받아도 여전히 같은 HLS 주소라 무의미했음 — 이걸
// 미리 감지해서 명확한 에러로 구분해준다(추천곡이 쌓일수록 라이브/프리미어 영상이 섞일 확률이
// 올라가는 것과 패턴이 일치).
// 포맷을 m4a(AAC) 고정으로 바꾼 이유(2026-08-16, yt-dlp 직접 실행 실측):
// 기존 'bestaudio[abr<=192]/bestaudio'는 항상 itag 251(webm/opus)을 골랐는데, opus는
// iOS 18.4 미만 사파리가 아예 재생하지 못한다(모바일 접근을 열면 그대로 재생불가).
// 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio'로 바꾸면 itag 140(m4a/AAC,
// 129.5kbps)이 선택된다 — 실측 3곡(dQw4w9WgXcQ/kJQP7kiw5Fk/9bZkp7q19f0) 전부 251→140,
// abr은 126~131 → 129.5로 사실상 동일해서 음질 손실이 없다. 유튜브가 애초에 130kbps 넘는
// 오디오를 주지 않기 때문에 "고음질" 선택지가 존재하지 않는다(그래서 320k 설정도 제거됨).
// 마지막 fallback으로 순수 bestaudio를 남겨서, m4a가 없는 희귀한 영상에서도 데스크톱
// 재생은 종전대로 되게 한다(그 경우만 opus라 iOS에서만 못 틈).
// quality 인자는 하위호환용으로 시그니처만 남긴다 — 설정 UI가 사라졌고 저장된 옛 값(128 등)이
// 계속 최저음질에 고정시키던 문제가 있었어서, 값을 더 이상 참조하지 않는다.
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio';

async function getStreamInfo(ytUrl, quality = '192') {
  const formatStr = AUDIO_FORMAT;

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
    // 실제로 어떤 컨테이너/코덱이 선택됐는지 — 모바일 프록시가 Content-Type을 정확히 붙이고,
    // 기계 대조(C1: 컨테이너가 m4a인지)가 검사할 수 있게 같이 돌려준다. 데스크톱 렌더러는
    // 이 필드를 읽지 않으므로 기존 동작에 영향이 없다.
    ext: info.ext || '',
    acodec: info.acodec || '',
    filesize: info.filesize || info.filesize_approx || null,
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

// ── [추천 재정렬 엔진(믹스·점수·쿨다운·중복제거·다양성)] main.js에서 그대로 옮겨옴 ──────────────────────────
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

// ── [추천 IPC 본문 → getRecommendations()] main.js에서 그대로 옮겨옴 ──────────────────────────
async function getRecommendations(accountId, seedYtUrl, excludeItems, count) {
  const account = getAccountById(accountId);
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
}

// ── [재생기록 IPC 본문 → recordPlayEvent()] main.js에서 그대로 옮겨옴 ──────────────────────────
function recordPlayEvent(accountId, ytUrl, meta, eventType) {
  const account = getAccountById(accountId);
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
}

// ────────────────────────────────────────────────────────────────────────────────
// 잘라온 구간 끝 — 아래는 생성기가 붙이는 export 목록
// ────────────────────────────────────────────────────────────────────────────────
module.exports = {
  DATA_DIR,
  // 저장소
  loadConfig, saveConfig,
  loadPlaylists, savePlaylists,
  loadLyricsCache, saveLyricsCache,
  writeJsonAtomic,
  uid, hashPin, verifyPin,
  loadAccounts, saveAccounts,
  loadHistory, saveHistory, getActiveAccount, getAccountById,
  // 가사
  LYRICS_MATCHER_VERSION, parseArtistTitle, fetchLyricsFromLrclib, getLyrics,
  // yt-dlp
  getYtDlpPath, ytdlp, getStreamInfo, searchYoutube, AUDIO_FORMAT,
  // 추천 엔진
  extractVideoId, getMixForVideo, enrichItem,
  scoreCandidate, cooldownPenalty, reorderByHistory,
  fetchViewCounts, popularityScore, buildMaxLogByDecade,
  looksLikeSameSong, dedupeSimilarSongs, excludesAsSongList,
  findOverused, partitionOverused, pickDiverseChannels,
  MIX_EXCLUDE_RE, BROADCAST_CHANNEL_RE, LIVE_BROADCAST_RE,
  // main.js의 IPC 핸들러 본문을 그대로 함수로 만든 것
  getRecommendations, recordPlayEvent
};
