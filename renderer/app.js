'use strict';

const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// ── state ─────────────────────────────────────────────────────────────────────
let playlists = [];
let currentPl = 0;
let playingPl = -1;  // which playlist the currently-loaded track actually belongs to — separate
                      // from currentPl (whichever tab the user is just LOOKING at), since those
                      // can differ once you view a different playlist while something plays
let currentTrack = -1;
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
const artBadge   = $('art-badge');
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
// 시드는 항상 "지금 실제로 재생중인 곡"으로 고정한다 — 예전엔 큐에 마지막으로 넣어둔 곡을
// 다음 시드로 삼아서(체이닝), 채워질 때마다 그 3번째곡 → 또 그 3번째곡 하는 식으로 계속
// 이어붙였는데, 이러면 유튜브 믹스 특성상 몇 단계만 넘어가도 원래 곡과 전혀 상관없는 방향
// 으로 새버린다(형 실사용 중 발견, 2026-08-08 — 풀하우스 OST 듣다가 몇 단계 만에 인도네시아
// 밴드 노래로 도배됨). 매번 지금 듣고 있는 곡에서 다시 출발하면 드리프트가 누적되지 않는다.
let extendingQueue = false;
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
    const recs = await window.api.getRecommendations(`https://www.youtube.com/watch?v=${seedId}`, excludeItems, need);
    if (!recs.length) return;
    // await 도중 사용자가 다른 곡/목록으로 옮겨갔을 수 있으니 재확인 후 반영
    if (playingPl !== plIdx || playlists[plIdx]?.tracks !== tracks) return;
    recs.forEach(r => tracks.push({ ytUrl: r.ytUrl, title: r.title, channel: r.channel, thumbnail: r.thumbnail, duration: r.duration, releaseYear: r.releaseYear, source: 'auto' }));
    await save();
    if (curView === 'home' && currentPl === plIdx) renderTrackList();
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

function updateQualityBadge() { artBadge.textContent = `${config.quality || '192'}k`; }

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
  const res = await window.api.getStream(ytUrl, config.quality || '192');
  if (res.error) throw new Error(res.error);
  streamCache[ytUrl] = { url: res.streamUrl, expireTs: now + 5.5*3600*1000 };
  return res.streamUrl;
}

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

// ── settings overlay ──────────────────────────────────────────────────────────
async function openSettings() {
  updateAccountUi();
  $('cfg-quality').value = config.quality || '192';
  $('cfg-theme').value = config.theme || 'default';
  $('cfg-auto').checked = !!config.autoplay;
  $('cfg-resume').checked = !!config.resume;
  $('auto-sub').textContent = config.autoplay ? '켜짐' : '꺼짐';
  $('cfg-startup').checked = await window.api.getLoginItem();
  $('settings-ov').classList.add('show');
}
function closeSettings() { $('settings-ov').classList.remove('show'); }
$('nav-settings').onclick = openSettings;
$('settings-close').onclick = closeSettings;
$('settings-ov').addEventListener('click', e => { if(e.target===$('settings-ov')) closeSettings(); });
$('cfg-auto').onchange = function() { $('auto-sub').textContent = this.checked ? '켜짐' : '꺼짐'; };
$('settings-save').onclick = async () => {
  const theme = $('cfg-theme').value;
  await saveCfg({
    quality: $('cfg-quality').value,
    theme,
    autoplay: $('cfg-auto').checked,
    resume: $('cfg-resume').checked,
    alwaysOnTop: config.alwaysOnTop
  });
  applyTheme(theme);
  updateQualityBadge();
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
      if (playlists.length<=1) { toast('마지막 플레이리스트는 삭제 불가'); return; }
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

async function playTrack(idx, plIdx = currentPl, resumeSec = 0) {
  const tracks = playlists[plIdx].tracks;
  if (!tracks[idx]) return;

  // 직전 곡의 완주/스킵을 기록(재정렬 알고리즘의 핵심 신호). resumeSec>0인 이어듣기 재시작
  // 케이스는 currentTrack===idx라서 아래 조건에서 자연히 제외됨.
  if (playingPl >= 0 && playlists[playingPl]?.tracks[currentTrack] && (playingPl !== plIdx || currentTrack !== idx)) {
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
  // URL을 받아와 한 번만 더 시도한다. 이것도 실패해야 토스트를 띄운다(2026-08-08 — 예전에
  // 문서에만 계획으로 남고 실제 코드 반영이 안 돼있던 걸 재발견해서 이번에 실제로 구현).
  const attemptLoad = async (force) => {
    const url = await getStream(t.ytUrl, force);
    audio.src = url;
    audio.volume = volSlider.value/100;
    if (resumeSec > 0) audio.currentTime = resumeSec;
    await audio.play();
  };
  try {
    try {
      await attemptLoad(false);
    } catch {
      await attemptLoad(true);
    }
    isPlaying=true; setPlayIcon(true);
    await saveCfg({lastPlId: playlists[plIdx].id, lastTrackIdx: idx, lastPos: resumeSec});
    if (inLyrics) ensureLyricsLoaded();
    window.api.recordPlayEvent(t.ytUrl, { title: t.title, channel: t.channel, duration: t.duration, releaseYear: t.releaseYear }, 'play');
    maybeExtendQueue(plIdx); // 큐 보충은 백그라운드로, 재생 시작을 기다리게 하지 않음
    pruneOldAutoTracks(plIdx); // 지나간 추천곡은 최근 10곡만 남기고 정리
  } catch(e) {
    toast('재생 실패: '+e.message);
    isPlaying=false; setPlayIcon(false);
    currentTrack = prev; playingPl = prevPl;
  } finally { hideLoad(); renderTrackList(); }
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
    lyrBadgeTx.textContent = '가사 (텍스트만) · 줄을 탭하면 그 지점부터 동기화, 휠로 스크롤 가능';
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
  toast('동기화 해제됨');
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

function togglePlay() {
  if (!audio.src) {
    const tracks = playlists[currentPl].tracks;
    if (!tracks.length) { toast('플레이리스트가 비어있습니다'); return; }
    playTrack(0); return;
  }
  if (isPlaying) { audio.pause(); isPlaying=false; setPlayIcon(false); }
  else { audio.play(); isPlaying=true; setPlayIcon(true); }
  renderTrackList();
}

function nextTrack() {
  if (playingPl<0) return;
  const tracks = playlists[playingPl].tracks;
  if (!tracks.length) return;
  let n;
  if (repeatMode===2) n=currentTrack;
  else if (shuffle) n=Math.floor(Math.random()*tracks.length);
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
  toast('링크를 복사했습니다');
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

window.api.getAppVersion().then(v => { $('about-version').textContent = `버전 ${v}`; });

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
  $('about-update-status').textContent = '최신 버전 사용 중입니다.';
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
  updateQualityBadge();
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
  if (!ytc.ok) toast('yt-dlp를 찾을 수 없습니다');
})();
