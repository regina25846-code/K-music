// K-Music 모바일 — yt-dlp 인자 주입 방어 (모바일 서버 전용)
//
// 왜 여기(mobile/)에만 있는가
// ─────────────────────────
// 데스크톱(main.js)은 "PC 앞에 앉은 사람 = 앱 주인"이라 스스로에게 URL을 넘기는 게
// 위협이 아니다. 반면 모바일 서버는 네트워크 너머의 요청이 /api/rpc를 통해 ytUrl을
// 그대로 밀어넣을 수 있어서 위협모델이 완전히 다르다. 그래서 방어는 mobile/ 경계에서만
// 건다 — main.js와 그걸로부터 생성되는 lib/core.js는 한 글자도 안 바꾼다
// (core.js는 build_core.js가 main.js에서 바이트 단위로 뽑아내는 파일이라, 여기서 손대면
//  build_core.js --check가 즉시 DRIFT로 실패한다).
//
// 막는 것
// ──────
// 1) execFile로 yt-dlp를 부를 때 인자에 '-'로 시작하는 낯선 옵션이 섞이는 것.
//    execFile이라 셸 주입은 애초에 없지만, yt-dlp 자체 옵션 파서가 값으로 넘어온
//    문자열을 옵션으로 먹는다: --exec(임의 명령 실행), --config-location(임의 설정
//    파일 로드), --paths(임의 경로 쓰기) 등이 그대로 원격 명령 실행이 된다.
//    → 코드가 실제로 쓰는 옵션만 화이트리스트로 두고 나머지는 전부 거절한다.
// 2) 끝에 붙는 위치 인자(=URL) 앞에 리터럴 '--'를 자동으로 끼워넣어, 그 뒤는 옵션으로
//    해석될 여지 자체를 없앤다.
// 3) RPC 경계에서 URL이 유튜브 계열 도메인인지 검사(아래 isAllowedYouTubeUrl).
//
// 1)과 2)는 execFile을 감싸는 방식이라 core.js 내부 호출(getStreamInfo/searchYoutube/
// getMixForVideo)까지 전부 덮는다. core.js는 모듈 로드 시점에 execFile을 구조분해로
// 잡아가므로, installYtdlpArgGuard()는 반드시 core.js를 require하기 전에 불러야 한다.

const child_process = require('child_process');

// 이 코드베이스가 실제로 yt-dlp에 넘기는 옵션 전부. 새 옵션을 쓰게 되면 여기에 추가해야
// 하고, 추가를 잊으면 조용히 이상하게 도는 대신 명확한 에러로 즉시 드러난다.
const ALLOWED_YTDLP_FLAGS = new Set([
  '--',
  '--version',
  '--dump-json',
  '--no-playlist',
  '--no-warnings',
  '--flat-playlist',
  '--skip-download',
  '--playlist-end',
  '-f'
]);

// 뒤에 값을 하나 더 받는 옵션(값이 위치 인자로 오인되면 안 되는 것들)
const VALUE_TAKING_FLAGS = new Set(['-f', '--playlist-end']);

const ALLOWED_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
]);

function looksLikeYtDlp(file) {
  return typeof file === 'string' && /(^|[\\/])yt-dlp(\.exe)?$/i.test(file.trim());
}

// '-'로 시작하는 인자는 화이트리스트에 있는 것만 통과. '--exec=touch /tmp/pwned'처럼
// '='로 값을 붙인 형태까지 잡으려고 '=' 앞부분만 떼어서 본다.
function assertSafeYtdlpArgs(args) {
  if (!Array.isArray(args)) throw new Error('unsafe_ytdlp_args: not_an_array');
  for (const raw of args) {
    const a = String(raw);
    if (!a.startsWith('-') || a === '-') continue;
    const base = a.split('=')[0];
    if (!ALLOWED_YTDLP_FLAGS.has(base)) {
      throw new Error(`unsafe_ytdlp_args: ${base}`);
    }
  }
  return true;
}

// 맨 뒤의 위치 인자(URL) 앞에 '--'를 끼워넣는다. 이미 '--'가 있으면 그대로 둔다.
// 마지막 인자가 옵션이거나(검색·믹스 호출처럼) 값 받는 옵션의 값이면 끼워넣지 않는다.
function withOptionTerminator(args) {
  if (!Array.isArray(args) || !args.length) return args;
  if (args.includes('--')) return args;
  const last = String(args[args.length - 1]);
  if (last.startsWith('-')) return args;
  const prev = args.length >= 2 ? String(args[args.length - 2]) : '';
  if (VALUE_TAKING_FLAGS.has(prev.split('=')[0])) return args;
  return [...args.slice(0, -1), '--', args[args.length - 1]];
}

function sanitizeYtdlpArgs(args) {
  assertSafeYtdlpArgs(args);
  return withOptionTerminator(args);
}

let _installed = false;
function installYtdlpArgGuard() {
  if (_installed) return;
  _installed = true;

  const origExecFile = child_process.execFile;
  child_process.execFile = function (file, args, ...rest) {
    if (looksLikeYtDlp(file) && Array.isArray(args)) {
      // 여기서 던지면 execFile을 부른 쪽(core.ytdlp의 Promise executor)에서 그대로
      // reject되어 RPC 에러로 정리된다 — 프로세스가 죽지 않는다.
      args = sanitizeYtdlpArgs(args);
    }
    return origExecFile.call(this, file, args, ...rest);
  };

  const origExecFileSync = child_process.execFileSync;
  child_process.execFileSync = function (file, args, ...rest) {
    if (looksLikeYtDlp(file) && Array.isArray(args)) args = sanitizeYtdlpArgs(args);
    return origExecFileSync.call(this, file, args, ...rest);
  };
}

// RPC 경계 검사. 모바일에서만 쓴다 — 데스크톱은 유튜브 외 URL을 넣는 흐름이 있을 수 있어
// 건드리지 않는다.
function isAllowedYouTubeUrl(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return ALLOWED_YT_HOSTS.has(u.hostname.toLowerCase());
}

module.exports = {
  ALLOWED_YTDLP_FLAGS,
  ALLOWED_YT_HOSTS,
  assertSafeYtdlpArgs,
  withOptionTerminator,
  sanitizeYtdlpArgs,
  installYtdlpArgGuard,
  isAllowedYouTubeUrl
};
