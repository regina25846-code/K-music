'use strict';

// ── state ─────────────────────────────────────────────────────────────────────
let playlists = [];
let currentPl = 0;
let currentTrack = -1;
let isPlaying = false;
let repeatMode = 0;  // 0=off 1=all 2=one
let shuffle = false;
let config = {};
let streamCache = {};  // ytUrl -> { url, expireTs }

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
const plTabs     = $('pl-tabs');
const trackList  = $('track-list');
const loading    = $('loading');
const toastEl    = $('toast');

// ── helpers ───────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}
function showLoad(msg='처리 중...') { $('loading-text').textContent = msg; loading.classList.add('show'); }
function hideLoad() { loading.classList.remove('show'); }

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

// ── stream cache ──────────────────────────────────────────────────────────────
async function getStream(ytUrl) {
  const now = Date.now();
  const c = streamCache[ytUrl];
  if (c && c.expireTs > now + 60000) return c.url;
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

// ── settings overlay ──────────────────────────────────────────────────────────
async function openSettings() {
  $('cfg-quality').value = config.quality || '192';
  $('cfg-auto').checked = !!config.autoplay;
  $('cfg-resume').checked = !!config.resume;
  $('auto-sub').textContent = config.autoplay ? 'On' : 'Off';
  $('cfg-startup').checked = await window.api.getLoginItem();
  $('settings-ov').classList.add('show');
}
function closeSettings() { $('settings-ov').classList.remove('show'); }
$('nav-settings').onclick = openSettings;
$('settings-close').onclick = closeSettings;
$('settings-ov').addEventListener('click', e => { if(e.target===$('settings-ov')) closeSettings(); });
$('cfg-auto').onchange = function() { $('auto-sub').textContent = this.checked ? 'On' : 'Off'; };
$('settings-save').onclick = async () => {
  await saveCfg({
    quality: $('cfg-quality').value,
    autoplay: $('cfg-auto').checked,
    resume: $('cfg-resume').checked,
    alwaysOnTop: config.alwaysOnTop
  });
  await window.api.setLoginItem($('cfg-startup').checked);
  closeSettings();
  toast('설정 저장됨');
};

// ── add URL overlay ───────────────────────────────────────────────────────────
$('btn-add-url').onclick = () => { $('url-overlay').classList.add('show'); $('url-input').focus(); };
$('url-cancel').onclick = () => { $('url-overlay').classList.remove('show'); $('url-input').value=''; };
$('url-overlay').addEventListener('click', e => { if(e.target===$('url-overlay')) { $('url-overlay').classList.remove('show'); $('url-input').value=''; } });
$('url-ok').onclick = () => { addByUrl($('url-input').value); $('url-input').value=''; $('url-overlay').classList.remove('show'); };
$('url-input').onkeydown = e => { if(e.key==='Enter') { addByUrl($('url-input').value); $('url-input').value=''; $('url-overlay').classList.remove('show'); } if(e.key==='Escape') { $('url-overlay').classList.remove('show'); } };

// ── render ────────────────────────────────────────────────────────────────────
function renderTabs() {
  plTabs.innerHTML = '';
  playlists.forEach((pl, i) => {
    const t = document.createElement('button');
    t.className = 'pl-tab' + (i===currentPl?' active':'');
    t.textContent = pl.name;
    t.onclick = () => { currentPl=i; renderTabs(); renderTrackList(); };
    plTabs.appendChild(t);
  });
}

function renderTrackList() {
  const tracks = playlists[currentPl]?.tracks || [];
  if (!tracks.length) {
    trackList.innerHTML = '<div class="track-empty">이 플레이리스트에 곡이 없습니다.<br>⊕ Add URL 또는 Search로 추가하세요.</div>';
    return;
  }
  trackList.innerHTML = '';
  tracks.forEach((t, i) => {
    const playing = (i===currentTrack);
    const el = document.createElement('div');
    el.className = 'track-item' + (playing?' playing':'');
    el.innerHTML = `
      <span class="t-num ${playing?'arrow':''}">${playing?'⇒':(i+1)}</span>
      <img class="t-thumb" src="${esc(t.thumbnail||'')}" onerror="this.style.visibility='hidden'" alt=""/>
      <div class="t-meta"><div class="t-title">${esc(t.title)}</div><div class="t-ch">${esc(t.channel)}</div></div>
      <button class="t-del" data-i="${i}">🗑</button>
    `;
    el.querySelector('.t-del').onclick = e => { e.stopPropagation(); removeTrack(i); };
    el.onclick = () => playTrack(i);
    el.oncontextmenu = e => showCtxMenu(e, i);
    trackList.appendChild(el);
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
async function addByUrl(url) {
  url = url.trim();
  if (!url || !url.startsWith('http')) { toast('올바른 YouTube URL을 입력하세요'); return; }
  showLoad('곡 정보 가져오는 중...');
  try {
    const info = await window.api.getVideoInfo(url);
    if (info.error) { toast('오류: '+info.error); return; }
    playlists[currentPl].tracks.push({ytUrl:url, title:info.title, channel:info.channel, thumbnail:info.thumbnail, duration:info.duration});
    await save(); renderTrackList();
    toast(`"${info.title.slice(0,20)}..." 추가됨`);
  } catch(e) { toast('추가 실패: '+e.message); } finally { hideLoad(); }
}

function removeTrack(i) {
  playlists[currentPl].tracks.splice(i,1);
  if (currentTrack===i) { currentTrack=-1; stopAudio(); }
  else if (currentTrack>i) currentTrack--;
  save(); renderTrackList();
}

// ── playback ──────────────────────────────────────────────────────────────────
function setPlayIcon(playing) {
  document.getElementById('icon-play').style.display = playing ? 'none' : '';
  document.getElementById('icon-pause').style.display = playing ? '' : 'none';
}

function stopAudio() {
  audio.pause(); audio.src='';
  isPlaying=false; setPlayIcon(false);
  progFill.style.width='0%'; tCur.textContent='0:00';
  albumArt.src=''; trackTitle.textContent='재생 중인 곡 없음'; trackCh.textContent='—';
}

async function playTrack(idx) {
  const tracks = playlists[currentPl].tracks;
  if (!tracks[idx]) return;
  const prev = currentTrack;
  currentTrack = idx;
  const t = tracks[idx];
  trackTitle.textContent = t.title;
  trackCh.textContent = t.channel;
  albumArt.src = t.thumbnail||'';
  tTot.textContent = fmt(t.duration);
  renderTrackList();
  showLoad('스트리밍 로딩 중...');
  try {
    const url = await getStream(t.ytUrl);
    audio.src = url;
    audio.volume = volSlider.value/100;
    await audio.play();
    isPlaying=true; setPlayIcon(true);
    await saveCfg({lastPlId: playlists[currentPl].id, lastTrackIdx: idx});
  } catch(e) {
    toast('재생 실패: '+e.message);
    isPlaying=false; setPlayIcon(false);
    currentTrack = prev;
  } finally { hideLoad(); renderTrackList(); }
}

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
  const tracks = playlists[currentPl].tracks;
  if (!tracks.length) return;
  let n;
  if (repeatMode===2) n=currentTrack;
  else if (shuffle) n=Math.floor(Math.random()*tracks.length);
  else n=(currentTrack+1)%tracks.length;
  playTrack(n);
}
function prevTrack() {
  if (audio.currentTime>3) { audio.currentTime=0; return; }
  const tracks = playlists[currentPl].tracks;
  if (!tracks.length) return;
  playTrack((currentTrack-1+tracks.length)%tracks.length);
}

// ── audio events ──────────────────────────────────────────────────────────────
audio.ontimeupdate = () => {
  if (!audio.duration) return;
  progFill.style.width = (audio.currentTime/audio.duration*100)+'%';
  tCur.textContent = fmt(audio.currentTime);
};
audio.onended = () => {
  if (repeatMode===2) { audio.currentTime=0; audio.play(); return; }
  const tracks = playlists[currentPl].tracks;
  if (repeatMode===0 && currentTrack===tracks.length-1) { isPlaying=false; setPlayIcon(false); renderTrackList(); return; }
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
  toast(['반복 꺼짐','전체 반복','한 곡 반복'][repeatMode]);
};
$('btn-shuffle').onclick = function() {
  shuffle=!shuffle; this.classList.toggle('active', shuffle);
  toast(shuffle?'셔플 켜짐':'셔플 꺼짐');
};
volSlider.oninput = function() { audio.volume=this.value/100; };
volSlider.onchange = function() { saveCfg({volume:parseInt(this.value)}); };

// ── search ────────────────────────────────────────────────────────────────────
let _searchTimer = null;
$('qs-input').addEventListener('keydown', e => {
  if (e.key==='Enter') {
    clearTimeout(_searchTimer);
    doSearch($('qs-input').value.trim());
    if (curView==='home') switchView('search');
  }
});
$('qs-input').addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    const q = $('qs-input').value.trim();
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
      <img class="s-thumb" src="${esc(r.thumbnail||'')}" onerror="this.style.visibility='hidden'" alt=""/>
      <div class="s-meta"><div class="s-title">${esc(r.title)}</div><div class="s-ch">${esc(r.channel)}${r.duration?' · '+fmt(r.duration):''}</div></div>
      <button class="s-add">+ 추가</button>
    `;
    el.querySelector('.s-add').onclick = async e => {
      e.stopPropagation();
      const btn=e.target; btn.textContent='추가 중...'; btn.disabled=true;
      playlists[currentPl].tracks.push({ytUrl:r.ytUrl,title:r.title,channel:r.channel,thumbnail:r.thumbnail,duration:r.duration});
      await save(); renderTrackList();
      btn.textContent='✓ 추가됨'; toast(`"${r.title.slice(0,20)}..." 추가됨`);
    };
    el.onclick = e => {
      if(e.target.classList.contains('s-add')) return;
      playlists[currentPl].tracks.push({ytUrl:r.ytUrl,title:r.title,channel:r.channel,thumbnail:r.thumbnail,duration:r.duration});
      save(); renderTrackList();
      switchView('home');
      playTrack(playlists[currentPl].tracks.length-1);
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
function hideCtx() { ctxMenu.classList.remove('show'); }
document.addEventListener('click', hideCtx);
document.addEventListener('contextmenu', hideCtx);

function showCtxMenu(e, idx) {
  e.preventDefault(); e.stopPropagation();
  _ctxIdx = idx;
  ctxMenu.style.left = Math.min(e.clientX, 400 - 120) + 'px';
  ctxMenu.style.top  = Math.min(e.clientY, 680 - 60) + 'px';
  ctxMenu.classList.add('show');
}
$('ctx-del').onclick = (e) => {
  e.stopPropagation();
  hideCtx();
  if (_ctxIdx >= 0) removeTrack(_ctxIdx);
};

// ── about overlay ─────────────────────────────────────────────────────────────
$('about-close').onclick = () => $('about-ov').classList.remove('show');
$('about-ov').addEventListener('click', e => { if(e.target===$('about-ov')) $('about-ov').classList.remove('show'); });

// ── auto-update ───────────────────────────────────────────────────────────────
window.api.onUpdateAvailable(() => toast('업데이트가 있어요. 다운로드 중...'));
window.api.onUpdateDownloaded(() => {
  const ok = confirm('업데이트 다운로드 완료! 지금 재시작하여 설치할까요?');
  if (ok) window.api.installUpdate();
});

// ── tray → renderer 이벤트 ────────────────────────────────────────────────────
window.api.onOpenSettings(() => openSettings());
window.api.onOpenAbout(() => $('about-ov').classList.add('show'));

// ── window ────────────────────────────────────────────────────────────────────
$('btn-min').onclick = () => window.api.minimize();
$('btn-close').onclick = () => window.api.closeApp();
function applyPinState(pinned) {
  const btn = $('btn-pin');
  btn.style.background = pinned ? 'var(--prog)' : '';
  btn.style.color = pinned ? '#fff' : '';
}
$('btn-pin').onclick = async function() {
  const pinned = await window.api.toggleAlwaysOnTop();
  applyPinState(pinned);
  await saveCfg({ alwaysOnTop: pinned });
  toast(pinned ? '항상 위 고정 켜짐' : '항상 위 고정 꺼짐');
};

// ── init ──────────────────────────────────────────────────────────────────────
(async () => {
  config = await window.api.getConfig();
  playlists = await window.api.getPlaylists();
  if (!playlists?.length) playlists=[{id:uid(),name:'My Playlist',tracks:[]}];
  volSlider.value = config.volume??80;
  audio.volume = volSlider.value/100;
  renderTabs(); renderTrackList();
  if (config.resume && config.lastPlId) {
    const pi = playlists.findIndex(p=>p.id===config.lastPlId);
    if (pi>=0) { currentPl=pi; renderTabs(); renderTrackList(); }
    if (config.autoplay && config.lastTrackIdx!=null && playlists[currentPl]?.tracks[config.lastTrackIdx]) {
      playTrack(config.lastTrackIdx);
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
