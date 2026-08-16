// K-Music 모바일 — 폰에서만 필요한 동작 보정
//
// app.js는 "마우스가 있는 데스크톱 창"을 전제로 짜여 있다. 폰에는 없는 두 가지 전제가
// 문제를 일으키는데, 둘 다 app.js를 고치지 않고 바깥에서 감싸서 해결한다.
//   1) 자동재생: 브라우저는 사용자가 화면을 한 번 건드리기 전에는 소리를 못 내게 막는다.
//   2) 우클릭: 곡별 메뉴가 oncontextmenu에 걸려 있는데, 폰에는 우클릭이 없다.
//
// ⚠️ 실기 검증 안 됨(2026-08-16 작성 시점). 실제 아이폰/안드로이드에서의 확인은 형 몫이다.

(function () {
  'use strict';

  const audio = document.getElementById('audio');

  // ── 1. 자동재생 차단 대응 ───────────────────────────────────────────────────
  // app.js는 시작할 때 "이어듣기 + 자동재생" 설정이 켜져 있으면 곧바로 playTrack()을 부르고,
  // 그 안에서 await audio.play()를 한다. 폰에서는 이게 NotAllowedError로 거절되는데, app.js의
  // 재생 실패 처리(3초 간격 3회 재시도 → 자동추천곡이면 다음 곡으로 스킵 → 실패 토스트)가
  // 그대로 돌아버린다. 즉 앱을 켜자마자 "재생 실패" 토스트가 뜨고 큐가 멋대로 넘어간다.
  //
  // 그래서 첫 사용자 조작 전까지는 play()를 "성공한 척하고 실제로는 재생하지 않는" 버전으로
  // 갈아끼운다. 곡 정보와 이어듣기 위치는 그대로 세팅되고, 화면만 "일시정지" 상태로 맞춰둔다.
  // 형이 재생 버튼을 누르는 순간 진짜 play()로 되돌아온다 — 폰 음악앱들이 다 이렇게 동작한다.
  if (audio) {
    let unlocked = false;
    const realPlay = audio.play.bind(audio);

    audio.play = function () {
      if (unlocked) return realPlay();
      // app.js의 playTrack은 이 promise가 풀린 "다음"에 isPlaying=true / 재생아이콘을 켠다.
      // setTimeout(0)은 그 마이크로태스크 체인보다 뒤에 실행되므로, 켜진 상태를 다시 끌 수 있다.
      setTimeout(() => {
        try {
          if (typeof isPlaying !== 'undefined') isPlaying = false;
          if (typeof setPlayIcon === 'function') setPlayIcon(false);
        } catch {}
      }, 0);
      return Promise.resolve();
    };

    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      audio.play = realPlay;
      // 여기서 곧바로 재생을 시작하지는 않는다. 첫 조작이 재생버튼이었다면 그 클릭이 이어서
      // togglePlay()를 부르며 자연스럽게 재생되고, 첫 조작이 스크롤 같은 거였다면 형이 의도한
      // 게 아니므로 갑자기 소리가 나면 안 된다.
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) {
      document.addEventListener(ev, unlock, { once: true, capture: true });
    }
  }

  // ── 2. 길게 누르기 → 곡별 메뉴 ──────────────────────────────────────────────
  // app.js는 곡 항목마다 el.oncontextmenu = e => showCtxMenu(e, i) 를 걸어둔다. 폰 브라우저도
  // 길게 누르면 contextmenu를 쏘긴 하지만 기기·브라우저마다 조건이 제각각이고(특히 iOS는
  // user-select:none이 걸린 요소에서 잘 안 뜬다), 대신 텍스트 선택/이미지 저장 팝업이 뜬다.
  // 그래서 직접 길게누르기를 감지해서 contextmenu 이벤트를 만들어 쏴준다.
  //
  // 주의: 곡 목록은 위아래로 끌면 순서를 바꾸는 드래그(attachTrackDrag)도 물려 있다. 손가락이
  // 조금이라도 움직이면 길게누르기를 취소해야 드래그와 안 싸운다.
  //
  // ⚠️ 그리고 곡 재생은 click이 아니라 pointerup으로 걸려 있다(2026-08-17 폴드7 실기에서 형이
  // "길게 누르면 메뉴가 뜨면서 그 곡이 같이 재생된다"고 발견). app.js의 attachTrackDrag는
  // document에 pointerup을 걸어두고, 손가락이 드래그 문턱(6px)을 안 넘었으면 손을 떼는 순간
  // 곧바로 playTrack()을 부른다. 아래쪽 "click 한 번 삼키기"는 click만 막기 때문에 이 경로를
  // 전혀 건드리지 못했다 — 그래서 메뉴와 재생이 같이 일어났다.
  //
  // 해결: pointerup을 막지 않는다. 막으면 attachTrackDrag의 cleanup()이 영영 안 돌아서
  // document에 리스너가 계속 쌓이고, 다음에 아무 곡이나 탭했을 때 남아있던 옛 onUp이 같이
  // 터져서 엉뚱한 곡이 재생된다. 대신 app.js가 이미 갖고 있는 탈출구인 pointercancel을 쏜다 —
  // onCancel은 리스너를 정리만 하고 재생은 하지 않는다. app.js는 한 줄도 안 고친다.
  const LONG_PRESS_MS = 500;
  const MOVE_CANCEL_PX = 8;

  let pressTimer = null;
  let startX = 0, startY = 0;
  let firedLongPress = false;

  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }

  // 진행 중인 드래그 제스처를 "취소된 것"으로 만들어 app.js의 재생 트리거를 무력화한다.
  function cancelGesture(target, e) {
    let ev;
    try {
      ev = new PointerEvent('pointercancel', {
        bubbles: true, cancelable: false,
        pointerId: e.pointerId, pointerType: e.pointerType,
        clientX: startX, clientY: startY
      });
    } catch {
      ev = new Event('pointercancel', { bubbles: true }); // PointerEvent 생성자가 없는 구형 엔진
    }
    target.dispatchEvent(ev);
  }

  document.addEventListener('pointerdown', e => {
    // 지난번 길게누르기의 잔여 플래그는 어디를 누르든 먼저 지운다. 이 줄이 아래 early return
    // 뒤에 있으면, 길게 누른 다음 재생버튼처럼 목록 바깥을 탭했을 때 그 탭이 삼켜진다.
    firedLongPress = false;
    cancelPress();

    if (e.pointerType === 'mouse') return; // 마우스는 진짜 우클릭이 있으니 건드리지 않는다
    const target = e.target.closest('.track-item, .s-item');
    if (!target) return;

    startX = e.clientX; startY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      firedLongPress = true;
      // 길게 눌렀다는 걸 손끝으로 알려준다(지원하는 기기에서만)
      try { navigator.vibrate?.(15); } catch {}
      // 순서가 중요하다: 먼저 드래그/재생 제스처를 취소하고, 그 다음에 메뉴를 띄운다.
      cancelGesture(target, e);
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: startX, clientY: startY
      }));
    }, LONG_PRESS_MS);
  }, { passive: true });

  document.addEventListener('pointermove', e => {
    if (!pressTimer) return;
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) {
      cancelPress(); // 드래그로 순서 바꾸는 중 — 메뉴를 띄우면 안 된다
    }
  }, { passive: true });

  document.addEventListener('pointerup', cancelPress, { passive: true });
  document.addEventListener('pointercancel', cancelPress, { passive: true });

  // app.js에는 document 전체에 click → hideCtx가 걸려 있다. 길게 누른 손을 떼면 브라우저가
  // click을 한 번 더 쏘기 때문에, 그대로 두면 메뉴가 뜨자마자 도로 닫힌다. 길게누르기 직후의
  // 클릭 한 번만 캡처 단계에서 삼킨다.
  document.addEventListener('click', e => {
    if (!firedLongPress) return;
    firedLongPress = false;
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  // ── 3. 서비스워커 등록(안드로이드 설치용) ───────────────────────────────────
  // 크롬이 "홈 화면에 추가" 설치 배너를 띄우려면 manifest 말고 fetch 핸들러를 가진
  // 서비스워커도 있어야 한다. 캐싱은 일부러 하지 않는다 — 오디오/추천은 전부 실시간이고,
  // 잘못 캐시하면 옛날 재생목록이 남아서 더 헷갈린다.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // ── 4. iOS 더블탭 확대 방지 ─────────────────────────────────────────────────
  // maximum-scale=1은 iOS 접근성 설정에 따라 무시된다. 재생/다음곡을 빠르게 두 번 누를 때
  // 화면이 확대돼버리는 걸 막는다(300ms 안에 같은 자리를 두 번 탭한 경우만).
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd < 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
})();
