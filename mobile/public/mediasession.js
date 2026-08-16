// K-Music 모바일 — 잠금화면/알림창 재생 컨트롤(MediaSession API)
//
// 폰에서 음악앱의 실질적인 조작 지점은 앱 화면이 아니라 잠금화면과 알림창이다. 그게 없으면
// 곡 하나 넘길 때마다 화면을 켜고 브라우저로 들어가야 해서 사실상 못 쓴다. 데스크톱 앱에는
// 이 코드가 아예 없었다(창이 늘 보이니 필요가 없었음).
//
// 왜 app.js를 안 고치고 여기서 처리하나:
// app.js는 클래식 스크립트라 최상위 let/function이 전부 전역 스코프에 있다. 즉 이 파일에서
// playlists/playingPl/currentTrack을 읽고 togglePlay()/nextTrack()/prevTrack()/seekBy()를
// 그대로 부를 수 있다. 그래서 app.js 본문을 건드리지 않고 바깥에서 얹기만 하면 된다.
//
// ⚠️ 실기 검증이 안 된 부분: 잠금화면 표시와 백그라운드 재생 유지는 iOS/안드로이드 실제
//    기기에서만 확인 가능하다(합격기준 D5~D7). 맥미니에서는 여기까지가 한계다.

(function () {
  'use strict';

  if (!('mediaSession' in navigator)) return;

  const audio = document.getElementById('audio');
  if (!audio) return;

  const ms = navigator.mediaSession;

  // 지금 재생 중인 곡을 app.js의 전역 상태에서 읽어온다. app.js 구조가 바뀌어 변수가
  // 사라지면 조용히 아무것도 안 하도록(=재생 자체는 멀쩡하도록) 전부 방어적으로 접근한다.
  function currentTrackObj() {
    try {
      if (typeof playlists === 'undefined' || typeof playingPl === 'undefined' || typeof currentTrack === 'undefined') return null;
      if (playingPl < 0 || currentTrack < 0) return null;
      const pl = playlists[playingPl];
      return (pl && pl.tracks && pl.tracks[currentTrack]) || null;
    } catch { return null; }
  }

  // 유튜브 썸네일은 원본 하나뿐이라 크기별 파일이 없다. 안드로이드/iOS가 알아서 리사이즈
  // 하도록 같은 URL을 여러 크기로 신고한다 — sizes를 하나만 주면 기기에 따라 아예 이미지를
  // 안 띄우는 경우가 있다.
  function artworkFor(url) {
    if (!url) return [];
    return ['96x96', '192x192', '256x256', '384x384', '512x512'].map(sizes => ({
      src: url, sizes, type: 'image/jpeg'
    }));
  }

  let lastKey = '';
  function syncMetadata() {
    const t = currentTrackObj();
    if (!t) {
      ms.metadata = null;
      lastKey = '';
      return;
    }
    const key = (t.ytUrl || '') + '|' + (t.title || '');
    if (key === lastKey) return; // 같은 곡이면 매번 새로 만들지 않는다(깜빡임 방지)
    lastKey = key;
    ms.metadata = new MediaMetadata({
      title: t.title || 'K-Music',
      artist: t.channel || '',
      album: 'K-Music',
      artwork: artworkFor(t.thumbnail)
    });
  }

  function syncPosition() {
    if (typeof ms.setPositionState !== 'function') return;
    const d = audio.duration;
    // duration이 아직 안 잡혔거나(NaN) 스트리밍 중 무한대면 setPositionState가 예외를 던진다.
    if (!isFinite(d) || d <= 0) return;
    try {
      ms.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(audio.currentTime || 0, 0), d)
      });
    } catch { /* 브라우저별로 까다로워서 실패해도 무시 — 재생에는 영향 없음 */ }
  }

  function call(fnName) {
    const fn = window[fnName];
    if (typeof fn === 'function') { try { fn(); } catch {} }
  }

  // ── 잠금화면 버튼 ─────────────────────────────────────────────────────────────
  // togglePlay()는 app.js가 이미 "재생 중이면 멈추고 아니면 재생"으로 구현해뒀다. 잠금화면
  // play/pause는 각각 따로 오지만, 그 시점의 audio.paused 상태와 항상 일치하므로 그대로 쓴다.
  const handlers = {
    play: () => { if (audio.paused) call('togglePlay'); },
    pause: () => { if (!audio.paused) call('togglePlay'); },
    previoustrack: () => call('prevTrack'),
    nexttrack: () => call('nextTrack'),
    seekbackward: (d) => {
      const off = (d && d.seekOffset) || 10;
      if (typeof seekBy === 'function') seekBy(-off);
    },
    seekforward: (d) => {
      const off = (d && d.seekOffset) || 10;
      if (typeof seekBy === 'function') seekBy(off);
    },
    seekto: (d) => {
      if (!d || typeof d.seekTime !== 'number') return;
      if (d.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
      syncPosition();
    },
    stop: () => { if (typeof stopAudio === 'function') stopAudio(); }
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, handler); }
    catch { /* 브라우저가 모르는 액션은 조용히 넘어간다 */ }
  }

  // ── 상태 동기화 ───────────────────────────────────────────────────────────────
  audio.addEventListener('play', () => { ms.playbackState = 'playing'; syncMetadata(); syncPosition(); });
  audio.addEventListener('pause', () => { ms.playbackState = 'paused'; syncPosition(); });
  audio.addEventListener('loadedmetadata', () => { syncMetadata(); syncPosition(); });
  audio.addEventListener('durationchange', syncPosition);
  audio.addEventListener('seeked', syncPosition);
  audio.addEventListener('emptied', () => { ms.playbackState = 'none'; syncMetadata(); });

  // 위치 갱신은 잠금화면 진행바용이라 자주 할 필요가 없다 — 5초마다면 충분하고,
  // 배터리도 아낀다(app.js의 ontimeupdate에 얹으면 초당 4회씩 불린다).
  setInterval(() => { if (!audio.paused) syncPosition(); }, 5000);

  // 곡이 바뀌는 건 app.js가 playTrack에서 audio.src를 갈아끼우는 시점인데, 그때 발생하는
  // 이벤트가 브라우저마다 조금씩 달라서(loadstart/loadedmetadata) 한 박자 늦게 한 번 더 확인.
  audio.addEventListener('loadstart', () => setTimeout(syncMetadata, 0));
})();
