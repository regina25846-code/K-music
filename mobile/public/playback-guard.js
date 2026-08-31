// K-Music 모바일 — 재생 끊김 감시 + 자동추천 큐 유지
//
// 왜 이 파일이 필요한가(2026-08-18, 형의 1시간 연속재생 테스트 사후 분석):
// 재생기록 파일을 대조해보니, 멈춘 지점이 "재생목록 끝"이 아니었다. 284초짜리 곡의 131초
// 지점에서 소리가 끊겼고, 큐에는 다음 곡이 3개나 그대로 남아 있었으며, 그 뒤로는 완주도
// 스킵도 다음곡 재생도 기록이 하나도 없다. 즉 오디오 엘리먼트가 곡 중간에 죽었고 아무도
// 그걸 몰랐다.
//
// 그럴 만했다 — app.js에는 audio의 error/stalled/waiting 핸들러가 하나도 없다. 데스크톱은
// 유튜브 주소를 브라우저가 직접 물고 재생해서 크롬이 알아서 재시도해주지만, 모바일은
// 맥미니 프록시(/audio/<토큰>)를 거치기 때문에 중간이 끊기는 경로가 하나 더 늘어난다.
// 실제로 프록시 쪽에도 20초 유휴 타임아웃 버그가 있어서 그걸 고쳤지만(streamproxy.js 참고),
// 원인이 무엇이든 "소리가 멈췄는데 아무도 안 살펴본다"는 구조 자체가 문제다.
//
// 그래서 여기서 두 가지를 바깥에서 감시한다. app.js는 한 줄도 안 고친다.
//   1) 재생 감시견: 재생 중인데 진도가 안 나가면 같은 위치에서 스트림을 새로 받아 이어붙인다.
//   2) 큐 유지: app.js는 큐 보충을 곡이 바뀌는 순간 딱 한 번만 시도하고, 실패하면 다음 곡까지
//      재시도가 없다. 주기적으로 한 번 더 두드려서 "한 번 실패 = 그날 끝"을 없앤다.
//
// ⚠️ 실기 검증은 형 몫이다(맥미니에서는 폰 백그라운드 상태를 못 만든다).

(function () {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;

  const CHECK_MS = 4000;          // 감시 주기
  const STALL_MS = 12000;         // 이만큼 진도가 안 나가면 끊긴 걸로 판정
  const QUEUE_CHECK_MS = 30000;   // 큐 보충 재시도 주기
  const MAX_RETRY_PER_TRACK = 3;  // 같은 곡에서 이만큼 실패하면 다음 곡으로 넘긴다
  const NEAR_END_SEC = 1.5;       // 사실상 끝까지 재생된 것으로 볼 여유

  // app.js의 전역은 let으로 선언돼서 window의 속성이 아니다. 같은 클래식 스크립트끼리는
  // 이름으로 그냥 보이지만, 없을 때 ReferenceError로 죽지 않게 전부 감싸서 읽는다.
  function state() {
    try {
      if (typeof playingPl === 'undefined' || typeof currentTrack === 'undefined' ||
          typeof playlists === 'undefined' || typeof isPlaying === 'undefined') return null;
      if (playingPl < 0 || currentTrack < 0) return null;
      const tracks = playlists[playingPl] && playlists[playingPl].tracks;
      if (!tracks || !tracks[currentTrack]) return null;
      return { tracks, idx: currentTrack, pl: playingPl, playing: isPlaying };
    } catch { return null; }
  }

  // 스트림을 새로 받아오는 중(로딩 오버레이가 떠 있는 동안)에는 진도가 안 나가는 게 정상이다.
  function isLoading() {
    const el = document.getElementById('loading');
    return !!(el && el.classList.contains('show'));
  }

  let lastPos = -1;
  let lastProgressAt = Date.now();
  let retryKey = '';      // 어느 곡에서 몇 번 재시도했는지
  let retryCount = 0;
  let recovering = false;

  function noteProgress(pos) {
    lastPos = pos;
    lastProgressAt = Date.now();
  }

  // 같은 위치에서 스트림을 새로 받아 이어붙인다. playTrack은 캐시된 스트림 주소를 그대로
  // 쓰기 때문에(만료됐으면 내부 재시도가 강제로 새로 받아온다) 대개 1초 안에 되살아난다.
  function recover(reason) {
    const s = state();
    if (!s || recovering) return;

    const key = s.pl + ':' + s.idx + ':' + (s.tracks[s.idx].ytUrl || '');
    if (key !== retryKey) { retryKey = key; retryCount = 0; }

    recovering = true;
    // 다음 감시 때 곧바로 또 걸리지 않도록 시계를 미리 돌려둔다.
    lastProgressAt = Date.now();

    try {
      if (retryCount >= MAX_RETRY_PER_TRACK) {
        // 이 곡만 계속 안 되는 상황 — 조용히 멈춰있는 것보다 다음 곡으로 넘어가는 게 낫다.
        retryCount = 0;
        if (typeof nextTrack === 'function') nextTrack();
        return;
      }
      retryCount++;
      const pos = Math.max(0, (audio.currentTime || lastPos || 0) - 1); // 1초 겹쳐서 이어붙임
      if (typeof playTrack === 'function') playTrack(s.idx, s.pl, pos);
    } catch { /* 복구 시도 자체가 실패해도 다음 주기에 다시 본다 */ }
    finally {
      // playTrack은 비동기라 여기서 곧바로 풀면 중복 호출이 난다. 로딩이 끝날 시간을 준다.
      setTimeout(() => { recovering = false; }, 8000);
    }
  }

  // ── 1. 재생 감시견 ──────────────────────────────────────────────────────────
  function watchdog() {
    const s = state();
    if (!s || !s.playing) { noteProgress(audio.currentTime || 0); return; }
    if (recovering || isLoading()) { lastProgressAt = Date.now(); return; }

    // (a) 명시적 오류 — 기다릴 이유가 없다
    if (audio.error) { recover('error'); return; }

    const pos = audio.currentTime || 0;
    if (pos > lastPos + 0.25) { noteProgress(pos); return; } // 정상 재생 중

    const stuckMs = Date.now() - lastProgressAt;
    if (stuckMs < STALL_MS) return;

    const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;

    // (b) 사실상 끝까지 재생됐는데 ended가 안 온 경우. iOS 사파리에는 화면이 꺼져 있으면
    //     ended를 안 쏘는 오래된 버그가 있고, 잘린 스트림에서도 같은 모양이 된다.
    if (dur && pos >= dur - NEAR_END_SEC) {
      lastProgressAt = Date.now();
      if (typeof nextTrack === 'function') nextTrack();
      return;
    }

    // (c) 곡 중간에서 멈춤. 다만 "버퍼는 멀쩡한데 멈춘 것"(전화 수신 등 시스템이 끼어들어
    //     일시정지시킨 경우)까지 되살리면 통화 중에 소리가 다시 나는 꼴이 된다. 버퍼가
    //     남아있는 정상 일시정지(readyState 4)는 건드리지 않는다.
    if (audio.paused && audio.readyState >= 3) { lastProgressAt = Date.now(); return; }

    recover(audio.paused ? 'paused-dry' : 'stalled');
  }

  // ── 2. 자동추천 큐 유지 ─────────────────────────────────────────────────────
  // app.js의 maybeExtendQueue는 곡이 바뀌는 순간에만 불리고, 그때 네트워크가 잠깐 나빴으면
  // 다음 곡으로 넘어갈 때까지(=몇 분) 재시도가 없다. 여기서 주기적으로 한 번 더 두드린다.
  // maybeExtendQueue 자체가 "꼬리가 3곡 이상이면 즉시 반환"이라 헛돌지 않는다.
  function keepQueueFilled() {
    const s = state();
    if (!s || !s.playing) return;
    try { if (typeof maybeExtendQueue === 'function') maybeExtendQueue(s.pl); } catch {}
  }

  // ⚠️ 30초 setInterval만으로는 부족하다(2026-08-31 수정) — 폰 브라우저는 백그라운드에서
  // 타이머를 조여들게 하고(수 분까지), 그 상태에서는 이 안전망 자체가 안 돈다. 그래서
  // gapless.js의 프리페치와 같은 수법으로 "재생 중인 오디오의 미디어 이벤트"에도 얹는다 —
  // timeupdate는 백그라운드에서도 소리가 나는 동안 계속 발화하므로, 재생 중인 한 큐 점검이
  // 반드시 주기적으로 돈다(이중화 — setInterval은 포그라운드용으로 그대로 둔다).
  let lastQueueCheckAt = 0;
  audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastQueueCheckAt < QUEUE_CHECK_MS) return;
    lastQueueCheckAt = now;
    keepQueueFilled();
  });

  // 재생목록 맨 끝 곡이 끝나면 app.js는 nextTrack을 부르지 않고 조용히 멈춘다(반복 꺼짐일 때).
  // 큐를 못 채운 채 끝에 닿았다는 뜻이므로, 마지막으로 한 번 더 채워보고 이어서 재생한다.
  //
  // 2026-08-31 보강: 예전엔 이 캐치올이 ended 직후 딱 1회였다 — 그 순간 네트워크가 나빴으면
  // (백그라운드 전환 직후 라디오가 내려간 폰에서 흔함) 재시도 기회 없이 재생이 영구 정지했다.
  // 실패하면 8초 간격으로 몇 번 더 두드리고(백그라운드 타이머가 이 간격을 늘려도 "언젠가는"
  // 돈다), 형이 화면을 다시 보는 순간(visibilitychange)에도 즉시 한 번 더 시도한다.
  var END_REFILL_RETRY_MS = 8000;
  var END_REFILL_MAX_TRIES = 6;
  let endRefillTimer = null;
  let endRefillTries = 0;

  async function refillAtEnd() {
    const s = state();
    if (!s || s.playing) { endRefillTries = 0; return; } // 이미 다음 곡으로 넘어갔으면 할 일 없음
    if (typeof repeatMode !== 'undefined' && repeatMode !== 0) return;
    if (s.idx !== s.tracks.length - 1) return;    // 끝 곡이 아니면 app.js가 알아서 처리한 것
    let extended = false;
    try {
      if (typeof maybeExtendQueue !== 'function') return;
      await maybeExtendQueue(s.pl);
      const after = state();
      if (after && !after.playing && after.idx < after.tracks.length - 1 && typeof nextTrack === 'function') {
        extended = true;
        endRefillTries = 0;
        nextTrack();
      }
    } catch {}
    if (!extended && endRefillTries < END_REFILL_MAX_TRIES) {
      endRefillTries++;
      clearTimeout(endRefillTimer);
      endRefillTimer = setTimeout(refillAtEnd, END_REFILL_RETRY_MS);
    }
  }

  audio.addEventListener('ended', () => {
    endRefillTries = 0;
    setTimeout(refillAtEnd, 0);
  });
  // 재생이 (어떤 경로로든) 다시 시작되면 끝곡 재시도는 더 필요 없다.
  audio.addEventListener('playing', () => {
    clearTimeout(endRefillTimer);
    endRefillTimer = null;
    endRefillTries = 0;
  });

  // 진도 추적은 감시 주기보다 촘촘하게 — 백그라운드에서 타이머가 느려져도 마지막으로 소리가
  // 났던 시점은 정확히 남는다.
  audio.addEventListener('timeupdate', () => { noteProgress(audio.currentTime || 0); });
  audio.addEventListener('playing', () => { noteProgress(audio.currentTime || 0); retryCount = 0; });
  audio.addEventListener('loadstart', () => { lastPos = -1; lastProgressAt = Date.now(); });
  // 브라우저가 명시적으로 오류를 알려주면 12초를 기다릴 이유가 없다.
  audio.addEventListener('error', () => { setTimeout(() => recover('error-event'), 1000); });

  setInterval(watchdog, CHECK_MS);
  setInterval(keepQueueFilled, QUEUE_CHECK_MS);

  // 화면이 꺼진 동안에는 브라우저가 타이머를 늦춘다(소리가 멈추면 몇 초 뒤부터 조여든다).
  // 형이 폰을 다시 켜서 화면을 보는 순간만큼은 즉시 한 번 확인해서, 돌아왔을 때 이미
  // 멈춰 있는 상황을 최대한 짧게 만든다.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { watchdog(); keepQueueFilled(); refillAtEnd(); }
  });
})();
