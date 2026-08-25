#!/usr/bin/env node
// K-Music 모바일 서버 — 맥미니에서 돌면서 폰 브라우저에 K-Music을 그대로 띄워준다.
//
// ⚠️ 아직 실행/배포된 적 없는 코드입니다(2026-08-16 작성). 실제 기동과 클라우드플레어
//    서브도메인 신설은 형 컨펌 후 별도 단계입니다.
//
// 설계 요약
// ─────────
// 1) 화면은 데스크톱과 완전히 같은 renderer/index.html + app.js를 그대로 쓴다. 서버가
//    내려줄 때만 <html>에 class="m"을 붙이고 모바일 CSS/뷰포트/시임 스크립트를 끼워넣는다.
//    디스크의 renderer 파일은 한 글자도 안 바뀌므로 데스크톱 앱에 영향이 0이다.
// 2) app.js가 부르는 window.api(=electron IPC)는 public/api-shim.js가 fetch로 대신 구현한다.
//    app.js 본문은 손대지 않는다.
// 3) 오디오는 폰이 유튜브에 직접 못 붙는다(서명에 맥미니 IP가 박혀 있음). /audio/<토큰>으로
//    맥미니가 중계하고, googlevideo 주소는 서버 밖으로 절대 안 나간다(lib/streamproxy.js).
// 4) 주소만 알면 아무나 여는 상태를 만들면 안 되므로, 모든 경로가 PIN 로그인 세션 뒤에 있다.
//
// 실행(형 컨펌 후):
//   node mobile/server.js
// 환경변수:
//   KMUSIC_MOBILE_PORT   기본 3839 (K-Memo 인증서버 3838과 겹치지 않게)
//   KMUSIC_MOBILE_HOST   기본 127.0.0.1 — 기본값이 루프백인 게 중요하다. 클라우드플레어
//                        터널이 로컬로 붙는 구조라 0.0.0.0으로 열 이유가 없고, 실수로
//                        공유기에 그대로 노출되는 사고를 기본값에서 막는다.
//   KMUSIC_DATA_DIR      데이터 폴더(기본 ~/.openclaw/kris-music-mobile)
//   KMUSIC_TRUST_PROXY   '1'이면 X-Forwarded-For를 클라이언트 IP로 신뢰(터널 뒤에서만 켤 것)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ⚠️ 순서 중요 — core.js가 모듈 로드 시점에 child_process.execFile을 구조분해로 잡아가기
// 때문에, yt-dlp 인자 가드는 반드시 core.js를 require하기 전에 설치해야 한다.
const ytsafe = require('./lib/ytsafe.js');
ytsafe.installYtdlpArgGuard();

const core = require('./lib/core.js');
const { SessionStore, SESSION_TTL_MS } = require('./lib/session.js');
const { StreamTokenStore, handleAudio } = require('./lib/streamproxy.js');
const { buildMobileHtml } = require('./lib/mobilehtml.js');

const PORT = Number(process.env.KMUSIC_MOBILE_PORT || 3839);
const HOST = process.env.KMUSIC_MOBILE_HOST || '127.0.0.1';
const TRUST_PROXY = process.env.KMUSIC_TRUST_PROXY === '1';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const sessions = new SessionStore(core.DATA_DIR);
const streamTokens = new StreamTokenStore();

// 계정이 하나도 없는 상태에서만 쓰는 최초 등록용 토큰. 서버를 켤 때 콘솔에 찍히고,
// 계정이 하나라도 생기면 등록 경로 자체가 닫힌다 — 주소를 아는 사람이 마음대로 계정을
// 만들어 들어오는 걸 막기 위함. 형이 미리 값을 정하고 싶으면 환경변수로 넣어도 된다.
const SETUP_TOKEN = process.env.KMUSIC_SETUP_TOKEN || crypto.randomBytes(6).toString('hex');

// ── 프로세스 최상위 안전망 ───────────────────────────────────────────────────────
// 개인용 서버라도 "요청 한 번에 프로세스가 죽는" 상태는 그 자체로 취약점이다(폰에서
// 음악이 끊기고, 형이 맥미니에 붙어서 직접 다시 켜야 함). 요청별 예외는 아래
// http.createServer 래퍼가 500으로 정리하고, 그물을 빠져나간 것만 여기서 받아
// 로그만 남기고 프로세스는 계속 살린다. 죽는 게 나은 상황(포트 점유 등 기동 실패)은
// server.on('error')에서 따로 처리한다.
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', (e && e.stack) || e);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) || reason);
});

// ── 공통 유틸 ────────────────────────────────────────────────────────────────────
// 클라이언트가 마음대로 붙일 수 있는 값을 IP로 믿으면 로그인 시도 제한(`ip:` 키)이
// 헤더 하나로 무력화된다. 그래서 신뢰 순서를 명시한다:
//   1) cf-connecting-ip — 클라우드플레어가 엣지에서 항상 덮어쓰는 값(터널 뒤 정답)
//   2) X-Forwarded-For의 "가장 오른쪽" — 우리 앞단 프록시가 마지막에 덧붙인 값.
//      가장 왼쪽은 공격자가 그냥 써 넣을 수 있는 자리라 절대 신뢰하면 안 된다.
//   3) TRUST_PROXY가 꺼져 있으면 헤더는 아예 안 보고 소켓 IP만 쓴다(종전 그대로).
// 헤더가 중복으로 들어오면 Node가 ', '로 이어붙이므로 두 경우 모두 마지막 조각을 쓴다.
function lastHeaderValue(v) {
  const parts = String(v).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) {
      const ip = lastHeaderValue(cf);
      if (ip) return ip;
    }
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const ip = lastHeaderValue(xff);
      if (ip) return ip;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// 쿠키 값이 깨진 퍼센트 인코딩('%', '%zz')이면 decodeURIComponent가 URIError를 던진다.
// 이 함수는 인증 검사보다 먼저 불리기 때문에, 막지 않으면 로그인도 안 한 요청 하나로
// 서버가 통째로 내려간다. 디코드에 실패한 값은 원문 그대로 둔다 — 세션 조회에서
// 어차피 못 찾고 401/로그인 리다이렉트로 정상 종료된다.
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const rawVal = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(rawVal); }
    catch { out[key] = rawVal; }
  }
  return out;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      // 재생목록 전체가 excludeItems로 올라오는 요청이 있어서 넉넉히 잡되, 무제한은 아님
      if (size > limit) { req.destroy(); return reject(new Error('body_too_large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extraHeaders
  });
  res.end(body);
}

// 브라우저가 HTTPS로 붙는 건 클라우드플레어 터널 구간이고 서버 자체는 평문 HTTP다.
// Secure 플래그를 무조건 켜면 LAN에서 http로 테스트할 때 쿠키가 아예 안 붙어서
// "로그인은 되는데 계속 로그인 화면"이 된다 — 요청이 https로 들어왔는지 보고 정한다.
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, token) {
  const bits = [
    `kmusic_sid=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

// ── 정적 파일 ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml'
};

// 경로 조작(../../etc/passwd)을 막는다 — 허용된 루트 밖으로 나가면 무조건 거절.
function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

function serveFile(res, filePath, { immutable = false } = {}) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not_found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow'
    });
    // 읽는 도중 파일이 사라지거나 권한이 바뀌면 스트림이 'error'를 쏘는데, 핸들러가
    // 없으면 EventEmitter 규칙상 곧바로 uncaughtException이 된다.
    const rs = fs.createReadStream(filePath);
    rs.on('error', (e) => {
      console.error('[serveFile]', e.message);
      res.destroy();
    });
    rs.pipe(res);
  });
}

// ── RPC(= window.api 대체) ───────────────────────────────────────────────────────
// app.js가 부르는 window.api.X(...)가 그대로 {method:'X', args:[...]}로 올라온다.
// 여기 없는 이름은 전부 거절 — 새 기능을 붙일 때 이 표에 넣는 걸 잊으면 모바일에서만
// 조용히 안 되는 대신 명확한 unknown_method 에러가 난다.
const RPC = {
  // 설정/재생목록 — 데스크톱과 똑같이 전역 파일 하나를 본다
  getConfig: () => core.loadConfig(),
  saveConfig: (s, cfg) => { core.saveConfig(cfg || {}); return true; },
  getPlaylists: () => core.loadPlaylists(),
  savePlaylists: (s, pl) => { core.savePlaylists(pl); return true; },

  // 검색/메타
  search: async (s, query) => {
    try { return await core.searchYoutube(String(query || '')); }
    catch (e) { return { error: e.message }; }
  },
  getVideoInfo: async (s, ytUrl) => {
    if (!ytsafe.isAllowedYouTubeUrl(String(ytUrl || ''))) {
      return { error: '지원하지 않는 주소예요(유튜브 주소만 가능)', code: 'UNSUPPORTED_URL' };
    }
    try {
      // '--'로 옵션 구간을 끊어서, 뒤에 오는 값은 무조건 위치 인자(URL)로만 해석되게 한다.
      const json = await core.ytdlp(['--dump-json', '--no-playlist', '--no-warnings', '--skip-download', '--', String(ytUrl)]);
      const d = JSON.parse(json);
      return {
        ytUrl, title: d.title, channel: d.uploader || d.channel || '',
        thumbnail: d.thumbnail, duration: d.duration, releaseYear: d.release_year || null
      };
    } catch (e) { return { error: e.message }; }
  },

  // 스트림 — 여기가 핵심. 진짜 주소는 절대 응답에 넣지 않고, 토큰 URL만 돌려준다.
  getStream: async (s, ytUrl) => {
    // ⚠️ 여기가 네트워크 너머의 문자열이 yt-dlp 인자로 곧장 흘러들어가는 유일한 통로다.
    // yt-dlp는 '-'로 시작하는 값을 옵션으로 먹기 때문에(--exec / --config-location /
    // --paths 등), 도메인 화이트리스트로 먼저 끊는다. 이걸 통과하면 값이 https://로
    // 시작하는 유튜브 주소인 게 보장돼서 옵션으로 오인될 여지가 사라진다.
    // (2차 방어로 lib/ytsafe.js의 execFile 가드가 낯선 '-' 인자를 전부 거절하고,
    //  마지막 위치 인자 앞에 '--'를 자동으로 끼워넣는다.)
    if (!ytsafe.isAllowedYouTubeUrl(String(ytUrl || ''))) {
      return { error: '지원하지 않는 주소예요(유튜브 주소만 가능)', code: 'UNSUPPORTED_URL' };
    }
    try {
      const info = await core.getStreamInfo(String(ytUrl));
      const token = streamTokens.issue(s.token, info);
      return {
        streamUrl: `/audio/${token}`,
        title: info.title,
        channel: info.channel,
        thumbnail: info.thumbnail,
        duration: info.duration,
        ext: info.ext,
        ytUrl: info.ytUrl
      };
    } catch (e) {
      return { error: e.message, code: e.code };
    }
  },

  // 가사
  getLyrics: async (s, ytUrl, title, channel, duration) => {
    try { return await core.getLyrics(ytUrl, title, channel, duration); }
    catch (e) { return { found: false, error: e.message }; }
  },
  searchLyricsManual: async (s, ytUrl, artist, title, duration) => {
    try {
      const found = await core.fetchLyricsFromLrclib(artist, title, duration);
      const result = found
        ? { found: true, synced: found.synced, plain: found.plain, artist, title }
        : { found: false, artist, title };
      result._v = core.LYRICS_MATCHER_VERSION;
      const cache = core.loadLyricsCache();
      cache[ytUrl] = result;
      core.saveLyricsCache(cache);
      return result;
    } catch (e) { return { found: false, error: e.message }; }
  },
  saveManualSync: (s, ytUrl, syncLines) => {
    const cache = core.loadLyricsCache();
    if (cache[ytUrl]) { cache[ytUrl].manualSyncLines = syncLines; core.saveLyricsCache(cache); }
    return true;
  },

  // 계정 — 세션이 곧 계정이라, "지금 활성 계정"은 로그인한 그 계정이다
  getActiveAccount: (s) => {
    const a = core.getAccountById(s.accountId);
    if (!a) return null;
    return { id: a.id, name: a.name, prefs: a.prefs || {} };
  },
  // 등록은 로그인 화면(부트스트랩 토큰)에서만 가능하다 — app.js의 최초실행 화면은 모바일에서
  // 뜰 일이 없지만(이미 로그인된 상태로만 페이지가 열리므로), 혹시라도 불리면 명확히 막는다.
  registerAccount: () => ({ ok: false, reason: 'mobile_register_disabled' }),
  changeAccountName: (s, newName) => {
    const data = core.loadAccounts();
    const a = data && data.accounts.find(x => x.id === s.accountId);
    if (!a) return { ok: false, reason: 'no_account' };
    const name = String(newName || '').trim();
    if (!name || name.length > 12) return { ok: false, reason: 'invalid_name' };
    a.name = name;
    core.saveAccounts(data);
    return { ok: true, name };
  },
  changeAccountPin: (s, currentPin, newPin, resetMode) => {
    const data = core.loadAccounts();
    const a = data && data.accounts.find(x => x.id === s.accountId);
    if (!a) return { ok: false, reason: 'no_account' };
    // 데스크톱은 "같은 PC 앞에 앉은 사람"이라 초기화를 신원확인 없이 허용했지만, 서버에서는
    // 그게 곧 "세션만 있으면 PIN을 마음대로 바꿈"이 되므로 현재 PIN 확인을 반드시 요구한다.
    if (!core.verifyPin(String(currentPin || ''), a.pin)) return { ok: false, reason: 'wrong_pin' };
    if (!/^\d{4,6}$/.test(String(newPin || ''))) return { ok: false, reason: 'invalid_pin' };
    a.pin = core.hashPin(String(newPin));
    core.saveAccounts(data);
    return { ok: true };
  },
  setPersonalize: (s, on) => {
    const data = core.loadAccounts();
    const a = data && data.accounts.find(x => x.id === s.accountId);
    if (!a) return false;
    a.prefs = a.prefs || {};
    a.prefs.personalize = !!on;
    core.saveAccounts(data);
    return true;
  },

  // 채널 차단
  toggleChannelBlock: (s, channel) => {
    const history = core.loadHistory(s.accountId);
    if (!history.channels[channel]) {
      history.channels[channel] = { playCount: 0, skipCount: 0, favoriteCount: 0, totalListenedSec: 0, lastPlayedAt: new Date().toISOString() };
    }
    const next = !history.channels[channel].blocked;
    history.channels[channel].blocked = next;
    core.saveHistory(history);
    return next;
  },
  getBlockedChannels: (s) => {
    const history = core.loadHistory(s.accountId);
    return Object.keys(history.channels || {}).filter(ch => history.channels[ch]?.blocked);
  },

  // 추천/재생기록 — main.js의 IPC 본문을 그대로 뽑아온 core 함수를 호출한다
  getRecommendations: (s, seedYtUrl, excludeItems, count) =>
    core.getRecommendations(s.accountId, seedYtUrl, excludeItems, count),
  getAnchorSeed: (s, excludeItems, currentSeedId) =>
    core.getAnchorSeed(s.accountId, excludeItems, currentSeedId),
  recordPlayEvent: (s, ytUrl, meta, eventType) =>
    core.recordPlayEvent(s.accountId, ytUrl, meta, eventType),

  // 기타
  testYtApiKey: async (s, apiKey) => {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=dQw4w9WgXcQ&key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return { ok: r.ok };
    } catch { return { ok: false }; }
  },
  getAppVersion: () => PKG.version,
  checkYtdlp: async () => {
    try { return { ok: true, version: await core.ytdlp(['--version']) }; }
    catch { return { ok: false }; }
  }
};

// ── 라우팅 ───────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const ip = clientIp(req);
  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { return sendJson(res, 400, { ok: false, reason: 'bad_request' }); }

  const name = String(body.name || '').trim();
  const pin = String(body.pin || '');
  const keys = [`ip:${ip}`, `acct:${name.toLowerCase()}`];

  if (sessions.isLoginBlocked(keys)) {
    return sendJson(res, 429, { ok: false, reason: 'too_many_attempts' });
  }

  const data = core.loadAccounts();
  const accounts = (data && data.accounts) || [];

  // 계정이 아직 하나도 없으면 = 이 서버를 처음 켠 상태. 이때만 부트스트랩 토큰으로 첫 계정을
  // 만들 수 있다. 계정이 생긴 뒤로는 이 경로가 영영 닫힌다.
  if (!accounts.length) {
    if (String(body.setupToken || '') !== SETUP_TOKEN) {
      sessions.noteLoginFailure(keys);
      return sendJson(res, 403, { ok: false, reason: 'setup_token_required' });
    }
    if (!name || name.length > 12) return sendJson(res, 400, { ok: false, reason: 'invalid_name' });
    if (!/^\d{4,6}$/.test(pin)) return sendJson(res, 400, { ok: false, reason: 'invalid_pin' });
    const id = core.uid();
    // 디스크가 꽉 찼거나 권한이 틀어지면 writeFileSync가 그대로 던진다 — 인증 전 경로라
    // 여기서 새면 로그인 시도 한 번으로 서버가 내려간다. 명시적으로 500으로 정리한다.
    let token;
    try {
      core.saveAccounts({
        accounts: [{ id, name, pin: core.hashPin(pin), createdAt: new Date().toISOString(), prefs: { personalize: true } }],
        activeAccountId: id
      });
      token = sessions.create(id);
    } catch (e) {
      console.error('[login:create]', e.message);
      return sendJson(res, 500, { ok: false, reason: 'storage_error' });
    }
    return sendJson(res, 200, { ok: true, created: true }, { 'Set-Cookie': sessionCookie(req, token) });
  }

  const acct = accounts.find(a => a.name === name);
  // 이름이 틀렸는지 PIN이 틀렸는지 구분해서 알려주지 않는다 — 계정 이름 목록을 캐내는 통로가 된다.
  if (!acct || !core.verifyPin(pin, acct.pin)) {
    sessions.noteLoginFailure(keys);
    return sendJson(res, 401, { ok: false, reason: 'invalid_login' });
  }

  sessions.clearLoginFailures(keys);
  let token;
  try { token = sessions.create(acct.id); }
  catch (e) {
    // 세션 파일 저장 실패(디스크/권한) — 위와 같은 이유로 절대 위로 던지지 않는다.
    console.error('[login:session]', e.message);
    return sendJson(res, 500, { ok: false, reason: 'storage_error' });
  }
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
}

async function handleRpc(req, res, session) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { ok: false, error: 'bad_request' }); }

  const fn = Object.prototype.hasOwnProperty.call(RPC, body.method) ? RPC[body.method] : null;
  if (!fn) return sendJson(res, 400, { ok: false, error: 'unknown_method' });

  try {
    const result = await fn(session, ...(Array.isArray(body.args) ? body.args : []));
    return sendJson(res, 200, { ok: true, result });
  } catch (e) {
    // 내부 예외 메시지에 경로나 주소가 섞여 나갈 수 있어서 그대로 내보내지 않는다.
    console.error(`[rpc:${body.method}]`, e.message);
    return sendJson(res, 500, { ok: false, error: 'server_error' });
  }
}

async function handleRequest(req, res) {
  // req.url은 클라이언트가 통째로 정하는 값이다. 깨진 퍼센트 인코딩('/%', '/%zz')이 오면
  // decodeURIComponent가 URIError를 던지는데, 이건 인증 검사보다 앞이라 로그인 없이도
  // 누구나 때릴 수 있다. 예전에는 이게 async 핸들러 밖으로 새어나가 unhandled rejection
  // → 프로세스 종료(= 요청 한 번으로 서버 영구 다운)로 이어졌다.
  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad_request');
  }
  const cookies = parseCookies(req);
  const sid = cookies.kmusic_sid;
  const sess = sessions.get(sid);
  const session = sess ? { ...sess, token: sid } : null;

  // 검색엔진에 잡히면 "개인 도구"가 아니게 된다. 최소한의 방어.
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /\n');
  }

  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);

  if (pathname === '/api/logout' && req.method === 'POST') {
    if (sid) sessions.destroy(sid);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'kmusic_sid=; Path=/; Max-Age=0; HttpOnly' });
  }

  // 로그인 화면과 그 화면이 쓰는 파일만 세션 없이 접근 가능
  if (pathname === '/login' || (pathname === '/' && !session)) {
    return serveFile(res, path.join(PUBLIC_DIR, 'login.html'));
  }
  if (pathname === '/m/login.css') return serveFile(res, path.join(PUBLIC_DIR, 'login.css'));

  // ── 홈 화면에 추가(PWA)용 파일은 세션 없이도 내려준다 ──────────────────────────
  // 브라우저는 manifest를 "쿠키 없이(credentials: omit)" 가져간다. 규격이 그렇고, 실측으로도
  // 확인했다(sec-fetch-dest: manifest / mode: cors, Cookie 헤더 없음). 그래서 이 경로가
  // 세션 게이트 뒤에 있으면 크롬이 JSON 대신 로그인 페이지(302)를 받아서 manifest 전체를
  // 버린다 — 이름도 아이콘도 통째로 무시되고, "홈 화면에 추가"에 기본 아이콘/스크린샷만 뜬다
  // (2026-08-17 폴드7에서 형이 발견한 증상의 원인).
  //
  // 아이콘과 manifest에는 개인정보가 없다(앱 이름과 로고뿐). 반면 데이터·오디오·RPC는 그대로
  // PIN 세션 뒤에 남는다. 로그인 화면에서 바로 홈 화면에 추가하는 경우까지 아이콘이 나오는
  // 이점도 같이 얻는다.
  const PUBLIC_PWA_FILES = {
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/sw.js': 'sw.js',
    '/apple-touch-icon.png': 'apple-touch-icon.png',
    '/m/apple-touch-icon.png': 'apple-touch-icon.png',
    '/m/icon-192.png': 'icon-192.png',
    '/m/icon-512.png': 'icon-512.png'
  };
  if (Object.prototype.hasOwnProperty.call(PUBLIC_PWA_FILES, pathname)) {
    return serveFile(res, path.join(PUBLIC_DIR, PUBLIC_PWA_FILES[pathname]));
  }

  if (!session) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  // ── 여기부터는 전부 로그인된 요청 ──
  if (pathname === '/api/rpc' && req.method === 'POST') return handleRpc(req, res, session);

  if (pathname === '/api/whoami') {
    const a = core.getAccountById(session.accountId);
    return sendJson(res, 200, { ok: true, name: a ? a.name : null });
  }

  if (pathname.startsWith('/audio/')) {
    const token = pathname.slice('/audio/'.length);
    const entry = streamTokens.resolve(token, session.token);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('unknown_stream');
    }
    return handleAudio(req, res, entry);
  }

  if (pathname === '/') {
    let html;
    try { html = buildMobileHtml(); }
    catch (e) {
      console.error('[html]', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('페이지를 만들지 못했습니다 — 서버 로그를 확인하세요.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow'
    });
    return res.end(html);
  }

  // 데스크톱과 완전히 같은 app.js를 그대로 내려준다(수정본이 아니다)
  if (pathname === '/app.js') return serveFile(res, path.join(RENDERER_DIR, 'app.js'));

  // manifest / sw.js / 아이콘은 위쪽 PUBLIC_PWA_FILES에서 세션 없이 이미 처리된다.

  if (pathname.startsWith('/m/')) {
    const p = safeJoin(PUBLIC_DIR, pathname.slice('/m'.length));
    if (!p) { res.writeHead(400); return res.end(); }
    return serveFile(res, p);
  }

  if (pathname.startsWith('/fonts/')) {
    const p = safeJoin(path.join(RENDERER_DIR, 'fonts'), pathname.slice('/fonts'.length));
    if (!p) { res.writeHead(400); return res.end(); }
    return serveFile(res, p, { immutable: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not_found');
}

// 요청 하나에서 터진 예외가 프로세스를 끌어내리지 않게, 모든 요청을 감싼다.
// 실패한 그 요청만 500으로 끝나고 서버는 계속 산다.
const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((e) => {
      console.error('[request]', req.method, req.url, '—', (e && e.stack) || e);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        }
        res.end('server_error');
      } catch { /* 응답이 이미 끊긴 경우 — 더 할 게 없다 */ }
    });
});

server.on('clientError', (err, socket) => {
  // 잘못된 HTTP 프레이밍으로 들어온 연결. 기본 동작도 소켓을 닫지만, 명시해두면
  // 소켓 쪽 예외가 uncaughtException으로 새는 경로가 하나 줄어든다.
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

server.on('error', (e) => {
  // 기동 자체가 실패한 경우(포트 점유 등)는 조용히 살아있는 것보다 죽는 게 낫다.
  console.error('[server]', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const accounts = (core.loadAccounts()?.accounts) || [];
  console.log(`K-Music 모바일 서버 — http://${HOST}:${PORT}`);
  console.log(`데이터 폴더: ${core.DATA_DIR}`);
  console.log(`yt-dlp: ${core.getYtDlpPath()}`);
  if (!accounts.length) {
    console.log(`계정이 아직 없습니다. 최초 등록 토큰: ${SETUP_TOKEN}`);
    console.log('(로그인 화면에서 이 토큰을 넣어야 첫 계정이 만들어집니다. 계정이 생기면 등록 경로는 닫힙니다.)');
  } else {
    console.log(`등록된 계정: ${accounts.length}개 — 최초 등록 경로는 닫혀 있습니다.`);
  }
});

module.exports = { server, RPC, buildMobileHtml };
