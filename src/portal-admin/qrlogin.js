'use strict';
// QR sign-in for JoolzApp accounts: a device with no good keyboard (a TV) shows a QR code; a phone that is already signed in to the
// JoolzApp Dashboard scans it, sees who is asking, and taps Approve. The app that started it then learns WHICH PERSON approved, and signs
// that person in itself (apps mint their own sessions, so no PocketBase token or password ever travels to the TV).
//   start(app, {label})  an app (with its Portal API key) opens a request            -> { id, secret, expiresIn }
//   info(id, user)       the phone looks at it (signed in)                              -> { app, label, ageSeconds }
//   decide(id, user, ok) the phone approves or denies (signed in)                       -> { ok }
//   poll(app, id, secret) the app asks how it went; an approval is handed over ONCE    -> { status, userId? }
// Everything is in memory on purpose: a request lives 2 minutes, a restart just cancels the pending ones.
const crypto = require('crypto');

const PENDING_MS = 120e3, DONE_MS = 60e3, MAX_PENDING = 300, PER_APP_PER_MIN = 12;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const cleanLabel = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const fail = (status, message) => Object.assign(new Error(message), { status });

module.exports = function makeQrLogin({ now = Date.now } = {}) {
  const reqs = new Map();      // id -> { secretHash, app, label, created, status, userId, doneAt }
  const starts = new Map();    // app -> [timestamps]

  function sweep() {
    const t = now();
    for (const [id, r] of reqs) if (t - r.created > PENDING_MS + DONE_MS || (r.doneAt && t - r.doneAt > DONE_MS)) reqs.delete(id);
  }
  const live = (r) => r && now() - r.created <= PENDING_MS;
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);

  function start(app, opt = {}) {
    sweep();
    const t = now(), recent = (starts.get(app) || []).filter((x) => t - x < 60e3);
    if (recent.length >= PER_APP_PER_MIN) throw fail(429, 'Too many QR codes requested. Wait a minute.');
    if (reqs.size >= MAX_PENDING) throw fail(503, 'Too many sign-ins are waiting. Try again shortly.');
    recent.push(t); starts.set(app, recent);
    const id = crypto.randomBytes(16).toString('base64url'), secret = crypto.randomBytes(32).toString('base64url');
    reqs.set(id, { secretHash: sha(secret), app: String(app), label: cleanLabel(opt.label) || String(app), created: t, status: 'pending', userId: '' });
    return { id, secret, expiresIn: Math.round(PENDING_MS / 1000) };
  }

  function info(id, user) {
    if (!user || !user.id) throw fail(401, 'Sign in to continue.');
    sweep(); const r = validId(id) && reqs.get(id);
    if (!r || !live(r) || r.status !== 'pending') throw fail(404, 'This QR code has expired. Ask the TV for a new one.');
    return { app: r.app, label: r.label, ageSeconds: Math.round((now() - r.created) / 1000) };
  }

  function decide(id, user, approve) {
    if (!user || !user.id) throw fail(401, 'Sign in to continue.');
    sweep(); const r = validId(id) && reqs.get(id);
    if (!r || !live(r) || r.status !== 'pending') throw fail(404, 'This QR code has expired. Ask the TV for a new one.');
    r.status = approve ? 'approved' : 'denied'; r.doneAt = now(); r.userId = approve ? String(user.id) : '';
    return { ok: true, status: r.status };
  }

  function poll(app, id, secret) {
    sweep(); const r = validId(id) && reqs.get(id);
    const a = sha(secret), ok = r && crypto.timingSafeEqual(a, r.secretHash) && r.app === String(app);
    if (!ok) return { status: 'expired' };                       // unknown id, wrong secret and wrong app all look the same
    if (r.status === 'pending') return live(r) ? { status: 'pending' } : (reqs.delete(id), { status: 'expired' });
    reqs.delete(id);                                             // approved or denied: handed over once
    return r.status === 'approved' ? { status: 'approved', userId: r.userId } : { status: 'denied' };
  }
  return { start, info, decide, poll, _size: () => reqs.size };
};
