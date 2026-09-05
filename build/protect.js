/* ══════════════════════════════════════════════════════════════════════════
   K-Music — 배포판 소스 보호 빌드 (PND-0113)

   무엇을 하는가
     kris_music/ 의 소스를 "무대(stage)" 폴더로 복사하면서 아래를 적용한다.
       ① 모든 JS 를 terser(자바스크립트 파서)로 다시 써서 주석을 전부 없애고
          함수·변수 이름을 한 글자로 바꾼다(mangle toplevel).
       ② renderer/*.html 은 html 파서로 HTML 주석을 없애고, 안에 들어 있는
          <script> 의 주석도 함께 없앤다.
       ③ index.html 의 <style> 블록은 문자열/url() 을 인식하는 렉서로 주석만 없앤다
          (base64 폰트가 그대로 들어 있어 CSS 자체는 한 글자도 다시 쓰지 않는다).
     그 다음 그 무대 폴더에서 electron-builder 를 돌린다.

   ⚠ 원본 소스는 한 글자도 건드리지 않는다. 주석은 다음에 이 코드를 고칠 사람에게
     꼭 필요한 자산이라 저장소에는 그대로 남고, 배포 산출물에서만 빠진다.

   ⚠ 정규식으로 주석을 지우지 않는다. 문자열 안의 "//" 나 정규식 리터럴을 주석으로
     오인해 코드를 깨뜨리기 때문이다. JS 는 terser(진짜 파서), HTML 은
     html-minifier-terser(진짜 파서), CSS 는 아래의 상태기계 렉서를 쓴다.

   ⚠ 속성 이름(mangle.properties)은 건드리지 않는다. config.json / playlists.json /
     accounts.json 의 키와 IPC 채널 이름이 전부 속성이라, 손대는 순간 형이 이미
     저장해 둔 재생목록·계정·설정을 못 읽는다.

   사용법
     node build/protect.js            # 무대만 만든다(검증·실행 확인용)
     node build/protect.js --build    # 무대를 만들고 electron-builder 까지 돌린다
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { minify: terserMinify } = require('terser');
const { minify: htmlMinify } = require('html-minifier-terser');

const APP = path.resolve(__dirname, '..');
const STAGE = process.env.KMUSIC_STAGE || '/private/tmp/kmusic-protected-stage';
const MAPDIR = path.join(APP, 'dist', 'sourcemaps');

/* ── 무대에 담을 것 ────────────────────────────────────────────────────── */
const JS_FILES = [
  'main.js',
  'preload.js',
  'renderer/app.js',
];
/* settings.html 은 지금 화면에서 열리는 통로가 없다(app.js 가 자체 설정 패널을 쓴다).
   그래도 main.js 의 open-settings 핸들러가 아직 살아 있어 파일이 없으면 그 경로가
   깨지므로, 지우지 않고 같이 보호해서 담는다. */
const HTML_FILES = [
  'renderer/index.html',
  'renderer/settings.html',
  'renderer/tab.html',
];
const COPY_DIRS = ['renderer/fonts', 'assets', 'build'];
const COPY_FILES = ['package.json'];

/* ── CSS 주석 제거 (상태기계 렉서 — 정규식 아님) ───────────────────────
   CSS 에는 정규식 리터럴이 없으므로 신경 쓸 상태는 ' " 문자열과 슬래시-별 주석뿐이다.
   index.html 의 폰트는 따옴표 없는 url(data:font/woff2;base64,…) 인데 base64 알파벳
   (A-Z a-z 0-9 + / =)에는 '*' 가 없어서 주석 시작으로 오인될 수 없다. */
function stripCssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      /* 주석 안의 줄바꿈 수는 유지한다 — 줄 번호가 밀리면 나중에 문제 위치를 못 찾는다 */
      const nl = src.slice(i, stop).split('\n').length - 1;
      out += '\n'.repeat(nl);
      i = stop;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* <style> … </style> 안쪽에만 위 렉서를 먹인다(태그·나머지 HTML 은 손대지 않는다) */
function stripStyleComments(html) {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, body, close) => open + stripCssComments(body) + close);
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function ensure(p) { fs.mkdirSync(p, { recursive: true }); }

function copyDir(from, to) {
  ensure(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'protect.js' || e.name === 'verify_protected.js') continue; // 빌드 도구 자신은 나르지 않는다
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const build = process.argv.includes('--build');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const mapOut = path.join(MAPDIR, pkg.version);

  console.log('[protect] stage =', STAGE);
  rmrf(STAGE);
  ensure(STAGE);
  rmrf(mapOut);
  ensure(mapOut);

  /* ① JS — terser */
  for (const rel of JS_FILES) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    const res = await terserMinify({ [path.basename(rel)]: src }, {
      ecma: 2020,
      module: false,
      /* toplevel: true 라야 최상위 함수·변수 이름까지 바뀐다.
         이 앱은 eval / new Function / Function.name 을 한 곳도 안 쓴다
         (2026-09-05 전수 확인) — 이름을 바꿔도 참조가 깨질 통로가 없다. */
      compress: { passes: 2, drop_debugger: true },
      mangle: { toplevel: true },
      /* 속성 이름은 절대 건드리지 않는다. 저장 파일 키(playlists/config/accounts)와
         IPC 채널 이름이 전부 속성이라 바꾸면 형의 기존 재생목록이 안 열린다. */
      format: { comments: false },
      sourceMap: { filename: path.basename(rel), url: false },
    });
    if (res.error) throw res.error;
    const dst = path.join(STAGE, rel);
    ensure(path.dirname(dst));
    fs.writeFileSync(dst, res.code, 'utf8');
    fs.writeFileSync(path.join(mapOut, rel.replace(/[\\/]/g, '__') + '.map'), res.map, 'utf8');
    const before = Buffer.byteLength(src), after = Buffer.byteLength(res.code);
    console.log(`[protect] js   ${rel.padEnd(22)} ${before} → ${after} (${(after / before * 100).toFixed(0)}%)`);
  }

  /* ② HTML — 주석 제거 (레이아웃에 영향 줄 수 있는 옵션은 전부 끈다) */
  for (const rel of HTML_FILES) {
    const raw = fs.readFileSync(path.join(APP, rel), 'utf8');
    const src = stripStyleComments(raw);           // <style> 안쪽 주석 먼저
    const out = await htmlMinify(src, {
      removeComments: true,
      collapseWhitespace: false,
      conservativeCollapse: false,
      /* 인라인 <script> 의 주석도 없앤다. compress 는 끄고(구조를 바꾸지 않는다)
         mangle 은 지역 변수까지만 — toplevel 을 켜면 이 스크립트가 노출하는
         전역 이름이 바뀌어 다른 파일에서 못 찾을 수 있다. */
      minifyJS: { compress: false, mangle: true, format: { comments: false } },
      minifyCSS: false,                            // 위에서 주석만 걷었고 CSS 는 다시 쓰지 않는다
      caseSensitive: true,
      keepClosingSlash: true,
      html5: true,
      /* ⚠ 이 옵션이 없으면 파서가 disabled → disabled="disabled" 로 다시 써 버린다. */
      collapseBooleanAttributes: true,
      removeAttributeQuotes: false,
      removeEmptyAttributes: false,
      removeRedundantAttributes: false,
      sortAttributes: false,
      sortClassName: false,
    });
    const dst = path.join(STAGE, rel);
    ensure(path.dirname(dst));
    fs.writeFileSync(dst, out, 'utf8');
    console.log(`[protect] html ${rel.padEnd(22)} ${Buffer.byteLength(raw)} → ${Buffer.byteLength(out)}`);
  }

  /* ③ 그대로 나르는 것 */
  for (const rel of COPY_DIRS) copyDir(path.join(APP, rel), path.join(STAGE, rel));
  for (const rel of COPY_FILES) fs.copyFileSync(path.join(APP, rel), path.join(STAGE, rel));

  /* ④ 무대용 package.json
       - files 를 못 박는다: docs/(공개 다운로드 페이지 360KB) · mobile/ · bin/ 이 앱 안으로
         새어 들어가지 않게 한다. 특히 bin/ 은 extraResources 로 이미 따로 실려서
         지금까지 같은 실행파일이 설치본에 두 번 들어가고 있었다(약 70MB 낭비).
       - asar: true — 파일이 낱개로 널브러지지 않게 한 덩이로 묶는다.
         (asar 는 암호화가 아니다. 진짜 보호는 위의 주석 제거 + 이름 뭉개기다.)
         패키징된 상태에서 yt-dlp 는 process.resourcesPath/bin 에서 찾으므로
         asar 안이 아니라 영향이 없다(main.js getYtDlpPath 확인). */
  const spkg = JSON.parse(fs.readFileSync(path.join(STAGE, 'package.json'), 'utf8'));
  spkg.build.asar = true;
  spkg.build.files = [
    'main.js', 'preload.js',
    'renderer/**/*',
    'assets/**/*',
    'package.json',
  ];
  spkg.build.directories = Object.assign({}, spkg.build.directories, {
    output: path.join(APP, 'dist'),
    buildResources: 'build',
  });
  /* extraResources 의 from 은 무대 기준 상대경로라, 원본 bin/ 을 절대경로로 가리킨다 */
  spkg.build.extraResources = [{ from: path.join(APP, 'bin'), to: 'bin', filter: ['*.exe'] }];
  delete spkg.scripts;
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(spkg, null, 2), 'utf8');

  /* ⑤ node_modules · bin 은 심볼릭 링크로 빌려 쓴다(복사하면 수백 MB)
       bin 은 위 files 목록에 없어서 패키징에는 안 들어가고, 무대에서 `electron .` 로
       직접 띄워 확인할 때만 쓰인다(개발 모드의 yt-dlp 후보 경로). */
  for (const [name, target] of [['node_modules', path.join(APP, 'node_modules')], ['bin', path.join(APP, 'bin')]]) {
    const link = path.join(STAGE, name);
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
  }

  console.log('[protect] 소스맵 보관 =', mapOut);
  console.log('[protect] 무대 준비 완료');

  if (build) {
    console.log('[protect] electron-builder 시작…');
    execFileSync(path.join(APP, 'node_modules/.bin/electron-builder'),
      ['--win', '--x64', '--publish', 'never'],
      { cwd: STAGE, stdio: 'inherit' });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
