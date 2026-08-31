#!/usr/bin/env node
// K-Music 모바일 — 기계 대조(정적 검사)
//
// 사람이 눈으로 읽어서 "맞는 것 같다"고 판단하는 대신, 스크립트가 실제 파일을 대조해서
// 통과/실패를 낸다. 서버를 띄우지 않고 파일만 읽으므로 아무 부작용이 없다.
//
// 실행: node mobile/check_mobile.js
//
// 여기서 검사하지 못하는 것(=반드시 실기에서 형이 확인해야 하는 것):
//  - 실제 아이폰/안드로이드에서의 백그라운드 재생 유지
//  - 잠금화면 컨트롤이 실제로 뜨는지
//  - 폰 화면에서의 실제 레이아웃(렌더 이미지 비교는 아직 미착수)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === true) results.push([true, name, '']);
    else results.push([false, name, String(r)]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── A. 공용 엔진이 main.js와 어긋나지 않았는가 ────────────────────────────────
check('core.js가 main.js와 동기화됨 (build_core.js --check)', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'build_core.js'), '--check'], { stdio: 'pipe' });
  return true;
});

check('core.js에 electron 의존성이 남아있지 않음', () => {
  const src = read('mobile/lib/core.js');
  // 주석은 빼고 실제 코드 줄만 본다
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  if (/require\(['"]electron['"]\)/.test(code)) return "require('electron') 발견";
  if (/\bipcMain\b/.test(code)) return 'ipcMain 발견';
  if (/\bapp\.(getPath|isPackaged|getVersion)\b/.test(code)) return 'electron app.* 발견';
  return true;
});

// ── B. window.api 시임이 preload와 같은 표면을 갖는가 ──────────────────────────
// 하나라도 빠지면 app.js가 로드 시점에 TypeError로 죽어서 화면이 통째로 안 뜬다.
check('api-shim이 preload.js의 모든 메서드를 구현함', () => {
  const preload = read('preload.js');
  const shim = read('mobile/public/api-shim.js');
  const want = new Set([...preload.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map(m => m[1]));
  const body = shim.slice(shim.indexOf('window.api = {'));
  const have = new Set([...body.matchAll(/^\s{4}([a-zA-Z][\w]*):/gm)].map(m => m[1]));
  const missing = [...want].filter(k => !have.has(k));
  return missing.length ? `누락: ${missing.join(', ')}` : true;
});

// ── C. 모바일 CSS가 데스크톱으로 새지 않는가 ─────────────────────────────────
// 규칙: mobile.css의 모든 선택자는 html.m 스코프 안에 있어야 한다. 하나라도 새면
// 그 순간 데스크톱 디자인이 조용히 바뀔 수 있다.
check('mobile.css의 모든 선택자가 html.m 스코프 안에 있음', () => {
  const css = read('mobile/public/mobile.css')
    .replace(/\/\*[\s\S]*?\*\//g, '');          // 주석 제거
  const leaked = [];
  for (const m of css.matchAll(/(^|[};])\s*([^{};@]+)\{/g)) {
    const selectorList = m[2].trim();
    if (!selectorList) continue;
    for (const sel of selectorList.split(',')) {
      const s = sel.trim();
      if (!s) continue;
      if (!s.startsWith('html.m')) leaked.push(s);
    }
  }
  return leaked.length ? `스코프 밖 선택자: ${leaked.slice(0, 5).join(' | ')}` : true;
});

// ── D. 데스크톱 원본이 안 바뀌었는가 ──────────────────────────────────────────
check('renderer/index.html에 모바일용 태그가 섞여들지 않음(주입은 서버가 런타임에만)', () => {
  const html = read('renderer/index.html');
  if (html.includes('mobile.css')) return 'index.html에 mobile.css 링크가 박혀있음';
  if (html.includes('api-shim')) return 'index.html에 api-shim이 박혀있음';
  if (html.includes('class="m"')) return 'index.html에 모바일 스코프 클래스가 박혀있음';
  return true;
});

check('renderer/app.js에 모바일 전용 분기가 섞여들지 않음', () => {
  const js = read('renderer/app.js');
  if (/window\.api\.isMobile|navigator\.mediaSession/.test(js)) return 'app.js가 모바일 전용 코드를 갖고 있음';
  return true;
});

// ── E. 주입 결과 검사 ─────────────────────────────────────────────────────────
const { buildMobileHtml } = require('./lib/mobilehtml.js');
let injected = null;
check('index.html 주입이 성공함', () => { injected = buildMobileHtml(); return true; });

if (injected) {
  const has = s => injected.includes(s);
  check('A1 viewport 메타(width=device-width, viewport-fit=cover)', () =>
    /<meta name="viewport" content="width=device-width[^"]*viewport-fit=cover/.test(injected) || '없음');
  check('A2 iOS standalone 설치를 강제하지 않음', () =>
    !injected.includes('apple-mobile-web-app-capable') || '해당 메타 태그가 페이지에 들어있음');
  check('A3 안드로이드 설치용 manifest 링크 있음', () =>
    has('<link rel="manifest" href="/manifest.webmanifest"/>') || '없음');
  check('A5 robots noindex', () => has('name="robots" content="noindex, nofollow"') || '없음');
  check('A6 html.m 스코프 클래스 부착', () => has('<html lang="ko" class="m">') || '없음');
  check('A6b mobile.css 링크', () => has('/m/mobile.css') || '없음');
  check('A7 원본 상대경로 app.js 태그가 남지 않음', () =>
    !has('<script src="app.js"></script>') || '남아있음');
  check('스크립트 순서(shim → app.js → mediasession → boot → playback-guard → gapless)', () => {
    const i1 = injected.indexOf('/m/api-shim.js');
    const i2 = injected.indexOf('<script src="/app.js">');
    const i3 = injected.indexOf('/m/mediasession.js');
    const i4 = injected.indexOf('/m/mobile-boot.js');
    const i5 = injected.indexOf('/m/playback-guard.js');
    // gapless는 mobile-boot의 audio.play 시임까지 덮어써야 해서 반드시 맨 마지막이다.
    const i6 = injected.indexOf('/m/gapless.js');
    return (i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5 && i5 < i6) ||
      `순서 어긋남 ${i1}/${i2}/${i3}/${i4}/${i5}/${i6}`;
  });
  check('원본 마크업 보존(bottom-nav, audio)', () =>
    (has('class="bottom-nav"') && /id="audio"/.test(injected)) || '원본 요소가 사라짐');
}

// ── F. 스트림 URL 은닉 ────────────────────────────────────────────────────────
check('RPC 응답에 실제 스트림 URL을 넣지 않음(getStream이 토큰 경로만 반환)', () => {
  const src = read('mobile/server.js');
  const i = src.indexOf('getStream: async');
  if (i < 0) return 'getStream 핸들러를 못 찾음';
  const block = src.slice(i, src.indexOf('\n  },', i));
  if (/streamUrl:\s*info\.streamUrl/.test(block)) return '진짜 스트림 URL을 그대로 반환하고 있음';
  if (!/streamUrl:\s*`\/audio\//.test(block)) return '토큰 경로를 반환하지 않음';
  return true;
});

check('오디오 프록시가 Range 헤더를 중계함', () => {
  const src = read('mobile/lib/streamproxy.js');
  if (!/upstreamHeaders\.range\s*=\s*req\.headers\.range/.test(src)) return 'Range를 위로 전달하지 않음';
  if (!/content-range/.test(src)) return 'Content-Range를 내려주지 않음';
  if (!/res\.writeHead\(upstream\.statusCode/.test(src)) return '업스트림 상태코드(206)를 그대로 안 넘김';
  return true;
});

check('프록시가 리다이렉트를 서버에서 따라감(폰에 googlevideo 주소를 넘기지 않음)', () => {
  const src = read('mobile/lib/streamproxy.js');
  return /301, 302, 303, 307, 308/.test(src) || '리다이렉트 처리 없음';
});

// ── H. 백그라운드 재생 끊김 재발 방지(2026-08-18) ─────────────────────────────
// 곡 중간에 소리가 끊기던 원인 두 갈래를 각각 못질해둔다.
check('프록시에 본문 스트리밍을 죽이는 소켓 유휴 타임아웃이 없음', () => {
  const src = read('mobile/lib/streamproxy.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // req.setTimeout / socket.setTimeout은 헤더를 받은 뒤에도 살아있어서, 브라우저가 버퍼를
  // 채우고 읽기를 쉬는 20초 동안 업스트림을 끊어버린다(= 곡 중간 무음 정지).
  if (/\breq\.setTimeout\s*\(/.test(code)) return 'req.setTimeout이 남아있음(본문 중간에 끊김)';
  if (/\bsocket\.setTimeout\s*\(/.test(code)) return 'socket.setTimeout이 남아있음';
  if (!/clearTimeout\(guard\)/.test(code)) return '헤더 수신 시 타임아웃 해제가 없음';
  return true;
});

check('시임 RPC에 응답 대기 상한이 있음(fetch 영구 매달림 방지)', () => {
  const src = read('mobile/public/api-shim.js');
  if (!/signal:\s*timeoutSignal\(\)/.test(src)) return 'fetch에 타임아웃 signal이 없음';
  return true;
});

check('시임 saveConfig가 예외를 던지지 않음(재생 중 오탐 스킵 방지)', () => {
  const src = read('mobile/public/api-shim.js');
  if (/saveConfig:\s*\(cfg\)\s*=>\s*rpc\(/.test(src)) return 'saveConfig가 그대로 throw하는 rpc임';
  if (!/saveConfig:\s*soft\(/.test(src)) return 'saveConfig가 soft 래퍼가 아님';
  return true;
});

check('재생 감시견(playback-guard)이 존재하고 app.js를 수정하지 않음', () => {
  const src = read('mobile/public/playback-guard.js');
  if (!/setInterval\(watchdog/.test(src)) return '감시 타이머가 없음';
  if (!/maybeExtendQueue/.test(src)) return '큐 보충 재시도가 없음';
  const js = read('renderer/app.js');
  if (/playback-guard|watchdog/.test(js)) return 'app.js에 모바일 감시 코드가 섞여들어감';
  return true;
});

// ── I. 곡 전환 끊김 재발 방지(2026-08-21) ─────────────────────────────────────
// "백그라운드에서 다음 곡부터 끊긴다"의 구조적 원인 세 갈래를 각각 못질해둔다.
check('다음 곡 스트림 주소를 미리 받아 streamCache에 꽂아둠(전환 무음구간 제거)', () => {
  const src = read('mobile/public/gapless.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  if (!/window\.api\.getStream\(/.test(code)) return '미리 받기 호출이 없음';
  if (!/cache\[ytUrl\]\s*=\s*\{/.test(code)) return 'app.js의 streamCache에 써넣지 않음';
  // 타이머는 백그라운드에서 조여든다 — 반드시 미디어 이벤트에 얹혀 있어야 한다.
  if (!/addEventListener\('timeupdate'/.test(code)) return '미리 받기가 미디어 이벤트에 얹혀있지 않음';
  if (/setInterval\(/.test(code)) return 'setInterval에 의존하고 있음(백그라운드에서 조여듦)';
  return true;
});

check('브라우저 재생거절(NotAllowedError)이 자동 스킵 연쇄로 번지지 않음', () => {
  const src = read('mobile/public/gapless.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  if (!/NotAllowedError/.test(code)) return '재생거절 판별이 없음';
  if (!/Object\.defineProperty\(audio, 'play'/.test(code)) return 'mobile-boot의 play 교체를 못 버티는 감싸기임';
  if (!/visibilitychange/.test(code)) return '되살리기 트리거가 없음';
  return true;
});

check('곡 전환 중 emptied로 미디어 세션을 내리지 않음', () => {
  const src = read('mobile/public/mediasession.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  if (/'emptied',\s*\(\)\s*=>\s*\{\s*ms\.playbackState\s*=\s*'none'/.test(code)) {
    return 'emptied에서 무조건 playbackState=none으로 내리고 있음';
  }
  if (!/if \(stopped\) ms\.playbackState = 'none'/.test(code)) return '정지 여부 판별이 없음';
  return true;
});

check('gapless가 app.js/데스크톱을 건드리지 않음', () => {
  const js = read('renderer/app.js');
  if (/gapless|prefetchNext|pendingResume/.test(js)) return 'app.js에 모바일 전용 코드가 섞여들어감';
  const html = read('renderer/index.html');
  if (html.includes('gapless')) return 'index.html에 gapless가 박혀있음';
  return true;
});

// ── G. 인증 게이트 ────────────────────────────────────────────────────────────
check('세션 없는 요청은 로그인으로 막힘', () => {
  const src = read('mobile/server.js');
  if (!/if \(!session\) \{/.test(src)) return '세션 검사 분기가 없음';
  if (!/sendJson\(res, 401/.test(src)) return 'API에 401 응답이 없음';
  return true;
});

check('로그인 시도 횟수 제한 있음', () => {
  const src = read('mobile/lib/session.js');
  return /LOGIN_MAX_FAILS/.test(src) || '시도 제한 없음';
});

check('기본 바인드 주소가 루프백(실수로 외부 노출되지 않음)', () => {
  const src = read('mobile/server.js');
  return /KMUSIC_MOBILE_HOST \|\| '127\.0\.0\.1'/.test(src) || '기본값이 루프백이 아님';
});

// ── P. PWA 설치 규격 ──────────────────────────────────────────────────────────
// 2026-08-31, 형이 폰에서 "설치"를 눌렀는데 한참 반응이 없다가 홈 화면에 아이콘이 여러 개
// 중복으로 깔린 사고 뒤에 추가했다. 그때 확인한 함정들을 기계가 매번 다시 확인한다.
let manifest = null;
check('P1 manifest가 올바른 JSON', () => {
  manifest = JSON.parse(read('mobile/public/manifest.webmanifest'));
  return true;
});

if (manifest) {
  // id가 없으면 브라우저가 start_url로 앱을 식별한다. start_url이 나중에 한 글자라도 바뀌면
  // "같은 앱의 업데이트"가 아니라 "새로운 앱"으로 인식돼서 홈 화면 아이콘이 하나 더 생긴다.
  // 명시해두면 start_url을 바꿔도 앱 정체성이 흔들리지 않는다.
  check('P2 manifest에 id가 명시돼 있음(중복 설치 방지)', () =>
    manifest.id === '/' || `id=${JSON.stringify(manifest.id)} (기대: "/")`);
  check('P3 start_url/scope/display가 설치 요건을 만족', () =>
    (manifest.start_url === '/' && manifest.scope === '/' && manifest.display === 'standalone') ||
    `start_url=${manifest.start_url} scope=${manifest.scope} display=${manifest.display}`);
  check('P4 name/short_name 있음', () =>
    (!!manifest.name && !!manifest.short_name) || '비어 있음');

  // 안드로이드 설치(WebAPK)는 any 192/512와 maskable 192/512를 전부 요구한다.
  check('P5 아이콘 4종(any 192·512, maskable 192·512)이 다 있음', () => {
    const want = [['192x192', 'any'], ['512x512', 'any'], ['192x192', 'maskable'], ['512x512', 'maskable']];
    const missing = want.filter(([s, p]) =>
      !(manifest.icons || []).some(i => i.sizes === s && String(i.purpose || 'any').split(/\s+/).includes(p)));
    return missing.length === 0 || '없음: ' + missing.map(x => x.join(' ')).join(', ');
  });

  // 크롬은 manifest에 적힌 아이콘도 "쿠키 없이" 받아간다. 하나라도 PIN 세션 게이트 뒤에
  // 있으면 302(로그인)로 튕겨서 조용히 실패하고, 설치가 정식 설치 대신 바로가기로 떨어진다.
  check('P6 manifest의 모든 아이콘이 세션 없이 열려 있음(PUBLIC_PWA_FILES 등록)', () => {
    const src = read('mobile/server.js');
    const i = src.indexOf('const PUBLIC_PWA_FILES');
    if (i < 0) return 'PUBLIC_PWA_FILES를 찾지 못함';
    const block = src.slice(i, src.indexOf('};', i));
    const missing = (manifest.icons || []).map(x => x.src)
      .filter(s => !block.includes(`'${s}'`));
    return missing.length === 0 || '세션 뒤에 갇힌 경로: ' + missing.join(', ');
  });

  check('P7 아이콘 파일이 실제로 존재하고 선언한 크기와 일치', () => {
    const bad = [];
    for (const ic of manifest.icons || []) {
      const p = path.join(ROOT, 'mobile/public', ic.src.replace(/^\/m\//, '').replace(/^\//, ''));
      if (!fs.existsSync(p)) { bad.push(`${ic.src} 파일 없음`); continue; }
      // PNG 헤더(IHDR)에서 가로·세로·컬러타입을 직접 읽는다.
      const b = fs.readFileSync(p);
      if (b.slice(1, 4).toString() !== 'PNG') { bad.push(`${ic.src} PNG가 아님`); continue; }
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colorType = b[25];
      if (`${w}x${h}` !== ic.sizes) bad.push(`${ic.src} 실제 ${w}x${h} ≠ 선언 ${ic.sizes}`);
      if (colorType !== 6) bad.push(`${ic.src} RGBA가 아님(colorType=${colorType})`);
    }
    return bad.length === 0 || bad.join(', ');
  });
}

// 서비스워커가 scope "/"에 등록돼 있어야 크롬이 정식 설치(WebAPK) 경로를 쓴다. 등록이 없으면
// "바로가기 만들기"로 떨어지는데, 바로가기는 중복 방지가 없어서 누를 때마다 아이콘이 늘어난다.
// start_url("/")이 로그인 전에는 login.html을 내려주므로 그쪽에도 반드시 등록이 있어야 한다.
check('P8 로그인 화면에서도 서비스워커를 등록함', () =>
  /navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(read('mobile/public/login.html')) ||
  'login.html에 등록 코드가 없음');
check('P9 앱 화면에서도 서비스워커를 등록함', () =>
  /navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(read('mobile/public/mobile-boot.js')) ||
  'mobile-boot.js에 등록 코드가 없음');
check('P10 서비스워커에 fetch 핸들러가 있음(설치 가능 조건)', () =>
  /addEventListener\('fetch'/.test(read('mobile/public/sw.js')) || 'fetch 핸들러가 없음');

// ── 출력 ──────────────────────────────────────────────────────────────────────
let fail = 0;
for (const [ok, name, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fail++;
}
console.log(`\n${results.length - fail}/${results.length} 통과${fail ? ` — 실패 ${fail}건` : ''}`);
process.exit(fail ? 1 : 0);
