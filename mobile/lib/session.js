// K-Music 모바일 — 로그인 세션(PIN 게이트)
//
// 데스크톱 앱의 계정/PIN은 "같은 PC 쓰는 다른 사람과 재생기록을 안 섞기 위한 칸막이"였지
// 진짜 보안 장치가 아니었다(main.js 주석 참고). 그런데 서버로 올리는 순간 성격이 달라진다 —
// 주소만 알면 아무나 열 수 있게 되고, 그건 "개인 PC 도구"가 "서비스 제공"으로 넘어가는
// 선이라 유튜브 ToS 리스크가 오히려 커진다. 그래서 같은 PIN 체계를 쓰되, 서버 쪽에서는
// 실제 방어 장치로 취급한다: 세션 토큰은 암호학적 난수, 로그인은 IP·계정 단위로 횟수 제한,
// 실패해도 어느 쪽이 틀렸는지(이름/PIN) 알려주지 않는다.
//
// ⚠️ 절대 하면 안 되는 것: 이 주소를 공개 링크로 뿌리거나 검색에 노출시키는 것.
//    서버는 robots noindex를 붙이지만 그건 최소한의 예의일 뿐 방어가 아니다.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 폰에서 매번 로그인하게 만들면 안 쓰게 됨 — 30일
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// 로그인 시도 제한. PIN이 4~6자리 숫자뿐이라 무제한으로 두면 실제로 뚫린다
// (4자리 = 1만 가지). IP당·계정당 둘 다 건다 — IP만 걸면 여러 IP에서 한 계정을,
// 계정만 걸면 한 IP에서 여러 계정을 두드리는 걸 못 막는다.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

class SessionStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'mobile-sessions.json');
    this.sessions = new Map(); // token -> { accountId, createdAt, lastSeen }
    this.failures = new Map(); // key(ip|acct) -> [timestamps]
    this._load();
    this._timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this._timer.unref?.();
  }

  // 서버를 재시작할 때마다 폰이 로그아웃되면 실사용이 괴로워서 디스크에 남긴다.
  // 파일 권한은 600 — 세션 토큰은 사실상 비밀번호와 같은 값이라 다른 사용자가 읽으면 끝이다.
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [token, s] of Object.entries(raw)) {
        if (now - s.createdAt < SESSION_TTL_MS) this.sessions.set(token, s);
      }
    } catch { /* 없으면 빈 상태로 시작 */ }
  }

  _persist() {
    const obj = Object.fromEntries(this.sessions);
    const tmp = this.file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  create(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, { accountId, createdAt: now, lastSeen: now });
    this._persist();
    return token;
  }

  get(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.createdAt >= SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(token) {
    if (this.sessions.delete(token)) this._persist();
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of this.sessions) {
      if (now - s.createdAt >= SESSION_TTL_MS) { this.sessions.delete(token); changed = true; }
    }
    for (const [key, arr] of this.failures) {
      const kept = arr.filter(t => now - t < LOGIN_WINDOW_MS);
      if (kept.length) this.failures.set(key, kept); else this.failures.delete(key);
    }
    if (changed) this._persist();
  }

  isLoginBlocked(keys) {
    const now = Date.now();
    return keys.some(k => {
      const arr = (this.failures.get(k) || []).filter(t => now - t < LOGIN_WINDOW_MS);
      return arr.length >= LOGIN_MAX_FAILS;
    });
  }

  noteLoginFailure(keys) {
    const now = Date.now();
    for (const k of keys) {
      const arr = (this.failures.get(k) || []).filter(t => now - t < LOGIN_WINDOW_MS);
      arr.push(now);
      this.failures.set(k, arr);
    }
  }

  clearLoginFailures(keys) {
    for (const k of keys) this.failures.delete(k);
  }
}

module.exports = { SessionStore, SESSION_TTL_MS };
