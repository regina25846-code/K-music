'use strict';

const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// ── state ─────────────────────────────────────────────────────────────────────
let playlists = [];
let currentPl = 0;
let playingPl = -1;  // which playlist the currently-loaded track actually belongs to — separate
                      // from currentPl (whichever tab the user is just LOOKING at), since those
                      // can differ once you view a different playlist while something plays
let currentTrack = -1;
let playGen = 0; // playTrack() 재생 시도 세대 번호 — 3초 재시도 대기 중에 다른 곡을 누르면
                  // 오래된 재생 시도가 뒤늦게 깨어나 audio.src를 도로 덮어써서 화면과 소리가
                  // 어긋나던 문제 방지(오푸스 검토, 2026-08-16). playTrack() 참고.
let lastPosSaveTs = 0;
let isPlaying = false;
let repeatMode = 0;  // 0=off 1=all 2=one
let shuffle = false;
let config = {};
let streamCache = {};  // ytUrl -> { url, expireTs }
let currentAccount = null; // 2026-08-07 계정(로그인) 기능 추가 — { id, name, prefs, ... }, pinHash는 메인 프로세스가 절대 안 보내줌
let blockedChannels = new Set(); // 2026-08-08 추가 — 추천에서 제외한 채널(우클릭 메뉴로 토글), 계정 로드 시 채움

let inLyrics = false;
let lyricsState = null;   // { found, synced(parsed lines[] or null), plain, artist, title, ytUrl }
let lyricsForYtUrl = null; // 어느 트랙에 대한 lyricsState인지
let curLineIdx = -1;
let plainScrollOverride = false; // 텍스트전용 모드에서 형이 직접 휠로 스크롤하면 자동 진행률 스크롤을 멈춤
let plainScrollOffsetPx = 0;

const audio = document.getElementById('audio');

// ── refs ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const albumArt   = $('album-art');
const trackTitle = $('track-title');
const trackCh    = $('track-ch');
const progBar    = $('prog-bar');
const progFill   = $('prog-fill');
const tCur       = $('t-cur');
const tTot       = $('t-tot');
const btnPlay    = $('btn-play');
const volSlider  = $('vol');
const volTrack   = $('vol-track');
const plTabs     = $('pl-tabs');
const trackList  = $('track-list');
const loading    = $('loading');
const toastEl    = $('toast');
const artWrap    = $('art-wrap');
const artSeekFwd = $('art-seek-fwd');
const artSeekBack= $('art-seek-back');
const lyrPList   = $('lyr-p-list');
const lyrBadgeTx = $('lyr-preview-badge-text');
const lyrMask    = $('lyr-preview-mask');
const lyrResetLink = $('lyr-manual-sync-reset');
const volPct     = $('vol-pct');
const vuMeter    = $('vu');
const playerEl   = document.querySelector('.player');

// ── helpers ───────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v');
  } catch { return null; }
}

// 2026-08-07 추천 개인화용 — 곡을 재생목록에 넣는 모든 경로(URL 추가/검색 추가/검색 후 즉시재생)가
// 이 함수 하나로 통일. "직접 추가한 곡은 항상 자동추천보다 먼저 재생된다"는 규칙(형 확정)을 지키려면
// 항상 맨 뒤(push)가 아니라 꼬리에 붙어있는 auto 트랙들 "앞"에 꽂아야 한다. autoplayNow일 땐 그
// 시점부터 이전 시드곡 기준으로 짜여있던 자동추천 꼬리 자체가 의미 없어지므로 통째로 걷어낸다
// (형이 확정한 "새 곡 틀면 그 뒤로 그 곡에 맞는 리스트가 새로 생김" 시나리오).
function addManualTrack(plIdx, trackData, { autoplayNow = false } = {}) {
  const tracks = playlists[plIdx].tracks;
  const track = { ...trackData, source: 'manual' };
  // 바로 재생하지 않고 담아두기만 하는 곡은 스트림 주소를 미리 받아둔다(선행 워밍) —
  // 나중에 그 곡을 누르는 순간 로딩 없이 시작되게. 즉시재생(autoplayNow)은 playTrack이
  // 어차피 지금 바로 받아오므로 이중 스폰을 피해 건너뛴다.
  if (!autoplayNow) prefetchStream(track.ytUrl);
  if (autoplayNow && plIdx === playingPl && currentTrack >= 0) {
    let i = tracks.length - 1;
    while (i > currentTrack && (tracks[i].source || 'manual') === 'auto') { tracks.splice(i, 1); i--; }
    tracks.push(track);
    return tracks.length - 1;
  }
  let insertAt = tracks.length;
  if (plIdx === playingPl && currentTrack >= 0) {
    let i = tracks.length - 1;
    while (i > currentTrack && (tracks[i].source || 'manual') === 'auto') i--;
    insertAt = i + 1;
  }
  tracks.splice(insertAt, 0, track);
  return insertAt;
}

// 재생 중인 목록의 현재 곡 뒤에 아직 안 나온 "직접 추가한 곡"이 남아있으면 대기하고, 자동추천
// 꼬리가 3곡 미만으로 줄었을 때만 부족한 만큼 채워넣는다.
//
// 시드의 기본값은 "지금 실제로 재생중인 곡"이다 — 예전엔 큐에 마지막으로 넣어둔 곡을
// 다음 시드로 삼아서(체이닝), 채워질 때마다 그 3번째곡 → 또 그 3번째곡 하는 식으로 계속
// 이어붙였는데, 이러면 유튜브 믹스 특성상 몇 단계만 넘어가도 원래 곡과 전혀 상관없는 방향
// 으로 새버린다(형 실사용 중 발견, 2026-08-08 — 풀하우스 OST 듣다가 몇 단계 만에 인도네시아
// 밴드 노래로 도배됨). 매번 지금 듣고 있는 곡에서 다시 출발하면 드리프트가 누적되지 않는다.
//
// ── 시드 섞기(2026-08-22 신설) ────────────────────────────────────────────────
// 그런데 시드를 현재곡 하나로만 두면 반대쪽 실패가 생긴다. 이 함수는 꼬리를 3곡으로 유지하니까
// 한 곡 넘어갈 때마다 1곡씩 채우고, 그 1곡은 3칸 뒤에 꽂힌다 — 즉 큐가 서로 독립적인 3개
// 갈래로 굴러간다. 유튜브 믹스는 시드가 특정 가수의 공식채널 영상이면 후보가 사실상 그 가수로만
// 채워지므로(실측: BANGTANTV 시드 → 후보 19개 전부 BANGTANTV), 한 갈래가 그런 곡에 걸리면
// 그 갈래는 영원히 그 가수만 뱉는다. 형 실제 재생기록 2026-08-22 04:20~07:17의 45곡이
// `..B..B..B..B..B..B..B..B..B..B..BBBBBBBBBBBBB`(B=방탄) 였던 게 바로 이 3주기 구조의 흔적이고,
// 마지막엔 세 갈래가 전부 물들어 13곡 연속이 됐다.
//
// 그래서 매번은 아니고 일부 칸만 다른 시드에서 출발시켜 갈래끼리 섞이게 한다. 고정 비율로
// 기계적으로 바꾸는 게 아니라, ①평상시엔 낮은 확률로만 섞고 ②최근 자동추천이 실제로 한쪽에
// 쏠려 있으면 확률을 올리고 ③연속 두 번은 섞지 않는다(=최소 절반은 항상 지금 듣는 곡에서 출발).
// 쏠림이 없을 땐 예전과 거의 같게 굴러가고, 쏠릴수록 더 자주 빠져나온다.
//
// ⚠️ 이 "다른 시드"는 2026-08-08에 폐기한 체이닝이 아니다. 체이닝은 직전에 추천된 곡으로 시드가
// 한 걸음씩 옮겨가서 세대가 쌓일수록 원곡에서 멀어지는 구조였다. 여기서 쓰는 시드는 메인
// 프로세스가 "형이 실제로 끝까지 들은 곡 + 직접 재생목록에 넣은 곡"이라는 고정된 집합에서
// 매번 독립적으로 뽑아준다(main.js pickAnchorSeed) — 이전 선택에 의존하지 않으니 누적 드리프트가
// 원리적으로 생길 수 없고, 시드가 멀리 가는 게 아니라 매번 형 취향의 원점으로 되돌아온다.
let extendingQueue = false;
let lastFillUsedAnchor = false; // 연속 두 번 섞이는 것 방지

// 최근 자동추천 곡들이 한 채널로 얼마나 쏠려 있는지(0~1). 렌더러는 제목에서 가수를 뽑는
// 규칙(parseArtistTitle)을 갖고 있지 않으므로 채널 기준의 근사치만 본다 — 이건 "섞을 확률을
// 얼마나 올릴까"를 정하는 힌트일 뿐이고, 가수 단위 판단은 메인 프로세스가 시드를 고를 때 한다.
function recentAutoSkew(tracks, upto, window = 9) {
  const recent = [];
  for (let i = upto; i >= 0 && recent.length < window; i--) {
    if ((tracks[i]?.source || 'manual') === 'auto') recent.push(tracks[i]);
  }
  if (recent.length < 3) return 0;
  const counts = {};
  let top = 0;
  for (const t of recent) {
    const ch = t.channel || '(알 수 없음)';
    counts[ch] = (counts[ch] || 0) + 1;
    if (counts[ch] > top) top = counts[ch];
  }
  return top / recent.length;
}
async function maybeExtendQueue(plIdx) {
  if (!currentAccount || currentAccount.prefs?.personalizeRecommendations === false) return;
  if (extendingQueue) return;
  if (plIdx !== playingPl) return;
  const tracks = playlists[plIdx]?.tracks;
  if (!tracks || !tracks.length || currentTrack < 0) return;

  let autoTailCount = 0;
  for (let i = currentTrack + 1; i < tracks.length; i++) {
    if ((tracks[i].source || 'manual') === 'manual') return; // 아직 들을 직접추가곡이 남아있음 — 대기
    autoTailCount++;
  }
  if (autoTailCount >= 3) return;

  const seedId = videoIdFromUrl(tracks[currentTrack].ytUrl);
  if (!seedId) return;
  const need = 3 - autoTailCount;

  extendingQueue = true;
  try {
    // id뿐 아니라 title/duration/channel/source도 같이 보낸다 — title/duration은 같은 노래의
    // 다른 업로드(다른 id) 중복을 걸러내는 데, channel/source는 "최근 자동추천에 같은 가수/채널이
    // 너무 많이 몰렸으면 새 추천에서 순위를 낮추는" 판단에 메인 프로세스 쪽에서 쓰인다(2026-08-08).
    const excludeItems = tracks
      .map(t => ({ id: videoIdFromUrl(t.ytUrl), title: t.title, duration: t.duration, channel: t.channel, source: t.source || 'manual' }))
      .filter(x => x.id);

    // 이번 칸을 현재곡 말고 다른 데서 출발시킬지 결정(위 "시드 섞기" 주석 참고).
    let seedUrl = `https://www.youtube.com/watch?v=${seedId}`;
    let usedAnchor = false;
    // need가 2 이상인 건 큐가 비어있는 시작 시점(형이 방금 곡을 눌렀거나 직접 추가한 직후)이다.
    // 이때는 한 번의 호출로 꼬리 전체가 채워지므로, 여기서 시드를 바꾸면 형이 방금 고른 곡과
    // 상관없는 곡으로 큐가 통째로 덮인다 — 재즈 목록에서 실측했더니 9곡이 전부 케이팝이 됐다
    // (2026-08-22). 갈래가 한 가수에 물리는 건 어차피 need===1인 정상 주행 중에 생기는 일이라,
    // 섞기는 그때만 한다. 시작 시점엔 형이 고른 곡을 100% 따라간다.
    if (need === 1 && !lastFillUsedAnchor) {
      const skew = recentAutoSkew(tracks, currentTrack);
      const chance = skew >= 0.5 ? 0.7 : skew >= 0.34 ? 0.45 : 0.25;
      if (Math.random() < chance) {
        // 메인 프로세스가 지금 도배 중인 가수를 피해서 골라준다. 마땅한 게 없으면 null이라
        // 예전과 똑같이 현재곡으로 간다.
        const anchor = await window.api.getAnchorSeed(excludeItems, seedId);
        if (anchor) { seedUrl = anchor; usedAnchor = true; }
      }
    }

    const recs = await window.api.getRecommendations(seedUrl, excludeItems, need);
    if (!recs.length) return;
    lastFillUsedAnchor = usedAnchor;
    // await 도중 사용자가 다른 곡/목록으로 옮겨갔을 수 있으니 재확인 후 반영 — 예전엔 tracks
    // 배열 자체의 참조 동일성(!==)으로 비교했는데, pruneOldAutoTracks가 오래된 추천곡을
    // 정리할 때마다 filter로 배열을 새로 만들어서 참조가 매번 바뀐다. 큐가 정리 임계치(과거
    // 10곡+미래 3곡=13곡)에 도달해서 이 정리가 곡 넘어갈 때마다 같이 일어나기 시작하면, 매번
    // 이 체크에 걸려 방금 받아온 추천이 통째로 버려지고 있었다 — "13곡 정도 되면 추가 생성이
    // 안 된다"는 형 리포트의 원인(2026-08-08). 배열 참조 대신 "지금 재생 중인 곡이 여전히
    // 이 요청을 보낼 때의 시드곡과 같은가"로 판단하면 정리로 배열이 바뀌어도 안전하다.
    const curTracks = playlists[plIdx]?.tracks;
    if (playingPl !== plIdx || !curTracks) return;
    if (videoIdFromUrl(curTracks[currentTrack]?.ytUrl) !== seedId) return;
    recs.forEach(r => curTracks.push({ ytUrl: r.ytUrl, title: r.title, channel: r.channel, thumbnail: r.thumbnail, duration: r.duration, releaseYear: r.releaseYear, source: 'auto' }));
    await save();
    if (curView === 'home' && currentPl === plIdx) renderTrackList();
    // 방금 꼬리에 붙은 자동추천곡 중 "다음에 나올" 곡을 미리 받아둔다 — 큐가 방금
    // 생성/보충된 직후가 프리페치 최적 타이밍(형 요청, 2026-08-31 선행 워밍).
    warmQueueHead();
  } catch {
    // 네트워크 실패 등은 조용히 무시 — 다음 곡 넘어갈 때 다시 시도됨
  } finally {
    extendingQueue = false;
  }
}

// 이미 지나간(재생 완료/스킵된) 알고리즘 추천곡이 재생목록에 무한정 쌓이는 걸 막는다(형 요청,
// 2026-08-07) — 아직 안 나온 미래 추천 3곡(maybeExtendQueue가 관리)이나 형이 직접 넣은 곡은
// 절대 안 건드리고, currentTrack보다 앞에 있는 "auto" 트랙만 오래된 순으로 정리한다.
function pruneOldAutoTracks(plIdx, keep = 10) {
  const tracks = playlists[plIdx]?.tracks;
  if (!tracks || plIdx !== playingPl || currentTrack < 0) return;
  const pastAutoIdx = [];
  for (let i = 0; i < currentTrack; i++) {
    if ((tracks[i].source || 'manual') === 'auto') pastAutoIdx.push(i);
  }
  const removeCount = pastAutoIdx.length - keep;
  if (removeCount <= 0) return;
  const toRemove = new Set(pastAutoIdx.slice(0, removeCount)); // 가장 오래 전에 지나간 것부터
  playlists[plIdx].tracks = tracks.filter((t, i) => !toRemove.has(i));
  currentTrack -= toRemove.size; // 앞쪽에서 빠진 개수만큼 현재 인덱스도 당겨줌
  save();
  if (curView === 'home' && currentPl === plIdx) renderTrackList();
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}
function showLoad(msg='처리 중...') { $('loading-text').textContent = msg; loading.classList.add('show'); }
function hideLoad() { loading.classList.remove('show'); }

// 앨범아트 색을 뽑아서 now-playing 배경에 은은한 글로우로 반영 — 썸네일 CDN이 CORS를 안 열어주면
// 캔버스가 tainted 상태가 돼서 getImageData가 예외를 던짐. 그 경우 그냥 글로우 없이 기본색(--prog)으로 폴백.
async function updateGlowFromArt(src) {
  if (!src) { playerEl.style.removeProperty('--glow'); return; }
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const loaded = new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    img.src = src;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const rr = data[i], gg = data[i+1], bb = data[i+2];
      const lum = (rr + gg + bb) / 3;
      if (lum < 20 || lum > 240) continue; // 거의 검정/흰색 픽셀은 글로우색으로 부적합해서 제외
      r += rr; g += gg; b += bb; n++;
    }
    if (!n) { playerEl.style.removeProperty('--glow'); return; }
    playerEl.style.setProperty('--glow', `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`);
  } catch { playerEl.style.removeProperty('--glow'); }
}

// modal
let _modalRes = null;
function openModal(title, def='') {
  return new Promise(r => {
    $('modal-title').textContent = title;
    $('modal-input').value = def;
    $('modal').classList.add('show');
    $('modal-input').focus();
    _modalRes = r;
  });
}
function closeModal(v) { $('modal').classList.remove('show'); _modalRes?.(v); _modalRes = null; }
$('modal-ok').onclick = () => closeModal($('modal-input').value.trim());
$('modal-cancel').onclick = () => closeModal(null);
$('modal-input').onkeydown = e => { if(e.key==='Enter') closeModal($('modal-input').value.trim()); if(e.key==='Escape') closeModal(null); };

// ── 계정(로그인) ──────────────────────────────────────────────────────────────
// 2026-08-07 추가(kmusic_login_spec.md). 등록 없이는 아무것도 못 건드리게 firstrun-ov가
// 전체화면을 덮고, 등록되면 그 뒤로는 계정 고유 id로만 연결되므로 이름을 바꿔도 재생기록이
// 안 끊긴다(main.js account-* IPC 참고).
function updateAccountUi() {
  if (!currentAccount) return;
  $('account-name').textContent = currentAccount.name;
  const d = (currentAccount.createdAt || '').slice(0, 10);
  $('account-sub').textContent = d ? `${d} 등록 · 이 PC에만 저장` : '이 PC에만 저장';
  $('cfg-personalize').checked = currentAccount.prefs?.personalizeRecommendations !== false;
  $('personalize-sub').textContent = $('cfg-personalize').checked ? '재생 기록으로 믹스 추천 재정렬' : '꺼짐 · 유튜브 원래 순서 그대로';
}

const PIN_RE = /^[0-9]{4,6}$/;
function clearFirstrunErr() {
  $('firstrun-error').textContent = '';
  ['login-name-input', 'login-pin-input', 'login-pin-confirm'].forEach(id => $(id).classList.remove('err'));
}
function firstrunFail(msg, focusId) {
  $('firstrun-error').textContent = msg;
  if (focusId) { $(focusId).classList.add('err'); $(focusId).focus(); }
}
$('firstrun-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFirstrunErr();
  const name = $('login-name-input').value.trim();
  const pin = $('login-pin-input').value;
  const pin2 = $('login-pin-confirm').value;
  if (!name) return firstrunFail('이름을 입력해 주세요.', 'login-name-input');
  if (!PIN_RE.test(pin)) return firstrunFail('간편 비밀번호는 숫자 4~6자리예요.', 'login-pin-input');
  if (pin !== pin2) return firstrunFail('두 비밀번호가 서로 달라요.', 'login-pin-confirm');

  const res = await window.api.registerAccount(name, pin);
  if (!res.ok) return firstrunFail(res.error, 'login-name-input');
  currentAccount = res.account;
  updateAccountUi();
  $('firstrun-ov').classList.remove('show');
  toast('등록 완료 — ' + res.account.name + ' 님');
});
['login-name-input', 'login-pin-input', 'login-pin-confirm'].forEach(id => {
  $(id).addEventListener('input', clearFirstrunErr);
});
['login-pin-input', 'login-pin-confirm', 'pw-current', 'pw-new', 'pw-new-confirm'].forEach(id => {
  $(id).addEventListener('input', function () { this.value = this.value.replace(/[^0-9]/g, ''); });
});

$('btn-change-name').onclick = async () => {
  const n = await openModal('이름 변경', currentAccount?.name || '');
  if (n === null || !n.trim()) return;
  const res = await window.api.changeAccountName(n.trim());
  if (!res.ok) { toast(res.error); return; }
  currentAccount.name = n.trim().slice(0, 12);
  updateAccountUi();
  toast('이름을 변경했어요');
};

let pwResetMode = false;
function setPwResetMode(on) {
  pwResetMode = on;
  $('pw-current-group').style.display = on ? 'none' : '';
  $('pw-reset-notice').style.display = on ? '' : 'none';
  $('pw-modal-title').textContent = on ? '간편 비밀번호 초기화' : '간편 비밀번호 변경';
}
function openPw() {
  $('pw-current').value = ''; $('pw-new').value = ''; $('pw-new-confirm').value = '';
  $('pw-error').textContent = '';
  setPwResetMode(false);
  $('pw-modal').classList.add('show');
  $('pw-current').focus();
}
function closePw() { $('pw-modal').classList.remove('show'); }
$('btn-change-pin').onclick = openPw;
$('pw-forgot').onclick = () => { setPwResetMode(true); $('pw-error').textContent = ''; $('pw-new').focus(); };
$('pw-cancel').onclick = closePw;
$('pw-modal').addEventListener('click', e => { if (e.target === $('pw-modal')) closePw(); });
$('pw-ok').onclick = async () => {
  $('pw-error').textContent = '';
  const cur = $('pw-current').value, nw = $('pw-new').value, nw2 = $('pw-new-confirm').value;
  if (!PIN_RE.test(nw)) { $('pw-error').textContent = '새 비밀번호는 숫자 4~6자리예요.'; $('pw-new').focus(); return; }
  if (nw !== nw2) { $('pw-error').textContent = '새 비밀번호가 서로 달라요.'; $('pw-new-confirm').focus(); return; }
  const res = await window.api.changeAccountPin(cur, nw, pwResetMode);
  if (!res.ok) { $('pw-error').textContent = res.error; $('pw-current').focus(); return; }
  closePw();
  toast(pwResetMode ? '비밀번호를 초기화했어요' : '비밀번호를 변경했어요');
};

$('cfg-personalize').onchange = async function () {
  await window.api.setPersonalize(this.checked);
  if (currentAccount) currentAccount.prefs = { ...currentAccount.prefs, personalizeRecommendations: this.checked };
  $('personalize-sub').textContent = this.checked ? '재생 기록으로 믹스 추천 재정렬' : '꺼짐 · 유튜브 원래 순서 그대로';
};

// 추천에서 제외한 채널 관리(2026-08-08 추가) — 우클릭 메뉴로 차단은 되는데 해제할 방법이
// 없었음(차단된 채널은 애초에 추천에 안 뜨니 다시 우클릭할 기회가 없음, 형 지적). 설정에서
// 목록을 보고 개별 해제할 수 있게 함.
function updateBlockedChSub() {
  $('blocked-ch-sub').textContent = `${blockedChannels.size}개`;
}
function renderBlockedChList() {
  const list = $('blocked-ch-list');
  const channels = [...blockedChannels].sort();
  if (!channels.length) {
    list.innerHTML = '<div class="blocked-ch-empty">추천에서 제외한 채널이 없어요</div>';
    return;
  }
  list.innerHTML = channels.map(ch => `
    <div class="blocked-ch-row" data-channel="${ch.replace(/"/g, '&quot;')}">
      <span class="blocked-ch-name">${ch.replace(/</g, '&lt;')}</span>
      <button class="blocked-ch-unblock" type="button">제외 해제</button>
    </div>
  `).join('');
  list.querySelectorAll('.blocked-ch-row').forEach(row => {
    row.querySelector('.blocked-ch-unblock').onclick = async () => {
      const ch = row.dataset.channel;
      const nowBlocked = await window.api.toggleChannelBlock(ch);
      if (!nowBlocked) {
        blockedChannels.delete(ch);
        updateBlockedChSub();
        renderBlockedChList();
        toast(`"${ch}" 채널 추천 제외를 해제했어요`);
      }
    };
  });
}
$('btn-blocked-channels').onclick = () => {
  renderBlockedChList();
  $('blocked-ch-modal').classList.add('show');
};
$('blocked-ch-close').onclick = () => $('blocked-ch-modal').classList.remove('show');

// ── stream cache ──────────────────────────────────────────────────────────────
// force=true면 캐시된 스트림 URL을 무시하고 무조건 yt-dlp를 다시 호출해서 새 URL을 받아온다
// — "no supported source" 재생 실패 시 재시도용(2026-08-08, 예전에 문서에만 남고 실제 코드
// 반영이 안 돼있던 걸 재발견해서 이번에 실제로 구현). 캐시된 URL이 재생 시점엔 이미 만료됐거나
// 뭔가 문제가 있었을 가능성을 겨냥한 방어책이라, 그 URL을 재사용하는 캐시 히트를 건너뛴다.
async function getStream(ytUrl, force = false) {
  const now = Date.now();
  const c = streamCache[ytUrl];
  if (!force && c && c.expireTs > now + 60000) return c.url;
  const res = await window.api.getStream(ytUrl);
  if (res.error) {
    const err = new Error(res.error);
    err.code = res.code; // UNSUPPORTED_LIVE_SOURCE 등 — playTrack에서 자동 스킵 판단용
    throw err;
  }
  streamCache[ytUrl] = { url: res.streamUrl, expireTs: now + 5.5*3600*1000 };
  return res.streamUrl;
}

// ── 스트림 프리페치(선행 워밍) ─────────────────────────────────────────────────
// 2026-08-31 이식. 모바일 웹앱이 이미 검증해 둔 선행 워밍 방식을 데스크톱에도 적용한다 —
// 원리는 동일: "다음에 재생될 곡"의 스트림 주소를 재생 전에 미리 받아 streamCache에
// 넣어두면, 곡이 넘어가는 순간 playTrack의 getStream이 캐시 히트(모바일 실측 0ms)로 끝나서
// 곡간 로딩 지연이 사라진다. 지연의 정체는 yt-dlp 프로세스 스폰+추출(형 실기 체감 2~3초,
// 맥미니 실측 10초)이라, 이걸 재생 중인 배경 시간으로 옮기는 것이 핵심이다.
//
// 여기에 형 요청(2026-08-31)으로 한 가지를 더 한다: 큐가 새로 만들어진 직후(앱 시작 직후,
// 곡을 직접 추가한 직후, 자동추천이 꼬리에 붙은 직후)에는 아직 아무것도 재생 전이라도
// 앞쪽 곡 몇 개를 미리 받아둔다 — "첫 곡을 누르는 순간"의 로딩까지 없애기 위함.
//
// ⚠️ 모바일 게이트(2026-08-31 오푸스 최종검토 배포차단 이슈 후속조치): 모바일 웹앱은
// app.js를 한 글자도 안 고치고 그대로 서빙하면서 이미 자기 전용 프리페처(mobile/public/
// 아래의 모바일 전용 스크립트, app.js 로드 뒤에 주입됨)를 따로 갖고 있다. 여기서 걸러내지
// 않으면 곡 전환마다 두 시스템이 서로 모르는 채 같은 스트림 주소를 각각 요청해서 yt-dlp가
// 2개씩 뜬다(mobile/check_mobile.js가 정적 검사로 이 중복을 감지). app.js는 모바일 전용
// API를 직접 참조하지 않고, mobile.css 스코프에도 쓰이는 <html class="m"> DOM 마커(서버가
// 모바일 요청에만 붙여준다, mobile/lib/mobilehtml.js)만 재사용해서 아래 prefetchStream
// 진입점 한 곳에서만 판단한다 — 데스크톱은 그 클래스가 없으니 평소처럼 그대로 동작한다.
//
// 설계 원칙:
//  - 프리페치는 전부 직렬(한 번에 yt-dlp 1개)로 돌린다. 병렬 스폰은 프로세스 기동 비용이
//    커서(맥 실측 8초/회) 오히려 서로 느려지는 걸 K-Music 조회수 조회 때 이미 실측했다
//    (main.js fetchViewCounts 주석의 "3개 동시 요청 시 개당 23~25초" 참고).
//  - 실패는 조용히 무시 — 프리페치가 안 됐으면 재생 시점에 기존 로딩 경로가 그대로 돈다.
//  - 셔플은 다음 곡이 난수라 예측 불가, 한곡반복은 같은 주소 재사용이라 프리페치 불필요
//    (모바일 쪽과 같은 한계/판단).
const PREFETCH_LEAD_SEC = 30; // 곡 끝 30초 전에 한 번 더 확인(그 사이 큐가 바뀌었을 수 있음)
const WARM_HEAD_COUNT = 3;    // 재생 전 선행 워밍으로 미리 받아둘 곡 수 — 시드곡 추가 시
                              // 큐에 한 번에 3곡이 들어오는데 2로는 3번째 곡에서 버퍼링이
                              // 남는 걸 형이 실기로 확인해서 3으로 확대(2026-08-31, 직렬 유지)

let prefetchChain = Promise.resolve();     // 직렬화 체인
const prefetchInFlight = new Set();        // 같은 곡 중복 예약 방지

function cachedStreamAlive(ytUrl) {
  const c = streamCache[ytUrl];
  return !!(c && c.expireTs > Date.now() + 60000); // getStream의 "1분 이상 남아야 히트" 기준과 동일
}

// 데스크톱 전용 게이트 — 위 "모바일 게이트" 주석 참고.
function isMobilePage() {
  return document.documentElement.classList.contains('m');
}

function prefetchStream(ytUrl) {
  if (isMobilePage()) return; // 모바일은 자기 전용 프리페처가 따로 처리한다
  if (!ytUrl || cachedStreamAlive(ytUrl) || prefetchInFlight.has(ytUrl)) return;
  prefetchInFlight.add(ytUrl);
  prefetchChain = prefetchChain.then(async () => {
    try {
      if (cachedStreamAlive(ytUrl)) return; // 대기 중에 playTrack이 이미 받아뒀으면 스킵
      await getStream(ytUrl); // 성공하면 getStream이 알아서 streamCache에 넣는다
    } catch { /* 실패는 재생 시점의 기존 재시도 경로가 처리 */ }
    finally { prefetchInFlight.delete(ytUrl); }
  });
}

// nextTrack()이 고를 다음 곡을 그대로 예측(app.js nextTrack의 규칙과 반드시 일치해야 함)
function predictNextYtUrl() {
  if (playingPl < 0 || currentTrack < 0) return null;
  const tracks = playlists[playingPl]?.tracks;
  if (!tracks || !tracks.length) return null;
  if (shuffle || repeatMode === 2) return null;
  if (repeatMode === 0 && currentTrack === tracks.length - 1) return null; // 끝 곡이면 안 넘어감
  return tracks[(currentTrack + 1) % tracks.length]?.ytUrl || null;
}

function prefetchUpcoming() { prefetchStream(predictNextYtUrl()); }

// 큐 앞쪽 선행 워밍 — 재생 중이면 "현재 곡 다음"부터, 재생 전이면 "누를 가능성이 높은 곳"
// (이어듣기 저장 위치가 있으면 거기, 없으면 목록 맨 앞)부터 n곡.
function warmQueueHead(n = WARM_HEAD_COUNT) {
  let tracks, from;
  if (playingPl >= 0 && currentTrack >= 0 && playlists[playingPl]?.tracks) {
    tracks = playlists[playingPl].tracks;
    from = currentTrack + 1;
  } else {
    tracks = playlists[currentPl]?.tracks || [];
    const li = config.lastTrackIdx;
    from = (config.resume && typeof li === 'number' && li >= 0 && tracks[li]) ? li : 0;
  }
  for (let i = from, c = 0; i < tracks.length && c < n; i++, c++) {
    prefetchStream(tracks[i]?.ytUrl);
  }
}

// 언제 부르는가 — 타이머가 아니라 미디어 이벤트에 얹는다(모바일 쪽과 동일한 방식).
audio.addEventListener('loadedmetadata', () => { prefetchUpcoming(); }); // 곡이 시작하자마자
audio.addEventListener('playing', () => { prefetchUpcoming(); });
let _prefetchLeadKey = '';
audio.addEventListener('timeupdate', () => {
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  if (d - audio.currentTime > PREFETCH_LEAD_SEC) return;
  const key = playingPl + ':' + currentTrack;
  if (_prefetchLeadKey === key) return;
  _prefetchLeadKey = key;
  prefetchUpcoming();
});

// ── persist ───────────────────────────────────────────────────────────────────
async function save() { await window.api.savePlaylists(playlists); }
async function saveCfg(p) { config = {...config,...p}; await window.api.saveConfig(config); }

// ── navigation ────────────────────────────────────────────────────────────────
let curView = 'home';
function switchView(v) {
  curView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  $(`view-${v}`).classList.add('active');
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view===v));
  $('home-search').style.display = (v==='home'||v==='search') ? '' : 'none';
  if (v==='playlists') renderPlView();
  if (v==='search') $('qs-input').focus();
}
document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

// ── theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (!theme || theme === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// ── 커스텀 드롭다운 ───────────────────────────────────────────────────────────
// 네이티브 <select>는 펼친 목록을 OS가 그려서 CSS가 하나도 안 먹는다. 폰에서는 회색 시스템
// 피커가 올라오고 데스크톱에서는 윈도우 기본 흰 목록이 떠서, 앱 디자인과 따로 놀았다.
//
// 여기서는 <select>를 없애지 않는다. 값의 원본은 계속 select이고(그래서 config 저장/불러오기
// 코드는 한 줄도 안 바뀐다), 눈에 보이는 버튼과 목록만 새로 그린다. 이 함수가 안 불리면
// 네이티브 select가 그대로 보이고 그대로 동작한다.
const SELECT_VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function enhanceSelect(sel) {
  if (!sel || sel.dataset.kselDone) return;
  sel.dataset.kselDone = '1';

  const wrap = document.createElement('div');
  wrap.className = 'ksel';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('ksel-native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ksel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'ksel-label';
  btn.appendChild(label);
  btn.insertAdjacentHTML('beforeend',
    '<svg class="ksel-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>');
  wrap.appendChild(btn);

  // 목록은 body 바로 밑에 붙인다 — 설정 패널이 overflow:auto라 그 안에 두면 잘린다.
  const menu = document.createElement('div');
  menu.className = 'ksel-menu';
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);

  let items = [];
  let hi = -1;

  function build() {
    menu.textContent = '';
    items = [];
    [...sel.options].forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'ksel-opt';
      d.setAttribute('role', 'option');
      d.dataset.value = o.value;
      const t = document.createElement('span');
      t.textContent = o.textContent;
      d.appendChild(t);
      d.insertAdjacentHTML('beforeend',
        '<svg class="ksel-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>');
      d.addEventListener('click', () => choose(i));
      menu.appendChild(d);
      items.push(d);
    });
  }

  // select의 현재 값 → 버튼 글자와 체크표시에 반영
  function sync() {
    const o = sel.options[sel.selectedIndex];
    label.textContent = o ? o.textContent : '';
    items.forEach((d, i) => d.setAttribute('aria-selected', String(i === sel.selectedIndex)));
  }

  function choose(i) {
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    sync();
    // app.js 다른 곳이 걸어둔 onchange(스킨 실시간 미리보기)를 네이티브와 똑같이 발화시킨다
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    btn.focus();
  }

  function place() {
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.minWidth = r.width + 'px';
    menu.style.maxHeight = '';
    const full = menu.offsetHeight;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    // 아래가 모자라고 위가 더 넓으면 위로 펼친다
    const up = full > below && above > below;
    const maxH = Math.max(120, up ? above : below);
    menu.style.maxHeight = maxH + 'px';
    const h = Math.min(full, maxH);
    menu.style.top = (up ? r.top - 6 - h : r.bottom + 6) + 'px';
    // 설정 행에서 이 컨트롤은 오른쪽 끝에 있으므로 오른쪽을 기준으로 맞춘다
    let left = r.right - menu.offsetWidth;
    left = Math.min(left, vw - menu.offsetWidth - 8);
    menu.style.left = Math.max(8, left) + 'px';
  }

  let swallowClick = false;

  function open() {
    if (menu.classList.contains('open')) return;
    build();
    sync();
    hi = sel.selectedIndex;
    paintHi();
    menu.classList.add('open');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    place();
    items[hi]?.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    if (!menu.classList.contains('open')) return;
    menu.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  function paintHi() {
    items.forEach((d, i) => d.classList.toggle('hi', i === hi));
  }

  function move(delta) {
    const n = sel.options.length;
    if (!n) return;
    hi = (hi + delta + n) % n;
    paintHi();
    items[hi]?.scrollIntoView({ block: 'nearest' });
  }

  btn.addEventListener('click', () => {
    menu.classList.contains('open') ? close() : open();
  });

  btn.addEventListener('keydown', e => {
    const isOpen = menu.classList.contains('open');
    if (e.key === 'Escape') { if (isOpen) { e.preventDefault(); close(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) { open(); return; }
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!isOpen) return;
      e.preventDefault();
      hi = e.key === 'Home' ? 0 : sel.options.length - 1;
      paintHi();
      items[hi]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      isOpen ? choose(hi) : open();
    }
  });

  // 바깥을 누르면 닫는다. 그 탭이 설정 오버레이 배경까지 도달하면 설정창까지 같이 닫혀버려서
  // (app.js의 "바깥 클릭 시 닫기"), 목록을 닫은 그 한 번의 click만 삼킨다.
  document.addEventListener('pointerdown', e => {
    if (!menu.classList.contains('open')) return;
    if (wrap.contains(e.target) || menu.contains(e.target)) return;
    close();
    swallowClick = true;
  }, true);
  document.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
  }, true);

  // 스크롤/리사이즈하면 목록이 버튼에서 떨어져 나가므로 닫는다(설정 패널 스크롤 포함이라 capture).
  // 단, 목록 자체를 스크롤하는 경우는 예외 — 항목이 많아 목록 안에서 스크롤할 때 닫히면 못 고른다.
  window.addEventListener('scroll', e => {
    if (e.target === menu) return;   // 목록 안에서 굴리는 중
    close();
  }, true);
  window.addEventListener('resize', close);

  // app.js가 openSettings에서 sel.value = ... 로 값을 직접 넣는다. 그건 change 이벤트를
  // 쏘지 않기 때문에, 그 대입을 가로채서 버튼 글자를 같이 갱신한다.
  if (SELECT_VALUE_DESC && SELECT_VALUE_DESC.set) {
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return SELECT_VALUE_DESC.get.call(this); },
      set(v) { SELECT_VALUE_DESC.set.call(this, v); sync(); }
    });
  }
  sel.addEventListener('change', sync);

  build();
  sync();
}

// 설정의 스킨 선택. 앞으로 <select>가 늘어도 여기에 걸리면 자동으로 같은 디자인이 된다.
document.querySelectorAll('.srow-ctrl select').forEach(enhanceSelect);

// ── settings overlay ──────────────────────────────────────────────────────────
async function openSettings() {
  updateAccountUi();
  $('cfg-theme').value = config.theme || 'default';
  $('cfg-auto').checked = !!config.autoplay;
  $('cfg-resume').checked = !!config.resume;
  $('auto-sub').textContent = config.autoplay ? '켜짐' : '꺼짐';
  $('cfg-yt-api-key').value = config.ytApiKey || '';
  $('yt-api-status').textContent = '';
  $('yt-api-status').className = 'yt-api-status';
  $('cfg-startup').checked = await window.api.getLoginItem();
  $('settings-ov').classList.add('show');
}
// 스킨 선택하면 저장 안 눌러도 바로 미리보기 반영, 저장 없이 닫으면 원래 저장된 테마로
// 되돌린다(형 요청, 2026-08-16). closeSettings에서 매번 config.theme를 다시 적용하는 방식이라
// 저장을 눌러 config.theme가 이미 갱신된 경우엔 그대로, 저장 없이 닫은 경우엔 원복된다.
function closeSettings() { $('settings-ov').classList.remove('show'); applyTheme(config.theme); }
$('cfg-theme').onchange = () => applyTheme($('cfg-theme').value);
$('nav-settings').onclick = openSettings;
$('settings-close').onclick = closeSettings;
$('settings-ov').addEventListener('click', e => { if(e.target===$('settings-ov')) closeSettings(); });
$('cfg-auto').onchange = function() { $('auto-sub').textContent = this.checked ? '켜짐' : '꺼짐'; };
$('yt-api-key-guide').onclick = (e) => {
  e.preventDefault();
  window.api.openExternal('https://music.krisb-infra.com/#api');
};
$('cfg-yt-api-key').oninput = () => { $('yt-api-status').textContent = ''; $('yt-api-status').className = 'yt-api-status'; };
$('btn-yt-api-check').onclick = async () => {
  const key = $('cfg-yt-api-key').value.trim();
  const statusEl = $('yt-api-status');
  const btn = $('btn-yt-api-check');
  if (!key) { statusEl.textContent = '키를 먼저 입력해 주세요'; statusEl.className = 'yt-api-status err'; return; }
  btn.disabled = true;
  statusEl.textContent = '확인 중...';
  statusEl.className = 'yt-api-status';
  const res = await window.api.testYtApiKey(key);
  btn.disabled = false;
  if (res.ok) {
    statusEl.textContent = '✓ 정상 작동';
    statusEl.className = 'yt-api-status ok';
  } else {
    statusEl.textContent = '✗ 키 오류 — 다시 확인해 주세요';
    statusEl.className = 'yt-api-status err';
  }
};
$('settings-save').onclick = async () => {
  const theme = $('cfg-theme').value;
  await saveCfg({
    theme,
    autoplay: $('cfg-auto').checked,
    resume: $('cfg-resume').checked,
    alwaysOnTop: config.alwaysOnTop,
    ytApiKey: $('cfg-yt-api-key').value.trim()
  });
  applyTheme(theme);
  await window.api.setLoginItem($('cfg-startup').checked);
  closeSettings();
};

// ── render ────────────────────────────────────────────────────────────────────
function renderTabs() {
  plTabs.innerHTML = '';
  playlists.forEach((pl, i) => {
    const t = document.createElement('button');
    t.className = 'pl-tab' + (i===currentPl?' active':'');
    t.innerHTML = `${esc(pl.name)} <span class="cnt">${pl.tracks.length}</span>`;
    t.onclick = () => { currentPl=i; renderTabs(); renderTrackList(); };
    plTabs.appendChild(t);
  });
}

function renderTrackList() {
  const tracks = playlists[currentPl]?.tracks || [];
  if (!tracks.length) {
    trackList.innerHTML = '<div class="track-empty">이 플레이리스트에 곡이 없습니다.<br>검색창에 검색어나 유튜브 URL을 넣어 추가하세요.</div>';
    return;
  }
  trackList.innerHTML = '';
  tracks.forEach((t, i) => {
    const playing = (i===currentTrack && currentPl===playingPl);
    const numHtml = playing
      ? `<span class="eq ${isPlaying?'':'paused'}"><i></i><i></i><i></i></span>`
      : (i+1);
    const el = document.createElement('div');
    el.className = 'track-item' + (playing?' playing':'');
    el.innerHTML = `
      <span class="t-num">${numHtml}</span>
      <img class="t-thumb" src="${esc(t.thumbnail||'')}" onerror="this.style.visibility='hidden'" alt="" draggable="false"/>
      <div class="t-meta"><div class="t-title">${t.source==='auto' ? '<span class="t-auto-badge">추천</span>' : ''}${esc(t.title)}</div><div class="t-ch">${esc(t.channel)}</div></div>
      <span class="t-dur">${fmt(t.duration)}</span>
      <button class="t-del" data-i="${i}">🗑</button>
    `;
    el.querySelector('.t-del').onclick = e => { e.stopPropagation(); removeTrack(i); };
    el.oncontextmenu = e => showCtxMenu(e, i);
    attachTrackDrag(el, i);
    trackList.appendChild(el);
  });
}

// ── 재생목록 클릭-드래그 순서 변경 ──────────────────────────────────────────────
// 클릭만 하면(이동 없음) 기존처럼 재생, 위/아래로 끌면 순서 변경. 버튼 없이 곡 자체를 잡고 옮기는 방식.
const DRAG_THRESHOLD = 6;
function attachTrackDrag(el, startIndex) {
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.t-del')) return; // 삭제 버튼은 기존 클릭 동작 그대로
    if (e.button !== undefined && e.button !== 0) return;

    const items = Array.from(trackList.children);
    const origTops = items.map(it => it.getBoundingClientRect().top);
    const itemH = origTops.length > 1 ? (origTops[1] - origTops[0]) : el.getBoundingClientRect().height;
    const startY = e.clientY;
    let dragging = false;
    let curIndex = startIndex;

    function onMove(ev) {
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true;
        el.classList.add('dragging');
        el.style.position = 'relative';
        el.style.zIndex = '5';
        el.style.transition = 'none';
        el.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)';
      }
      if (!dragging) return;
      ev.preventDefault();
      el.style.transform = `translateY(${dy}px)`;

      const draggedCenter = origTops[startIndex] + itemH/2 + dy;
      let newIndex = startIndex;
      for (let j = 0; j < items.length; j++) {
        if (j === startIndex) continue;
        const slotCenter = origTops[j] + itemH/2;
        if (j < startIndex && draggedCenter < slotCenter) newIndex = Math.min(newIndex, j);
        if (j > startIndex && draggedCenter > slotCenter) newIndex = Math.max(newIndex, j);
      }
      curIndex = newIndex;

      items.forEach((it, j) => {
        if (j === startIndex) return;
        let shift = 0;
        if (curIndex < startIndex && j >= curIndex && j < startIndex) shift = itemH;
        else if (curIndex > startIndex && j <= curIndex && j > startIndex) shift = -itemH;
        it.style.transition = 'transform 0.18s ease';
        it.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    }

    function cleanup() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    }

    function onCancel() {
      // 네이티브 드래그(예: 이미지 끌기) 등으로 제스처가 중간에 취소된 경우 —
      // 재생 트리거 없이 조용히 원상복구만 하고 리스너 정리(안 하면 다음 시도부터 리스너가 계속 쌓임).
      cleanup();
      if (!dragging) return;
      el.classList.remove('dragging');
      el.style.position = '';
      el.style.zIndex = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.style.transform = '';
      Array.from(trackList.children).forEach(it => { if (it !== el) { it.style.transition = ''; it.style.transform = ''; } });
    }

    function onUp() {
      cleanup();

      if (!dragging) {
        playTrack(startIndex);
        return;
      }

      const items2 = Array.from(trackList.children);
      el.classList.remove('dragging');
      el.style.position = '';
      el.style.zIndex = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.style.transform = '';
      items2.forEach(it => { if (it !== el) { it.style.transition = ''; it.style.transform = ''; } });

      if (curIndex !== startIndex) {
        const tracks = playlists[currentPl].tracks;
        const [moved] = tracks.splice(startIndex, 1);
        tracks.splice(curIndex, 0, moved);

        if (playingPl === currentPl && currentTrack !== -1) {
          if (currentTrack === startIndex) currentTrack = curIndex;
          else if (startIndex < currentTrack && curIndex >= currentTrack) currentTrack -= 1;
          else if (startIndex > currentTrack && curIndex <= currentTrack) currentTrack += 1;
          // 재생 중 순서를 바꾸면 이어재생용으로 저장해둔 인덱스(lastTrackIdx)도 같이 갱신 안 하면
          // 다음 실행 때 엉뚱한 곡에서 이어재생됨(오푸스 리뷰 발견, 2026-08-02)
          saveCfg({ lastTrackIdx: currentTrack });
        }
        save();
        renderTrackList();
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });
}

function renderPlView() {
  const c = $('pl-view');
  c.innerHTML = '';
  playlists.forEach((pl, i) => {
    const el = document.createElement('div');
    el.className = 'pl-card';
    el.innerHTML = `
      <div><div class="pl-card-name">${esc(pl.name)}</div><div class="pl-card-count">${pl.tracks.length}곡</div></div>
      <div class="pl-card-btns">
        <button class="pl-card-btn" data-a="ren">✏</button>
        <button class="pl-card-btn" data-a="del">🗑</button>
      </div>
    `;
    el.querySelector('[data-a="ren"]').onclick = async e => {
      e.stopPropagation();
      const n = await openModal('플레이리스트 이름 변경', pl.name);
      if (!n) return;
      playlists[i].name = n; await save(); renderTabs(); renderPlView();
    };
    el.querySelector('[data-a="del"]').onclick = async e => {
      e.stopPropagation();
      if (playlists.length<=1) { toast('마지막 플레이리스트는 삭제할 수 없어요'); return; }
      playlists.splice(i,1); if(currentPl>=playlists.length) currentPl=playlists.length-1;
      // keep playingPl valid: if the playing playlist itself was deleted, stop;
      // if a playlist before it was removed, its index shifted down by one.
      if (i===playingPl) { playingPl=-1; currentTrack=-1; stopAudio(); }
      else if (i<playingPl) playingPl--;
      await save(); renderTabs(); renderTrackList(); renderPlView();
    };
    el.onclick = () => { currentPl=i; switchView('home'); renderTabs(); renderTrackList(); };
    c.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'pl-add-card'; add.textContent = '+ 새 플레이리스트';
  add.onclick = async () => {
    const n = await openModal('새 플레이리스트 이름');
    if (!n) return;
    playlists.push({id:uid(),name:n,tracks:[]});
    currentPl = playlists.length-1;
    await save(); renderTabs(); renderTrackList(); renderPlView();
  };
  c.appendChild(add);
}

// ── add track ─────────────────────────────────────────────────────────────────
function looksLikeUrl(s) { return /^https?:\/\//i.test(s); }

async function addByUrl(url, autoplay=false) {
  url = url.trim();
  if (!url || !looksLikeUrl(url)) { toast('올바른 YouTube URL을 입력하세요'); return; }
  showLoad('곡 정보 가져오는 중...');
  try {
    const info = await window.api.getVideoInfo(url);
    if (info.error) { toast('오류: '+info.error); return; }
    const idx = addManualTrack(currentPl, {ytUrl:url, title:info.title, channel:info.channel, thumbnail:info.thumbnail, duration:info.duration, releaseYear:info.releaseYear}, {autoplayNow: autoplay});
    await save(); renderTrackList();
    if (autoplay) { switchView('home'); playTrack(idx); }
  } catch(e) { toast('추가 실패: '+e.message); } finally { hideLoad(); }
}

function removeTrack(i) {
  playlists[currentPl].tracks.splice(i,1);
  if (currentPl===playingPl) {
    // 재생 중이던 곡이 삭제/이동돼서 인덱스가 바뀌면 이어재생용 저장값(lastTrackIdx)도 같이
    // 갱신 안 하면 다음 실행 때 엉뚱한 곡에서 이어재생됨(오푸스 리뷰 발견, 2026-08-02)
    if (currentTrack===i) { currentTrack=-1; playingPl=-1; stopAudio(); saveCfg({lastTrackIdx: -1}); }
    else if (currentTrack>i) { currentTrack--; saveCfg({lastTrackIdx: currentTrack}); }
  }
  save(); renderTrackList();
}

// ── playback ──────────────────────────────────────────────────────────────────
function setPlayIcon(playing) {
  btnPlay.classList.toggle('is-paused', !playing);
  vuMeter.classList.toggle('paused', !playing);
}

function stopAudio() {
  // 로딩/재시도 중이던 곡을 재생목록/재생목록 자체 삭제로 멈추는 경우, 그 진행 중이던
  // playTrack이 뒤늦게 깨어나 이미 지워진 곡을 다시 재생시키는 걸 막는다(오푸스 2차 검증,
  // 2026-08-16 — playGen 가드가 stopAudio와 연동돼있지 않던 구멍).
  playGen++;
  audio.pause(); audio.src='';
  isPlaying=false; playingPl=-1; setPlayIcon(false);
  progFill.style.width='0%'; tCur.textContent='0:00';
  albumArt.src=BLANK_PX; albumArt.classList.add('default'); trackTitle.textContent='재생 중인 곡 없음'; trackCh.textContent='—';
  lyricsState = null; lyricsForYtUrl = null; curLineIdx = -1;
  plainScrollOverride = false; plainScrollOffsetPx = 0;
  updateGlowFromArt(null);
  if (inLyrics) renderLyricsPreview();
}

let wasNaturalEnd = false; // 2026-08-07 추천 개인화 — 곡이 끝까지 재생돼서 넘어간 건지(완주),
                            // 사용자가 중간에 다른 곡으로 넘긴 건지(스킵) 구분하는 플래그

// 자동추천곡이 연달아 재생 불가능할 때 몇 곡까지 자동으로 건너뛸지 상한. 곡당 재시도(3초
// 간격 3회 + yt-dlp 자체 타임아웃)가 최악의 경우 1분 반 가까이 걸릴 수 있어서, 예전 상한
// 5는 인터넷이 아예 끊긴 상태에서는 로딩 화면만 8분 가까이 뜰 수 있었다(오푸스 검토,
// 2026-08-16). 3으로 낮춰서 최악의 경우도 몇 분 안으로 줄인다.
const AUTO_SKIP_CHAIN_MAX = 3;

async function playTrack(idx, plIdx = currentPl, resumeSec = 0, skipChain = 0) {
  const tracks = playlists[plIdx].tracks;
  if (!tracks[idx]) return;
  const myGen = ++playGen; // 이 재생 시도 고유 번호 — 아래서 재시도 대기 후 깨어날 때마다 재확인

  // 직전 곡의 완주/스킵을 기록(재정렬 알고리즘의 핵심 신호). resumeSec>0인 이어듣기 재시작
  // 케이스는 currentTrack===idx이고 wasNaturalEnd도 false라서 아래 조건에서 자연히 제외됨.
  // wasNaturalEnd 항을 추가한 이유(2026-08-31): 전체반복 + 곡 1개(또는 순환해서 같은 곡으로
  // 재진입)일 때 "다음 곡 == 지금 곡"이라 인덱스 비교만으론 항상 거짓이 되어, 곡이 끝까지
  // 재생됐는데도 완주(complete) 기록이 영영 안 쌓이는 구멍이 있었다.
  if (playingPl >= 0 && playlists[playingPl]?.tracks[currentTrack] && (wasNaturalEnd || playingPl !== plIdx || currentTrack !== idx)) {
    const prevT = playlists[playingPl].tracks[currentTrack];
    const listenedSec = audio.currentTime || 0;
    window.api.recordPlayEvent(prevT.ytUrl, { title: prevT.title, channel: prevT.channel, duration: prevT.duration, releaseYear: prevT.releaseYear, listenedSec }, wasNaturalEnd ? 'complete' : 'skip');
  }
  wasNaturalEnd = false;

  const prev = currentTrack;
  const prevPl = playingPl;
  currentTrack = idx;
  playingPl = plIdx;
  const t = tracks[idx];
  trackTitle.textContent = t.title;
  trackCh.textContent = t.channel;
  albumArt.src = t.thumbnail||BLANK_PX;
  albumArt.classList.toggle('default', !t.thumbnail);
  updateGlowFromArt(t.thumbnail||'');
  tTot.textContent = fmt(t.duration);
  renderTrackList();
  showLoad('스트리밍 로딩 중...');
  // "재생 실패: no supported source" 대응 — 캐시된 스트림 URL이 재생 시점엔 이미 만료됐거나
  // 문제가 생겼을 가능성을 겨냥해서, 첫 시도가 실패하면 캐시를 건너뛰고 완전히 새로 스트림
  // URL을 받아와 재시도한다(2026-08-08 최초 구현). 형이 실사용 중 "오류 떠도 서너 번 다시
  // 누르면 되던데"라고 리포트(2026-08-16) — 즉시 스킵/정지하지 말고 버퍼링/일시적 문제를
  // 감안해서 3초 간격으로 최대 3번까지 재시도하도록 확장.
  const attemptLoad = async (force) => {
    const url = await getStream(t.ytUrl, force);
    // getStream이 오래 걸리는(캐시 미스) 동안 다른 곡이 눌려서 이미 낡은 세대가 됐으면, 여기서
    // 멈춰서 audio.src를 건드리지 않는다 — 재시도 대기(3초) 구간만 막던 이전 가드로는 이
    // "첫 응답을 기다리는 동안" 구간이 안 막혀서 화면/소리 어긋남이 그대로 재현됐다(오푸스
    // 2차 검증, 2026-08-16). 여기서 조용히 반환하면 바깥 루프는 예외 없이 성공한 것처럼
    // break하지만, 루프 직후의 myGen!==playGen 체크가 그 상태를 잡아서 후속 처리를 생략한다.
    if (myGen !== playGen) return;
    audio.src = url;
    audio.volume = volSlider.value/100;
    if (resumeSec > 0) audio.currentTime = resumeSec;
    await audio.play();
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 3초 대기 중에 다른 곡이 눌려서 이 재생 시도가 이미 낡은 세대가 됐으면, 여기서 멈춰서
      // audio.src를 도로 덮어쓰지 않는다(오푸스 검토, 2026-08-16 — 화면·소리 어긋남 버그).
      if (myGen !== playGen) return;
      try {
        await attemptLoad(attempt > 1); // 첫 시도는 캐시 사용, 이후는 매번 강제로 새로 받아옴
        lastErr = null;
        break;
      } catch (e1) {
        lastErr = e1;
        // 라이브방송/프리미어 영상은 재시도해도 똑같은 HLS 주소가 나와서 재시도 자체가
        // 무의미함 — 바로 중단하고 아래 catch(e)로 넘겨 자동 스킵 처리하게 한다(2026-08-16).
        if (e1.code === 'UNSUPPORTED_LIVE_SOURCE') break;
        if (attempt < 3) await sleep(3000);
      }
    }
    if (myGen !== playGen) return; // 재시도 끝난 시점에도 낡은 세대면 성공/실패 후처리 자체를 생략
    if (lastErr) throw lastErr;
    isPlaying=true; setPlayIcon(true);
    await saveCfg({lastPlId: playlists[plIdx].id, lastTrackIdx: idx, lastPos: resumeSec});
    if (inLyrics) ensureLyricsLoaded();
    window.api.recordPlayEvent(t.ytUrl, { title: t.title, channel: t.channel, duration: t.duration, releaseYear: t.releaseYear }, 'play');
    maybeExtendQueue(plIdx); // 큐 보충은 백그라운드로, 재생 시작을 기다리게 하지 않음
    pruneOldAutoTracks(plIdx); // 지나간 추천곡은 최근 10곡만 남기고 정리
  } catch(e) {
    if (myGen !== playGen) return; // 낡은 세대는 스킵/토스트/롤백도 하지 않고 조용히 물러남
    // 라이브방송/프리미어라 재생 불가능한 곡은 에러로 멈추지 않고, 다음 곡으로 자동으로 넘어간다
    // (형 요청, 2026-08-16). 직접 재생목록에 추가한 곡은 형이 의도적으로 고른 곡이라 문제가
    // 있으면 알아야 하니 종전대로 실패 토스트 후 정지하고, 자동추천곡(t.source==='auto')만
    // 넓게 자동 스킵 대상으로 삼는다 — 실제 테스트해보니 "no supported source" 외에도 yt-dlp가
    // 포맷 자체를 못 찾는 등 다양한 형태로 실패할 수 있다는 걸 확인해서, 원인 문자열을 일일이
    // 맞추기보다 "강제 재시도까지 실패한 자동추천곡"이면 전부 스킵 대상으로 넓게 잡았다.
    // 연속 실패가 이어지는 극단적 상황을 막기 위해 skipChain 상한(아래 참고).
    // 한곡반복(repeatMode===2) 상태에서 재생 불가능한 곡이면 "다음곡"이 자기 자신이 되어
    // 안 되는 곡을 skipChain 상한까지 헛되이 반복하던 버그가 있었다(오푸스 검토, 2026-08-16)
    // — 자동 스킵 경로에서는 반복모드를 무시하고 항상 진짜 다음 곡으로 넘어간다.
    if ((e.code === 'UNSUPPORTED_LIVE_SOURCE' || t.source === 'auto') && skipChain < AUTO_SKIP_CHAIN_MAX) {
      toast('"'+t.title+'" 곡을 재생할 수 없어 다음 곡으로 넘어갈게요');
      // ── 재생시간 오집계 방지(2026-08-22 발견 버그의 자동스킵 경로 수정, 2026-08-31) ──
      // 여기서 그냥 playTrack(n)으로 넘어가면, 다음 playTrack 상단의 "직전 곡 기록"이
      // 이 실패한 곡(currentTrack=idx)에 대해 audio.currentTime을 listenedSec으로 기록하는데,
      // 스트림을 아예 못 받은 실패라 audio에는 그 앞 곡의 재생위치가 그대로 남아있다 —
      // 즉 앞 곡의 재생시간이 "재생된 적도 없는 실패 곡"에 집계됐다. 실패 곡의 기록(스킵,
      // 0초)은 여기서 직접 남기고, playingPl을 잠깐 내려서 다음 playTrack의 상단 기록을
      // 건너뛰게 한다(앞 곡의 실제 재생시간은 이 실패 곡의 playTrack이 시작될 때 이미
      // 올바르게 기록됐으므로 여기서 잃는 기록은 없다).
      window.api.recordPlayEvent(t.ytUrl, { title: t.title, channel: t.channel, duration: t.duration, releaseYear: t.releaseYear, listenedSec: 0 }, 'skip');
      playingPl = -1;
      const n = shuffle ? pickShuffleIndex(tracks.length, idx) : (idx+1)%tracks.length;
      playTrack(n, plIdx, 0, skipChain+1);
      return;
    }
    toast('재생 실패: '+e.message);
    isPlaying=false; setPlayIcon(false);
    currentTrack = prev; playingPl = prevPl;
    // 헤더 UI(제목/채널/아트/총시간)도 같이 원복(2026-08-31) — 예전엔 인덱스만 되돌리고
    // 화면 상단은 실패한 곡의 제목/아트가 그대로 남아서, 목록 하이라이트(이전 곡)와 상단
    // 표기(실패 곡)가 어긋난 상태로 지속됐다.
    const pt = prevPl >= 0 ? playlists[prevPl]?.tracks?.[prev] : null;
    if (pt) {
      trackTitle.textContent = pt.title;
      trackCh.textContent = pt.channel;
      albumArt.src = pt.thumbnail || BLANK_PX;
      albumArt.classList.toggle('default', !pt.thumbnail);
      updateGlowFromArt(pt.thumbnail || '');
      tTot.textContent = fmt(pt.duration);
    } else {
      trackTitle.textContent = '재생 중인 곡 없음';
      trackCh.textContent = '—';
      albumArt.src = BLANK_PX;
      albumArt.classList.add('default');
      updateGlowFromArt(null);
      tTot.textContent = fmt(0);
    }
  } finally { if (myGen === playGen) { hideLoad(); renderTrackList(); } }
}

// ── 가사 ──────────────────────────────────────────────────────────────────────
function parseLRC(lrc) {
  if (!lrc) return [];
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (!m) continue;
    const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    const text = m[3].trim();
    if (text) lines.push({ time, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// lrclib 데이터 중 "앞 몇 줄만 타임스탬프 있고 나머지는 평문"인 불완전 항목이 섞여있어서,
// 곡 길이 대비 타임스탬프 커버리지가 너무 부실하면 동기화를 포기하고 일반 가사로 취급한다
// (그대로 쓰면 곡 중반부터 화면이 멈춘 것처럼 보임 — 2026-07-19 한로로 곡에서 발견).
function parseLRCReliable(lrc, durationSec) {
  const lines = parseLRC(lrc);
  if (lines.length < 3) return [];
  if (durationSec) {
    const coverage = lines[lines.length - 1].time / durationSec;
    if (coverage < 0.5) return [];
  }
  return lines;
}

function renderLyricsPreview() {
  // 직전 곡이 동기화/텍스트 모드였다면 top/transform에 그 곡 기준 스크롤 위치(예: 큰 음수 translateY)가
  // 남아있음 — "찾는 중"/"가사 없음" 같은 짧은 안내문은 그 위치를 그대로 물려받으면 화면 밖으로
  // 밀려나서 안 보이게 됨(2026-07-20, 박효신 곡에서 "직접 검색하기" 버튼이 안 보이던 원인).
  lyrPList.style.top = '50%';
  lyrPList.style.transform = 'translateY(-50%)';
  lyrResetLink.style.display = 'none';
  if (!lyricsState) {
    lyrPList.innerHTML = '<div class="lyr-p-empty">가사 찾는 중...</div>';
    lyrBadgeTx.textContent = '가사 찾는 중...';
    return;
  }
  if (!lyricsState.found) {
    lyrPList.innerHTML = `<div class="lyr-p-empty">이 곡은 가사를 찾을 수 없어요.<br>아티스트/제목을 직접 입력해서 다시 찾아볼 수 있어요.<br><button id="lyr-research-btn">직접 검색하기</button></div>`;
    lyrBadgeTx.textContent = '가사 없음';
    $('lyr-research-btn')?.addEventListener('click', manualLyricsSearch);
    return;
  }
  if (lyricsState.syncedLines && lyricsState.syncedLines.length) {
    lyrBadgeTx.textContent = lyricsState.manualSync ? '동기화됨 (직접 설정)' : '동기화됨';
    lyrResetLink.style.display = lyricsState.manualSync ? 'inline' : 'none';
    lyrPList.style.top = '50%';
    lyrPList.innerHTML = lyricsState.syncedLines.map((l, i) => `<div class="lyr-p-line" data-i="${i}">${esc(l.text)}</div>`).join('');
    updateLyricsHighlight(true);
  } else {
    lyrResetLink.style.display = 'none';
    lyrBadgeTx.textContent = '가사 (텍스트만) · 줄을 탭하면 그 지점부터 동기화되고, 휠로 스크롤할 수 있습니다';
    // 동기화 정보가 없으니 시간 기준 스크롤이 불가능함 — 가사 전체 블록을 세로 중앙(-50%)에 맞추면
    // 긴 가사일수록 화면엔 중간 아무 구간이나 걸려서 곡 시작과 무관한 부분이 보이는 버그가 있었음(2026-07-19).
    // 그래서 첫 줄부터 보이도록 컨테이너 맨 위에 붙인다.
    lyrPList.style.top = '0';
    const plainLines = (lyricsState.plain || '가사 내용이 비어있어요').split('\n').filter(Boolean);
    lyrPList.innerHTML = plainLines.map((l, i) => `<div class="lyr-p-line near tap-sync" data-i="${i}" style="transform:scale(1)">${esc(l)}</div>`).join('');
    lyrPList.style.transform = 'translateY(0)';
    lyrPList.querySelectorAll('.tap-sync').forEach(el => {
      el.addEventListener('click', () => applyManualSync(parseInt(el.dataset.i, 10), plainLines));
    });
    updatePlainLyricsScroll();
  }
}

// lrclib에 동기화 데이터가 아예 없는 곡(예: 김범수 "끝사랑")에서, 형이 지금 나오고 있는 줄을
// 직접 탭하면 그 시점을 기준으로 앞뒤 줄들을 남은/지난 재생시간에 균등 배분해서 "직접 만든 동기화"를
// 만들어줌. 다음에 같은 곡 틀 때도 자동으로 이 타이밍을 재사용하도록 저장까지 함(2026-07-20).
function applyManualSync(idx, plainLines) {
  const dur = audio.duration || 0;
  const total = plainLines.length;
  if (!dur || !total) return;
  const anchorTime = audio.currentTime || 0;
  const gapAfter = idx < total - 1 ? (dur - anchorTime) / (total - 1 - idx) : 0;
  const gapBefore = idx > 0 ? anchorTime / idx : 0;
  const syncLines = plainLines.map((text, i) => {
    let time;
    if (i === idx) time = anchorTime;
    else if (i < idx) time = anchorTime - (idx - i) * gapBefore;
    else time = anchorTime + (i - idx) * gapAfter;
    return { time: Math.max(0, time), text };
  });
  lyricsState.syncedLines = syncLines;
  lyricsState.manualSync = true;
  curLineIdx = -1;
  renderLyricsPreview();
  if (lyricsForYtUrl) window.api.saveManualSync(lyricsForYtUrl, syncLines);
  toast('이 지점부터 동기화됐어요');
}

// 타임스탬프가 없는 텍스트 전용 가사는 정확한 줄 동기화가 불가능하니, 최소한
// "재생 진행률 = 가사 스크롤 진행률"로 맞춰서 곡이 끝나갈 때 가사도 끝부분에 가 있도록 함
// (형이 "텍스트만 모드라도 넘어가기는 해야 될거 아냐"라고 지적해서 추가, 2026-07-20).
function updatePlainLyricsScroll() {
  if (!inLyrics || !lyricsState?.found || lyricsState.syncedLines?.length || !lyricsState.plain) return;
  // 형이 실제로 부르는 줄을 찾아서 탭하려는 도중에 자동 스크롤이 계속 밀고 나가서
  // 원하는 줄을 못 맞추는 문제가 있었음(2026-07-20) — 휠로 직접 스크롤을 시작하면
  // 그 다음부턴 자동 진행률 스크롤을 멈추고 형이 맞춰놓은 위치를 그대로 둔다.
  if (plainScrollOverride) return;
  const dur = audio.duration || 0;
  if (!dur) return;
  const maxScroll = lyrPList.scrollHeight - lyrMask.clientHeight;
  if (maxScroll <= 0) return;
  const progress = Math.min(1, Math.max(0, audio.currentTime / dur));
  lyrPList.style.transform = `translateY(${-progress * maxScroll}px)`;
}

lyrMask.addEventListener('wheel', (e) => {
  if (!inLyrics || !lyricsState?.found || lyricsState.syncedLines?.length || !lyricsState.plain) return;
  e.preventDefault();
  const maxScroll = lyrPList.scrollHeight - lyrMask.clientHeight;
  if (maxScroll <= 0) return;
  if (!plainScrollOverride) {
    plainScrollOverride = true;
    // 현재 자동 스크롤 위치를 그대로 이어받아서 시작(갑자기 튀지 않게)
    const m = /translateY\((-?[\d.]+)px\)/.exec(lyrPList.style.transform);
    plainScrollOffsetPx = m ? parseFloat(m[1]) : 0;
  }
  plainScrollOffsetPx = Math.min(0, Math.max(-maxScroll, plainScrollOffsetPx - e.deltaY * 0.6));
  lyrPList.style.transform = `translateY(${plainScrollOffsetPx}px)`;
}, { passive: false });

lyrResetLink.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!lyricsState?.manualSync) return;
  lyricsState.syncedLines = [];
  lyricsState.manualSync = false;
  curLineIdx = -1;
  plainScrollOverride = false;
  plainScrollOffsetPx = 0;
  renderLyricsPreview();
  if (lyricsForYtUrl) window.api.saveManualSync(lyricsForYtUrl, []);
  toast('동기화를 해제했어요');
});

function updateLyricsHighlight(force) {
  if (!inLyrics || !lyricsState?.syncedLines?.length) return;
  const t = audio.currentTime || 0;
  const lines = lyricsState.syncedLines;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) { if (lines[i].time <= t) idx = i; else break; }
  if (idx === curLineIdx && !force) return;
  curLineIdx = idx;
  const els = lyrPList.querySelectorAll('.lyr-p-line');
  els.forEach((el, i) => {
    el.classList.remove('current', 'near');
    if (i === idx) el.classList.add('current');
    else if (Math.abs(i - idx) === 1) el.classList.add('near');
  });
  // top:50%로 리스트 맨 위를 컨테이너 중앙에 놓은 상태이므로, 현재 줄(idx)의 "중심"을
  // 그 중앙에 맞추려면 (idx*줄높이 + 줄높이/2)만큼만 위로 밀면 됨.
  // 여기서 -50%를 쓰면 CSS 규칙상 "리스트 자기 자신의 전체 높이의 50%"로 계산돼서
  // 곡 전체 줄 수와 무관하게 항상 "리스트 한가운데 줄"이 화면에 걸리는 버그가 있었음
  // (2026-07-19 빅뱅/한로로 곡에서 재발견 — 짧은 4~5줄 미리보기로만 테스트할 땐 안 드러났음).
  lyrPList.style.transform = `translateY(calc(-16.5px - ${idx * 33}px))`;
}

async function ensureLyricsLoaded() {
  const t = playlists[playingPl]?.tracks?.[currentTrack];
  if (!t) { lyricsState = { found: false }; renderLyricsPreview(); return; }
  if (lyricsForYtUrl === t.ytUrl && lyricsState) { renderLyricsPreview(); return; }
  lyricsState = null; curLineIdx = -1;
  plainScrollOverride = false; plainScrollOffsetPx = 0;
  renderLyricsPreview();
  const res = await window.api.getLyrics(t.ytUrl, t.title, t.channel, t.duration);
  if (playlists[playingPl]?.tracks?.[currentTrack]?.ytUrl !== t.ytUrl) return; // 그 사이 곡이 바뀜
  lyricsForYtUrl = t.ytUrl;
  const lrcLines = res.found ? parseLRCReliable(res.synced, t.duration) : [];
  const manualLines = res.manualSyncLines || [];
  const syncedLines = lrcLines.length ? lrcLines : manualLines;
  lyricsState = { ...res, syncedLines, manualSync: !lrcLines.length && manualLines.length > 0 };
  renderLyricsPreview();
}

async function manualLyricsSearch() {
  const t = playlists[playingPl]?.tracks?.[currentTrack];
  if (!t) return;
  const artist = await openModal('아티스트명 입력', lyricsState?.artist || '');
  if (artist === null) return;
  const title = await openModal('곡 제목 입력', lyricsState?.title || t.title);
  if (title === null) return;
  lyrPList.style.top = '50%';
  lyrPList.style.transform = 'translateY(-50%)';
  lyrPList.innerHTML = '<div class="lyr-p-empty">검색 중...</div>';
  const res = await window.api.searchLyricsManual(t.ytUrl, artist, title, t.duration);
  lyricsForYtUrl = t.ytUrl;
  lyricsState = { ...res, syncedLines: res.found ? parseLRCReliable(res.synced, t.duration) : [] };
  curLineIdx = -1;
  renderLyricsPreview();
}

function toggleLyrics() {
  inLyrics = !inLyrics;
  document.body.classList.toggle('lyrics-mode', inLyrics);
  if (inLyrics) ensureLyricsLoaded();
}
artWrap.addEventListener('click', toggleLyrics);

// 앨범아트 양옆 빈 공간 탭으로 5초 앞/뒤 이동 (형이 "노래 빨리 넘기는 기능 없다"고 요청, 2026-07-20)
function seekBy(sec) {
  if (!audio.duration) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + sec));
}
// 형이 실제로 써보니 방향이 반대로 느껴진다고 해서 좌/우 동작을 스왑함(2026-07-20).
artSeekFwd.addEventListener('click', () => seekBy(-5));
artSeekBack.addEventListener('click', () => seekBy(5));

// 오래 멈춰뒀다가 다시 재생 누르면 "no supported source"가 뜬다는 형 신고(2026-08-16) 대응 —
// 오래 방치된 캐시 스트림 주소가 그 사이 죽어있을 가능성을 겨냥해서, 단순 재개(audio.play())가
// 실패하면 조용히 넘어가지 않고 playTrack을 다시 호출해서 스트림 주소를 새로 받아와 같은
// 위치(audio.currentTime)에서 이어 재생한다. 확실한 원인 확정은 아니라 방어적 보완 조치.
async function togglePlay() {
  if (!audio.src) {
    const tracks = playlists[currentPl].tracks;
    if (!tracks.length) { toast('플레이리스트가 비어 있어요'); return; }
    playTrack(0); return;
  }
  if (isPlaying) { audio.pause(); isPlaying=false; setPlayIcon(false); }
  else {
    try {
      await audio.play();
      isPlaying=true; setPlayIcon(true);
    } catch {
      const resumeSec = audio.currentTime || 0;
      playTrack(currentTrack, playingPl, resumeSec);
      return;
    }
  }
  renderTrackList();
}

// 셔플에서 "현재 곡 인덱스만 뺀" 난수 뽑기 — 예전엔 Math.random이 현재 곡을 다시 뽑아
// 같은 곡이 연달아 나올 수 있었다(2026-08-31 점검에서 발견). 곡이 1개뿐이면 그 곡뿐이다.
function pickShuffleIndex(len, exclude) {
  if (len <= 1) return 0;
  const r = Math.floor(Math.random() * (len - 1));
  return r >= exclude ? r + 1 : r;
}

function nextTrack() {
  if (playingPl<0) return;
  const tracks = playlists[playingPl].tracks;
  if (!tracks.length) return;
  let n;
  if (repeatMode===2) n=currentTrack;
  else if (shuffle) n=pickShuffleIndex(tracks.length, currentTrack);
  else n=(currentTrack+1)%tracks.length;
  playTrack(n, playingPl);
}
function prevTrack() {
  if (playingPl<0) return;
  if (audio.currentTime>3) { audio.currentTime=0; return; }
  const tracks = playlists[playingPl].tracks;
  if (!tracks.length) return;
  playTrack((currentTrack-1+tracks.length)%tracks.length, playingPl);
}

// ── audio events ──────────────────────────────────────────────────────────────
audio.ontimeupdate = () => {
  if (!audio.duration) return;
  progFill.style.width = (audio.currentTime/audio.duration*100)+'%';
  tCur.textContent = fmt(audio.currentTime);
  if (inLyrics) { updateLyricsHighlight(); updatePlainLyricsScroll(); }
  const now = Date.now();
  if (playingPl>=0 && now-lastPosSaveTs>5000) { lastPosSaveTs=now; saveCfg({lastPos: audio.currentTime}); }
};
audio.onpause = () => { if (playingPl>=0) saveCfg({lastPos: audio.currentTime}); };
audio.onended = () => {
  if (repeatMode===2) { audio.currentTime=0; audio.play(); return; }
  wasNaturalEnd = true;
  const tracks = playlists[playingPl]?.tracks || [];
  if (repeatMode===0 && currentTrack===tracks.length-1) {
    // 목록 맨 끝이라 playTrack으로 안 넘어가서, 완주 기록을 여기서 직접 남긴다
    const t = tracks[currentTrack];
    if (t) window.api.recordPlayEvent(t.ytUrl, { title: t.title, channel: t.channel, duration: t.duration, releaseYear: t.releaseYear, listenedSec: audio.duration || t.duration || 0 }, 'complete');
    wasNaturalEnd = false;
    isPlaying=false; setPlayIcon(false); renderTrackList(); return;
  }
  nextTrack();
};

progBar.onclick = e => {
  if (!audio.duration) return;
  const r = progBar.getBoundingClientRect();
  audio.currentTime = ((e.clientX-r.left)/r.width)*audio.duration;
};

// ── controls ──────────────────────────────────────────────────────────────────
btnPlay.onclick = togglePlay;
$('btn-prev').onclick = prevTrack;
$('btn-next').onclick = nextTrack;
$('btn-repeat').onclick = function() {
  repeatMode=(repeatMode+1)%3;
  this.classList.toggle('active', repeatMode>0);
  this.querySelector('.repeat-badge').style.display = repeatMode===2 ? 'flex' : 'none';
};
$('btn-shuffle').onclick = function() {
  shuffle=!shuffle; this.classList.toggle('active', shuffle);
};
function updateVolSlider() { volTrack.style.setProperty('--vol-pct', volSlider.value + '%'); volPct.textContent = volSlider.value; }
volSlider.oninput = function() { audio.volume=this.value/100; updateVolSlider(); };
volSlider.onchange = function() { saveCfg({volume:parseInt(this.value)}); };

// ── search ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='k') { e.preventDefault(); $('qs-input').focus(); $('qs-input').select(); }

  const tag = (e.target.tagName || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  const overlayOpen = document.querySelector('.settings-overlay.show, .modal-ov.show, .ctx-menu.show');
  if (isTyping || overlayOpen) return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'Enter') { e.preventDefault(); window.api.closeApp(); }
});
let _searchTimer = null;
$('qs-input').addEventListener('keydown', e => {
  if (e.key==='Enter') {
    clearTimeout(_searchTimer);
    const q = $('qs-input').value.trim();
    if (looksLikeUrl(q)) { addByUrl(q, true); $('qs-input').value=''; return; }
    doSearch(q);
    if (curView==='home') switchView('search');
  }
});
$('qs-input').addEventListener('input', () => {
  clearTimeout(_searchTimer);
  const q = $('qs-input').value.trim();
  if (looksLikeUrl(q)) return; // URL 입력 중엔 자동검색 생략, Enter로 추가+재생
  _searchTimer = setTimeout(() => {
    if (q.length>2) { doSearch(q); if(curView==='home') switchView('search'); }
  }, 700);
});

async function doSearch(q) {
  if (!q) { $('search-results').innerHTML='<div class="search-empty">검색어를 입력하세요</div>'; return; }
  $('search-results').innerHTML='<div class="search-empty">검색 중...</div>';
  const res = await window.api.search(q);
  if (res.error) { $('search-results').innerHTML=`<div class="search-empty">오류: ${res.error}</div>`; return; }
  if (!res.length) { $('search-results').innerHTML='<div class="search-empty">결과 없음</div>'; return; }
  $('search-results').innerHTML='';
  res.forEach(r => {
    const el = document.createElement('div');
    el.className='s-item';
    el.innerHTML=`
      <img class="s-thumb" src="${esc(r.thumbnail||'')}" onerror="this.style.visibility='hidden'" alt="" draggable="false"/>
      <div class="s-meta"><div class="s-title">${esc(r.title)}</div><div class="s-ch">${esc(r.channel)}${r.duration?' · '+fmt(r.duration):''}</div></div>
      <button class="s-add">+ 추가</button>
    `;
    el.querySelector('.s-add').onclick = async e => {
      e.stopPropagation();
      const btn=e.target; btn.textContent='추가 중...'; btn.disabled=true;
      addManualTrack(currentPl, {ytUrl:r.ytUrl,title:r.title,channel:r.channel,thumbnail:r.thumbnail,duration:r.duration,releaseYear:r.releaseYear});
      await save(); renderTrackList();
      btn.textContent='✓ 추가됨';
    };
    el.onclick = e => {
      if(e.target.classList.contains('s-add')) return;
      const idx = addManualTrack(currentPl, {ytUrl:r.ytUrl,title:r.title,channel:r.channel,thumbnail:r.thumbnail,duration:r.duration,releaseYear:r.releaseYear}, {autoplayNow: true});
      save(); renderTrackList();
      switchView('home');
      playTrack(idx);
    };
    $('search-results').appendChild(el);
  });
}

// ── playlist management ───────────────────────────────────────────────────────
$('btn-new-pl').onclick = async () => {
  const n = await openModal('새 플레이리스트 이름');
  if (!n) return;
  playlists.push({id:uid(),name:n,tracks:[]});
  currentPl=playlists.length-1;
  await save(); renderTabs(); renderTrackList();
};
$('btn-rename-pl').onclick = async () => {
  const n = await openModal('이름 변경', playlists[currentPl].name);
  if (!n) return;
  playlists[currentPl].name=n; await save(); renderTabs();
};

// ── context menu ─────────────────────────────────────────────────────────────
let _ctxIdx = -1;
const ctxMenu = $('ctx-menu');
const ctxMain = $('ctx-main');
const ctxMoveList = $('ctx-move-list');
function showCtxMain() { ctxMain.style.display = ''; ctxMoveList.style.display = 'none'; }
function hideCtx() { ctxMenu.classList.remove('show'); showCtxMain(); }
document.addEventListener('click', hideCtx);
document.addEventListener('contextmenu', hideCtx);

function showCtxMenu(e, idx) {
  e.preventDefault(); e.stopPropagation();
  _ctxIdx = idx;
  showCtxMain();
  $('ctx-move').style.display = playlists.length > 1 ? '' : 'none';
  const ctxChannel = playlists[currentPl]?.tracks[idx]?.channel || '';
  $('ctx-block-channel').style.display = ctxChannel ? '' : 'none';
  $('ctx-block-channel-label').textContent = blockedChannels.has(ctxChannel)
    ? '이 채널 추천 제외 해제' : '이 채널 추천에서 제외';
  ctxMenu.classList.add('show'); // 실제 크기를 재려면 먼저 보이는 상태여야 함 — 같은 틱 안에서 위치까지 잡으니 깜빡임 없음

  const menuW = ctxMenu.offsetWidth;
  const menuH = ctxMenu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;

  // 클릭 지점이 플레이어 가로 중앙보다 왼쪽이면 메뉴의 좌측 하단 모서리를, 오른쪽이면
  // 우측 하단 모서리를 커서 위치에 맞춰 위쪽으로 펼침(형 요청, 2026-08-02) — 창 밖으로
  // 잘리지 않게 가로/세로 둘 다 클램프(세로는 창 높이가 채움상태 등으로 커져도 항상 실측값 사용).
  let left = (e.clientX < vw / 2) ? e.clientX : e.clientX - menuW;
  let top = e.clientY - menuH;

  left = Math.max(4, Math.min(left, vw - menuW - 4));
  top = Math.max(4, Math.min(top, vh - menuH - 4));

  ctxMenu.style.left = left + 'px';
  ctxMenu.style.top = top + 'px';
}
$('ctx-del').onclick = (e) => {
  e.stopPropagation();
  hideCtx();
  if (_ctxIdx >= 0) removeTrack(_ctxIdx);
};
$('ctx-copy-link').onclick = async (e) => {
  e.stopPropagation();
  hideCtx();
  const track = playlists[currentPl]?.tracks[_ctxIdx];
  if (!track?.ytUrl) return;
  await window.api.copyText(track.ytUrl);
  toast('링크를 복사했어요');
};
// 형이 의도치 않은 채널이 추천에 계속 끼어들 때 직접 끊는 스위치(2026-08-08 추가) — 채널을
// 차단하면 scoreCandidate가 -Infinity 처리해서 그 채널은 앞으로 추천 후보에서 아예 빠진다.
$('ctx-block-channel').onclick = async (e) => {
  e.stopPropagation();
  hideCtx();
  const track = playlists[currentPl]?.tracks[_ctxIdx];
  const channel = track?.channel;
  if (!channel) return;
  const nowBlocked = await window.api.toggleChannelBlock(channel);
  if (nowBlocked) blockedChannels.add(channel); else blockedChannels.delete(channel);
  updateBlockedChSub();
  toast(nowBlocked ? `"${channel}" 채널을 추천에서 제외했어요` : `"${channel}" 채널 추천 제외를 해제했어요`);
};

function moveTrackToPlaylist(idx, targetPlIdx) {
  const track = playlists[currentPl].tracks.splice(idx, 1)[0];
  if (!track) return;
  playlists[targetPlIdx].tracks.push(track);
  if (currentPl===playingPl) {
    if (currentTrack === idx) {
      // 지금 재생 중인 곡 자체를 다른 목록으로 옮기는 경우 — 끊지 않고 그대로 재생 유지,
      // 재생 위치만 새 플레이리스트/인덱스로 갱신(형 요청, 2026-08-02)
      playingPl = targetPlIdx;
      currentTrack = playlists[targetPlIdx].tracks.length - 1;
      saveCfg({ lastPlId: playlists[targetPlIdx].id, lastTrackIdx: currentTrack });
    }
    else if (currentTrack > idx) { currentTrack--; saveCfg({lastTrackIdx: currentTrack}); }
  }
  save(); renderTrackList(); renderTabs();
}

$('ctx-move').onclick = (e) => {
  e.stopPropagation();
  ctxMoveList.innerHTML = `
    <button class="ctx-item ctx-back" id="ctx-back"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>뒤로</button>
    ${playlists.map((pl, i) => i===currentPl ? '' : `<button class="ctx-item ctx-pl-opt" data-i="${i}"><span class="ctx-pl-name">${esc(pl.name)}</span></button>`).join('')}
  `;
  ctxMain.style.display = 'none';
  ctxMoveList.style.display = '';
  ctxMoveList.querySelectorAll('.ctx-pl-opt').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      hideCtx();
      if (_ctxIdx >= 0) moveTrackToPlaylist(_ctxIdx, parseInt(btn.dataset.i, 10));
    };
  });
  $('ctx-back').onclick = (ev) => { ev.stopPropagation(); showCtxMain(); };
};

// ── about overlay ─────────────────────────────────────────────────────────────
$('about-close').onclick = () => $('about-ov').classList.remove('show');
$('about-ov').addEventListener('click', e => { if(e.target===$('about-ov')) $('about-ov').classList.remove('show'); });

// K-시리즈 About 창 버전 표기는 "v1.2.3" 형식으로 통일(2026-08-25 — K-Clock은 "v",
// K-Zone/K-Tube/K-Memo/K-Music은 "버전 "이라 나란히 놓으면 표기가 달라 보였음).
window.api.getAppVersion().then(v => { $('about-version').textContent = `v${v}`; });

$('about-check-update').onclick = () => {
  $('about-check-update').disabled = true;
  $('about-update-status').textContent = '확인 중...';
  window.api.checkForUpdates().then(res => {
    if (res === 'dev') {
      $('about-check-update').disabled = false;
      $('about-update-status').textContent = '개발 모드에서는 확인할 수 없어요.';
    }
  });
};

// ── auto-update ───────────────────────────────────────────────────────────────
window.api.onUpdateAvailable(() => {
  toast('업데이트가 있어요. 다운로드 중...');
  $('about-check-update').disabled = false;
  $('about-update-status').textContent = '새 버전 발견, 다운로드 중...';
});
window.api.onUpdateNotAvailable(() => {
  $('about-check-update').disabled = false;
  $('about-update-status').textContent = '최신 버전을 사용 중이에요.';
});
window.api.onUpdateError((msg) => {
  $('about-check-update').disabled = false;
  $('about-update-status').textContent = '업데이트 확인 실패, 잠시 후 다시 시도해주세요.';
  // 실제 원인(네트워크 오류/다운로드 실패 등)을 그냥 버리고 있었음 — 콘솔에라도 남겨서
  // 다음에 같은 리포트 받으면 원인 추적 가능하게(형 리포트로 발견, 2026-08-02)
  if (msg) console.error('[K-Music] 업데이트 오류:', msg);
});
window.api.onUpdateDownloaded(() => {
  $('about-update-status').textContent = '다운로드 완료! 재시작하면 설치돼요.';
  const ok = confirm('업데이트 다운로드 완료! 지금 재시작하여 설치할까요?');
  if (ok) window.api.installUpdate();
});

// ── tray → renderer 이벤트 ────────────────────────────────────────────────────
window.api.onOpenSettings(() => openSettings());
window.api.onOpenAbout(() => $('about-ov').classList.add('show'));

// ── window ────────────────────────────────────────────────────────────────────
$('btn-min').onclick = () => window.api.minimize();
$('btn-close').onclick = () => window.api.closeApp();

// 제목("K Music Player") 더블클릭 → 세로로 꽉 채우기 토글.
// OS 기본 최대화(SC_MAXIMIZE)에 의존하지 않고, 우리가 직접 토글을 걸어준다.
//
// ⚠️ 왜 헤더 전체가 아니라 제목만인가 (2026-07-25, Windows에서 안 먹던 버그 수정):
// 헤더는 -webkit-app-region:drag(프레임 없는 창을 잡고 옮기려고)인데, Windows에선
// 이 drag 영역이 OS 상 "타이틀바(HTCAPTION)"로 취급돼서, 그 위에서 마우스를 누르면
// Windows가 창 이동 처리로 이벤트를 가로채버림 → 렌더러 DOM엔 mousedown/click/dblclick이
// 아예(또는 불안정하게) 안 들어옴. 맥은 drag를 다른 계층에서 처리해서 DOM 이벤트가 살아있어
// 예전 mousedown 방식이 맥에서만 됐던 것. 그래서 제목 영역만 no-drag로 빼고(index.html
// .app-title에 -webkit-app-region:no-drag), win-btns처럼 평범한 dblclick으로 감지한다.
// no-drag 영역은 두 OS 모두 일반 버튼과 똑같이 이벤트가 확실히 들어옴.
$('app-title')?.addEventListener('dblclick', () => {
  window.api.toggleFillHeight();
});
function applyPinState(pinned) {
  const btn = $('btn-pin');
  btn.style.background = pinned ? 'var(--prog)' : '';
  btn.style.color = pinned ? '#fff' : '';
}
$('btn-pin').onclick = async function() {
  const pinned = await window.api.toggleAlwaysOnTop();
  applyPinState(pinned);
  await saveCfg({ alwaysOnTop: pinned });
};

// ── init ──────────────────────────────────────────────────────────────────────
(async () => {
  currentAccount = await window.api.getActiveAccount();
  if (!currentAccount) {
    $('firstrun-ov').classList.add('show');
    $('login-name-input').focus();
  } else {
    updateAccountUi();
    blockedChannels = new Set(await window.api.getBlockedChannels());
    updateBlockedChSub();
  }

  config = await window.api.getConfig();
  playlists = await window.api.getPlaylists();
  if (!playlists?.length) playlists=[{id:uid(),name:'My Playlist',tracks:[]}];
  applyTheme(config.theme);
  volSlider.value = config.volume??80;
  audio.volume = volSlider.value/100;
  updateVolSlider();
  renderTabs(); renderTrackList();
  if (config.resume && config.lastPlId) {
    const pi = playlists.findIndex(p=>p.id===config.lastPlId);
    if (pi>=0) { currentPl=pi; renderTabs(); renderTrackList(); }
    if (config.autoplay && config.lastTrackIdx!=null && playlists[currentPl]?.tracks[config.lastTrackIdx]) {
      playTrack(config.lastTrackIdx, currentPl, config.lastPos||0);
    }
  }
  // restore always-on-top
  if (config.alwaysOnTop) {
    await window.api.setAlwaysOnTop(true);
    applyPinState(true);
  }

  const ytc = await window.api.checkYtdlp();
  if (!ytc.ok) toast('yt-dlp를 찾을 수 없어요');

  // 시작 직후 선행 워밍 — 형이 첫 곡을 누르기 전에 앞쪽 곡의 스트림 주소를 미리 받아둔다.
  // 3초 지연을 두는 이유: 이어듣기 자동재생(playTrack)이 지금 자기 곡을 받아오는 중일 수
  // 있는데, 같은 타이밍에 워밍까지 스폰하면 yt-dlp 2개가 동시에 돌아 첫 재생이 오히려
  // 늦어진다. 자동재생의 첫 로딩이 끝날 시간을 주고 시작한다.
  setTimeout(() => warmQueueHead(), 3000);
})();
