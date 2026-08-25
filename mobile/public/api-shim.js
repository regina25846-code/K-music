// K-Music 모바일 — window.api 시임(shim)
//
// 데스크톱에서는 preload.js가 contextBridge로 window.api를 심어주고, 그 안은 전부
// electron IPC다. 브라우저에는 IPC가 없으니 같은 이름·같은 모양의 함수들을 fetch로 다시
// 구현한다. app.js는 자기가 electron 위에 있는지 브라우저 위에 있는지 알 필요가 없다 —
// 그래서 app.js 본문은 한 줄도 안 고친다.
//
// ⚠️ 이 파일은 반드시 app.js보다 먼저 로드돼야 한다. app.js가 로드 시점에 곧바로
//    window.api.onUpdateAvailable(...) 같은 걸 부르기 때문에, 그때 window.api가 없으면
//    스크립트 전체가 그 자리에서 죽는다(=화면이 통째로 안 뜸). server.js가 주입 순서를
//    보장한다.

(function () {
  'use strict';

  const RPC_URL = '/api/rpc';

  // 폰에서는 fetch가 "실패"하는 대신 "영원히 안 끝나는" 경우가 실제로 생긴다(화면 끄는 순간
  // 와이파이↔LTE가 바뀌거나 절전으로 라디오가 내려가면, 이미 나가 있던 요청이 거절도 응답도
  // 없이 매달려 있는다). 그런데 app.js의 큐 보충(maybeExtendQueue)은 extendingQueue 플래그를
  // finally에서만 내리기 때문에, 요청 하나가 영영 안 끝나면 그 플래그가 true로 굳어서
  // 그 뒤로는 자동추천 채워넣기가 통째로 죽는다. 그래서 시임 단계에서 상한을 건다.
  // 서버 쪽 최장 작업이 yt-dlp(30초 상한)라서 60초면 정상 요청을 자를 위험이 없다.
  const RPC_TIMEOUT_MS = 60000;

  function timeoutSignal() {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(RPC_TIMEOUT_MS);
      }
      const ac = new AbortController();
      setTimeout(() => { try { ac.abort(); } catch {} }, RPC_TIMEOUT_MS);
      return ac.signal;
    } catch { return undefined; }
  }

  async function rpc(method, ...args) {
    let res;
    try {
      res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: timeoutSignal(),
        body: JSON.stringify({ method, args })
      });
    } catch (e) {
      // 폰은 지하철/엘리베이터에서 수시로 끊긴다. 여기서 예외를 그대로 던지면 app.js의
      // 재시도 로직(3초 간격 3회)이 그대로 받아주므로, 형식만 맞춰서 올려보낸다.
      throw new Error('네트워크에 연결할 수 없어요');
    }

    // 세션이 만료되면 서버가 401을 준다. 조용히 실패하면 "아무것도 안 되는 화면"이 되므로
    // 로그인 화면으로 되돌린다.
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('로그인이 필요해요');
    }

    let data;
    try { data = await res.json(); }
    catch { throw new Error('서버 응답을 읽지 못했어요'); }

    if (!data || data.ok !== true) throw new Error((data && data.error) || 'server_error');
    return data.result;
  }

  // main.js의 IPC 핸들러들은 실패를 예외로 던지지 않고 { error } 객체로 돌려주는 규약이라
  // (app.js가 그걸 보고 분기한다), 시임도 그 규약을 그대로 지킨다. 통신 자체가 실패한
  // 경우에도 같은 모양으로 감싸주는 래퍼.
  function soft(method, shape) {
    return async (...args) => {
      try { return await rpc(method, ...args); }
      catch (e) { return { ...(shape || {}), error: e.message }; }
    };
  }

  const noop = () => {};
  const noopAsync = async () => {};

  window.api = {
    // ── 서버가 실제로 처리하는 것들 ───────────────────────────────────────────
    getConfig: () => rpc('getConfig'),
    // ⚠️ saveConfig는 절대 예외를 던지면 안 된다(2026-08-18).
    // app.js의 playTrack()은 재생을 시작한 "뒤" try 블록 안에서 await saveCfg(...)를 부른다.
    // 즉 소리는 이미 잘 나고 있는데 이 설정 저장 한 번이 네트워크 문제로 실패하면, 그 예외가
    // 재생 실패 catch로 떨어져서 자동추천곡을 멀쩡한 채로 건너뛰고(skipChain), 3번 반복되면
    // "재생 실패" 토스트와 함께 정지한다. 데스크톱은 IPC라 이런 실패가 없어서 안 드러났다.
    // 저장 실패는 마지막 재생위치가 조금 옛날 값으로 남는 정도의 문제라, 조용히 삼키는 쪽이
    // 항상 낫다(다음 저장이 5초 뒤에 또 온다).
    saveConfig: soft('saveConfig', { ok: false }),
    getPlaylists: () => rpc('getPlaylists'),
    savePlaylists: (pl) => rpc('savePlaylists', pl),

    // quality 인자는 데스크톱에서도 이미 무시되는 값이라 그대로 안 보낸다.
    getStream: soft('getStream'),
    search: soft('search'),
    getVideoInfo: soft('getVideoInfo'),

    getLyrics: soft('getLyrics', { found: false }),
    searchLyricsManual: soft('searchLyricsManual', { found: false }),
    saveManualSync: (ytUrl, syncLines) => rpc('saveManualSync', ytUrl, syncLines),

    getActiveAccount: () => rpc('getActiveAccount'),
    registerAccount: (name, pin) => rpc('registerAccount', name, pin),
    changeAccountName: (newName) => rpc('changeAccountName', newName),
    changeAccountPin: (currentPin, newPin, resetMode) => rpc('changeAccountPin', currentPin, newPin, resetMode),
    setPersonalize: (on) => rpc('setPersonalize', on),
    toggleChannelBlock: (channel) => rpc('toggleChannelBlock', channel),
    getBlockedChannels: () => rpc('getBlockedChannels'),

    getRecommendations: async (seedYtUrl, excludeIds, count) => {
      // 추천이 실패해도 재생 자체는 계속돼야 한다(데스크톱도 같은 규약: 실패 시 빈 배열).
      try { return await rpc('getRecommendations', seedYtUrl, excludeIds, count); }
      catch { return []; }
    },
    getAnchorSeed: async (excludeItems, currentSeedId) => {
      // 못 고르면 null — 렌더러는 예전처럼 지금 재생 중인 곡을 시드로 쓴다(데스크톱과 같은 규약).
      try { return await rpc('getAnchorSeed', excludeItems, currentSeedId); }
      catch { return null; }
    },
    recordPlayEvent: async (ytUrl, meta, eventType) => {
      // 통계 기록이 실패했다고 재생을 방해하면 안 된다 — 조용히 삼킨다.
      try { return await rpc('recordPlayEvent', ytUrl, meta, eventType); }
      catch { return false; }
    },

    testYtApiKey: soft('testYtApiKey', { ok: false }),
    checkYtdlp: soft('checkYtdlp', { ok: false }),
    getAppVersion: async () => { try { return await rpc('getAppVersion'); } catch { return '?'; } },

    // ── 브라우저 기능으로 대체되는 것들 ───────────────────────────────────────
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    copyText: async (text) => {
      try { await navigator.clipboard.writeText(String(text || '')); return true; }
      catch { return false; }
    },

    // ── 데스크톱 창 제어 — 브라우저에는 대응물이 없어서 조용한 무동작 ─────────
    // 무동작이라도 "함수 자체는 반드시 존재"해야 한다. app.js가 이 이름들을 곧바로
    // 호출하기 때문에, 하나라도 빠지면 TypeError로 화면 전체가 안 뜬다.
    minimize: noopAsync,
    closeApp: noopAsync,
    quitApp: noopAsync,
    toggleFillHeight: noopAsync,
    toggleAlwaysOnTop: async () => false,
    setAlwaysOnTop: noopAsync,
    getLoginItem: async () => false,
    setLoginItem: noopAsync,
    openSettings: noopAsync,
    closeSettings: noopAsync,
    toggleMainWindow: noopAsync,
    tabDragStart: noopAsync,
    tabDragMove: noopAsync,
    tabDragEnd: noopAsync,

    // ── 자동 업데이트 — 웹에서는 새로고침이 곧 업데이트라 개념 자체가 없다 ───
    // 콜백 등록만 받아두고 절대 부르지 않는다(=업데이트 팝업이 안 뜬다).
    onUpdateAvailable: noop,
    onUpdateDownloaded: noop,
    onUpdateNotAvailable: noop,
    onUpdateError: noop,
    installUpdate: noopAsync,
    checkForUpdates: noopAsync,

    // ── 메인프로세스가 보내주던 이벤트들 — 브라우저에는 보낼 주체가 없다 ─────
    onSettingsClosed: noop,
    onOpenSettings: noop,
    onOpenAbout: noop,
    onSetTheme: noop,

    // ── 모바일에만 있는 것 ────────────────────────────────────────────────────
    isMobile: true,
    logout: async () => {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
      location.href = '/login';
    }
  };
})();
