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
  check('스크립트 순서(shim → app.js → mediasession → boot)', () => {
    const i1 = injected.indexOf('/m/api-shim.js');
    const i2 = injected.indexOf('<script src="/app.js">');
    const i3 = injected.indexOf('/m/mediasession.js');
    const i4 = injected.indexOf('/m/mobile-boot.js');
    return (i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4) || `순서 어긋남 ${i1}/${i2}/${i3}/${i4}`;
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

// ── 출력 ──────────────────────────────────────────────────────────────────────
let fail = 0;
for (const [ok, name, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fail++;
}
console.log(`\n${results.length - fail}/${results.length} 통과${fail ? ` — 실패 ${fail}건` : ''}`);
process.exit(fail ? 1 : 0);
