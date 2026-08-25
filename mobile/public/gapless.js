// K-Music 모바일 — 곡 전환 무음구간 제거 + 백그라운드 재생거절 가드
//
// 왜 이 파일이 필요한가 (2026-08-21 실측)
// ────────────────────────────────────────────────────────────────────────────
// 형 신고: "백그라운드에서 재생하면 다음 곡부터 노래가 끊긴다. 화면을 보고 있을 땐 괜찮다."
// 즉 재생 중인 곡이 아니라 "곡이 넘어가는 그 순간"만 실패한다. 코드를 따라가 보면 그럴
// 수밖에 없는 구조였다.
//
// app.js의 곡 전환 경로는 이렇다:
//   ended → nextTrack() → playTrack() → await getStream()  ← 여기서 네트워크를 기다린다
//                       → audio.src = 새 주소 → await audio.play()
//
// 1) getStream은 캐시가 없으면 맥미니에 RPC를 보내고, 서버는 그때서야 yt-dlp를 돌린다.
//    실측(2026-08-21, mobile/lib/core.js getStreamInfo 직접 호출): 3.00s / 2.30s / 1.30s.
//    미리 받아두는 코드는 어디에도 없다 — getStream 호출부는 playTrack 안 딱 한 곳뿐이다.
// 2) <audio>는 preload="none"이라(renderer/index.html:1689) 주소를 넣기 전까지 단 1바이트도
//    미리 받지 않는다.
// 3) 그래서 곡과 곡 사이에는 "소리도 안 나고, 받아둔 버퍼도 없는" 구간이 매번 1.3~3초
//    생긴다. 실측(브라우저 프로브): audio:ended → 다음 audio:playing 까지 정확히 2.01초.
// 4) 그 구간에 app.js가 audio.src를 갈아끼우면 emptied 이벤트가 뜨고, mediasession.js가
//    playbackState를 'none'으로 내린다 = OS에 "이제 아무것도 안 틉니다"라고 신고하는 것.
//
// 폰의 백그라운드 정책은 전부 "지금 소리가 나고 있는가"를 기준으로 돈다. 위 구간은 그
// 기준에서 정확히 '아니오'다. 그래서 그 몇 초 사이에 미디어 알림이 내려가고 오디오 포커스가
// 풀리고 타이머가 조여들고, 뒤늦게 도착한 audio.play()가 사용자 제스처 없는 새 재생으로
// 취급돼 거절될 수 있다. 화면을 켜두면 이 정책이 전부 적용되지 않으니 같은 코드가 멀쩡히
// 돌아간다 — 형이 겪은 "포그라운드는 괜찮다"와 정확히 일치한다.
//
// 그리고 한 번 거절되면 피해가 그 곡 하나로 끝나지 않는다. playTrack의 catch는 실패 원인을
// 구분하지 않아서(app.js:993) 자동추천곡이면 "이 곡이 고장났다"고 판단하고 바로 다음 곡으로
// 넘어가며, 그게 3번 반복되면(AUTO_SKIP_CHAIN_MAX) "재생 실패" 토스트와 함께 멈춘다.
// 실제 재생기록에도 이 흔적이 남아있다(~/.openclaw/kris-music-mobile/history):
// 3.0초·3.8초·0.2초 간격으로 곡이 연달아 넘어간 구간, 재생시간 0초짜리 스킵, 그리고
// 그 뒤에 이어지는 몇 분짜리 무음 구간.
//
// 무엇을 하는가
// ────────────────────────────────────────────────────────────────────────────
//  1) 다음 곡 스트림 주소를 곡이 시작하자마자 미리 받아 app.js의 streamCache에 꽂아둔다.
//     → playTrack의 getStream이 캐시 히트(실측 0ms)로 끝나서 무음 구간 자체가 사라진다.
//  2) 브라우저가 play()를 거절해도 app.js에는 예외를 올리지 않는다.
//     → 멀쩡한 곡 3개를 연달아 버리고 멈추는 연쇄가 없어진다. 대신 "형이 폰을 다시 보는
//       순간"이나 잠금화면 재생버튼에서 그 자리부터 이어서 튼다.
//  3) 곡 전환 중의 emptied로 미디어 세션을 내리지 않는다(mediasession.js와 짝).
//
// app.js는 한 줄도 고치지 않는다. app.js의 최상위 let 바인딩(streamCache 등)은 같은
// 클래식 스크립트에서 이름으로 그대로 읽고 쓸 수 있다는 걸 실측으로 확인했다.
//
// ⚠️ 코드로 못 고치는 부분(정직하게 남겨둠)
//  - 셔플이 켜져 있으면 다음 곡이 난수라 미리 받아둘 수가 없다(nextTrack의 규칙 자체가
//    Math.random이다). 셔플일 때는 2)/3)만 적용되고 전환 무음 구간은 남는다.
//  - iOS 사파리가 화면이 꺼진 동안 ended를 늦게 쏘거나 안 쏘는 경우, 그리고 OS가 페이지를
//    통째로 얼려버리는 경우는 웹 코드로 되돌릴 수 없다. 그건 형이 폰을 다시 켜는 순간의
//    복구(2)로만 완화된다.
//  - 맥미니에서는 폰의 백그라운드 상태를 만들 수 없다. 데스크톱 크롬은 소리가 나는 탭을
//    아예 얼리지 않는 걸 CDP로 확인했다(Page.setWebLifecycleState('frozen')이 무시됨).
//    그래서 최종 확인은 형의 실기 몫이다.

(function () {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;

  const CACHE_TTL_MS = 5.5 * 3600 * 1000; // app.js getStream과 같은 값
  const CACHE_MARGIN_MS = 60000;          // app.js와 같은 "1분 이상 남아야 캐시 히트" 기준
  const PREFETCH_LEAD_SEC = 30;           // 곡 끝 30초 전에 한 번 더 확인

  // app.js의 전역은 let이라 window의 속성이 아니다. 같은 클래식 스크립트끼리는 이름으로
  // 그냥 보이지만, 없을 때 ReferenceError로 죽지 않게 전부 감싸서 읽는다
  // (playback-guard.js와 같은 방식. eval은 쓰지 않는다 — CSP가 붙으면 통째로 죽는다).
  const G = {
    playingPl:   () => { try { return typeof playingPl   === 'undefined' ? undefined : playingPl;   } catch { return undefined; } },
    currentTrack:() => { try { return typeof currentTrack === 'undefined' ? undefined : currentTrack;} catch { return undefined; } },
    playlists:   () => { try { return typeof playlists    === 'undefined' ? undefined : playlists;   } catch { return undefined; } },
    shuffle:     () => { try { return typeof shuffle      === 'undefined' ? undefined : shuffle;     } catch { return undefined; } },
    repeatMode:  () => { try { return typeof repeatMode   === 'undefined' ? undefined : repeatMode;  } catch { return undefined; } },
    streamCache: () => { try { return typeof streamCache  === 'undefined' ? undefined : streamCache; } catch { return undefined; } }
  };

  // ── 1. 다음 곡 스트림 주소 미리 받기 ────────────────────────────────────────

  // nextTrack()이 고를 인덱스를 그대로 계산한다(app.js:1239). 셔플은 난수라 예측 불가.
  function predictNextYtUrl() {
    const pl = G.playingPl();
    const cur = G.currentTrack();
    const lists = G.playlists();
    if (typeof pl !== 'number' || pl < 0 || typeof cur !== 'number' || cur < 0) return null;
    if (!lists || !lists[pl] || !lists[pl].tracks || !lists[pl].tracks.length) return null;
    if (G.shuffle() === true) return null;           // 난수 — 미리 받아둘 대상이 없다
    const repeat = G.repeatMode();
    if (repeat === 2) return null;                   // 한곡반복은 같은 주소를 다시 쓴다
    const tracks = lists[pl].tracks;
    // 반복 꺼짐 + 목록 끝이면 app.js는 다음 곡으로 안 넘어간다(onended에서 정지).
    if (repeat === 0 && cur === tracks.length - 1) return null;
    const t = tracks[(cur + 1) % tracks.length];
    return (t && t.ytUrl) || null;
  }

  function cachedAlive(ytUrl) {
    const cache = G.streamCache();
    if (!cache) return false;
    const c = cache[ytUrl];
    return !!(c && c.expireTs > Date.now() + CACHE_MARGIN_MS);
  }

  // 받아둔 토큰 주소가 실제로 살아있는지 1~2바이트만 찔러본다. 죽어있으면(만료 403 →
  // 프록시가 410) 캐시에서 빼서, 정작 곡이 넘어갈 때 playTrack이 새로 받아오게 한다.
  // 겸사겸사 폰↔맥미니 연결이 미리 열려서 첫 바이트가 더 빨리 온다.
  //
  // ⚠️ "죽었다"와 "확인을 못 했다"를 반드시 구분한다(2026-08-21 프로브에서 실제로 걸린 실수).
  // 폰은 지하철·엘리베이터에서 fetch가 그냥 던진다. 그때 받아둔 주소까지 같이 버리면
  // 미리 받기가 통째로 무효가 되어(=예전과 똑같은 무음 구간) 고치려던 걸 도로 망가뜨린다.
  // 서버가 명시적으로 4xx/5xx를 준 경우에만 버린다.
  async function warmUp(streamUrl) {
    try {
      const res = await fetch(streamUrl, {
        headers: { Range: 'bytes=0-1' },
        credentials: 'same-origin',
        cache: 'no-store'
      });
      try { res.body && res.body.cancel && res.body.cancel(); } catch {}
      return res.status < 400 ? 'alive' : 'dead';
    } catch { return 'unknown'; }
  }

  let inFlight = '';
  async function prefetchNext() {
    const ytUrl = predictNextYtUrl();
    if (!ytUrl) return;
    if (cachedAlive(ytUrl)) return;
    if (inFlight === ytUrl) return;
    inFlight = ytUrl;
    try {
      // window.api.getStream은 시임에서 soft() 래퍼라 실패해도 던지지 않고 {error}를 준다.
      const res = await window.api.getStream(ytUrl);
      if (!res || res.error || !res.streamUrl) return;
      const cache = G.streamCache();
      if (!cache) return;
      cache[ytUrl] = { url: res.streamUrl, expireTs: Date.now() + CACHE_TTL_MS };
      const state = await warmUp(res.streamUrl);
      if (state === 'dead' && cache[ytUrl] && cache[ytUrl].url === res.streamUrl) delete cache[ytUrl];
    } catch { /* 미리 받기 실패는 종전 동작(전환 시점에 받기)으로 돌아갈 뿐이다 */ }
    finally { if (inFlight === ytUrl) inFlight = ''; }
  }

  // 언제 부르는가: 타이머가 아니라 "미디어 이벤트"에 얹는다. 백그라운드에서 setInterval은
  // 초당 1회 이하로 조여들지만, 재생 중인 오디오의 이벤트는 그대로 나온다.
  audio.addEventListener('loadedmetadata', () => { prefetchNext(); });  // 곡이 시작하자마자
  audio.addEventListener('playing', () => { prefetchNext(); });

  // 곡 도중에 큐가 늘어나거나(자동추천 보충) 반복/셔플이 바뀌었을 수 있으니 끝나기 전에 한 번 더.
  let leadDone = '';
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    if (d - audio.currentTime > PREFETCH_LEAD_SEC) return;
    const key = (G.playingPl()) + ':' + (G.currentTrack());
    if (leadDone === key) return;
    leadDone = key;
    prefetchNext();
  });

  // ── 2. 브라우저의 재생 거절을 app.js로 흘려보내지 않기 ──────────────────────
  //
  // NotAllowedError = "사용자 제스처 없이 새 재생을 시작할 수 없다"(백그라운드 전환의
  // 전형적인 실패). AbortError = "새 load 요청이 이전 play()를 잘랐다".
  // 둘 다 "이 곡이 고장났다"는 뜻이 절대 아닌데, app.js는 구분하지 못하고 자동추천곡을
  // 3개까지 버린 뒤 멈춘다. 그래서 여기서 삼키고, 대신 우리가 되살린다.
  function isBrowserRefusal(err) {
    const n = err && err.name;
    return n === 'NotAllowedError' || n === 'AbortError' || n === 'SecurityError';
  }

  let pendingResume = false;

  function markBlocked() {
    pendingResume = true;
    // 화면과 잠금화면에는 정직하게 "멈춤"으로 보여준다. 소리가 안 나는데 재생 아이콘만
    // 돌아가면 형이 원인을 알 수 없다. app.js는 play()가 성공한 줄 알고 isPlaying=true를
    // 세팅하므로, 그 마이크로태스크 뒤에 되돌린다(mobile-boot.js와 같은 수법).
    setTimeout(() => {
      try {
        if (!pendingResume) return;
        if (typeof isPlaying !== 'undefined') isPlaying = false;
        if (typeof setPlayIcon === 'function') setPlayIcon(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      } catch {}
    }, 0);
  }

  function tryResume() {
    if (!pendingResume) return;
    if (!audio.src) { pendingResume = false; return; }
    if (!audio.paused) { pendingResume = false; return; }
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        // ⚠️ 이 promise는 아래 guardedPlay를 거쳐 오기 때문에, 또 거절당했어도 "성공"으로
        // 풀린다(그게 자동 스킵을 막는 장치다). 그래서 성공 여부는 promise가 아니라
        // 실제 상태로 판단해야 한다 — 아직 멈춰 있으면 켜졌다고 표시하면 안 된다.
        if (audio.paused) return;   // 여전히 거절 — pendingResume은 그대로 두고 다음 기회에
        pendingResume = false;
        try {
          if (typeof isPlaying !== 'undefined') isPlaying = true;
          if (typeof setPlayIcon === 'function') setPlayIcon(true);
          if (typeof renderTrackList === 'function') renderTrackList();
        } catch {}
      }, () => { /* 아직도 안 되면 다음 기회에 */ });
    }
  }

  // mobile-boot.js는 첫 사용자 조작 때 audio.play를 원본으로 되돌린다. 단순히 한 번
  // 감싸두면 그 순간 가드가 통째로 벗겨진다. 접근자를 심어서, 누가 audio.play에 무엇을
  // 넣든 바깥에서는 항상 가드로 감싼 함수가 보이게 만든다.
  let inner = audio.play.bind(audio);

  function guardedPlay() {
    let p;
    try { p = inner.apply(audio, arguments); }
    catch (e) { return Promise.reject(e); }
    if (!p || typeof p.then !== 'function') { pendingResume = false; return p; }
    return p.then(
      (v) => { pendingResume = false; return v; },
      (err) => {
        if (!isBrowserRefusal(err)) throw err;  // 진짜 재생 오류는 종전대로 app.js가 처리
        markBlocked();
        return undefined;                       // app.js에는 성공으로 보이게 한다
      }
    );
  }

  try {
    Object.defineProperty(audio, 'play', {
      configurable: true,
      get() { return guardedPlay; },
      set(v) { if (typeof v === 'function') inner = v.bind(audio); }
    });
  } catch {
    // 접근자를 못 심는 엔진이면 최소한 한 번은 감싸둔다.
    audio.play = guardedPlay;
  }

  // 되살릴 기회: 전부 "형이 폰을 만지는 순간"이다. 타이머에 기대지 않는다.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tryResume(); });
  window.addEventListener('pageshow', tryResume);
  window.addEventListener('focus', tryResume);
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(ev, tryResume, { capture: true });
  }
  // 잠금화면 재생버튼은 mediasession.js가 togglePlay로 이어주지만, 그 경로가 막힌
  // 브라우저를 대비해 한 번 더 걸어둔다(같은 액션에 두 번 걸리지 않도록 pendingResume로 자체 차단).
  if ('mediaSession' in navigator) {
    audio.addEventListener('play', () => { pendingResume = false; });
  }
})();
