// K-Music 모바일 — 최소 서비스워커
//
// 존재 이유는 딱 하나다: 안드로이드 크롬이 "홈 화면에 추가"(설치) 배너를 띄우려면
// manifest 외에 "fetch 이벤트를 처리하는 서비스워커"가 반드시 있어야 한다.
//
// 캐싱은 일부러 전혀 하지 않는다:
//  - 오디오는 서명이 걸린 임시 주소를 프록시로 중계하는 것이라 캐시하면 곧 깨진 소리가 난다
//  - 재생목록/설정은 서버가 정본이라, 오래된 응답을 돌려주면 폰과 PC가 어긋난다
//  - 유튜브 오디오를 기기에 저장하는 형태가 되는 것 자체가 피해야 할 방향이다
// 그래서 그냥 네트워크로 그대로 흘려보내기만 한다.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  // 아무것도 가로채지 않고 브라우저 기본 동작에 맡긴다. 이 핸들러가 "존재한다"는 사실만으로
  // 설치 가능 조건이 충족된다.
  return;
});
