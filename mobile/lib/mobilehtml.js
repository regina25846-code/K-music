// K-Music 모바일 — index.html 주입
//
// 디스크의 renderer/index.html은 한 글자도 고치지 않는다. 서버가 내려보낼 때만 모바일용
// 조각을 끼워넣는다. 이렇게 하면 데스크톱 앱은 이 파일의 존재조차 모르는 상태가 되어
// "모바일 작업이 데스크톱을 건드릴 위험"이 구조적으로 0이 된다.
//
// 서버(server.js)와 분리해둔 이유: 서버 모듈을 require하면 포트를 열어버리기 때문에,
// 주입 결과만 검사하고 싶을 때 곤란하다. 주입 로직만 따로 두면 서버를 띄우지 않고도
// 기계 대조로 확인할 수 있다.

const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

// ⚠️ iOS에 홈화면 설치(standalone) 메타 태그를 일부러 넣지 않는 이유:
// 아이폰에서 PWA를 홈화면에 standalone으로 설치하면, 오히려 화면을 끄거나 앱을 내렸을 때
// 오디오가 끊기는 애플 자체 버그가 있다(확신도 85%). 사파리 탭으로 열어두면 백그라운드
// 재생이 정상 동작한다. 그래서 iOS는 "사파리 탭"을 기본 경로로 두고, 설치를 막지도 않는다
// (형이 원하면 설치할 수 있게 두 경로 다 열어두는 것으로 확정, 2026-08-16).
// 안드로이드는 이 버그가 없어서 manifest로 설치형 경로를 정상 제공한다.
// 아래 주입 문자열에 그 메타 태그 이름이 "글자로도" 들어가지 않게 조심할 것 —
// 기계 대조(A2)가 "페이지에 그 이름이 아예 없어야 한다"로 검사하기 때문에, 주석에라도
// 적어두면 통과하지 못한다.

const MOBILE_HEAD = `
<!-- ↓ K-Music 모바일 서버가 주입한 부분 (renderer/index.html 원본에는 없음) -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1"/>
<meta name="theme-color" content="#0d0d0f"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="format-detection" content="telephone=no"/>
<!-- iOS용 웹앱 standalone 메타 태그는 일부러 넣지 않는다(자세한 이유는 lib/mobilehtml.js 주석).
     manifest는 안드로이드 설치용으로 정상 제공한다. -->
<link rel="manifest" href="/manifest.webmanifest"/>
<!-- 홈 화면에 추가할 때 쓰는 아이콘.
     apple-touch-icon은 알파를 지원하지 않아서(투명한 곳을 검정으로 합성한다) 로고를 테마색
     #0d0d0f 위에 미리 평탄화해둔 180x180 전용 파일을 쓴다. 192짜리를 그대로 주면 모서리가
     검게 나온다. 안드로이드는 manifest의 192/512(알파 있는 원본)를 그대로 쓴다. -->
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="/m/icon-192.png"/>
<link rel="stylesheet" href="/m/mobile.css"/>
`;

// 순서가 중요하다. api-shim은 반드시 app.js보다 먼저(그래야 window.api가 이미 있다),
// mediasession/mobile-boot은 반드시 app.js보다 나중(그래야 app.js의 전역 함수를 잡을 수 있다).
const MOBILE_SCRIPTS = `<script src="/m/api-shim.js"></script>
<script src="/app.js"></script>
<script src="/m/mediasession.js"></script>
<script src="/m/mobile-boot.js"></script>`;

const ANCHORS = [
  ['<html lang="ko">', '<html lang="ko" class="m">'],
  ['<head>', '<head>' + MOBILE_HEAD],
  ['<script src="app.js"></script>', MOBILE_SCRIPTS]
];

let _cache = { mtime: 0, html: '' };

function buildMobileHtml(srcPath = path.join(RENDERER_DIR, 'index.html')) {
  const st = fs.statSync(srcPath);
  if (_cache.mtime === st.mtimeMs && _cache.html) return _cache.html;

  let html = fs.readFileSync(srcPath, 'utf8');
  for (const [find, replace] of ANCHORS) {
    // 앵커를 못 찾으면 조용히 반쪽짜리 페이지를 내려주지 않고 즉시 실패한다 — "모바일에서만
    // CSS가 안 먹은 채로 돌아가는" 상태가 제일 알아채기 어렵고 제일 오래 방치된다.
    if (!html.includes(find)) {
      throw new Error(`renderer/index.html에서 주입 앵커를 못 찾았습니다: ${find}`);
    }
    html = html.replace(find, replace);
  }

  _cache = { mtime: st.mtimeMs, html };
  return html;
}

module.exports = { buildMobileHtml, ANCHORS, MOBILE_HEAD, MOBILE_SCRIPTS, RENDERER_DIR };
