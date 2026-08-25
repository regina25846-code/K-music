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
//
// ── 오버라이드 통로(2026-08-18 신설, 임시 성격) ──────────────────────────────
// 데스크톱(main.js)에 넣은 것과 같은 목적이다. 유튜브가 SABR 전용 스트리밍을 켜면서
// yt-dlp 2026.07.04로 뽑은 스트림 주소가 앞쪽 1,000,000바이트까지만 서빙되고 그 뒤는
// 403으로 끊긴다(실측). 모바일에서는 프록시가 그 403을 410으로 바꿔 내려주기 때문에
// 폰에서는 "재생 실패 → 주소 재발급 → 또 실패"가 반복된다.
// yt-dlp 수정(visionos 클라이언트 추가 #17184, 2026-07-09 머지)은 나이틀리에 이미 들어가
// 있고 PO Token 없이 정상 동작하는 걸 확인했지만, 아직 정식 릴리스에는 안 실렸다.
//
// 데스크톱은 앱 재빌드가 필요해서 userData 아래에 통로를 뒀는데, 서버는 원래부터
// KMUSIC_YTDLP 환경변수로 실행파일을 지정할 수 있었다. 여기에 "파일만 떨어뜨리면 되는"
// 경로를 하나 더 추가한다 — DATA_DIR/bin/yt-dlp. 환경변수를 못 건드리는 상황(이미 떠 있는
// 서버를 그대로 두고 다음 재기동 때부터 반영하고 싶을 때)에서 쓰기 위한 것이다.
// 우선순위는 KMUSIC_YTDLP → DATA_DIR/bin/yt-dlp → 기존 시스템 경로 순. 둘 다 없으면
// 예전과 완전히 똑같이 동작한다.
//
// 걷어낼 때: 정식 릴리스가 깔리면 override 파일만 지우면 원복이고, 후보 배열에서 그 한 줄만
// 빼면 이 통로 자체가 사라진다.
//
// 타임아웃을 5초에서 15초로 올린 이유: yt-dlp 공식 단독 실행파일은 PyInstaller onefile이라
// 호출마다 압축을 푸느라 첫 응답이 느리다(맥 실측 8.5초). 5초로 두면 멀쩡한 바이너리를
// 고장난 것으로 오판하고 조용히 다음 후보로 넘어간다. 실행파일이 아예 없는 후보는
// ENOENT로 즉시 실패하므로 이 값이 올라가도 탐색이 느려지지 않는다.
let _ytDlpPathCache = null;
function getYtDlpPath() {
  if (_ytDlpPathCache) return _ytDlpPathCache;
  const candidates = [
    process.env.KMUSIC_YTDLP,
    path.join(DATA_DIR, 'bin', 'yt-dlp'),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(__dirname, '..', '..', 'bin', 'yt-dlp'),
    'yt-dlp'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      require('child_process').execFileSync(c, ['--version'], { timeout: 15000, stdio: 'ignore' });
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

// "ARTIST '곡명' Official MV" 형식 — 국내 대형 기획사/레이블 공식채널(HYBE LABELS, SMTOWN,
// JYP Entertainment 등)이 압도적으로 많이 쓰는 제목 형식인데, 대시도 언더스코어도 없어서
// 아래 구분자 규칙에 안 걸리고 전부 채널명 fallback으로 떨어지고 있었다(2026-08-22 실측:
// 형 재생기록 270곡 중 64%가 채널명 fallback, BTS 곡 26개가 9개의 서로 다른 "가수" 라벨로
// 흩어짐 → 가수 단위 반복방지/쿨다운이 사실상 무력화). 따옴표로 감싼 곡명을 곡 구분자로
// 인정해서 "BTS (방탄소년단) 'Dynamite' Official MV" → 가수 "BTS"로 제대로 뽑아낸다.
//
// 오탐 방지 장치 두 개: ① 여는 따옴표 앞에 반드시 공백이 있어야 한다 — 안 그러면
// "we can't be friends"의 아포스트로피를 따옴표로 오인한다. ② 닫는 따옴표 뒤도 공백이나
// 문장 끝이어야 한다 — "DON'T LEAVE ME"처럼 단어 안에 아포스트로피가 든 경우를 걸러낸다.
const QUOTED_TITLE_RE = /^(\S.*?)\s+['‘"“]([^'’"”]{1,60})['’"”](?:\s|$)/;

function parseArtistTitle(rawTitle, channel) {
  let t = rawTitle
    // 괄호류 전부 제거 (Official Video, MV, Lyrics 등 잡음). 낫표/겹낫표/홑화살괄호는 일본어
    // 표기 재업로드("BTS 「防弾少年団」- ...")에서 흔한데 빠져 있어서 가수명에 그대로 섞여
    // 들어가고 있었다(2026-08-22 실측) — 같이 제거한다.
    .replace(/[\(\[［【][^)\]］】]*[\)\]］】]|[「『《〈][^」』》〉]*[」』》〉]/g, ' ')
    // 괄호가 중첩된 제목("(여자)아이들((G)I-DLE)")은 위 한 번의 치환으로 짝이 안 맞는 닫는
    // 괄호가 남는다 — 남은 건 정의상 짝 없는 잔해라 그냥 지운다.
    .replace(/[)\]］】」』》〉]/g, ' ')
    .replace(/\s*[|｜]\s*.*/g, '') // "| 채널명" 꼬리표 제거
    .replace(/\s+/g, ' ')
    .trim();

  // 따옴표 규칙을 대시/언더스코어보다 먼저 본다 — "TVXQ! 동방신기 '주문 - MIROTIC' MV"처럼
  // 대시가 곡명 안에 들어있는 경우 대시를 먼저 보면 가수가 "TVXQ! 동방신기 '주문"으로 잘리고,
  // "G-DRAGON - '무제(無題)' M/V"는 가수가 "G"로 잘린다(둘 다 형 재생기록에 실제로 그렇게
  // 저장돼 있던 값). 따옴표를 먼저 보면 둘 다 제대로 나온다.
  const qMatch = t.match(QUOTED_TITLE_RE);
  if (qMatch) {
    // "iKON - '사랑을 했다' M/V"처럼 가수 뒤에 구분자가 남는 경우가 있어 꼬리 구분자만 털어낸다.
    const artist = qMatch[1].replace(/[\s\-–—_|:,]+$/, '').trim();
    // 꼬리를 턴 뒤에도 "가수 - 한글곡명" 같은 공백 낀 구분자가 남아있으면, 곡명이 두 번
    // 적힌 제목("BTOB(비투비) - 그리워하다 'Missing You' Official Music Video")이라 따옴표보다
    // 앞쪽 구분자가 진짜 경계다 — 이때만 아래 대시 규칙에 넘긴다. "G-DRAGON"처럼 가수명
    // 자체에 붙어있는 대시(공백 없음)는 여기 안 걸리므로 그대로 유지된다.
    if (artist && !/\s[-–—_]\s/.test(artist)) {
      return { artist, title: qMatch[2].trim().replace(TRAILING_TAG_RE, '').trim() };
    }
  }

  // "ARTIST _ 제목" 형식(1theK 같은 MV 채널이 대시 대신 언더스코어를 구분자로 씀 — 형 실사용 중
  // 발견: "[MV] ZICO(지코) _ Any song?"이 아티스트를 채널명("1theK")으로 잘못 뽑아서 가사 검색이
  // 안 됨, 2026-08-08). 언더스코어는 단어 중간에도 흔히 쓰이니 대시(공백 없어도 매치)와 달리
  // 앞뒤에 공백이 실제로 있을 때만 구분자로 인정해서 오탐을 줄인다.
  // 언더스코어를 대시보다 먼저 본다 — 대시는 공백 없이도 매치돼서 가수명 안에 대시가 든 곡
  // ("T-ARA(티아라) _ Sexy Love")을 "T"로 잘라먹는다(형 재생기록에 실제로 'T'로 저장돼 있었음).
  // 언더스코어 구분자가 있다는 건 그게 진짜 경계라는 뜻이라 먼저 보는 게 항상 맞다.
  const sepMatch = t.match(/^(.+?)\s+_\s+(.+)$/) || t.match(/^(.+?)\s*[-–—]\s*(.+)$/);
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
// "스튜디오:D"(SBS 디지털스튜디오)·"스튜디오 드리밍"은 제목이 "[풀버전] 노래방 헬곡 입장.."
// 처럼 방송 신호 단어가 하나도 없는 예능형 클립이라 위 제목 필터에 안 걸린다. 신예영 편중
// 재발 조사(2026-08-25)에서 시드 믹스 6벌 120칸 중 35칸(29%)을 이 한 채널이 차지하는 걸
// 실측해서 추가 — 곡이 아니라 방송 무대 클립이라 애초에 추천에 들어오면 안 되는 부류다.
const BROADCAST_CHANNEL_RE = /(kbs\s*kpop|sbs\s*kpop|mbc\s*kpop|jtbc\s*music|디티비씨|dj\s*티비씨|스브스|디스패치|텐아시아|예능맛집|어디든\s*가요|스튜디오\s*:\s*d\b|스튜디오\s*드리밍)/i;

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

  // 가수를 제목에서 못 뽑아서 채널명으로 대체된 경우(parseArtistTitle의 fallback), 채널 점수와
  // 가수 점수가 "같은 하나의 대상"을 두 번 세게 된다 — 한 번 재생할 때마다 1.5(채널)+2.5(가수)
  // =4.0점이 붙어서, 정상적으로 가수가 분리되는 곡(채널 1.5 + 다른 가수 2.5로 나뉨)보다 항상
  // 유리해진다. 특히 여러 가수를 한 채널에 올리는 레이블 채널(HYBE LABELS/SMTOWN/JYP 등)에서는
  // 소속 가수 전원의 재생이 한 덩어리로 쌓인 뒤 4.0배로 증폭돼서, 그 레이블 곡이 어떤 믹스에
  // 끼어들든 무조건 1등이 되는 "블랙홀"이 된다(2026-08-22 실측: HYBE LABELS 후보 36.0점 vs
  // 같은 기록으로 채점한 AKMU 믹스 최고 20.5점, Ariana Grande 믹스 최고 4.0점 — 2~9배).
  // 같은 대상이면 한 번만, 더 강한 신호인 가수 가중치로 센다.
  const chNorm = (item.channel || '').replace(/\s*-\s*Topic$/i, '').trim();
  const artistIsChannel = !!item.artist && item.artist === chNorm;

  if (ch && !artistIsChannel) {
    score += (ch.playCount || 0) * 1.5;
    score -= (ch.skipCount || 0) * 1.5;
    score += (ch.favoriteCount || 0) * 5;
  }

  const ar = item.artist && history.artists?.[item.artist];
  if (ar) {
    score += (ar.playCount || 0) * 2.5;
    score -= (ar.skipCount || 0) * 2;
    score += (ar.favoriteCount || 0) * 6;
  } else if (ch && artistIsChannel) {
    // 가수 집계가 아직 없는 채널(=이 채널 곡을 처음 듣는 중)은 채널 집계만 있으므로 그건 그대로 센다.
    score += (ch.playCount || 0) * 1.5;
    score -= (ch.skipCount || 0) * 1.5;
    score += (ch.favoriteCount || 0) * 5;
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

// ── 가수 신원(같은 사람인지) 판정 ─────────────────────────────────────────────
// 2026-08-25 신설. 2026-08-22에 고친 건 "대형 레이블 채널의 따옴표 제목"이라는 갈래 하나뿐이었고,
// 같은 가수가 여러 라벨로 흩어지는 경로가 그것 말고도 최소 세 개 더 있다는 게 신예영 편중
// 재발(형 리포트)로 드러났다. 시드 "신예영 - 기억속의 먼 그대에게"(Municon_Official)의 실제
// 믹스 6벌을 받아서 확인한 갈래들:
//   ① 로마자/한글 표기 분리 — "신예영"(Municon_Official) vs "Sin Ye Young"(1theK)
//   ② 자동생성 아티스트 채널이 한글+로마자를 병기 — "신예영 SIN YE YOUNG"
//   ③ 합작곡 제목 — "순순희(기태), 신예영 - 결혼" → 가수 문자열이 "순순희 , 신예영"
// 이 셋 때문에 pickDiverseChannels/findOverused의 "가수 문자열 완전일치" 비교가 통째로 뚫려서,
// 형이 곡을 누른 직후 채워지는 첫 큐 3곡이 서로 다른 채널·다른 라벨의 같은 가수로 채워졌다
// (실측: 믹스 6벌 × 3곡 = 18칸 중 10칸이 신예영, 55.6%).
//
// 그래서 가수를 문자열 하나로 보지 않고 "신원 키 여러 개"로 본다. 한 이름 안에 한글 덩어리와
// 로마자 덩어리가 같이 있으면(②) 그 둘은 같은 사람을 가리키는 다른 표기이므로 서로 이어붙이고
// (union-find), 그렇게 배운 별칭 관계 덕에 ①이 자동으로 연결된다. 합작곡(③)은 구분자로 갈라서
// 각각 다른 사람으로 세되, 아이템 하나가 여러 신원을 동시에 갖게 둔다(그 곡은 두 사람 모두의 곡).
//
// ⚠️ 재생기록(history.artists)의 키는 손대지 않는다 — 이미 갈라진 채로 쌓여 있는 기록을
// 마이그레이션하는 건 별개 문제이고, 잘못 합치면 점수가 통째로 뒤틀린다(2026-08-22에도 같은
// 이유로 안 건드리기로 했음). 여기서 만드는 신원 키는 "다양성/반복방지 비교"에서만 쓴다.

// 채널·레이블 브랜딩 단어는 신원 키가 될 수 없다 — 이런 게 키로 남으면 "OFFICIAL"만 겹쳐도
// 서로 다른 가수가 한 사람으로 합쳐진다.
const ARTIST_KEY_STOPWORDS = new Set([
  'official', 'officialchannel', 'channel', 'music', 'musictv', 'tv', 'entertainment', 'ent',
  'records', 'record', 'label', 'labels', 'studio', 'studios', 'media', 'company', 'group',
  'kpop', 'topic', 'vevo', 'mv', 'lyrics', 'lyric', 'audio', 'video', 'live', 'shorts',
  'cover', 'band', 'crew', 'project', 'production', 'productions', 'the'
]);

// 합작곡 한 곡에 여러 사람이 적혀 있으면 각각 다른 사람으로 가른다. 'X'/'x'는 구분자로 쓰기
// 위험해서(가수명 안에 흔히 들어감) 뺐다.
const PERFORMER_SPLIT_RE = /\s*(?:,|、|&|＆|\+|\/|\bfeat\.?|\bft\.?|\bwith\b|×|✕)\s*/i;
function splitPerformers(name) {
  return String(name || '').split(PERFORMER_SPLIT_RE).map(s => s.trim()).filter(Boolean);
}

// 이름 하나를 "표기 덩어리"로 쪼갠다. 글자 종류(한글/로마자/일본어·한자)가 바뀌는 곳이 경계고,
// 같은 종류끼리는 띄어쓰기를 넘어 하나로 붙인다 — "신예영 SIN YE YOUNG" → ['신예영','sinyeyoung'],
// "박혜원HYNN" → ['박혜원','hynn'], "Sin Ye Young" → ['sinyeyoung'].
// 각 덩어리에 그 덩어리가 한글인지 로마자인지(script)를 같이 달아준다 — 별칭으로 이어붙일지
// 판단하는 데 쓴다.
const IDENTITY_RUN_RE = /[가-힣]+|[A-Za-z][A-Za-z0-9'’]*|[぀-ヿ一-鿿]+/g;
function identitySegments(name) {
  const runs = String(name || '').match(IDENTITY_RUN_RE) || [];
  const groups = [];
  let cur = null, curScript = null;
  for (const run of runs) {
    const k = run.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!k || ARTIST_KEY_STOPWORDS.has(k)) { cur = null; curScript = null; continue; }
    const script = /[가-힣]/.test(k) ? 'ko' : /[a-z]/.test(k) ? 'la' : 'cjk';
    if (cur && script === curScript) cur.parts.push(k);
    else { cur = { script, parts: [k] }; curScript = script; groups.push(cur); }
  }
  const out = [];
  const seen = new Set();
  for (const g of groups) {
    const key = g.parts.join('');
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, script: g.script });
  }
  return out;
}

// 제목에서 "가수 자리"만 원문 그대로(괄호를 지우지 않고) 떼어낸다. parseArtistTitle은 괄호를
// 먼저 지워버려서 "Sin Ye Young(신예영)"의 한글 표기를 잃는데, 바로 그 괄호 안이 한글↔로마자를
// 이어주는 가장 확실한 단서다. 여기서 뽑은 건 별칭 학습에만 쓰고 신원 키 자체로는 안 쓴다.
// 길이 제한: 진짜 가수 자리는 짧다. 방송클립 제목처럼 문장이 통째로 들어오면 엉뚱한 이름끼리
// 이어붙을 수 있어서 아예 안 배운다.
const RAW_ARTIST_REGION_MAX = 40;
function rawArtistRegion(rawTitle) {
  const t = String(rawTitle || '')
    .replace(/\s*[|｜]\s*.*/, '')
    .replace(/^\s*[\[［【][^\]］】]*[\]］】]\s*/, ' ')
    .trim();
  const m = t.match(/^(.+?)\s+_\s+/) || t.match(/^(.+?)\s+['‘"“]/) || t.match(/^(.+?)\s*[-–—]\s*/);
  const region = m ? m[1].trim() : '';
  return region.length && region.length <= RAW_ARTIST_REGION_MAX ? region : '';
}

// 추천 호출 한 번 동안만 쓰는 "가수 신원 색인". 이름을 볼 때마다 별칭 관계를 배우고(union-find),
// 두 아이템이 같은 사람인지 물어보면 그 시점의 최신 관계로 판정한다.
// ⚠️ 저장은 항상 "원시 키"로 하고 비교할 때 대표값(root)을 매번 다시 구한다 — 나중에 배운
// 별칭 때문에 대표값이 바뀌어도 예전에 담아둔 집합이 어긋나지 않게 하기 위함이다.
function makeArtistIndex() {
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.has(c) && parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    if (!parent.has(k)) parent.set(k, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const learned = new Set();
  // 한 사람 이름 안에서 "한글 덩어리 ↔ 로마자 덩어리"만 별칭으로 이어붙인다. 같은 글자 종류끼리
  // 이어붙이면 "허각X민서"처럼 서로 다른 두 사람이 한 사람으로 합쳐진다(실측 위험 케이스).
  const learnName = (name) => {
    if (!name || learned.has(name)) return;
    learned.add(name);
    for (const performer of splitPerformers(name)) {
      const segs = identitySegments(performer);
      const ko = segs.filter(s => s.script === 'ko');
      const other = segs.filter(s => s.script !== 'ko');
      for (const s of segs) find(s.key);
      if (ko.length === 1 && other.length === 1) union(ko[0].key, other[0].key);
    }
  };
  const learnItem = (it) => {
    if (!it) return;
    learnName(it.artist || '');
    learnName(it.channel || '');
    learnName(rawArtistRegion(it.title || ''));
  };
  // 아이템의 신원 키(원시 키 배열). 가수를 못 뽑아서 채널명으로 대체된 경우엔 예전과 똑같이
  // 채널명이 그대로 신원이 된다.
  const keysOf = (it) => {
    if (!it) return [];
    learnItem(it);
    const artist = it.artist || parseArtistTitle(it.title || '', it.channel || '').artist;
    const out = [];
    for (const performer of splitPerformers(artist)) {
      for (const s of identitySegments(performer)) if (!out.includes(s.key)) out.push(s.key);
    }
    return out;
  };
  const overlaps = (keysA, keysB) => {
    if (!keysA?.length || !keysB?.length) return false;
    const roots = new Set();
    for (const k of keysA) roots.add(find(k));
    for (const k of keysB) if (roots.has(find(k))) return true;
    return false;
  };
  return { find, learnName, learnItem, keysOf, overlaps };
}

// 재생기록에 있는 제목/채널을 전부 한 번 읽혀서 별칭을 미리 배우게 한다. 후보 목록 안에만
// 단서가 있으면 "이예준"(한글 채널)과 "Lee Yejoon - Topic"(로마자 채널)처럼 이어줄 다리가
// 없어서 따로 놀지만, 형이 예전에 들은 곡 중에 "이예준(Lee Ye Joon) - ..."처럼 두 표기를 같이
// 쓴 제목이 하나라도 있으면 그걸로 이어진다. 이름만 읽는 거라 점수/기록은 전혀 안 건드린다.
function learnHistoryAliases(history, idx) {
  for (const t of Object.values(history?.tracks || {})) idx.learnItem(t);
}

// "최근 자동추천 10곡" 창(=pruneOldAutoTracks가 유지하는 범위, 렌더러가 넘겨준 전체 재생목록
// 중 source==='auto'인 것들) 안에 같은 채널/가수 곡이 1곡이라도 이미 있으면 "질렸다"고 보고
// 새 추천에서 아예 제외한다 — 다른 후보가 진짜 하나도 없을 때만 최후 수단으로 허용
// (형 요청, 2026-08-08: "10개 연속된 것 중에서는 겹치는 게 없게" — 처음엔 3개까지 봐주고
// 순서만 뒤로 미는 느슨한 버전이었는데, 형이 직접 1개 기준 + 완전 제외로 강화 요청함. 영구
// 차단은 아니고 그 곡이 최근 10곡 창에서 밀려나면 자연히 다시 추천 후보로 돌아온다).
const OVERUSE_CAP = 1;
function findOverused(excludeItems, idx = makeArtistIndex()) {
  const recentAuto = (excludeItems || []).filter(x => x && x.source === 'auto');
  const channelCounts = {};
  const artistKeyCounts = new Map();
  for (const x of recentAuto) {
    if (x.channel) channelCounts[x.channel] = (channelCounts[x.channel] || 0) + 1;
    for (const k of idx.keysOf(x)) artistKeyCounts.set(k, (artistKeyCounts.get(k) || 0) + 1);
  }
  return {
    channels: new Set(Object.keys(channelCounts).filter(c => channelCounts[c] >= OVERUSE_CAP)),
    // 가수는 문자열이 아니라 신원 키로 담는다(같은 사람의 다른 표기까지 함께 걸리도록).
    artistKeys: [...artistKeyCounts.keys()].filter(k => artistKeyCounts.get(k) >= OVERUSE_CAP)
  };
}
// findOverused는 "최근 자동추천에 한 번이라도 나왔으면" 전부 잡는다 — 후보를 걸러내는 용도로는
// 그게 맞지만, 시드를 고르는 데 그대로 쓰면 재생목록 안의 곡이 거의 다 걸러져서 섞을 시드를
// 아예 못 찾는다(2026-08-22 재즈 재생목록 실측: 안정 시드 발동 0회). 시드를 고를 때는 "실제로
// 도배 중인" 것만 피하면 되므로, 최근 창에서 일정 비율 이상을 차지한 채널/가수만 추려낸다.
function findDominant(excludeItems, minShare = 0.34, idx = makeArtistIndex()) {
  const recentAuto = (excludeItems || []).filter(x => x && x.source === 'auto');
  const empty = { channels: new Set(), artistKeys: [] };
  if (recentAuto.length < 3) return empty;
  const chC = {};
  // 1차: 이름을 전부 먼저 읽혀서 별칭 관계를 다 배우게 한다. 배우는 도중에 대표값이 바뀌므로
  // 세는 건 그 다음에 해야 "같은 사람의 다른 표기"가 한 덩어리로 집계된다.
  const keysByItem = recentAuto.map(x => idx.keysOf(x));
  const itemsByRoot = new Map();  // 대표값 → 그 사람 곡의 개수
  const keysByRoot = new Map();   // 대표값 → 그 사람의 원시 키들
  recentAuto.forEach((x, i) => {
    if (x.channel) chC[x.channel] = (chC[x.channel] || 0) + 1;
    const roots = new Set(keysByItem[i].map(idx.find));
    for (const r of roots) itemsByRoot.set(r, (itemsByRoot.get(r) || 0) + 1);
    for (const k of keysByItem[i]) {
      const r = idx.find(k);
      if (!keysByRoot.has(r)) keysByRoot.set(r, new Set());
      keysByRoot.get(r).add(k);
    }
  });
  const need = Math.max(2, Math.ceil(recentAuto.length * minShare));
  const artistKeys = [];
  for (const [r, n] of itemsByRoot) {
    if (n < need) continue;
    for (const k of (keysByRoot.get(r) || [])) if (!artistKeys.includes(k)) artistKeys.push(k);
  }
  return {
    channels: new Set(Object.keys(chC).filter(k => chC[k] >= need)),
    artistKeys
  };
}

function partitionOverused(ranked, overused, idx = makeArtistIndex()) {
  const fresh = [], stale = [];
  for (const it of ranked) {
    const over = (it.channel && overused.channels.has(it.channel))
      || idx.overlaps(overused.artistKeys, idx.keysOf(it));
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
// preUsed: 이 호출 전에 이미 뽑아둔 곡들(구조요청으로 두 번 나눠 뽑을 때) — 그것들과 채널/가수가
// 겹치지 않게 하고, 같은 곡이 두 번 들어가지도 않게 한다. 예전엔 두 번째 호출이 첫 번째 결과를
// 몰라서 같은 가수가 다시 뽑힐 수 있었다.
// allowLeftover: false면 "겹치더라도 개수는 채운다"는 마지막 보정을 하지 않고, 다양성 조건을
// 만족하는 만큼만 돌려준다. 이게 중요한 이유(2026-08-25) — 예전엔 이 함수가 어떻게든 need만큼
// 채워서 돌려주는 바람에, 호출부의 "모자라면 다른 시드로 구조요청" 분기가 사실상 발동하지
// 않았다. 믹스가 통째로 한 가수인 최악의 경우에 그 한 가수로 3칸이 다 채워지고 구조요청은
// 건너뛰어지던 게 방탄 13연속·신예영 도배의 마지막 통로였다.
function pickDiverseChannels(ranked, need, idx = makeArtistIndex(), preUsed = [], allowLeftover = true) {
  const picked = [];
  const usedChannels = new Set();
  const usedArtistKeys = [];
  const usedIds = new Set();
  const leftover = [];
  for (const p of preUsed) {
    if (!p) continue;
    if (p.id) usedIds.add(p.id);
    if (p.channel) usedChannels.add(p.channel);
    for (const k of idx.keysOf(p)) if (!usedArtistKeys.includes(k)) usedArtistKeys.push(k);
  }
  for (const it of ranked) {
    if (picked.length >= need) break;
    if (it.id && usedIds.has(it.id)) continue;
    const ch = it.channel || '';
    const keys = idx.keysOf(it);
    if ((ch && usedChannels.has(ch)) || idx.overlaps(usedArtistKeys, keys)) { leftover.push(it); continue; }
    picked.push(it);
    if (it.id) usedIds.add(it.id);
    if (ch) usedChannels.add(ch);
    for (const k of keys) if (!usedArtistKeys.includes(k)) usedArtistKeys.push(k);
  }
  if (!allowLeftover) return picked;
  for (const it of leftover) {
    if (picked.length >= need) break;
    picked.push(it);
  }
  return picked;
}

// 시드 하나로 "유튜브 믹스 → 필터 → 취향순 정렬 → 중복제거" 까지 돌려서 후보 목록을 만든다.
// (아래 구조요청 시드와 본 시드가 완전히 같은 처리를 거치도록 함수로 분리, 2026-08-22)
async function buildRankedCandidates(seedId, history, excludeItems, cfg) {
  const mix = (await getMixForVideo(seedId, 20))
    .filter(it => !MIX_EXCLUDE_RE.test(it.title) && !BROADCAST_CHANNEL_RE.test(it.channel))
    .map(enrichItem);
  const exclude = new Set((excludeItems || []).map(x => x?.id).filter(Boolean));
  const alreadyQueued = excludesAsSongList(excludeItems);
  let ranked = reorderByHistory(mix, history).filter(it => !exclude.has(it.id));
  ranked = dedupeSimilarSongs(ranked);
  ranked = ranked.filter(it => !alreadyQueued.some(ex => looksLikeSameSong(it, ex, true)));

  // 조회수 인기도 가산점 — 사용자가 설정에서 유튜브 API 키를 넣어둔 경우에만 시도.
  // 후보가 이미 20개 이하로 추려진 상태라 배치 1회 호출로 전부 조회 가능(50개까지 배치 지원).
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
  return ranked;
}

// ── 안정 시드(anchor) 고르기 ───────────────────────────────────────────────────
// 유튜브 믹스(watch?v=X&list=RDX)는 X가 특정 가수의 공식채널 영상이면 사실상 그 가수 곡으로만
// 채워진다(2026-08-22 실측: BANGTANTV 곡을 시드로 주면 후보 19개 전부 BANGTANTV, HYBE LABELS
// 시드는 19개 중 17개가 BTS 계열). 그런데 시드는 "지금 재생 중인 곡"이고, 추천된 곡이 다시
// 재생되면 그게 다음 시드가 되므로 — 한 번 특정 가수 곡이 걸리는 순간 후보 풀 자체가 그
// 가수로만 채워져서 아래 다양성 장치들이 "고를 게 그것뿐"인 상태가 되고, 그 뒤로는 영원히
// 빠져나오지 못한다(형 실제 재생기록 2026-08-22 06:20~07:13 구간에서 BTS 13곡 연속 확인).
//
// 그래서 "지금 재생 중인 곡" 말고 기댈 수 있는 다른 시드를 하나 고른다. 두 군데서 쓴다:
//   ① 렌더러가 큐를 채울 때 일부 칸에 섞어 쓰는 시드(app.js maybeExtendQueue)
//   ② 후보가 전부 도배 대상이라 fresh가 0이 된 막다른 상태의 구조요청(아래 get-recommendations)
//
// ⚠️ 이건 2026-08-08에 폐기한 "체이닝"과 원리적으로 다르다. 그때 문제는 직전에 추천된 곡을
// 다음 시드로 삼아서 시드가 한 걸음씩 옮겨가는 구조였고, 그래서 세대를 거칠수록 원곡에서
// 멀어졌다(풀하우스 OST → 몇 단계 만에 인도네시아 밴드). 여기 후보 풀은 "형이 실제로 끝까지
// 들은 곡 + 형이 직접 재생목록에 넣은 곡"이라는 고정된 집합이고, 매번 그 집합에서 이전 선택과
// 무관하게 독립적으로 뽑는다 — 선택이 이전 선택에 의존하지 않으므로 누적 드리프트(랜덤워크)가
// 성립할 수 없다. 시드가 멀리 가는 게 아니라 매번 형 취향의 원점으로 되돌아온다.
//
// minIdleHours: 이 시간 안에 재생된 곡은 시드에서 제외(같은 자리로 되돌아가는 것 방지).
// skipIds: 시드로 쓰면 안 되는 영상 id(구조요청은 재생목록 전체, 평상시 섞기는 현재 곡만).
// poolIds: 주면 이 id들 안에서만 고른다.
//   ⚠️ 평상시 섞기에서 이게 핵심이다. 재생기록 전체에서 고르면 "지금 듣고 있는 결"이 통째로
//   날아간다 — 재즈 재생목록(Diana Krall)에서 실측했더니 9곡이 전부 케이팝으로 바뀌어버렸다
//   (형 기록의 대부분이 케이팝이라 그쪽이 뽑힐 수밖에 없음, 2026-08-22). 그래서 평상시에는
//   "지금 재생 중인 그 재생목록 안"으로 후보를 가둔다 — 재즈 목록이면 재즈에서, 가요 목록이면
//   가요에서 나온다. 반대로 목록 전체가 한 가수로 도배돼 탈출이 급한 구조요청에서는 결을
//   지키는 것보다 빠져나오는 게 우선이라 poolIds 없이(=기록 전체에서) 고른다.
function pickAnchorSeed(history, overused, opts = {}) {
  const { minIdleHours = 6, skipIds = null, poolIds = null, idx = makeArtistIndex() } = opts;
  const now = Date.now();

  // 형이 손으로 직접 재생목록에 넣은 곡 — 가장 확실한 취향 신호라 가중치를 크게 준다.
  const manualIds = new Set();
  try {
    for (const pl of (loadPlaylists() || [])) {
      for (const t of (pl?.tracks || [])) {
        if ((t.source || 'manual') !== 'manual') continue;
        const v = extractVideoId(t.ytUrl || '');
        if (v) manualIds.add(v);
      }
    }
  } catch { /* 재생목록을 못 읽어도 재생기록만으로 충분히 고를 수 있다 */ }

  const cands = [];
  for (const [id, t] of Object.entries(history.tracks || {})) {
    if (!id || t.blocked) continue;
    if (skipIds && skipIds.has(id)) continue;
    if (poolIds && !poolIds.has(id)) continue;
    if (!t.completeCount && !t.favorite && !manualIds.has(id)) continue; // 취향이 확실한 곡만
    if (t.channel && overused.channels.has(t.channel)) continue; // 지금 도배 중인 채널/가수는 탈출로가 못 됨
    if (idx.overlaps(overused.artistKeys, idx.keysOf(t))) continue; // 표기가 달라도 같은 사람이면 탈출로가 아님
    if (history.channels?.[t.channel]?.blocked) continue;
    const ageH = t.lastPlayedAt ? (now - Date.parse(t.lastPlayedAt)) / 3600e3 : 9999;
    if (ageH < minIdleHours) continue;
    cands.push({ id, weight: 1 + (t.completeCount || 0) + (t.favorite ? 3 : 0) + (manualIds.has(id) ? 4 : 0) });
  }
  if (!cands.length) return null;

  // 상위 몇 곡만 놓고 뽑으면 매번 같은 곡으로 탈출해서 이번엔 그 가수로 도배된다. 가중치에
  // 비례한 확률로 풀 전체에서 뽑아, 취향이 확실한 곡을 우선하면서도 매번 다른 곳으로 나가게 한다.
  let total = 0;
  for (const c of cands) total += c.weight;
  let r = Math.random() * total;
  for (const c of cands) { r -= c.weight; if (r <= 0) return c.id; }
  return cands[cands.length - 1].id;
}

// ── [안정 시드 IPC 본문 → getAnchorSeed()] main.js에서 그대로 옮겨옴 ──────────────────────────
function getAnchorSeed(accountId, excludeItems, currentSeedId) {
  const account = getAccountById(accountId);
  if (!account) return null;
  try {
    const history = loadHistory(account.id);
    const skipIds = new Set();
    if (currentSeedId) skipIds.add(currentSeedId);
    // 후보는 "지금 재생 중인 그 재생목록 안"으로만 한정한다(위 pickAnchorSeed 주석의 재즈 사례).
    const poolIds = new Set((excludeItems || []).map(x => x?.id).filter(Boolean));

    // 도배 중인 채널/가수는 피하고, 거기에 "지금 재생 중인 곡"의 채널/가수도 반드시 더한다 —
    // 빠져나오려는 게 바로 그 갈래라서, 같은 가수에서 다시 출발하면 섞는 의미가 없다.
    const idx = makeArtistIndex();
    learnHistoryAliases(history, idx);
    const avoid = findDominant(excludeItems, 0.34, idx);
    const cur = (excludeItems || []).find(x => x?.id === currentSeedId);
    if (cur) {
      if (cur.channel) avoid.channels.add(cur.channel);
      for (const k of idx.keysOf(cur)) if (!avoid.artistKeys.includes(k)) avoid.artistKeys.push(k);
    }

    const id = pickAnchorSeed(history, avoid, { minIdleHours: 0.5, skipIds, poolIds, idx });
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}

// ── [추천 IPC 본문 → getRecommendations()] main.js에서 그대로 옮겨옴 ──────────────────────────
async function getRecommendations(accountId, seedYtUrl, excludeItems, count) {
  const account = getAccountById(accountId);
  if (!account) return [];
  const seedId = extractVideoId(seedYtUrl);
  if (!seedId) return [];
  try {
    const history = loadHistory(account.id);
    const cfg = loadConfig();
    const ranked = await buildRankedCandidates(seedId, history, excludeItems, cfg);

    const need = count || 3;
    // 신원 색인은 이 호출 안에서 한 벌만 만들어 아래 전부가 같은 별칭 관계를 보게 한다.
    const idx = makeArtistIndex();
    learnHistoryAliases(history, idx);
    const overused = findOverused(excludeItems, idx);
    const { fresh, stale } = partitionOverused(ranked, overused, idx);
    // 1차는 엄격하게 — 같은 채널/같은 가수를 두 번 뽑느니 개수가 모자란 채로 둔다. 모자란 칸은
    // 아래에서 "다른 시드로 구조요청"으로 채운다(형이 곡을 누른 직후 채워지는 첫 3칸이 전부 같은
    // 가수가 되던 신예영 도배가 정확히 이 지점에서 생겼다, 2026-08-25).
    let picks = pickDiverseChannels(fresh, need, idx, [], false);

    // 이 시드의 믹스가 통째로 한 가수(또는 최근 도배 중인 그 가수)라 쓸 만한 후보가 모자란 경우 —
    // 예전엔 곧바로 같은 가수 곡으로 채워버려서 도배가 스스로 영속했다.
    if (picks.length < need) {
      const rescueId = pickAnchorSeed(history, overused, {
        minIdleHours: 6,
        skipIds: new Set((excludeItems || []).map(x => x?.id).filter(Boolean)),
        idx
      });
      if (rescueId) {
        try {
          const rescueRanked = await buildRankedCandidates(rescueId, history, excludeItems, cfg);
          const rescueFresh = partitionOverused(rescueRanked, overused, idx).fresh;
          const already = new Set(picks.map(p => p.id));
          for (const it of pickDiverseChannels(rescueFresh, need - picks.length, idx, picks, false)) {
            if (!already.has(it.id)) { picks.push(it); already.add(it.id); }
          }
        } catch { /* 구조요청 실패는 조용히 무시하고 아래 기존 폴백으로 */ }
      }
    }

    // 구조요청까지 해도 모자라면 그때는 예전처럼 겹치는 것이라도 채운다 — 큐가 비어서 재생이
    // 멎는 것보다는 낫다. 이미 뽑은 곡/가수는 preUsed로 넘겨서 최소한 순서상 뒤로 밀리게 한다.
    if (picks.length < need) {
      picks = picks.concat(pickDiverseChannels(fresh, need - picks.length, idx, picks));
    }
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
  findOverused, findDominant, partitionOverused, pickDiverseChannels, learnHistoryAliases,
  // 가수 신원(같은 사람인지) 판정 — 2026-08-25 신설
  makeArtistIndex, identitySegments, splitPerformers, rawArtistRegion, ARTIST_KEY_STOPWORDS,
  MIX_EXCLUDE_RE, BROADCAST_CHANNEL_RE, LIVE_BROADCAST_RE,
  pickAnchorSeed, buildRankedCandidates,
  // main.js의 IPC 핸들러 본문을 그대로 함수로 만든 것
  getAnchorSeed, getRecommendations, recordPlayEvent
};
