// K-Music 모바일 — 오디오 프록시(스트림 URL 은닉 + Range 중계)
//
// 왜 프록시가 필요한가(실측 근거, 2026-08-16):
// yt-dlp가 돌려주는 googlevideo.com 주소에는 맥미니의 공인 IP가 서명 안에 박혀 있다.
// URL의 ip= 파라미터를 다른 값으로 바꿔서 요청하면 즉시 403이 떨어지는 걸 확인했다.
// 즉 폰이 그 주소를 직접 받아가도 재생이 안 된다 — 맥미니가 대신 받아서 바이트만 넘겨줘야 한다.
//
// Range 중계가 왜 필수인가:
// <audio>의 시킹(탐색)은 "이 바이트 구간만 다시 줘"라는 Range 요청으로 동작한다. 프록시가
// Range를 그대로 위로 전달하고 206 응답(Content-Range 포함)을 그대로 내려주지 않으면,
// 브라우저는 그 오디오를 "탐색 불가"로 판단해서 진행바를 못 끌게 만들고, iOS에서는 아예
// 재생이 끊기기도 한다. 그래서 여기서는 상태코드와 Range 관련 헤더를 손대지 않고 넘긴다.
//
// URL 은닉 원칙:
// 응답 바디·헤더·에러메시지 어디에도 googlevideo 주소가 나가면 안 된다. 그래서
//  - 위로 보낼 주소는 서버 메모리의 토큰 테이블에만 있고, 클라이언트는 /audio/<토큰>만 본다
//  - 업스트림 헤더는 화이트리스트로만 복사한다(location·set-cookie 등은 절대 통과 못 함)
//  - 에러는 상태코드만 내려주고 원인 문자열을 그대로 노출하지 않는다

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// 스트림 URL 자체가 대략 6시간이면 만료돼서, 토큰을 그보다 오래 살려둘 이유가 없다.
const TOKEN_TTL_MS = 5.5 * 3600 * 1000;
const MAX_REDIRECTS = 3;

// 업스트림에서 그대로 내려줘도 안전하고, 시킹에 실제로 필요한 헤더만.
const SAFE_UPSTREAM_HEADERS = ['content-length', 'content-range', 'accept-ranges'];

function contentTypeFor(ext) {
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'opus') return 'audio/ogg';
  return 'application/octet-stream';
}

class StreamTokenStore {
  constructor() {
    this.tokens = new Map(); // token -> { url, ext, sessionToken, expiresAt, ytUrl }
    const t = setInterval(() => this.sweep(), 10 * 60 * 1000);
    t.unref?.();
  }

  // 토큰을 세션에 묶는다 — 토큰이 어쩌다 새어나가도 로그인한 그 기기 밖에서는 못 쓴다.
  issue(sessionToken, info) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, {
      url: info.streamUrl,
      ext: info.ext || '',
      ytUrl: info.ytUrl,
      sessionToken,
      expiresAt: Date.now() + TOKEN_TTL_MS
    });
    return token;
  }

  resolve(token, sessionToken) {
    const e = this.tokens.get(token);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.tokens.delete(token); return null; }
    if (e.sessionToken !== sessionToken) return null;
    return e;
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.tokens) if (now > v.expiresAt) this.tokens.delete(k);
  }
}

// 업스트림으로 실제 요청을 보내고 응답을 그대로 흘려보낸다.
//
// ⚠️ 타임아웃은 "응답 헤더가 올 때까지"만 건다(2026-08-18 수정). 예전에는 req.setTimeout(20초)를
// 걸어놨는데, 이건 소켓 유휴 타임아웃이라 헤더를 받은 뒤 본문을 흘려보내는 내내 그대로 살아있다.
// 그런데 오디오 재생은 구조상 이 소켓을 길게 놀린다 — 브라우저는 앞으로 몇십 초~몇 분치를
// 미리 받아두면 읽기를 멈추고(backpressure), 그동안 upstream.pipe(res)가 막히면서 업스트림
// 소켓에 아무 데이터도 안 흐른다. 20초가 지나면 타임아웃이 터져 req.destroy()가 불리고,
// 폰은 본문이 중간에 잘린 응답(ECONNRESET)을 받는다. 그러면 미리 받아둔 버퍼까지만 소리가
// 나다가 "곡 중간에서 조용히 멈춤"이 된다.
//
// 실측(2026-08-18, mobile/lib/streamproxy.js를 그대로 불러서 재현): 클라이언트가 2MB 받고
// 25초 쉬었을 뿐인데 40MB 중 3.5MB만 받은 채 ECONNRESET. 형이 겪은 "백그라운드로 두면
// 노래가 멈춘다"의 실제 원인이 이것이다(재생기록상 284초짜리 곡의 131초 지점에서 정지,
// 큐에는 다음 곡이 3개나 남아있었음).
//
// 본문 도중 업스트림이 진짜로 죽는 경우는 타임아웃 대신 아래 handleAudio의 res.on('close')
// 정리와 클라이언트 쪽 재생 감시(playback-guard.js)가 받아낸다.
const HEADER_TIMEOUT_MS = 20000;

function fetchUpstream(targetUrl, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) return reject(new Error('too_many_redirects'));
    let u;
    try { u = new URL(targetUrl); } catch { return reject(new Error('bad_url')); }
    const mod = u.protocol === 'http:' ? http : https;

    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('upstream_timeout'));
    }, HEADER_TIMEOUT_MS);
    guard.unref?.();

    const req = mod.request(u, { method: 'GET', headers }, res => {
      // 헤더가 왔으면 감시 종료. 여기서 안 끄면 본문 스트리밍 중 유휴에도 터진다(위 주석 참고).
      clearTimeout(guard);
      if (settled) { res.resume(); return; } // 타임아웃이 먼저 터진 뒤 도착한 응답은 버린다
      settled = true;

      // googlevideo는 리다이렉트를 자주 준다. 폰에게 리다이렉트를 그대로 넘기면 폰이
      // googlevideo 주소를 직접 보게 되므로(=은닉 실패 + 서명 IP 불일치로 403), 반드시
      // 서버가 따라간다.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // 소켓 해제
        const next = new URL(res.headers.location, u).toString();
        return resolve(fetchUpstream(next, headers, depth + 1));
      }
      resolve(res);
    });
    req.on('error', () => {
      clearTimeout(guard);
      if (settled) return; // 본문 도중 끊긴 건 여기서 reject할 대상이 아니다(이미 resolve됨)
      settled = true;
      reject(new Error('upstream_error'));
    });
    req.end();
  });
}

async function handleAudio(req, res, entry) {
  // 위로 올려보낼 헤더는 최소한으로. 특히 폰의 Cookie·Authorization·User-Agent를 그대로
  // 유튜브로 올려보내면 안 된다(형 기기 정보가 새는 것과 같음).
  const upstreamHeaders = {};
  if (req.headers.range) upstreamHeaders.range = req.headers.range;
  upstreamHeaders['accept'] = '*/*';
  upstreamHeaders['accept-encoding'] = 'identity'; // 오디오는 이미 압축돼 있고, 재인코딩은 Range를 깨뜨린다

  let upstream;
  try {
    upstream = await fetchUpstream(entry.url, upstreamHeaders);
  } catch {
    // 원인 문자열을 그대로 내보내지 않는다 — 안에 주소가 섞여 나갈 수 있다.
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('stream_unavailable');
  }

  // 서명 만료(403)/삭제(404)는 클라이언트가 "새 주소 받아와서 재시도"해야 하는 상황이다.
  // app.js에는 이미 재생 실패 시 캐시를 건너뛰고 스트림을 새로 받아오는 재시도 로직이 있어서,
  // 여기서 4xx를 그대로 내려주면 그 로직이 그대로 동작한다.
  if (upstream.statusCode >= 400) {
    upstream.resume();
    res.writeHead(upstream.statusCode === 403 ? 410 : upstream.statusCode,
      { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('stream_expired');
  }

  const outHeaders = {
    'Content-Type': contentTypeFor(entry.ext),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  for (const h of SAFE_UPSTREAM_HEADERS) {
    if (upstream.headers[h]) outHeaders[h.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())] = upstream.headers[h];
  }

  res.writeHead(upstream.statusCode, outHeaders);
  upstream.pipe(res);

  // 폰이 곡을 넘기거나 화면을 닫으면 클라이언트 연결이 끊기는데, 그때 업스트림 연결을
  // 같이 끊어주지 않으면 맥미니가 아무도 안 듣는 오디오를 계속 내려받는다.
  const cleanup = () => { upstream.destroy(); };
  res.on('close', cleanup);
  res.on('error', cleanup);
  upstream.on('error', () => { try { res.destroy(); } catch {} });
}

module.exports = { StreamTokenStore, handleAudio, contentTypeFor };
