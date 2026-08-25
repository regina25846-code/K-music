#!/usr/bin/env node
// K-Music 모바일 — 공용 엔진(lib/core.js) 생성기
//
// 왜 "생성"하는가(2026-08-16):
// 모바일 서버가 필요로 하는 로직(yt-dlp 호출, 검색 필터, 가사 매칭, 추천 재정렬, 재생기록
// 집계)은 전부 main.js 안에 이미 있고, 그 하나하나가 형의 실사용 리포트로 몇 번씩 다듬어진
// 대단히 예민한 코드다. 이걸 손으로 베껴 쓰면 베끼는 순간부터 두 벌이 갈라지기 시작하고,
// 나중에 main.js만 고쳤을 때 모바일에서만 옛날 추천이 나오는 식으로 조용히 어긋난다.
//
// 그래서 "손으로 옮기지 않고" main.js에서 해당 구간을 글자 그대로 잘라내 lib/core.js를
// 만들어낸다. 잘라낸 구간에 electron 의존성이 하나도 없기 때문에 가능한 방식이다
// (electron이 필요한 부분 — 창/트레이/자동업데이트/파일경로 — 은 애초에 잘라내는 구간
// 밖에 있고, 데이터 경로만 아래 PREAMBLE에서 서버용으로 새로 정의한다).
//
// ⚠️ 이건 어디까지나 "main.js를 건드리지 않기 위한" 임시 구조다. 최종적으로는 main.js가
// 거꾸로 이 core.js를 require해서 한 벌만 남기는 게 맞는데, 그건 데스크톱 앱 본체를 크게
// 뜯는 변경이라 형 컨펌을 따로 받아야 하는 별도 단계다. 그때까지는 아래 --check 모드를
// 배포 게이트에 걸어서 "main.js가 바뀌었는데 core.js가 안 따라온" 상태를 기계가 잡아낸다.
//
// 사용법:
//   node mobile/build_core.js          # lib/core.js 생성(덮어쓰기)
//   node mobile/build_core.js --check  # 현재 lib/core.js가 main.js와 일치하는지만 검사

const fs = require('fs');
const path = require('path');

const MAIN_JS = path.join(__dirname, '..', 'main.js');
const OUT = path.join(__dirname, 'lib', 'core.js');

// main.js 안에서 잘라낼 구간. 각 마커는 main.js 전체에서 "정확히 한 번만" 나와야 하고,
// 하나라도 어긋나면 조용히 이상한 코드를 만들어내는 대신 즉시 실패한다.
const SECTIONS = [
  {
    name: '저장소(config/playlists/계정/재생기록 로드·저장)',
    from: 'function loadConfig() {',
    to: '// ── 가사(lrclib.net) ─'
  },
  {
    name: '가사(lrclib 검색·매칭·캐시)',
    from: '// ── 가사(lrclib.net) ─',
    to: '// yt-dlp binary path'
  },
  {
    name: '스트림 정보 + 유튜브 검색',
    from: '// Get audio stream URL + metadata for a YouTube URL',
    to: '// ── 추천 재정렬(개인화 믹스)'
  },
  {
    name: '추천 재정렬 엔진(믹스·점수·쿨다운·중복제거·다양성)',
    from: '// ── 추천 재정렬(개인화 믹스)',
    to: 'let mainWin = null;'
  },
  // 아래 둘은 main.js에서 ipcMain.handle(...) 안에 직접 들어있는 본문이다. 껍데기만
  // 일반 함수로 바꿔서 가져온다 — 알맹이(추천 파이프라인 순서, 스킵 회계 규칙)는 여전히
  // main.js 원본 그대로라, 형이 나중에 main.js에서 추천 규칙을 고치면 여기도 같이 따라온다.
  // "활성 계정"을 보는 방식만 바꾼다: 데스크톱은 PC 앞에 앉은 사람이 곧 활성 계정이지만,
  // 서버는 여러 기기가 동시에 붙을 수 있어서 전역 활성계정을 보면 요청끼리 섞인다 —
  // 로그인 세션에 박힌 accountId로 대체한다.
  {
    name: '안정 시드 IPC 본문 → getAnchorSeed()',
    from: "ipcMain.handle('get-anchor-seed', (_, excludeItems, currentSeedId) => {",
    to: '// ── 추천 IPC ─',
    transform: [
      [
        "ipcMain.handle('get-anchor-seed', (_, excludeItems, currentSeedId) => {",
        'function getAnchorSeed(accountId, excludeItems, currentSeedId) {'
      ],
      ['const account = getActiveAccount();', 'const account = getAccountById(accountId);'],
      [/\}\);\s*$/, '}\n']
    ]
  },
  {
    name: '추천 IPC 본문 → getRecommendations()',
    from: "ipcMain.handle('get-recommendations', async (_, seedYtUrl, excludeItems, count) => {",
    to: "// eventType: 'play' | 'complete' | 'skip'.",
    transform: [
      [
        "ipcMain.handle('get-recommendations', async (_, seedYtUrl, excludeItems, count) => {",
        'async function getRecommendations(accountId, seedYtUrl, excludeItems, count) {'
      ],
      ['const account = getActiveAccount();', 'const account = getAccountById(accountId);'],
      [/\}\);\s*$/, '}\n']
    ]
  },
  {
    name: '재생기록 IPC 본문 → recordPlayEvent()',
    from: "ipcMain.handle('record-play-event', (_, ytUrl, meta, eventType) => {",
    to: "ipcMain.handle('get-stream'",
    transform: [
      [
        "ipcMain.handle('record-play-event', (_, ytUrl, meta, eventType) => {",
        'function recordPlayEvent(accountId, ytUrl, meta, eventType) {'
      ],
      ['const account = getActiveAccount();', 'const account = getAccountById(accountId);'],
      [/\}\);\s*$/, '}\n']
    ]
  }
];

// core.js가 electron 없이 혼자 돌기 위해 필요한 것들. main.js에서 잘라낸 구간이 참조하는
// 심볼 중 electron에 묶여 있던 것(데이터 폴더 경로, yt-dlp 실행파일 경로)만 여기서 새로 정의한다.
const PREAMBLE = `// ⚠️ 이 파일은 자동 생성됩니다 — 직접 고치지 마세요.
// 생성기: mobile/build_core.js  (원본: main.js)
// 고쳐야 할 내용이 있으면 main.js를 고치고 \`node mobile/build_core.js\`를 다시 돌리세요.
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
`;

const POSTAMBLE = `
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
`;

function extract(src) {
  const parts = [];
  for (const sec of SECTIONS) {
    const fromCount = src.split(sec.from).length - 1;
    const toCount = src.split(sec.to).length - 1;
    if (fromCount !== 1) {
      throw new Error(`[${sec.name}] 시작 마커가 main.js에 ${fromCount}번 나옵니다(1번이어야 함): ${sec.from}`);
    }
    if (toCount !== 1) {
      throw new Error(`[${sec.name}] 끝 마커가 main.js에 ${toCount}번 나옵니다(1번이어야 함): ${sec.to}`);
    }
    const a = src.indexOf(sec.from);
    const b = src.indexOf(sec.to);
    if (b <= a) throw new Error(`[${sec.name}] 끝 마커가 시작 마커보다 앞에 있습니다`);
    let slice = src.slice(a, b).replace(/\s+$/, '') + '\n';
    for (const [pattern, replacement] of sec.transform || []) {
      const before = slice;
      slice = slice.replace(pattern, replacement);
      // 치환이 하나도 안 먹었다면 원본 구조가 바뀐 것이다 — 조용히 깨진 코드를 뱉는 대신 멈춘다.
      if (slice === before) {
        throw new Error(`[${sec.name}] 치환 실패(원본 구조가 바뀐 듯): ${pattern}`);
      }
    }
    parts.push(`\n// ── [${sec.name}] main.js에서 그대로 옮겨옴 ──────────────────────────\n`);
    parts.push(slice);
  }
  return PREAMBLE + parts.join('') + POSTAMBLE;
}

function main() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const generated = extract(src);
  const check = process.argv.includes('--check');

  if (check) {
    let current = null;
    try { current = fs.readFileSync(OUT, 'utf8'); } catch {}
    if (current === generated) {
      console.log('OK — mobile/lib/core.js가 main.js와 일치합니다.');
      process.exit(0);
    }
    console.error('DRIFT — main.js가 바뀌었는데 mobile/lib/core.js가 따라오지 않았습니다.');
    console.error('        `node mobile/build_core.js`를 돌려서 다시 생성하세요.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, generated, 'utf8');
  console.log(`생성 완료: ${OUT} (${generated.split('\n').length}줄)`);
}

main();
