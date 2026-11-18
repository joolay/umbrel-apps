/* Quick Access: a faster, less secure way back in with a 4 or 6 digit PIN or a pattern, on a device you already signed in on.
   The device keeps a device id + secret (localStorage); the server checks them together with the code and switches the device off after 5 wrong codes.
   Loaded before app.js; everything here runs when called. */
const QA_KEY = 'pa.quick', QA_KINDS = [['pin4', '4 digit PIN', 'Quickest to type'], ['pin6', '6 digit PIN', 'A bit harder to guess'], ['pattern', 'Pattern', 'Join 4 or more dots']];
const qaGet = () => { try { return JSON.parse(localStorage.getItem(QA_KEY) || 'null'); } catch { return null; } };
const qaPut = (v) => { try { v ? localStorage.setItem(QA_KEY, JSON.stringify(v)) : localStorage.removeItem(QA_KEY); } catch { /* private mode: Quick Access just isn't remembered */ } };
const qaCall = async (body, withToken = true) => {
  const h = { 'content-type': 'application/json' }; if (withToken) h.authorization = state.token;
  const r = await fetch('/quick', { method: 'POST', headers: h, body: JSON.stringify(body), cache: 'no-store' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.message || 'That did not work.'), { status: r.status, left: j.left }); return j;
};
let qaOffset = 0;                                                  // server clock minus this device's clock, so "signed in at" is comparable with the admin's sign-out time
const qaSync = () => fetch('/healthz', { cache: 'no-store' }).then((r) => { const d = Date.parse(r.headers.get('date') || ''); if (d) qaOffset = d - Date.now(); }).catch(() => {});
const qaMarkSignedIn = () => { try { localStorage.setItem('pa.signedInAt', String(Date.now() + qaOffset)); } catch { /* ignore */ } };

/* ---- the pad: a dialog that asks for a PIN or a pattern and resolves with the code (or null when closed) ---- */
function qaAsk({ title, sub = '', kind, note = '' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'qa-dlg';
    const isPat = kind === 'pattern', n = kind === 'pin6' ? 6 : 4;
    dlg.innerHTML = `<div class="qa-in"><button class="qa-x" type="button" aria-label="Close">×</button><h2>${esc(title)}</h2><p class="muted small qa-sub">${esc(sub)}</p>
      ${isPat ? `<div class="qa-pat" id="qa-pat"><svg class="qa-lines" viewBox="0 0 300 300"><polyline id="qa-line" points="" /></svg>${[...Array(9).keys()].map((i) => `<span class="qa-dot" data-i="${i}"><i></i></span>`).join('')}</div>`
        : `<div class="qa-dots">${[...Array(n).keys()].map(() => '<span></span>').join('')}</div><div class="qa-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => k === '' ? '<span></span>' : `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>`}
      <p class="qa-msg small" id="qa-msg">${esc(note)}</p></div>`;
    document.body.appendChild(dlg); dlg.showModal();
    let done = false; const msg = (t) => { dlg.querySelector('#qa-msg').textContent = t || ''; };
    const finish = (v) => { if (done) return; done = true; try { dlg.close(); } catch { /* already closed */ } dlg.remove(); resolve(v); };
    dlg.querySelector('.qa-x').onclick = () => finish(null); dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    if (!isPat) {
      let code = ''; const dots = [...dlg.querySelectorAll('.qa-dots span')];
      const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < code.length));
      const add = (d) => { if (code.length >= n) return; code += d; paint(); if (code.length === n) setTimeout(() => finish(code), 120); };
      dlg.querySelectorAll('.qa-keys button').forEach((b) => { b.onclick = () => { if (b.dataset.k === '⌫') { code = code.slice(0, -1); paint(); } else add(b.dataset.k); }; });
      dlg.addEventListener('keydown', (e) => { if (/^\d$/.test(e.key)) add(e.key); else if (e.key === 'Backspace') { code = code.slice(0, -1); paint(); } });
    } else {
      const pat = dlg.querySelector('#qa-pat'), dots = [...pat.querySelectorAll('.qa-dot')], line = pat.querySelector('#qa-line'); let seq = [], drawing = false;
      const centre = (i) => { const r = dots[i].getBoundingClientRect(), p = pat.getBoundingClientRect(); return [((r.left + r.width / 2 - p.left) / p.width) * 300, ((r.top + r.height / 2 - p.top) / p.height) * 300]; };
      const paint = (cursor) => { dots.forEach((d, i) => d.classList.toggle('on', seq.includes(i))); line.setAttribute('points', seq.map((i) => centre(i).join(',')).concat(cursor ? [cursor.join(',')] : []).join(' ')); };
      const hit = (x, y) => { const el = document.elementFromPoint(x, y), d = el && el.closest && el.closest('.qa-dot'); if (d && pat.contains(d)) { const i = +d.dataset.i; if (!seq.includes(i)) { seq.push(i); } } };
      const pos = (e) => { const p = pat.getBoundingClientRect(); return [((e.clientX - p.left) / p.width) * 300, ((e.clientY - p.top) / p.height) * 300]; };
      pat.addEventListener('pointerdown', (e) => { e.preventDefault(); pat.setPointerCapture && pat.setPointerCapture(e.pointerId); drawing = true; seq = []; msg(''); hit(e.clientX, e.clientY); paint(pos(e)); });
      pat.addEventListener('pointermove', (e) => { if (!drawing) return; hit(e.clientX, e.clientY); paint(pos(e)); });
      const up = () => { if (!drawing) return; drawing = false; paint(); if (seq.length < 4) { msg('Join at least 4 dots.'); setTimeout(() => { seq = []; paint(); }, 500); return; } setTimeout(() => finish('p:' + seq.join('')), 150); };
      pat.addEventListener('pointerup', up); pat.addEventListener('pointercancel', up);
    }
    qaAsk.msg = msg;
  });
}
function qaChoice({ title, text, buttons }) {                      // a small dialog with buttons; resolves with the chosen value (or null)
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog'); dlg.className = 'qa-dlg';
    dlg.innerHTML = `<div class="qa-in"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="qa-btns">${buttons.map((b, i) => `<button type="button" class="btn ${b.primary ? 'primary' : ''}" data-i="${i}">${esc(b.label)}${b.hint ? `<small>${esc(b.hint)}</small>` : ''}</button>`).join('')}</div></div>`;
    document.body.appendChild(dlg); dlg.showModal();
    const fin = (v) => { try { dlg.close(); } catch { /* closed */ } dlg.remove(); resolve(v); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); fin(null); });
    dlg.querySelectorAll('button[data-i]').forEach((b) => { b.onclick = () => fin(buttons[+b.dataset.i].value); });
  });
}
/* ---- set up on this device (needs a signed-in person) ---- */
async function qaSetup() {
  const kind = await qaChoice({ title: 'Quick Access', text: 'Pick how you want to unlock JoolzApp on this device. It is quicker than a password but less secure, so only use it on a device that is yours.',
    buttons: QA_KINDS.map(([v, l, h]) => ({ value: v, label: l, hint: h })).concat([{ value: null, label: 'Cancel' }]) });
  if (!kind) return false;
  for (let tries = 0; tries < 5; tries++) {
    const a = await qaAsk({ title: kind === 'pattern' ? 'Draw your pattern' : 'Choose your PIN', sub: kind === 'pattern' ? 'Join 4 or more dots.' : 'Pick something you will remember.', kind }); if (a === null) return false;
    const b = await qaAsk({ title: kind === 'pattern' ? 'Draw it again' : 'Type it again', sub: 'To make sure it is right.', kind }); if (b === null) return false;
    if (a !== b) { toast('They did not match. Try again.', true); continue; }
    try {
      const d = await qaCall({ action: 'setup', kind, code: a, label: (navigator.userAgentData && navigator.userAgentData.platform) || (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows PC' : 'This device') });
      qaPut({ deviceId: d.deviceId, deviceSecret: d.deviceSecret, kind, email: state.actor }); toast('Quick Access is on for this device.'); return true;
    } catch (e) { toast(e.message, true); return false; }
  }
  return false;
}
/* asked once, right after a new account is made */
async function qaOffer() {
  if (state.role !== 'user') return;
  const v = await qaChoice({ title: 'Add Quick Access?', text: 'Get back in with a 4 or 6 digit PIN or a pattern instead of typing your password. It is faster but less secure. You can change this any time in My settings.',
    buttons: [{ value: 'yes', label: 'Add Quick Access', primary: true }, { value: null, label: 'Not now' }] });
  if (v === 'yes') await qaSetup();
}
/* ---- sign in with it (login screen) ---- */
async function qaLogin() {
  const d = qaGet(); if (!d) return false;
  let note = '';
  for (let i = 0; i < 6; i++) {
    const code = await qaAsk({ title: d.kind === 'pattern' ? 'Draw your pattern' : 'Enter your PIN', sub: d.email || '', kind: d.kind, note }); if (code === null) return false;
    try {
      const r = await qaCall({ action: 'login', deviceId: d.deviceId, deviceSecret: d.deviceSecret, code }, false);
      state.pid = ''; state.pidTried = false; Object.assign(state, { token: r.token, actor: (r.record && r.record.email) || d.email, role: 'user', uid: (r.record && r.record.id) || '' });
      saveSession(true); qaMarkSignedIn(); return true;
    } catch (e) {
      if (e.status === 423 || (e.status === 401 && e.left === undefined)) { qaPut(null); const m = document.getElementById('login-err'); if (m) m.textContent = e.message; return false; }
      note = e.message;
    }
  }
  return false;
}
function qaLoginButton() {                                          // shown on the login form when this device has Quick Access
  const f = document.getElementById('login-form'); if (!f) return; let b = document.getElementById('login-qa');
  const d = qaGet(); if (!d) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'login-qa'; b.className = 'btn qa-login'; f.insertBefore(b, f.querySelector('.login-opts') || f.firstChild.nextSibling); b.onclick = async () => { if (await qaLogin()) { document.getElementById('login-err').textContent = ''; showShell(); } }; }
  b.textContent = d.kind === 'pattern' ? 'Use Quick Access (pattern)' : 'Use Quick Access (PIN)';
}
/* ---- My settings: Quick Access ---- */
async function qaPane(box) {
  const mine = qaGet(); let devices = []; try { devices = (await qaCall({ action: 'list' })).devices; } catch { /* the list just stays empty */ }
  const kindName = { pin4: '4 digit PIN', pin6: '6 digit PIN', pattern: 'Pattern' };
  box.innerHTML = `<h2>Quick Access</h2><p class="muted small">Unlock JoolzApp on a device with a 4 or 6 digit PIN or a pattern instead of your password. Faster, but less secure: use it only on devices that are yours. After 5 wrong tries it switches itself off on that device.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin:10px 0"><button class="btn primary" id="qa-add">${mine ? 'Change on this device' : 'Add to this device'}</button><button class="btn danger" id="qa-out">Sign out everywhere</button></div>
    ${devices.length ? `<table class="tbl"><thead><tr><th>Device</th><th>Type</th><th>Last used</th><th></th></tr></thead><tbody>${devices.map((d) => `<tr><td>${esc(d.label)}${mine && mine.deviceId === d.id ? ' <span class="chip ok">this device</span>' : ''}</td><td>${esc(kindName[d.kind] || '')}</td><td>${d.lastUsed ? esc(new Date(d.lastUsed).toLocaleDateString()) : 'Never'}</td><td style="text-align:right"><button class="btn qa-rm" data-id="${esc(d.id)}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Quick Access is not on any device yet.</p>'}
    <p class="muted small">"Sign out everywhere" ends your sign-in and every Quick Access on all your devices, including your TVs.</p>`;
  box.querySelector('#qa-add').onclick = guard(async () => { if (mine) { try { await qaCall({ action: 'remove', deviceId: mine.deviceId }); } catch { /* the old one may be gone already */ } qaPut(null); } if (await qaSetup()) qaPane(box); });
  box.querySelectorAll('.qa-rm').forEach((b) => { b.onclick = guard(async () => { await qaCall({ action: 'remove', deviceId: b.dataset.id }); if (mine && mine.deviceId === b.dataset.id) qaPut(null); qaPane(box); }); });
  box.querySelector('#qa-out').onclick = guard(async () => { if (!confirm('Sign out of everything, on every device?')) return; await qaCall({ action: 'signout' }); qaPut(null); logout(); });
}
/* ---- an admin signed this person out: the stamp is compared with when this device signed in (server clock) ---- */
let qaTimer = null;
async function qaWatch() {
  clearInterval(qaTimer); await qaSync();
  const check = async () => {
    if (!state.token || state.role !== 'user' || !state.uid) return;
    let stamp = 0; try { const r = await api('GET', `/api/collections/portal_settings/records?page=1&perPage=1&filter=${encodeURIComponent(`scope = "user" && user = "${state.uid}" && app = "" && key = "portal.signedOutAt"`)}`); stamp = Number(((r.items || [])[0] || {}).value) || 0; } catch { return; }
    let at = Number(localStorage.getItem('pa.signedInAt')) || 0; if (!at) { qaMarkSignedIn(); at = Number(localStorage.getItem('pa.signedInAt')); }
    if (stamp > at) { qaPut(null); logout(); showLogin(); const m = document.getElementById('login-err'); if (m) m.textContent = 'You were signed out. Sign in again.'; }
  };
  check(); qaTimer = setInterval(check, 60000);
}
