'use strict';
/* Portal Admin front-end. Talks to PocketBase through the /pb proxy using the signed-in superuser's token. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d = '') => { try { return sessionStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
  lget: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  lset: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const sess = (k) => store.get('pa.' + k) || store.lget('pa.' + k);
const state = { token: sess('token'), actor: sess('actor'), role: sess('role') || 'admin', uid: sess('uid'), pid: sess('pid') || '', usersColl: store.lget('pa.usersColl', 'users') };
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RESERVED = [
  ['portal.access', 'boolean', 'false blocks a user (all apps, or one app) from using the app'],
  ['portal.editor', 'boolean', 'true makes a user an Editor: can edit, confirm and re-render shared resources in every app'],
  ['portal.readonly', 'boolean', 'true stops a user changing shared resources (menus, logos, uploads) in any app; they can still use the app'],
  ['portal.url', 'string', 'Address of this dashboard, used by the "Back to Dashboard" button in apps (blank = same address with port 3886)'],
];

/* ---------- API ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(method, path, body) {
  const res = await fetch('/pb' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: state.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if (res.status === 401 && state.token) { logout(); }
    let msg = (data && data.message) || res.statusText || 'Request failed';
    if (data && data.data) { const f = Object.entries(data.data).map(([k, v]) => `${k}: ${v.message}`); if (f.length) msg += ' (' + f.join('; ') + ')'; }
    throw new ApiError(msg, res.status);
  }
  return data;
}
const q = encodeURIComponent;
const fq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const AI_PROVIDERS = [ // [id, label, model hint, help, default model]
  ['gemini', 'Google Gemini', 'gemini-3.8-flash', 'Free keys are available at aistudio.google.com/apikey.', 'gemini-3.8-flash'],
  ['openrouter', 'OpenRouter', 'e.g. anthropic/claude-sonnet-4.5 (pick from the list)', 'One OpenRouter key works with hundreds of models. Get a key at openrouter.ai/keys.', ''],
  ['anthropic', 'Anthropic (Claude)', 'claude-sonnet-5-5', 'Use a key from console.anthropic.com.', 'claude-sonnet-5-5'],
  ['openai', 'OpenAI', 'e.g. gpt-4o', 'Use a key from platform.openai.com.', ''],
  ['custom', 'Custom (OpenAI-compatible)', 'Model name', 'Any service that speaks the OpenAI chat API, such as a local Ollama or LM Studio.', ''],
];
async function saveAiPrefs(uid, { provider, model, apiKey, baseUrl }) {
  const put = (k, v) => v ? api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.' + k, value: v, secret: false }) : null;
  await put('ai.provider', provider); await put('ai.model', model); await put('ai.apiKey', apiKey); await put('ai.baseUrl', baseUrl);
}
async function listAll(coll, { filter = '', sort = '', max = 2000 } = {}) {
  let page = 1, out = [];
  for (;;) {
    const r = await api('GET', `/api/collections/${coll}/records?perPage=200&page=${page}${filter ? '&filter=' + q(filter) : ''}${sort ? '&sort=' + q(sort) : ''}`);
    out = out.concat(r.items);
    if (page >= r.totalPages || out.length >= max) return out;
    page++;
  }
}
const count = async (coll, filter = '') => (await api('GET', `/api/collections/${coll}/records?perPage=1&skipTotal=false${filter ? '&filter=' + q(filter) : ''}`)).totalItems;
async function audit(action, target, detail) {
  try { await api('POST', '/api/collections/portal_audit/records', { actor: state.actor, action, target, detail: detail ?? {} }); } catch {}
}

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 2500);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };
const fmtDate = (s) => s ? new Date(s.replace(' ', 'T')).toLocaleString() : '';
const main = () => $('#main');

/* ---------- Schema ---------- */
const SCHEMA = [
  {
    name: 'portal_apps',
    fields: [
      { name: 'slug', type: 'text', required: true }, { name: 'name', type: 'text', required: true },
      { name: 'description', type: 'text' }, { name: 'url', type: 'url' },
      { name: 'enabled', type: 'bool' }, { name: 'maintenance', type: 'bool' }, { name: 'message', type: 'text' },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_portal_apps_slug ON portal_apps (slug)'],
    listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""',
  },
  {
    name: 'portal_requests',
    fields: [
      { name: 'user', type: 'text', required: true }, { name: 'email', type: 'text' }, { name: 'app', type: 'text', required: true },
      { name: 'message', type: 'text' }, { name: 'status', type: 'text' }, { name: 'decided_by', type: 'text' },
    ],
    indexes: [],
    // Users see/create/withdraw only their own requests; approving or denying is superuser-only.
    listRule: '@request.auth.id != "" && user = @request.auth.id', viewRule: '@request.auth.id != "" && user = @request.auth.id',
    createRule: '@request.auth.id != "" && @request.body.user = @request.auth.id && @request.body.status = "pending" && @request.body.decided_by:isset = false',
    deleteRule: '@request.auth.id != "" && user = @request.auth.id',
  },
  {
    name: 'portal_settings',
    fields: [
      { name: 'scope', type: 'text', required: true }, { name: 'app', type: 'text' }, { name: 'user', type: 'text' },
      { name: 'key', type: 'text', required: true }, { name: 'value', type: 'json', maxSize: 1000000 },
      { name: 'secret', type: 'bool' }, { name: 'note', type: 'text' },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_portal_settings_uniq ON portal_settings (scope, app, user, key)'],
    // Any signed-in app user may read non-secret global/app settings and their OWN user settings.
    listRule: '@request.auth.id != "" && secret = false && (scope != "user" || user = @request.auth.id)',
    viewRule: '@request.auth.id != "" && secret = false && (scope != "user" || user = @request.auth.id)',
    // Users may manage only their own all-apps "pref.*" rows (never portal.access or anything else).
    createRule: '@request.auth.id != "" && @request.body.scope = "user" && @request.body.user = @request.auth.id && @request.body.app = "" && @request.body.key ~ "pref." && @request.body.secret != true',
    updateRule: '@request.auth.id != "" && scope = "user" && user = @request.auth.id && app = "" && key ~ "pref." && @request.body.scope:isset = false && @request.body.user:isset = false && @request.body.app:isset = false && @request.body.key:isset = false && @request.body.secret:isset = false',
    deleteRule: '@request.auth.id != "" && scope = "user" && user = @request.auth.id && key ~ "pref."',
  },
  {
    name: 'portal_audit',
    fields: [{ name: 'actor', type: 'text' }, { name: 'action', type: 'text' }, { name: 'target', type: 'text' }, { name: 'detail', type: 'json', maxSize: 200000 }],
    indexes: [],
  },
];
async function schemaStatus() {
  const out = [];
  for (const s of SCHEMA) {
    try { await api('GET', `/api/collections/${s.name}`); out.push({ name: s.name, ok: true }); }
    catch (e) { out.push({ name: s.name, ok: false, err: e.message }); }
  }
  return out;
}
async function ensureSchema() {
  for (const s of SCHEMA) {
    const body = {
      name: s.name, type: 'base', fields: [...s.fields,
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }],
      indexes: s.indexes, listRule: s.listRule ?? null, viewRule: s.viewRule ?? null,
      createRule: s.createRule ?? null, updateRule: s.updateRule ?? null, deleteRule: s.deleteRule ?? null,
    };
    try { await api('GET', `/api/collections/${s.name}`); await api('PATCH', `/api/collections/${s.name}`, { listRule: body.listRule, viewRule: body.viewRule, createRule: body.createRule, updateRule: body.updateRule, deleteRule: body.deleteRule }); }
    catch (e) { if (e.status === 404) await api('POST', '/api/collections', body); else throw e; }
  }
}

/* ---------- Auth ---------- */
async function boot() {
  $('#login-remember').checked = store.lget('pa.remember') === '1';
  $('#login-email').value = store.lget('pa.email');
  if (resetToken()) return showReset();
  // Every app's "Create a JoolzApp account" button lands here.
  { const qs = new URLSearchParams(location.search);
    if (qs.get('signup') === '1') {
      signupApp = (qs.get('app') || '').toLowerCase(); history.replaceState(null, '', location.pathname);
      if (!state.token) { $('#shell').classList.add('hidden'); $('#login').classList.add('hidden'); $('#reset').classList.add('hidden'); $('#signup').classList.remove('hidden'); return; }
    } }
  // Arriving from an app's "Back to Dashboard" button: sign in with the account the app already knows (only if not signed in here).
  const hs = location.hash.match(/^#sso=([^&]+)/);
  if (hs) {
    history.replaceState(null, '', location.pathname + location.search);
    if (!state.token) {
      try {
        state.token = decodeURIComponent(hs[1]);
        const r = await api('POST', `/api/collections/${state.usersColl}/auth-refresh`);
        Object.assign(state, { token: r.token, actor: r.record.email, role: 'user', uid: r.record.id }); saveSession(false);
        location.hash = '#/me'; return showShell();
      } catch { state.token = ''; }
    }
  }
  // Keep people signed in until 90 days after they last opened the dashboard: ask PocketBase for a fresh token each time it opens.
  // (in the background, so the dashboard opens without waiting for it)
  if (state.token && state.role === 'user') (async () => { try { const r = await api('POST', `/api/collections/${state.usersColl}/auth-refresh`); if (r.token) { state.token = r.token; saveSession(!!store.lget('pa.token')); } if (store.lget('pa.seen') !== new Date().toISOString().slice(0, 10)) { await acctFetch('/api/active', {}); store.lset('pa.seen', new Date().toISOString().slice(0, 10)); } } catch {} })();
  // Portal Admin behind Umbrel's login: no second sign-in. The server hands over an admin session (it refuses anywhere else).
  if ((!state.token || state.role === 'user') && !store.get('pa.noauto') && await autoLogin()) return showShell();
  if (state.token) { try { await api('GET', '/api/collections/portal_apps/records?perPage=1').catch((e) => { if (e.status !== 404) throw e; }); return showShell(); } catch {} }
  showLogin();
}
function showLogin() { $('#shell').classList.add('hidden'); $('#reset').classList.add('hidden'); $('#signup').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function resetToken() { const m = location.hash.match(/^#\/(?:reset|auth\/confirm-password-reset)\/([^/?]+)/); return m ? decodeURIComponent(m[1]) : ''; }
$('#login-signup').onclick = (e) => { e.preventDefault(); $('#login').classList.add('hidden'); $('#signup').classList.remove('hidden'); $('#signup-err').textContent = ''; $('#signup-email').value = $('#login-email').value; $('#signup-email').focus(); };
$('#signup-ai-prov').innerHTML = AI_PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
$('#signup-ai-prov').onchange = () => { const p = AI_PROVIDERS.find(([v]) => v === $('#signup-ai-prov').value); $('#signup-ai-model').placeholder = p[2]; $('#signup-ai-hint').textContent = p[3]; $('#signup-ai-base-row').style.display = p[0] === 'custom' ? '' : 'none'; };
$('#signup-ai-prov').onchange();
$('#signup-cancel').onclick = (e) => { e.preventDefault(); showLogin(); };
// Apps send people here with ?signup=1&app=<slug>; after the account is made they are taken straight back to that app.
let signupApp = '';
const kidMode = () => !$('#signup-kid').classList.contains('hidden');
$('#signup-dob').max = new Date().toISOString().slice(0, 10);
$('#signup-dob').oninput = $('#signup-dob').onchange = () => {
  const v = $('#signup-dob').value; if (!v) { $('#signup-kid').classList.add('hidden'); $('#signup-parent').required = false; return; }
  const b = new Date(v + 'T00:00:00'), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  $('#signup-kid').classList.toggle('hidden', !(a < 18)); $('#signup-parent').required = a < 18;
};
async function openAfterSignup(slug) {
  try {
    const app = (await listAll('portal_apps', { filter: `slug = "${slug.replace(/[^a-z0-9-]/gi, '')}"` }))[0];
    if (!app || !/^https?:\/\//i.test(app.url || '')) return;
    let url = app.url; const t = await ssoToken().catch(() => '');
    if (t) { try { url = new URL('sso.html', app.url).href + '#t=' + encodeURIComponent(t); } catch {} }
    location.href = url;
  } catch {}
}
$('#signup-form').onsubmit = async (e) => {
  e.preventDefault(); $('#signup-err').textContent = '';
  const email = $('#signup-email').value.trim(), password = $('#signup-pass').value;
  if (password !== $('#signup-pass2').value) { $('#signup-err').textContent = 'Passwords do not match.'; return; }
  try {
    const r = await fetch('/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, username: $('#signup-username').value.trim(), name: $('#signup-name').value.trim(), dob: $('#signup-dob').value, parentEmails: kidMode() ? [$('#signup-parent').value] : [] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Could not create that account.');
    state.pid = ''; state.pidTried = false;
    Object.assign(state, await signIn(email, password));
    state.usernameOk = true;
    saveSession(false);
    ['#signup-pass', '#signup-pass2'].forEach((id) => { $(id).value = ''; });
    const aiKey = $('#signup-ai-key').value.trim();
    if (aiKey) {
      const provider = $('#signup-ai-prov').value, baseUrl = $('#signup-ai-base').value.trim();
      try { await saveAiPrefs(state.uid, { provider, model: $('#signup-ai-model').value.trim(), apiKey: aiKey, baseUrl: provider === 'custom' ? baseUrl : '' }); }
      catch { toast("Your account is ready, but the AI key couldn't be saved. Add it under My settings.", true); }
    }
    ['#signup-ai-key'].forEach((id) => { $(id).value = ''; });
    $('#signup').classList.add('hidden'); await showShell();
    if (signupApp) openAfterSignup(signupApp);
  } catch (err) { $('#signup-err').textContent = err.message; }
};
function showReset() { $('#shell').classList.add('hidden'); $('#login').classList.add('hidden'); $('#signup').classList.add('hidden'); $('#reset').classList.remove('hidden'); $('#reset-pass').focus(); }
$('#reset-cancel').onclick = (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname); showLogin(); };
$('#reset-form').onsubmit = async (e) => {
  e.preventDefault(); $('#reset-err').textContent = '';
  const password = $('#reset-pass').value;
  if (password !== $('#reset-pass2').value) { $('#reset-err').textContent = 'Passwords do not match.'; return; }
  try {
    const body = { token: resetToken(), password, passwordConfirm: password };
    try { await api('POST', '/api/collections/_superusers/confirm-password-reset', body); }
    catch (err) { if (err.status !== 400) throw err; await api('POST', `/api/collections/${state.usersColl}/confirm-password-reset`, body); }
    $('#reset-pass').value = ''; $('#reset-pass2').value = '';
    history.replaceState(null, '', location.pathname); showLogin();
    $('#login-ok').textContent = 'Password updated. Sign in with your new password.';
  } catch (err) { $('#reset-err').textContent = err.message; }
};
// People who sign in here are users of the JoolzApp apps, not admins, so the page is branded JoolzApp for them
// and on the public address (the server tells us which one we are on through /config).
function setBrand(name) { document.querySelectorAll('.brand span').forEach((n) => { n.textContent = name; }); document.title = name; }
fetch('/config').then((r) => r.json()).then((c) => { state.public = !!c.public; if (state.public) setBrand('JoolzApp'); }).catch(() => {});
async function showShell() {
  await resolvePid();
  setBrand(state.role === 'user' || state.public ? 'JoolzApp' : 'Portal Admin');
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#who').textContent = state.actor; route(); startDetecting();
  homeModel().then((m) => { if (!HM) HM = m; renderDock(); }).catch(() => {});   // so the dock is there on every page
  if (selfId()) { seedRegional().then(loadDatePref).catch(loadDatePref); loadAppearance(); }
  loadEvents();
  if (state.role !== 'user' && !state.public) rememberAdminUrl().catch(() => {});
}
// Portal Admin notes its own address on every admin's account (a private pref.* row each), so JoolzApp Portal can show them an Admin icon.
async function rememberAdminUrl() {
  const admins = new Set((await listAll(state.usersColl, { filter: 'isAdmin = true', max: 50 }).catch(() => [])).map((u) => u.id)); if (state.pid) admins.add(state.pid);
  if (!admins.size) return;
  const rows = await listAll('portal_settings', { filter: 'scope = "user" && app = "" && key = "pref.adminUrl"' });
  for (const id of admins) {
    const r = rows.find((x) => x.user === id);
    if (r && r.value === location.origin) continue;
    if (r) await api('PATCH', `/api/collections/portal_settings/records/${r.id}`, { value: location.origin }).catch(() => {});
    else await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: id, app: '', key: 'pref.adminUrl', value: location.origin, secret: false }).catch(() => {});
  }
}
const SESSION_KEYS = ['token', 'actor', 'role', 'uid', 'pid'];
// The JoolzApp person behind this sign-in. A regular user is themselves; the PocketBase superuser is the account with the same email (if any),
// so the admin gets Family, Settings, events, layout and everything else just like everyone else.
const selfId = () => (state.role === 'user' ? state.uid : state.pid) || '';
async function resolvePid() {
  if (state.role === 'user' || state.pid || state.pidTried || !state.token) return;
  state.pidTried = true;
  try { const r = await api('GET', `/api/collections/${state.usersColl}/records?perPage=1&filter=${q('email = ' + fq(String(state.actor || '').toLowerCase()))}`); state.pid = (r.items[0] && r.items[0].id) || ''; saveSession(!!store.lget('pa.remember')); } catch { /* no linked account */ }
}
function saveSession(remember) { SESSION_KEYS.forEach((k) => { store.set('pa.' + k, state[k]); store.lset('pa.' + k, remember ? state[k] : null); }); }
function logout() { SESSION_KEYS.forEach((k) => { state[k] = ''; store.set('pa.' + k, null); store.lset('pa.' + k, null); }); state.role = 'admin'; state.pidTried = false; if (!store.get('pa.noauto')) autoLogin().then((ok) => (ok ? showShell() : showLogin())); else showLogin(); }
let autoTried = 0;
async function autoLogin() {
  if (Date.now() - autoTried < 30000) return false;   // never loop if the session it hands over doesn't work
  try {
    const c = await (await fetch('/config')).json(); if (!c.autoLogin) return false;
    autoTried = Date.now();
    const r = await fetch('/auto-login', { method: 'POST' }); if (!r.ok) return false;
    const j = await r.json(); if (!j.token) return false;
    state.pid = ''; state.pidTried = false;
    Object.assign(state, { token: j.token, actor: j.email, role: 'admin', uid: j.id || '' }); saveSession(false);
    return true;
  } catch { return false; }
}
async function signIn(identity, password) {
  identity = String(identity || '').trim(); if (!identity.includes('@')) identity = identity.toLowerCase();   // usernames are saved in lower case
  let adminBlocked = false;
  try {
    const r = await api('POST', '/api/collections/_superusers/auth-with-password', { identity, password });
    return { token: r.token, actor: r.record.email, role: 'admin', uid: r.record.id };
  } catch (err) { if (![400, 401, 403].includes(err.status)) throw err; adminBlocked = err.status === 403; }
  try {
    const r = await api('POST', `/api/collections/${state.usersColl}/auth-with-password`, { identity, password });
    return { token: r.token, actor: r.record.email, role: 'user', uid: r.record.id };
  } catch (err) {
    if (adminBlocked && err.status === 400) throw new Error('Sign-in failed. If you are the admin: admin sign-in only works from your home network or tailnet.');
    throw err;
  }
}
$('#logout').onclick = () => { store.set('pa.noauto', '1'); logout(); };   // a real sign-out stays signed out in this tab (so you can sign in as someone else)
$('#login-form').onsubmit = async (e) => {
  e.preventDefault(); $('#login-err').textContent = '';
  try {
    const email = $('#login-email').value.trim();
    state.pid = ''; state.pidTried = false;
    Object.assign(state, await signIn(email, $('#login-pass').value));
    const remember = $('#login-remember').checked;
    saveSession(remember);
    store.lset('pa.remember', remember ? '1' : null); store.lset('pa.email', remember ? email : null);
    $('#login-ok').textContent = '';
    $('#login-pass').value = '';
    showShell();
  } catch (err) { $('#login-err').textContent = err.message; }
};

$('#login-forgot').onclick = async (e) => {
  e.preventDefault(); $('#login-err').textContent = ''; $('#login-ok').textContent = '';
  const who = $('#login-email').value.trim();
  if (!who) { $('#login-err').textContent = 'Enter your email or username above first.'; $('#login-email').focus(); return; }
  try {
    if (who.includes('@')) await api('POST', '/api/collections/_superusers/request-password-reset', { email: who }).catch(() => {});
    await fetch('/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: who }) });
    $('#login-ok').textContent = 'If that account exists, a password reset email has been sent.';
  } catch (err) { $('#login-err').textContent = err.message; }
};

/* ---------- Router ---------- */
window.addEventListener('hashchange', () => { if (resetToken()) return showReset(); state.token && route(); });
function route() {
  let [, view = 'home', arg] = location.hash.split('/');
  if (state.role === 'user') view = (view === 'me' || view === 'family' || view === 'paid') ? view : 'home';
  const v = { home: viewHome, overview: viewOverview, global: viewGlobal, apps: viewApps, users: viewUsers, requests: viewRequests, cleanup: viewCleanup, audit: viewAudit, changes: viewChanges, setup: viewSetup, me: viewMe, family: viewFamily, paywall: viewPaywall, paid: viewPaid }[view] || viewHome;
  if (!v || v === viewHome) view = 'home';
  setBar(view); $('#acct').open && $('#acct').close(); $('#sheet').open && $('#sheet').close();
  main().innerHTML = '<p class="muted">Loading…</p>';
  guard(async (a) => { if (await needDob()) return; if (await needUsername()) return; await v(a); })(arg ? decodeURIComponent(arg) : undefined);
}

/* ---------- Setup banner ---------- */
async function needSetup() {
  const st = await schemaStatus();
  if (st.every((s) => s.ok)) return false;
  main().innerHTML = `<h1>First-time setup</h1><p class="sub">Portal Admin stores its data in PocketBase collections, and some are missing or need updated permissions.</p>
    <div class="card"><ul>${st.map((s) => `<li><code>${s.name}</code> ${s.ok ? '<span class="chip ok">ready</span>' : '<span class="chip bad">missing</span>'}</li>`).join('')}</ul>
    <button id="mk" class="btn primary">Create collections</button></div>`;
  $('#mk').onclick = guard(async () => { await ensureSchema(); await audit('setup', 'schema'); toast('Collections created'); route(); });
  return true;
}

/* ---------- Settings editor ---------- */
function typeOf(v) { return typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : 'json'; }
function valueInput(type, v) {
  if (type === 'boolean') return `<select data-f="value"><option value="true"${v === true ? ' selected' : ''}>true</option><option value="false"${v === false ? ' selected' : ''}>false</option></select>`;
  if (type === 'number') return `<input data-f="value" type="number" step="any" value="${esc(v ?? 0)}">`;
  if (type === 'json') return `<textarea data-f="value" rows="2">${esc(JSON.stringify(v ?? {}, null, 2))}</textarea>`;
  return `<input data-f="value" type="text" value="${esc(v ?? '')}">`;
}
function readValue(row) {
  const type = $('[data-f=type]', row).value, raw = $('[data-f=value]', row).value;
  if (type === 'boolean') return raw === 'true';
  if (type === 'number') { const n = Number(raw); if (raw === '' || Number.isNaN(n)) throw new Error('Not a valid number'); return n; }
  if (type === 'json') { try { return JSON.parse(raw); } catch { throw new Error('Not valid JSON'); } }
  return raw;
}
/** Renders an editable list of settings for one scope into `host`. */
async function settingsEditor(host, scopeSpec, onChange) {
  const { scope, app = '', user = '' } = scopeSpec;
  const filter = scope === 'global' ? `scope = "global"` : scope === 'app' ? `scope = "app" && app = ${fq(app)}` : `scope = "user" && user = ${fq(user)} && app = ${fq(app)}`;
  const label = `${scope}${app ? ':' + app : ''}${user ? ':' + user : ''}`;
  const rows = await listAll('portal_settings', { filter, sort: 'key' });
  const rowHtml = (r) => {
    const t = typeOf(r.value);
    return `<tr class="setrow" data-id="${esc(r.id)}">
      <td style="width:22%"><input data-f="key" type="text" value="${esc(r.key)}" readonly></td>
      <td style="width:92px"><select data-f="type">${['string', 'number', 'boolean', 'json'].map((x) => `<option${x === t ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
      <td data-valcell>${valueInput(t, r.value)}</td>
      <td style="width:60px;text-align:center" title="Secret: hidden from apps, visible to admins only"><input data-f="secret" type="checkbox"${r.secret ? ' checked' : ''}></td>
      <td style="width:26%"><input data-f="note" type="text" placeholder="note" value="${esc(r.note || '')}"></td>
      <td style="white-space:nowrap"><button class="btn small primary" data-a="save">Save</button> <button class="btn small danger" data-a="del">✕</button></td></tr>`;
  };
  host.innerHTML = `<table><thead><tr><th>Key</th><th>Type</th><th>Value</th><th>Secret</th><th>Note</th><th></th></tr></thead>
    <tbody>${rows.map(rowHtml).join('') || '<tr><td colspan="6" class="muted">No settings yet.</td></tr>'}
    <tr class="setrow" data-new="1"><td><input data-f="key" type="text" placeholder="new.key" list="reserved-keys"></td>
      <td><select data-f="type"><option>string</option><option>number</option><option>boolean</option><option>json</option></select></td>
      <td data-valcell>${valueInput('string', '')}</td><td style="text-align:center"><input data-f="secret" type="checkbox"></td>
      <td><input data-f="note" type="text" placeholder="note"></td><td><button class="btn small primary" data-a="add">Add</button></td></tr></tbody></table>
    <datalist id="reserved-keys">${RESERVED.map((r) => `<option value="${r[0]}">${esc(r[2])}</option>`).join('')}</datalist>`;
  host.onchange = (e) => {
    if (e.target.dataset.f !== 'type') return;
    const row = e.target.closest('tr'), type = e.target.value, cur = $('[data-f=value]', row).value;
    let seed = cur; if (type === 'boolean') seed = cur === 'true'; if (type === 'number') seed = Number(cur) || 0;
    if (type === 'json') { try { seed = JSON.parse(cur); } catch { seed = cur; } }
    $('[data-valcell]', row).innerHTML = valueInput(type, seed);
  };
  host.onclick = guard(async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const row = b.closest('tr'), id = row.dataset.id, a = b.dataset.a;
    if (a === 'del') {
      const key = $('[data-f=key]', row).value;
      if (!confirm(`Delete setting "${key}"?`)) return;
      await api('DELETE', `/api/collections/portal_settings/records/${id}`);
      await audit('setting.delete', label, { key }); toast('Deleted');
    } else {
      const key = $('[data-f=key]', row).value.trim();
      if (!key) throw new Error('Key is required');
      const body = { scope, app, user, key, value: readValue(row), secret: $('[data-f=secret]', row).checked, note: $('[data-f=note]', row).value };
      if (a === 'add') { await api('POST', '/api/collections/portal_settings/records', body); await audit('setting.create', label, { key, value: body.secret ? '(secret)' : body.value }); }
      else { delete body.scope; delete body.app; delete body.user; await api('PATCH', `/api/collections/portal_settings/records/${id}`, body); await audit('setting.update', label, { key, value: body.secret ? '(secret)' : body.value }); }
      toast('Saved');
    }
    await settingsEditor(host, scopeSpec, onChange); onChange && onChange();
  });
}

/** Resolve effective settings for an app (+ optional user): global < app < user(all apps) < user×app. */
async function resolveEffective(appSlug, userId) {
  const all = await listAll('portal_settings', {
    filter: `scope = "global" || (scope = "app" && app = ${fq(appSlug)})${userId ? ` || (scope = "user" && user = ${fq(userId)} && (app = "" || app = ${fq(appSlug)}))` : ''}`,
  });
  const rank = (r) => r.scope === 'global' ? 0 : r.scope === 'app' ? 1 : (r.app ? 3 : 2);
  const names = ['global', 'app', 'user', 'user-app'];
  const eff = {};
  all.sort((a, b) => rank(a) - rank(b)).forEach((r) => { eff[r.key] = { value: r.value, source: names[rank(r)], secret: r.secret }; });
  return eff;
}
function effectiveTable(eff) {
  const keys = Object.keys(eff).sort();
  if (!keys.length) return '<p class="muted">Nothing configured.</p>';
  return `<table><thead><tr><th>Key</th><th>Effective value</th><th>Comes from</th></tr></thead><tbody>${keys.map((k) =>
    `<tr><td><code>${esc(k)}</code></td><td><code>${eff[k].secret ? '••• (secret)' : esc(JSON.stringify(eff[k].value))}</code></td><td><span class="chip src-${eff[k].source}">${eff[k].source}</span></td></tr>`).join('')}</tbody></table>`;
}

/* ---------- Views ---------- */
async function viewOverview() {
  if (await needSetup()) return;
  const [apps, settings, audits, users] = await Promise.all([
    listAll('portal_apps', { sort: 'name' }), count('portal_settings'), api('GET', '/api/collections/portal_audit/records?perPage=8&sort=-created'),
    count(state.usersColl).catch(() => null),
  ]);
  const overrides = await count('portal_settings', 'scope = "user"');
  const pending = await count('portal_requests', 'status = "pending"').catch(() => 0);
  main().innerHTML = `<h1>Overview</h1><p class="sub">Everything your portal apps are doing, in one place.</p>
    <div class="grid" style="margin-bottom:16px">
      <div class="stat"><b>${apps.length}</b>apps registered</div><div class="stat"><b>${users ?? '–'}</b>users</div>
      <div class="stat"><b>${settings}</b>settings</div><div class="stat"><b>${overrides}</b>per-user overrides</div>
      <div class="stat click" onclick="location.hash='#/requests'"><b>${pending}</b>pending requests</div></div>
    <div class="card"><div class="row spread"><h2>Apps</h2><a href="#/apps">Manage →</a></div>
      <table><tbody>${apps.map((a) => `<tr class="click" onclick="location.hash='#/apps/${esc(a.slug)}'"><td><b>${esc(a.name)}</b> <span class="muted small">${esc(a.slug)}</span></td>
        <td>${a.enabled ? '<span class="chip ok">enabled</span>' : '<span class="chip bad">disabled</span>'} ${a.maintenance ? '<span class="chip warn">maintenance</span>' : ''}</td></tr>`).join('') || '<tr><td class="muted">No apps registered yet.</td></tr>'}</tbody></table></div>
    <div class="card"><div class="row spread"><h2>Recent activity</h2><a href="#/audit">Full log →</a></div>
      <table><tbody>${audits.items.map((a) => `<tr><td class="muted small">${esc(fmtDate(a.created))}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.target)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`;
}

async function viewGlobal() {
  if (await needSetup()) return;
  main().innerHTML = `<h1>Global settings</h1><p class="sub">Defaults applied to every app and user. Apps and users can override them.</p>
    <div class="card"><div id="ed"></div></div>`;
  await settingsEditor($('#ed'), { scope: 'global' });
}

/* ---------- Apps installed on this Umbrel ---------- */
// The server lists the apps installed on this Umbrel (read-only). Apps that sign in with the JoolzApp account (they declare
// POCKETBASE_APP_ID) are registered here automatically; any other new app is offered under "Detected on your Umbrel".
const hiddenApps = () => { try { return JSON.parse(localStorage.getItem('pa.hiddenApps') || '[]'); } catch { return []; } };
const slugOf = (id) => String(id).toLowerCase().replace(/^joolay-/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 48);
// Where an installed app lives. Apps published through Tailscale (a tsdproxy name in their compose file) are at
// https://<name>.<your tailnet>.ts.net; the tailnet is learned from this page's address or from apps already registered.
// Anything else falls back to this Umbrel's own address and the app's port.
function appUrlFinder(existing) {
  let tail = '';
  const fromHost = /\.ts\.net$/i.test(location.hostname) ? location.hostname.split('.').slice(1).join('.') : '';
  tail = fromHost;
  if (!tail) for (const e of existing) { const m = /^https:\/\/[a-z0-9-]+\.([a-z0-9-]+\.ts\.net)(?:[/:]|$)/i.exec(e.url || ''); if (m) { tail = m[1]; break; } }
  return (a) => a.funnel && tail ? `https://${a.funnel}.${tail}` : (a.port ? `${location.protocol}//${location.hostname}:${a.port}` : '');
}
async function detectApps() {
  if (state.role === 'user' || !state.token) return null;
  try {
    const r = await fetch('/umbrel-apps', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.available) return { available: false, added: [], pending: [] };
    const existing = await listAll('portal_apps'), have = new Set(existing.map((a) => a.slug));
    const urlFor = appUrlFinder(existing);
    // Apps added before their address was known get it filled in now (an address you set yourself is never changed).
    for (const e of existing) { if (e.url) continue; const m = d.apps.find((x) => x.slug === e.slug), u = m && urlFor(m); if (u) { await api('PATCH', `/api/collections/portal_apps/records/${e.id}`, { url: u }).catch(() => {}); await audit('app.url', e.slug, { url: u, detected: true }); } }
    const added = [], pending = [];
    // Owner-only tools (JOOLZAPP_DASHBOARD=hidden in their compose file) have no icon on the home screen: never added, and taken off if they were added before.
    for (const a of d.apps) { if (!a.noDash || !a.slug) continue; const e = existing.find((x) => x.slug === a.slug); if (e) { await api('DELETE', `/api/collections/portal_apps/records/${e.id}`).catch(() => {}); await audit('app.hidden', a.slug, { reason: 'owner-only tool' }); HM = null; } }
    for (const a of d.apps) {
      if (a.noDash) continue;
      if (a.slug) {
        if (have.has(a.slug)) continue;
        try {
          await api('POST', '/api/collections/portal_apps/records', { slug: a.slug, name: a.pbName || a.name, description: a.tagline || '', url: urlFor(a), enabled: true });
          have.add(a.slug); added.push(a); await audit('app.detected', a.slug, { umbrelId: a.id, version: a.version });
        } catch (e) { if (e.status !== 400) throw e; }
      } else if (!have.has(slugOf(a.id)) && !hiddenApps().includes(a.id)) pending.push(a);
    }
    if (added.length) toast('Added from your Umbrel: ' + added.map((a) => a.pbName || a.name).join(', '));
    await markSsoApps(d.apps);
    const schemaApplied = await syncSchemas(d.apps);
    return { available: true, added, pending, schemaApplied, apps: d.apps };
  } catch { return null; }
}
/* ---------- PocketBase changes an app asks for ---------- */
// An app lists the collections it needs in its docker-compose.yml (`x-pocketbase`). Missing collections and missing fields are
// worked out and created here, so a new app finds its database ready. Nothing is ever removed or retyped. Apps from your own
// store (joolay-*) are applied automatically; any other app's changes wait for you to approve them.
const SCHEMA_PROTECTED = /^(_|users$|portal_|app_access$)/;
const NAME_OK = /^[A-Za-z][A-Za-z0-9_]{0,48}$/;
const AUTO_STORE = /^joolay-/;
let schemaPending = [];
async function planSchema(a) {
  const decl = a.pocketbase; if (!decl) return null;
  if (decl.error) return { app: a, steps: [], problems: [decl.error] };
  const steps = [], problems = [];
  for (const c of Array.isArray(decl.collections) ? decl.collections.slice(0, 30) : []) {
    if (!c || !/^[a-z][a-z0-9_]{0,48}$/.test(c.name || '') || SCHEMA_PROTECTED.test(c.name)) { problems.push(`"${c && c.name}" isn't an allowed collection name`); continue; }
    const fields = (Array.isArray(c.fields) ? c.fields : []).filter((f) => f && NAME_OK.test(f.name || '') && typeof f.type === 'string');
    let have = null;
    try { have = await api('GET', '/api/collections/' + c.name); } catch (e) { if (e.status !== 404) throw e; }
    if (!have) { steps.push({ kind: 'create', coll: c, fields }); continue; }
    const byName = new Map((have.fields || []).map((f) => [f.name, f]));
    for (const f of fields) { const h = byName.get(f.name); if (h && h.type !== f.type) problems.push(`${c.name}.${f.name} is ${h.type} in PocketBase but the app wants ${f.type} (left as it is)`); }
    const missing = fields.filter((f) => !byName.has(f.name));
    if (missing.length) steps.push({ kind: 'addFields', coll: c, have, fields: missing });
  }
  return { app: a, steps, problems };
}
const describeSteps = (plan) => plan.steps.map((s) => s.kind === 'create' ? `create ${s.coll.name}` : `add ${s.fields.map((f) => f.name).join(', ')} to ${s.coll.name}`).join('; ');
async function applyPlan(plan) {
  for (const s of plan.steps) {
    if (s.kind === 'create') {
      const c = s.coll;
      await api('POST', '/api/collections', { name: c.name, type: 'base', indexes: Array.isArray(c.indexes) ? c.indexes : [],
        fields: [...s.fields, { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }, { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }],
        listRule: c.listRule ?? null, viewRule: c.viewRule ?? null, createRule: c.createRule ?? null, updateRule: c.updateRule ?? null, deleteRule: c.deleteRule ?? null });
    } else await api('PATCH', '/api/collections/' + s.coll.name, { fields: [...s.have.fields, ...s.fields] });
    await audit('schema.apply', s.coll.name, { app: plan.app.id, kind: s.kind, fields: s.fields.map((f) => f.name) });
  }
}
async function syncSchemas(apps) {
  const applied = []; schemaPending = [];
  for (const a of apps) {
    try {
      const plan = await planSchema(a); if (!plan) continue;
      if (plan.steps.length && AUTO_STORE.test(a.id)) { await applyPlan(plan); applied.push({ app: a, text: describeSteps(plan) }); plan.steps = []; }
      if (plan.steps.length || plan.problems.length) schemaPending.push(plan);
    } catch (e) { schemaPending.push({ app: a, steps: [], problems: ['Could not update PocketBase: ' + e.message] }); }
  }
  if (applied.length) toast('PocketBase updated for ' + applied.map((x) => x.app.name).join(', '));
  return applied;
}

/* ---------- First-time connect: sign in once, then the app gets its PocketBase login ---------- */
// Nothing is remembered: the superuser login you type here is checked, written into each app's own data folder, and forgotten.
const connectNeeded = (found) => found && found.available ? found.apps.filter((a) => /^joolay-/.test(a.id) && a.slug && a.slug !== 'portal' && a.env === 'missing') : [];
const connectSkipped = new Set();
function promptConnect(apps, force) {
  const todo = apps.filter((a) => force || !connectSkipped.has(a.id));
  if (!todo.length || document.getElementById('connectModal')) return;
  const box = document.createElement('div'); box.id = 'connectModal';
  box.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px';
  box.innerHTML = `<form class="card" style="max-width:420px;width:100%;margin:0"><h2>Connect to PocketBase</h2>
    <p class="muted small">${todo.map((a) => '<b>' + esc(a.name) + '</b>').join(', ')} ${todo.length > 1 ? 'are' : 'is'} new and not connected yet. Sign in with your PocketBase superuser login once. It is checked and passed on to ${todo.length > 1 ? 'those apps' : 'the app'}, and Portal Admin does not keep it.</p>
    <input name="email" type="email" required value="${esc(state.actor || '')}" placeholder="Superuser email" autocomplete="username" style="width:100%;margin-top:8px">
    <input name="password" type="password" required placeholder="Password" autocomplete="current-password" style="width:100%;margin-top:8px">
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end"><button type="button" class="btn" id="cmLater">Later</button><button class="btn primary">Connect</button></div></form>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelector('#cmLater').onclick = () => { todo.forEach((a) => connectSkipped.add(a.id)); close(); };
  const f = box.querySelector('form'); f.email.focus();
  f.onsubmit = guard(async (e) => {
    e.preventDefault(); const btn = f.querySelector('button.primary'); btn.disabled = true;
    try {
      for (const a of todo) {
        const r = await fetch('/connect-app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id, email: f.email.value.trim(), password: f.password.value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || 'Could not connect ' + a.name);
        await audit('app.connect', a.id, { email: f.email.value.trim() });
      }
      toast(todo.map((a) => a.name).join(', ') + ' connected. The app starts on its own within a few seconds.');
      close(); if (location.hash.startsWith('#/apps')) route();
    } finally { btn.disabled = false; f.password.value = ''; }
  });
}
let detectTimer;
function startDetecting() {
  clearInterval(detectTimer);
  if (state.role === 'user') return;
  const after = (r) => { if (!r) return; promptConnect(connectNeeded(r)); if ((r.added.length || r.schemaApplied.length) && location.hash.startsWith('#/apps')) route(); };
  detectApps().then(after);
  detectTimer = setInterval(() => {
    if (!state.token || state.role === 'user' || document.hidden) return;
    detectApps().then(after);
  }, 30 * 1000);
}

async function viewApps(slug) {
  if (await needSetup()) return;
  return slug ? appDetail(slug) : appList();
}
async function appList() {
  const found = await detectApps();
  const apps = await listAll('portal_apps', { sort: 'name' });
  main().innerHTML = `<div class="row spread"><div><h1>Apps</h1><p class="sub">Apps installed on your Umbrel appear here automatically, or register one by hand.</p></div><button id="new" class="btn primary">+ Register app</button></div>
    <div class="card"><table><thead><tr><th>App</th><th>Status</th><th>URL</th></tr></thead><tbody>${apps.map((a) => `
      <tr class="click" data-slug="${esc(a.slug)}"><td><b>${esc(a.name)}</b>${/^https?:\/\//i.test(a.url || '') ? ` <a class="btn small" href="${esc(a.url)}" data-open="${esc(a.slug)}" target="_blank" rel="noopener">Open</a>` : ''}<div class="muted small">${esc(a.slug)}</div></td>
      <td>${a.enabled ? '<span class="chip ok">enabled</span>' : '<span class="chip bad">disabled</span>'} ${a.maintenance ? '<span class="chip warn">maintenance</span>' : ''}</td>
      <td class="muted small">${esc(a.url)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No apps yet.</td></tr>'}</tbody></table></div>`;
  $('#new').onclick = () => { location.hash = '#/apps/__new'; };
  { const ss = new Set((await listAll('portal_settings', { filter: 'scope = "app" && key = "app.sso"' }).catch(() => [])).filter((r) => r.value === true).map((r) => r.app)); bindOpen(main(), ss); }
  if (found && found.available && found.pending.length) {
    main().insertAdjacentHTML('beforeend', `<div class="card"><h2>Detected on your Umbrel</h2><p class="muted small">Installed apps that don't use the JoolzApp account. Add the ones you want to control here.</p>
      <table><tbody>${found.pending.map((a) => `<tr><td><b>${esc(a.name)}</b><div class="muted small">${esc(a.id)}${a.version ? ' · v' + esc(a.version) : ''}</div></td>
        <td style="text-align:right"><button class="btn" data-add="${esc(a.id)}">Add</button> <button class="btn" data-hide="${esc(a.id)}">Hide</button></td></tr>`).join('')}</tbody></table></div>`);
  }
  if (schemaPending.length) {
    main().insertAdjacentHTML('beforeend', `<div class="card"><h2>PocketBase changes</h2><p class="muted small">Needed by apps on your Umbrel. Changes only add collections and fields; nothing is removed.</p>
      <table><tbody>${schemaPending.map((pl, i) => `<tr><td><b>${esc(pl.app.name)}</b><div class="muted small">${esc(describeSteps(pl) || 'nothing to change')}</div>${pl.problems.map((x) => `<div class="small" style="color:#b3261e">${esc(x)}</div>`).join('')}</td>
        <td style="text-align:right">${pl.steps.length ? `<button class="btn primary" data-apply="${i}">Apply</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
  }
  const needConnect = connectNeeded(found);
  if (needConnect.length) {
    main().insertAdjacentHTML('beforeend', `<div class="card"><h2>Connect to PocketBase</h2><p class="muted small">${needConnect.map((a) => esc(a.name)).join(', ')} can't sign people in until PocketBase is connected.</p><button class="btn primary" id="connectNow">Sign in to connect</button></div>`);
    main().querySelector('#connectNow').onclick = () => promptConnect(needConnect, true);
  }
  if (found && !found.available) main().insertAdjacentHTML('beforeend', '<p class="muted small">Portal Admin can\'t see which apps are installed on this Umbrel (the app list isn\'t mounted), so new apps aren\'t detected automatically.</p>');
  main().onclick = guard(async (e) => {
    const ap = e.target.closest('[data-apply]');
    if (ap) { const pl = schemaPending[+ap.dataset.apply]; if (!pl) return; await applyPlan(pl); toast('PocketBase updated for ' + pl.app.name); return route(); }
    const add = e.target.closest('[data-add]'), hide = e.target.closest('[data-hide]');
    if (add || hide) {
      const a = found.pending.find((x) => x.id === (add || hide).dataset[add ? 'add' : 'hide']); if (!a) return;
      if (hide) { localStorage.setItem('pa.hiddenApps', JSON.stringify([...hiddenApps(), a.id])); return route(); }
      const body = { slug: slugOf(a.id), name: a.name, description: a.tagline || '', url: appUrlFinder(await listAll('portal_apps'))(a), enabled: true };
      await api('POST', '/api/collections/portal_apps/records', body); await audit('app.create', body.slug, { ...body, umbrelId: a.id });
      toast('Added ' + a.name); return route();
    }
    if (e.target.closest('a[data-open]')) return;
    const tr = e.target.closest('tr[data-slug]'); if (tr) location.hash = '#/apps/' + encodeURIComponent(tr.dataset.slug);
  });
}
async function appDetail(slug) {
  const isNew = slug === '__new';
  const rec = isNew ? { slug: '', name: '', description: '', url: '', enabled: true, maintenance: false, message: '' }
    : (await api('GET', `/api/collections/portal_apps/records?filter=${q('slug = ' + fq(slug))}&perPage=1`)).items[0];
  if (!rec) { main().innerHTML = '<p>App not found. <a href="#/apps">Back</a></p>'; return; }
  main().innerHTML = `<div class="crumb"><a href="#/apps">← Apps</a></div><h1>${isNew ? 'Register app' : esc(rec.name)}</h1><p class="sub">${isNew ? 'Add a custom app to the portal.' : `<code>${esc(rec.slug)}</code>`}</p>
    <div class="tabs"><button class="active" data-t="info">Details</button>${isNew ? '' : '<button data-t="set">App settings</button><button data-t="eff">Effective &amp; per-user</button>'}</div>
    <div id="tab"></div>`;
  const tabs = { info: tabInfo, set: tabSet, eff: tabEff };
  main().onclick = guard((e) => { const b = e.target.closest('.tabs button'); if (!b) return; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); return tabs[b.dataset.t](); });
  tabInfo();

  function tabInfo() {
    $('#tab').innerHTML = `<form id="f" class="card"><div class="kv">
      <label>Name<input name="name" value="${esc(rec.name)}" required></label>
      <label>Slug (id used by the app)<input name="slug" value="${esc(rec.slug)}" ${isNew ? '' : 'readonly'} required pattern="[a-z0-9][a-z0-9_\\-]{0,47}" placeholder="shutterworth"></label>
      <label>URL (where users open the app)<input name="url" type="url" value="${esc(rec.url)}" placeholder="https://shutterworth.your-tailnet.ts.net"></label>
      <label>Description<input name="description" value="${esc(rec.description)}"></label></div>
      <div class="row" style="margin-bottom:10px"><label class="inline"><input type="checkbox" name="enabled"${rec.enabled ? ' checked' : ''}> Enabled</label>
      <label class="inline"><input type="checkbox" name="maintenance"${rec.maintenance ? ' checked' : ''}> Maintenance mode</label></div>
      <label>Message shown to users when disabled / in maintenance<input name="message" value="${esc(rec.message)}"></label>
      <div class="row"><button class="btn primary">${isNew ? 'Register' : 'Save'}</button>${isNew ? '' : '<button type="button" id="del" class="btn danger">Delete app</button>'}</div></form>`;
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const body = { name: f.get('name').trim(), slug: f.get('slug').trim(), url: f.get('url').trim(), description: f.get('description').trim(), message: f.get('message').trim(),
        enabled: e.target.enabled.checked, maintenance: e.target.maintenance.checked };
      if (!SLUG.test(body.slug)) throw new Error('Slug: lowercase letters, digits, - and _ only');
      if (isNew) { await api('POST', '/api/collections/portal_apps/records', body); await audit('app.create', body.slug, body); location.hash = '#/apps/' + body.slug; }
      else { await api('PATCH', `/api/collections/portal_apps/records/${rec.id}`, body); await audit('app.update', rec.slug, body); toast('Saved'); }
    });
    const del = $('#del');
    if (del) del.onclick = guard(async () => {
      if (!confirm(`Delete "${rec.name}" and ALL its settings and per-user overrides?`)) return;
      for (const s of await listAll('portal_settings', { filter: `app = ${fq(rec.slug)}` })) await api('DELETE', `/api/collections/portal_settings/records/${s.id}`);
      await api('DELETE', `/api/collections/portal_apps/records/${rec.id}`); await audit('app.delete', rec.slug); location.hash = '#/apps';
    });
  }
  async function tabSet() {
    $('#tab').innerHTML = `<div class="card"><p class="muted small">Applies to every user of <b>${esc(rec.name)}</b>; overrides global settings.</p><div id="ed"></div></div>`;
    await settingsEditor($('#ed'), { scope: 'app', app: rec.slug });
  }
  async function tabEff() {
    const users = await listAll(state.usersColl, { sort: 'email', max: 500 }).catch(() => []);
    $('#tab').innerHTML = `<div class="card"><div class="row"><label style="margin:0">Preview as user
      <select id="pu"><option value="">(no user — app defaults)</option>${users.map((u) => `<option value="${esc(u.id)}">${esc(u.email || u.username || u.id)}</option>`).join('')}</select></label>
      ${''}</div><div id="eff" style="margin-top:12px"></div></div>
      <p class="muted small">To change one user's settings or access to this app, open the user in the <a href="#/users">Users</a> tab.</p>`;
    const draw = guard(async () => { $('#eff').innerHTML = effectiveTable(await resolveEffective(rec.slug, $('#pu').value)); });
    $('#pu').onchange = draw; draw();
  }
}

async function viewUsers(id) {
  if (await needSetup()) return;
  return id ? userDetail(id) : userList();
}
async function userList(page = 1, search = '') {
  const filter = search ? `email ~ ${fq(search)} || name ~ ${fq(search)}` : '';
  let r;
  try { r = await api('GET', `/api/collections/${state.usersColl}/records?perPage=25&page=${page}&sort=-created${filter ? '&filter=' + q(filter) : ''}`); }
  catch (e) { main().innerHTML = `<h1>Users</h1><div class="card"><p class="error">${esc(e.message)}</p><p>Collection <code>${esc(state.usersColl)}</code> couldn't be read. Change it in <a href="#/setup">Setup</a>.</p></div>`; return; }
  const blocked = new Set((await listAll('portal_settings', { filter: 'scope = "user" && key = "portal.access" && app = ""' })).filter((s) => s.value === false).map((s) => s.user));
  main().innerHTML = `<div class="row spread"><div><h1>Users</h1><p class="sub">${r.totalItems} user${r.totalItems === 1 ? '' : 's'} in <code>${esc(state.usersColl)}</code></p></div><button id="new" class="btn primary">+ Add user</button></div>
    <div class="card"><div class="row" style="margin-bottom:10px"><input id="s" type="search" placeholder="Search email or name" value="${esc(search)}" style="flex:1"><button id="go" class="btn">Search</button></div>
    <table><thead><tr><th>User</th><th>Status</th><th>Created</th></tr></thead><tbody>${r.items.map((u) => `<tr class="click" data-id="${esc(u.id)}"><td><b>${esc(u.name || u.username || '—')}</b><div class="muted small">${esc(u.email)}</div></td>
      <td>${u.verified ? '<span class="chip ok">verified</span>' : '<span class="chip">unverified</span>'} ${blocked.has(u.id) ? '<span class="chip bad">blocked</span>' : ''}</td><td class="muted small">${esc(fmtDate(u.created))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No users.</td></tr>'}</tbody></table>
    <div class="row spread" style="margin-top:10px"><button id="pv" class="btn small"${page <= 1 ? ' disabled' : ''}>← Prev</button><span class="muted small">Page ${page} of ${r.totalPages || 1}</span><button id="nx" class="btn small"${page >= r.totalPages ? ' disabled' : ''}>Next →</button></div></div>`;
  const again = (p, s) => guard(() => userList(p, s))();
  $('#go').onclick = () => again(1, $('#s').value.trim()); $('#s').onkeydown = (e) => e.key === 'Enter' && again(1, e.target.value.trim());
  $('#pv').onclick = () => again(page - 1, search); $('#nx').onclick = () => again(page + 1, search);
  $('#new').onclick = () => { location.hash = '#/users/__new'; };
  main().onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = '#/users/' + encodeURIComponent(tr.dataset.id); };
}
async function userDetail(id) {
  if (id === '__new') {
    main().innerHTML = `<div class="crumb"><a href="#/users">← Users</a></div><h1>Add user</h1><form id="f" class="card"><div class="kv">
      <label>Email<input name="email" type="email" required></label><label>Name and surname<input name="name" required pattern=".*\\S\\s+\\S.*" title="Enter a name and surname"></label>
      <label>Password (min 8)<input name="password" type="password" minlength="8" required></label></div>
      <label class="inline"><input type="checkbox" name="verified" checked> Mark as verified</label><button class="btn primary">Create user</button></form>`;
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const body = { email: f.get('email'), password: f.get('password'), passwordConfirm: f.get('password'), verified: e.target.verified.checked, emailVisibility: true };
      if (f.get('name')) body.name = f.get('name');
      const u = await api('POST', `/api/collections/${state.usersColl}/records`, body); await audit('user.create', u.id, { email: u.email }); location.hash = '#/users/' + u.id;
    });
    return;
  }
  const u = await api('GET', `/api/collections/${state.usersColl}/records/${id}`);
  const apps = await listAll('portal_apps', { sort: 'name' });
  main().innerHTML = `<div class="crumb"><a href="#/users">← Users</a></div><h1>${esc(u.name || u.username || u.email)}</h1><p class="sub">${esc(u.email)} · <code>${esc(u.id)}</code></p>
    <div class="tabs"><button class="active" data-t="prof">Profile</button><button data-t="acc">App access</button><button data-t="ovr">Settings overrides</button></div><div id="tab"></div>`;
  const tabs = { prof: tabProfile, acc: tabAccess, ovr: tabOverrides };
  main().onclick = guard((e) => { const b = e.target.closest('.tabs button'); if (!b) return; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); return tabs[b.dataset.t](); });
  tabProfile();

  function tabProfile() {
    $('#tab').innerHTML = `<form id="f" class="card"><div class="kv"><label>Name<input name="name" value="${esc(u.name || '')}"></label><label>Email<input name="email" type="email" value="${esc(u.email)}" required></label></div>
      <label class="inline"><input type="checkbox" name="verified"${u.verified ? ' checked' : ''}> Verified</label>
      <div class="row"><button class="btn primary">Save</button><button type="button" id="rs" class="btn">Send password reset email</button><button type="button" id="del" class="btn danger">Delete user</button></div></form>
      <form id="pwf" class="card"><h2>Set password</h2><p class="muted small">Sets a new password right now, without email. The user is signed out everywhere and must use the new password. Share it with them securely.</p>
        <div class="kv"><label>New password<input name="pw" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label><label>Repeat password<input name="pw2" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label></div>
        <div class="row"><button class="btn primary">Set password</button><button type="button" id="pwgen" class="btn">Generate</button></div></form>`;
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const body = { email: f.get('email'), verified: e.target.verified.checked }; if ('name' in u || f.get('name')) body.name = f.get('name');
      await api('PATCH', `/api/collections/${state.usersColl}/records/${id}`, body); await audit('user.update', id, body); toast('Saved');
    });
    $('#pwgen').onclick = () => {
      const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint32Array(16));
      const pw = Array.from(b, (n) => chars[n % chars.length]).join('');
      const f = $('#pwf'); f.pw.type = f.pw2.type = 'text'; f.pw.value = f.pw2.value = pw; toast('Generated. Copy it before setting.');
    };
    $('#pwf').onsubmit = guard(async (e) => {
      e.preventDefault(); const pw = e.target.pw.value;
      if (pw !== e.target.pw2.value) throw new Error('Passwords do not match');
      if (!confirm(`Set a new password for ${u.email}? They will be signed out everywhere.`)) return;
      await api('PATCH', `/api/collections/${state.usersColl}/records/${id}`, { password: pw, passwordConfirm: pw });
      await audit('user.password-set', id, { email: u.email });
      e.target.reset(); e.target.pw.type = e.target.pw2.type = 'password'; toast('Password changed');
    });
    $('#rs').onclick = guard(async () => { await api('POST', `/api/collections/${state.usersColl}/request-password-reset`, { email: u.email }); await audit('user.password-reset', id); toast('Reset email requested'); });
    $('#del').onclick = guard(async () => {
      if (!confirm(`Delete ${u.email}? This also removes their settings overrides.`)) return;
      for (const s of await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(id)}` })) await api('DELETE', `/api/collections/portal_settings/records/${s.id}`);
      await api('DELETE', `/api/collections/${state.usersColl}/records/${id}`); await audit('user.delete', id, { email: u.email }); location.hash = '#/users';
    });
  }
  async function tabAccess() {
    const recs = (await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(id)} && key = "portal.access"` }));
    const ap = await approvalState();
    const blockedFor = (slug) => {
      const own = recs.find((r) => r.app === slug), uw = recs.find((r) => r.app === '');
      if (own) return own.value === false ? own : undefined;
      if (slug !== '' && uw) return uw.value === false ? uw : undefined;
      return ap.required ? { inherited: true } : undefined;
    };
    const all = blockedFor('');
    const roleRows = await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(id)} && (key = "portal.readonly" || key = "portal.editor") && app = ""` });
    const roleRow = k => roleRows.find((r) => r.key === k && r.value === true);
    const role = roleRow('portal.readonly') ? 'viewonly' : roleRow('portal.editor') ? 'editor' : 'member';
    const targets = [{ slug: '', name: 'All apps' }, ...apps];
    $('#tab').innerHTML = `<div class="card"><p class="muted small">Untick to block this user. Apps check the <code>portal.access</code> setting (see Setup &amp; integration).</p>
      <table><tbody>${targets.map((t) => `<tr><td><b>${esc(t.name)}</b>${t.slug ? `<div class="muted small">${esc(t.slug)}</div>` : ''}</td>
        <td>${t.slug && !t.enabled ? '<span class="chip bad">app disabled</span>' : ''}${t.slug && all && !all.inherited ? ' <span class="chip">blocked by "All apps"</span>' : ''}${ap.required && !recs.find((r) => r.app === t.slug) ? ' <span class="chip">approval required</span>' : ''}</td>
        <td style="width:90px"><label class="inline" style="margin:0"><input type="checkbox" data-slug="${esc(t.slug)}"${blockedFor(t.slug) ? '' : ' checked'}> allowed</label></td></tr>`).join('')}</tbody></table></div>`
    $('#tab').insertAdjacentHTML('beforeend', `<div class="card"><h2>Role in the JoolzApps</h2>
      <p class="muted small">Admin (set under Users) can do everything. <b>Editor</b> can edit, confirm and re-render shared things (menus, pictures, uploads) in every app, not only their own. <b>Member</b> is the normal user: they can use the apps and make tagged edits that an editor or admin confirms; whoever uploads something is its <i>uploader</i> (a title for the originator) and is treated as an editor of that upload. <b>View-only</b> can use the apps but cannot change anything shared.</p>
      <select id="role" style="max-width:260px"><option value="editor"${role === 'editor' ? ' selected' : ''}>Editor (elevated)</option><option value="member"${role === 'member' ? ' selected' : ''}>Member</option><option value="viewonly"${role === 'viewonly' ? ' selected' : ''}>View-only</option></select></div>`);
    $('#role').onchange = guard(async (e) => {
      const want = e.target.value, set = async (key, on) => {
        const ex = roleRows.find((r) => r.key === key);
        if (on && ex) await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value: true });
        else if (on) await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: id, app: '', key, value: true });
        else if (ex) await api('DELETE', `/api/collections/portal_settings/records/${ex.id}`);
      };
      await set('portal.editor', want === 'editor'); await set('portal.readonly', want === 'viewonly');
      await audit('user.role', id, { role: want });
      toast('Role updated'); tabAccess();
    });
    $('#tab').onchange = guard(async (e) => {
      const slug = e.target.dataset.slug; if (slug === undefined) return;
      const ex = recs.find((r) => r.app === slug);
      if (e.target.checked) {
        const uw = recs.find((r) => r.app === '');
        if (ap.required || (slug !== '' && uw && uw.value === false)) await setAccess(id, slug, true);
        else if (ex) await api('DELETE', `/api/collections/portal_settings/records/${ex.id}`);
        await audit('user.access.allow', id, { app: slug || '*' });
      }
      else if (ex) await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value: false });
      else await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: id, app: slug, key: 'portal.access', value: false });
      if (!e.target.checked) await audit('user.access.block', id, { app: slug || '*' });
      toast('Updated'); tabAccess();
    });
  }
  async function tabOverrides() {
    $('#tab').innerHTML = `<div class="card"><label>Applies to<select id="sc"><option value="">All apps (user-wide)</option>${apps.map((a) => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('')}</select></label>
      <div id="ed"></div></div><div class="card"><h2>Effective settings</h2><div class="row" style="margin-bottom:8px"><label style="margin:0">For app<select id="ea">${apps.map((a) => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('')}</select></label></div><div id="eff"></div></div>`;
    const drawEff = guard(async () => { const a = $('#ea').value; $('#eff').innerHTML = a ? effectiveTable(await resolveEffective(a, id)) : '<p class="muted">Register an app first.</p>'; });
    const drawEd = guard(() => settingsEditor($('#ed'), { scope: 'user', user: id, app: $('#sc').value }, drawEff));
    $('#sc').onchange = drawEd; $('#ea').onchange = drawEff; drawEd(); drawEff();
  }
}

/* ---------- Account approval ---------- */
// "Require approval" = a global portal.access=false row. Approved users get a user-wide portal.access=true row,
// which outranks the global one, so apps need no extra logic beyond the portal.access check they already do.
async function approvalState() {
  const row = (await listAll('portal_settings', { filter: 'scope = "global" && key = "portal.access" && app = ""' }))[0];
  return { required: !!row && row.value === false, row };
}
async function awaitingApproval() {
  const [users, rows] = await Promise.all([listAll(state.usersColl, { sort: '-created', max: 5000 }), listAll('portal_settings', { filter: 'scope = "user" && app = "" && key = "portal.access"', max: 5000 })]);
  const have = new Set(rows.map((r) => r.user)); return users.filter((u) => !have.has(u.id));
}
async function setAccess(user, app, value) {
  const ex = (await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(user)} && app = ${fq(app)} && key = "portal.access"` }))[0];
  if (ex) await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value });
  else await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user, app, key: 'portal.access', value });
}

/* ---------- One sign-in for every JoolzApp app ---------- */
// Apps of your own store that use the shared account have a /sso.html page. From the dashboard, "Open" passes the person's
// sign-in to it (in the address fragment, which is never sent to a server) so they skip the app's own login page.
// An "app.sso" setting marks which apps support this, so a sign-in is never handed to an app that doesn't.
async function markSsoApps(apps) {
  const want = apps.filter((a) => /^joolay-/.test(a.id) && a.slug).map((a) => a.slug);
  if (!want.length) return;
  const have = new Set((await listAll('portal_settings', { filter: 'scope = "app" && key = "app.sso"' })).map((r) => r.app));
  for (const slug of want) if (!have.has(slug)) { try { await api('POST', '/api/collections/portal_settings/records', { scope: 'app', app: slug, user: '', key: 'app.sso', value: true, secret: false }); } catch (e) { if (e.status !== 400) throw e; } }
}
async function ssoToken() {
  if (state.role === 'user') return (await api('POST', `/api/collections/${state.usersColl}/auth-refresh`)).token;
  // Admins sign in here as a PocketBase superuser; apps use the matching JoolzApp user (same email), if there is one.
  const u = (await api('GET', `/api/collections/${state.usersColl}/records?perPage=1&filter=${q('email = ' + fq(state.actor))}`)).items[0];
  return u ? (await api('POST', `/api/collections/${state.usersColl}/impersonate/${u.id}`, { duration: 7 * 86400 })).token : '';
}
let ssoSlugs = new Set();
const bindOpen = (root, slugs) => { ssoSlugs = slugs; };
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-open]'); if (!a || e.ctrlKey || e.metaKey || e.shiftKey || !ssoSlugs.has(a.dataset.open)) return;   // not a JoolzApp app: plain link
  e.preventDefault();
  const w = window.open('about:blank', '_blank');       // opened now so the browser doesn't block it
  (async () => {
    let url = a.href;
    try { const t = await ssoToken(); if (t) url = new URL('sso.html', a.href).href + '#t=' + encodeURIComponent(t); } catch {}
    if (w) w.location.href = url; else location.href = url;
  })();
});

/* ---------- Cleanup review ---------- */
// Portal Admin never deletes anything on its own. This page only LISTS leftovers that look safe to remove (rows that belong to
// deleted users or uninstalled apps); you tick what you want gone and confirm. Anything it can't judge with confidence is left out.
const CAP = 20000;
const keptCleanup = () => { try { return JSON.parse(localStorage.getItem('pa.keptCleanup') || '[]'); } catch { return []; } };
async function findCleanup() {
  const notes = [], groups = [];
  const [users, apps, settings, reqs] = await Promise.all([
    listAll(state.usersColl, { max: CAP }), listAll('portal_apps'), listAll('portal_settings', { max: CAP }), listAll('portal_requests', { max: CAP }).catch(() => []),
  ]);
  const usersKnown = users.length < CAP, userIds = new Set(users.map((u) => u.id)), slugs = new Set(apps.map((a) => a.slug));
  let installed = null;
  try { const r = await fetch('/umbrel-apps', { cache: 'no-store' }); const d = r.ok ? await r.json() : null; if (d && d.available) installed = { slugs: new Set(d.apps.map((a) => a.slug || slugOf(a.id))), ids: new Set(d.apps.map((a) => a.id)), apps: d.apps }; } catch {}
  if (!installed) notes.push("Portal Admin can't see which apps are installed on this Umbrel, so uninstalled apps and their leftover collections aren't checked.");
  if (!usersKnown) notes.push('There are too many users to check for deleted ones.');
  const add = (id, title, help, items, extra = {}) => { items = items.filter((i) => !keptCleanup().includes(i.key)); if (items.length) groups.push({ id, title, help, items, ...extra }); };
  const used = new Set();
  const rec = (coll, r, label, sub) => { used.add(coll + ':' + r.id); return { key: coll + ':' + r.id, kind: 'record', coll, id: r.id, label, sub }; };
  if (usersKnown) add('users', 'Settings of deleted users', "These belong to accounts that no longer exist, so nothing can use them.",
    settings.filter((r) => r.scope === 'user' && r.user && !userIds.has(r.user)).map((r) => rec('portal_settings', r, r.key + (r.app ? ' · ' + r.app : ''), 'user ' + r.user)));
  add('apps', 'Settings of apps that are no longer registered', 'The app they belong to is not in your Apps list.',
    settings.filter((r) => r.app && !slugs.has(r.app) && !used.has('portal_settings:' + r.id)).map((r) => rec('portal_settings', r, r.key, r.app + (r.scope === 'user' ? ' · user ' + r.user : ''))));
  add('reqs', 'Access requests that can no longer be answered', 'The person was deleted or the app is no longer registered.',
    reqs.filter((r) => (usersKnown && !userIds.has(r.user)) || (r.app !== DEL_REQ && r.app !== CHILD_REQ && r.app !== SPOUSE_REQ && !slugs.has(r.app))).map((r) => rec('portal_requests', r, (r.email || r.user) + ' → ' + (r.app === DEL_REQ ? 'account deletion' : r.app), r.status || '')));
  // Accounts nobody has used for a year (the last-active date is kept by Portal Admin > Changes > "Track when people were last active").
  { const cut = Date.now() - 365 * 86400e3, ms = (v) => { const t = Date.parse(String(v || '').replace(' ', 'T')); return Number.isFinite(t) ? t : 0; };
    add('inactive', 'Accounts unused for a year', 'Marked for deletion. Email them a deletion notice first: if they sign in to any app within 30 days they come off this list and their year restarts. Nothing is removed until you tick the person and confirm.',
      users.filter((u) => u.lastActive && !u.isAdmin && u.id !== state.uid && ms(u.lastActive) && ms(u.lastActive) < cut)
        .map((u) => { const na = ms(u.deletionNoticeAt), left = na ? Math.ceil((na + 30 * 86400e3 - Date.now()) / 86400e3) : 0, fmt = (v) => String(v).slice(8, 10) + '/' + String(v).slice(5, 7) + '/' + String(v).slice(0, 4);
          return { key: 'inactive:' + u.id, kind: 'user', coll: state.usersColl, id: u.id, noticeAt: na, label: u.name || u.email, sub: (u.email || '') + ' · last active ' + fmt(u.lastActive) + ' · ' + (na ? 'notice sent ' + fmt(u.deletionNoticeAt) + (left > 0 ? ' (' + left + ' day' + (left === 1 ? '' : 's') + ' left)' : ' (30 days passed)') : 'no notice sent') }; }), { keepResets: true, notice: true }); }
  if (installed) {
    const gone = apps.filter((a) => !installed.slugs.has(a.slug));
    add('uninstalled', 'Apps no longer installed on this Umbrel', 'Removing one also removes its settings and per-user overrides.',
      gone.map((a) => ({ key: 'app:' + a.id, kind: 'app', coll: 'portal_apps', id: a.id, slug: a.slug, label: a.name, sub: a.slug })));
    // Collections left behind: created by Portal Admin for an app that is gone, or named after an app that is gone.
    const goneSlugs = gone.map((a) => a.slug);
    const fromAudit = new Map();
    for (const r of await listAll('portal_audit', { filter: 'action = "schema.apply"', max: 2000 }).catch(() => [])) if (r.detail && r.detail.app && !installed.ids.has(r.detail.app)) fromAudit.set(r.target, r.detail.app);
    const protectedName = /^(_|portal_)/;
    const cols = ((await api('GET', '/api/collections?perPage=200&sort=name').catch(() => ({ items: [] }))).items || [])
      .filter((c) => c.type === 'base' && !c.system && c.name !== state.usersColl && c.name !== 'users' && !protectedName.test(c.name) && c.name !== 'app_access');
    const items = [];
    for (const c of cols) {
      const why = fromAudit.has(c.name) ? 'created for ' + fromAudit.get(c.name) : goneSlugs.find((g) => c.name.startsWith(g + '_')) ? 'named after the uninstalled app ' + goneSlugs.find((g) => c.name.startsWith(g + '_')) : '';
      if (why) items.push({ key: 'collection:' + c.name, kind: 'collection', coll: c.name, id: c.id, label: c.name, sub: why + ' · ' + (await count(c.name).catch(() => '?')) + ' records' });
    }
    add('collections', 'PocketBase collections left behind', 'These hold data. Deleting one is permanent, so each is confirmed by typing its name.', items, { single: true });
  }
  return { groups, notes };
}
async function deleteCleanupItem(it) {
  if (it.kind === 'collection') await api('DELETE', '/api/collections/' + it.coll);
  else if (it.kind === 'user') {
    for (const r of await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(it.id)}` })) await api('DELETE', `/api/collections/portal_settings/records/${r.id}`);
    await api('DELETE', `/api/collections/${state.usersColl}/records/${it.id}`);
    await audit('user.delete', it.id, { email: it.sub.split(' · ')[0], reason: 'unused for a year' }); return;
  } else {
    if (it.kind === 'app') for (const r of await listAll('portal_settings', { filter: `app = ${fq(it.slug)}` })) await api('DELETE', `/api/collections/portal_settings/records/${r.id}`);
    await api('DELETE', `/api/collections/${it.coll}/records/${it.id}`);
  }
  await audit('cleanup.delete', it.key, { label: it.label });
}
async function viewCleanup() {
  if (await needSetup()) return;
  const { groups, notes } = await findCleanup();
  const row = (it) => `<tr><td style="width:28px"><input type="checkbox" data-k="${esc(it.key)}"></td><td><b>${esc(it.label)}</b><div class="muted small">${esc(it.sub)}</div></td></tr>`;
  main().innerHTML = `<h1>Cleanup</h1><p class="sub">Leftovers that look safe to remove. Nothing here is deleted automatically: tick what you want gone and confirm.</p>
    ${notes.map((n) => `<p class="muted small">${esc(n)}</p>`).join('')}
    ${groups.map((g) => `<div class="card" data-g="${esc(g.id)}"><h2>${esc(g.title)} <span class="chip">${g.items.length}</span></h2><p class="muted small">${esc(g.help)}</p>
      <table><tbody>${g.items.map(row).join('')}</tbody></table>
      <div class="row" style="margin-top:10px;gap:8px">${g.notice ? '<button class="btn primary" data-do="notice">Email deletion notice</button> ' : ''}<button class="btn danger" data-do="delete">Delete selected</button> <button class="btn" data-do="keep">${g.keepResets ? 'Keep (restart their year)' : 'Keep (hide)'}</button></div></div>`).join('') || '<div class="card"><p class="muted">Nothing to clean up. 🎉</p></div>'}`;
  main().onclick = guard(async (e) => {
    const b = e.target.closest('[data-do]'); if (!b) return;
    const card = b.closest('[data-g]'), g = groups.find((x) => x.id === card.dataset.g);
    const keys = [...card.querySelectorAll('input[data-k]:checked')].map((i) => i.dataset.k);
    if (!keys.length) return toast('Tick at least one item first', true);
    const sendNotices = async (list) => {
      b.disabled = true;
      try {
        const r = await acctFetch('/admin/inactive/notice', { ids: list.map((i) => i.id) }), okN = r.results.filter((x) => x.ok), bad = r.results.filter((x) => !x.ok);
        for (const x of okN) await audit('user.deletion-notice', x.id, { email: x.email, deleteOn: x.deleteOn });
        toast(okN.length ? `Notice emailed to ${okN.length} ${okN.length === 1 ? 'person' : 'people'}` + (bad.length ? `, ${bad.length} failed: ${bad[0].message}` : '') : (bad[0] ? bad[0].message : 'Nothing was sent'), !okN.length);
      } finally { b.disabled = false; }
      route();
    };
    if (b.dataset.do === 'notice') {
      const list = keys.map((k) => g.items.find((i) => i.key === k)).filter(Boolean);
      if (!list.length) return;
      if (!confirm(`Email a deletion notice to ${list.length} ${list.length === 1 ? 'person' : 'people'}? It tells them the account will be deleted in 30 days unless they sign in.`)) return;
      return sendNotices(list);
    }
    if (b.dataset.do === 'delete' && g.notice) {
      const list = keys.map((k) => g.items.find((i) => i.key === k)).filter(Boolean), none = list.filter((i) => !i.noticeAt), early = list.filter((i) => i.noticeAt && Date.now() - i.noticeAt < 30 * 86400e3);
      if (none.length) {
        const who = none.slice(0, 3).map((i) => i.label).join(', ') + (none.length > 3 ? ' and ' + (none.length - 3) + ' more' : '');
        if (confirm(`${who} ${none.length === 1 ? 'has' : 'have'} not been sent a deletion notice.\n\nOK = email ${none.length === 1 ? 'them' : 'the notice'} instead (nothing is deleted).\nCancel = carry on to delete without a notice.`)) return sendNotices(none);
        if (!confirm(`Delete ${none.length === 1 ? who : none.length + ' accounts'} WITHOUT a deletion notice? This cannot be undone.`)) return;
      }
      if (early.length && !confirm(`${early.length} of these ${early.length === 1 ? 'was' : 'were'} sent a notice less than 30 days ago, so ${early.length === 1 ? 'they still have' : 'they still have'} time to sign in. Delete anyway?`)) return;
    }
    if (b.dataset.do === 'keep' && g.keepResets) { const now = new Date().toISOString().replace('T', ' '); for (const k of keys) await api('PATCH', `/api/collections/${state.usersColl}/records/${k.replace(/^inactive:/, '')}`, { lastActive: now, deletionNoticeAt: '' }); toast(keys.length + ' kept'); return route(); }
    if (b.dataset.do === 'keep') { localStorage.setItem('pa.keptCleanup', JSON.stringify([...keptCleanup(), ...keys])); return route(); }
    if (g.single && keys.length > 1) return toast('Collections are deleted one at a time', true);
    if (g.single) { const name = keys[0].replace(/^collection:/, ''); if (prompt(`Type "${name}" to permanently delete this collection and its data.`) !== name) return; }
    else if (!confirm(`Delete ${keys.length} item${keys.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    // Re-check against fresh data so only things that are still leftovers get removed.
    const fresh = new Map((await findCleanup()).groups.flatMap((x) => x.items).map((i) => [i.key, i]));
    let done = 0; for (const k of keys) { const it = fresh.get(k); if (it) { await deleteCleanupItem(it); done++; } }
    toast(done + ' deleted'); route();
  });
}

/* ---------- Access requests (admin) ---------- */
async function viewRequests() {
  if (await needSetup()) return;
  const [reqs, apps] = await Promise.all([listAll('portal_requests', { sort: '-created', max: 500 }), listAll('portal_apps')]);
  const appName = (slug) => slug === DEL_REQ ? 'Account deletion' : slug === CHILD_REQ ? "Child's account (created by a parent)" : slug === SPOUSE_REQ ? "Spouse's account (created by their spouse)" : (apps.find((a) => a.slug === slug) || {}).name || slug;
  const pending = reqs.filter((r) => r.status === 'pending'), done = reqs.filter((r) => r.status !== 'pending');
  main().innerHTML = `<h1>Access requests</h1><p class="sub">Users asking for access to individual Joolzapp apps, and account deletion requests. Approving access sets <code>portal.access = true</code> for that user and app; confirming a deletion permanently removes the user and their settings.</p>
    <div class="card"><h2>Pending (${pending.length})</h2><table><tbody>${pending.map((r) => `<tr><td><b>${esc(r.email || r.user)}</b><div class="muted small">${esc(fmtDate(r.created))}</div></td>
      <td><b>${esc(appName(r.app))}</b>${r.message ? `<div class="small">${esc(r.message)}</div>` : ''}</td>
      <td style="white-space:nowrap">${r.app === DEL_REQ ? `<button class="btn danger small" data-act="approve" data-id="${esc(r.id)}">Confirm deletion</button>` : `<button class="btn primary small" data-act="approve" data-id="${esc(r.id)}">Approve</button>`} <button class="btn small" data-act="deny" data-id="${esc(r.id)}">Deny</button></td></tr>`).join('') || '<tr><td class="muted">No pending requests.</td></tr>'}</tbody></table></div>
    <div class="card"><h2>History</h2><table><tbody>${done.map((r) => `<tr><td>${esc(r.email || r.user)}</td><td>${esc(appName(r.app))}</td>
      <td>${r.status === 'approved' ? '<span class="chip ok">approved</span>' : '<span class="chip bad">denied</span>'}</td><td class="muted small">${esc(r.decided_by)} · ${esc(fmtDate(r.updated))}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`;
  main().onclick = guard(async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const r = reqs.find((x) => x.id === b.dataset.id); const approve = b.dataset.act === 'approve';
    if (approve && r.app === DEL_REQ) {
      if (!confirm(`Permanently delete ${r.email || r.user} from every Joolzapp app? This cannot be undone.`)) return;
      for (const x of await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(r.user)}` })) await api('DELETE', `/api/collections/portal_settings/records/${x.id}`);
      await api('DELETE', `/api/collections/${state.usersColl}/records/${r.user}`);
      await audit('user.delete', r.user, { email: r.email, via: 'deletion request' });
    } else if (r.app === CHILD_REQ || r.app === SPOUSE_REQ) {
      for (const x of await listAll('joolz_guardians', { filter: `childId = ${fq(r.user)} && kind = "admin"` })) await api('PATCH', `/api/collections/joolz_guardians/records/${x.id}`, { status: approve ? 'approved' : 'declined', decidedAt: new Date().toISOString() });
    } else if (approve) {
      const ex = (await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(r.user)} && app = ${fq(r.app)} && key = "portal.access"` }))[0];
      if (ex) await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value: true });
      else await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: r.user, app: r.app, key: 'portal.access', value: true });
    }
    await api('PATCH', `/api/collections/portal_requests/records/${r.id}`, { status: approve ? 'approved' : 'denied', decided_by: state.actor });
    await audit(approve ? 'request.approve' : 'request.deny', r.user, { app: r.app, email: r.email });
    toast(approve ? (r.app === DEL_REQ ? 'Account deleted' : 'Approved') : 'Denied'); route();
  });
}




/* ---------- Upcoming events ticker ----------
   Scrolls in the top bar on the home screen. Today it carries birthdays; the Organiser app will add family events, notices and school pickups
   through the same /events feed (see events.js on the server). */
let EVENTS = [], tkTimer = null;
const localDay = (d = new Date()) => d.toLocaleDateString('en-CA');
const evDate = (s) => new Date(s + 'T00:00:00');
function evWhen(e, long) {
  const n = Math.round((evDate(e.date) - evDate(localDay())) / 86400000), d = evDate(e.date);
  const dayTxt = long ? d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const base = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 && !long ? d.toLocaleDateString(undefined, { weekday: 'long' }) : dayTxt;
  return base + (e.time ? ' ' + e.time : '');
}
const evIcon = (e) => (e.kind === 'birthday' ? '🎂' : e.kind === 'pickup' ? '🚌' : e.kind === 'notice' ? '📣' : e.kind === 'update' ? '🔄' : '📅');
function renderTicker() {
  const b = $('#tb-ticker'), t = $('#tk-track'); if (!b || !t) return;
  const show = !!selfId() && $('#shell').classList.contains('home-page') && !editing;
  b.hidden = !show; $('#shell').classList.toggle('has-ticker', show);
  if (!show) return;
  if (!EVENTS.length) { t.innerHTML = '<span class="tk-i"><i>📅</i>Nothing coming up. Family birthdays and Organiser events will show here.</span>'; t.classList.add('still'); return; }
  t.classList.remove('still');
  const one = EVENTS.map((e) => `<span class="tk-i"><i>${evIcon(e)}</i><b>${esc(evWhen(e))}</b> ${esc(e.title)}${e.sub ? ' <em>' + esc(e.sub) + '</em>' : ''}</span>`).join('');
  t.innerHTML = one + one;   // twice, so the loop is seamless
  requestAnimationFrame(() => { const w = t.scrollWidth / 2; t.style.setProperty('--tk-dur', Math.max(14, Math.round(w / 45)) + 's'); });
}
async function loadEvents() {
  if (!state.token || !selfId()) { EVENTS = []; renderTicker(); return; }
  try { EVENTS = (await acctFetch('/events?days=60&today=' + localDay())).events || []; } catch { EVENTS = []; }
  renderTicker();
}
function eventsSheet() {
  const by = {}; EVENTS.forEach((e) => { (by[e.date] = by[e.date] || []).push(e); });
  openSheet(`<h2>Upcoming</h2>${Object.keys(by).sort().map((d) => `<h3 class="ev-day">${esc(evWhen(by[d][0], true))}</h3>${by[d].map((e) => `<div class="ev-row"><i>${evIcon(e)}</i><div><b>${esc(e.title)}</b>${e.sub ? '<span class="muted small"> · ' + esc(e.sub) + '</span>' : ''}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">Open</a>` : ''}</div></div>`).join('')}`).join('') || '<p class="muted">Nothing coming up.</p>'}<p class="muted small">Birthdays come from the dates of birth in your family. Events, notices and school pick-ups from the Organiser app will appear here too.</p>`);
}
$('#tb-ticker').onclick = eventsSheet;
setInterval(() => { if (state.token) loadEvents(); }, 30 * 60 * 1000);


/* ---------- Paid apps: return from Yoco, and the admin screen ---------- */
let payPoll = 0;
async function viewPaid(slug) {
  const token = ++payPoll;
  const app = (await listAll('portal_apps', { sort: 'name' }).catch(() => [])).find((x) => x.slug === slug);
  const name = app ? app.name : 'your app', open = app && /^https?:\/\//i.test(app.url || '') ? `<a class="btn primary" href="${esc(app.url)}" target="_blank" rel="noopener">Open ${esc(name)}</a> ` : '';
  const show = (h) => { if (token === payPoll) main().innerHTML = `<h1>Payment</h1><div class="card">${h}</div>`; };
  show(`<p>Thanks! Confirming your payment for <b>${esc(name)}</b>…</p><p class="muted small">This usually takes a few seconds.</p>`);
  for (let i = 0; i < 25 && token === payPoll; i++) {
    const s = await acctFetch('/pay/status?slug=' + encodeURIComponent(slug)).catch(() => ({}));
    if (s.active) { show(`<p><b>${esc(name)} is unlocked.</b></p>${s.until ? `<p class="muted small">Access runs until ${esc(fmtDay(s.until))}.</p>` : ''}<p>${open}<a class="btn" href="#/home">Back to Home</a></p>`); if (HM) HM = null; return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  show(`<p>We haven't had confirmation from Yoco yet.</p><p class="muted small">If you were charged, it can take a minute. Check again, or ask the admin to unlock ${esc(name)} for you.</p><p><button class="btn primary" id="paid-again">Check again</button> <a class="btn" href="#/home">Back to Home</a></p>`);
  const b = $('#paid-again'); if (b) b.onclick = () => viewPaid(slug);
}
const toCents = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
async function viewPaywall() {
  const j = await acctFetch('/admin/paywall'), apps = await listAll('portal_apps', { sort: 'name' });
  const y = j.yoco, origin = location.origin;
  const chip = (ok, t) => `<span class="chip ${ok ? 'ok' : 'warn'}">${esc(t)}</span>`;
  main().innerHTML = `<h1>Paid apps</h1><p class="sub">Lock an app so only you, people you choose, and people who pay can use it.</p>
    <div class="card"><h2>Yoco</h2><p>${chip(y.hasSecret, y.hasSecret ? 'Secret key saved' + (y.mode ? ' (' + y.mode + ' mode)' : '') : 'No secret key')} ${chip(!!y.publicUrl, y.publicUrl ? 'Public address set' : 'No public address')} ${chip(y.hasWebhook, y.hasWebhook ? 'Webhook secret saved' : 'Webhook not registered')}</p>
      <form id="yoco" class="kv"><label>Yoco secret key<input name="secretKey" type="password" autocomplete="off" placeholder="${y.hasSecret ? 'Saved. Paste a new one to replace it.' : 'sk_test_… (start with a test key)'}"></label>
      <label>Public address of this dashboard<input name="publicUrl" value="${esc(y.publicUrl)}" placeholder="https://your-funnel-address.ts.net" autocomplete="off" autocapitalize="none"></label>
      <label>Webhook secret (filled in for you when you register)<input name="webhookSecret" type="password" autocomplete="off" placeholder="${y.hasWebhook ? 'Saved' : 'whsec_… (only if you registered it yourself)'}"></label>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn primary">Save</button><button type="button" class="btn" id="yreg">Register webhook with Yoco</button></div></form>
      <p class="muted small">Yoco confirms each payment by calling <code>${esc((y.publicUrl || 'https://your-address') + '/yoco/webhook')}</code>, so the public address has to be the internet address of this dashboard (the Tailscale Funnel one, not your home network). Until the webhook is registered, payments are taken but apps don't unlock by themselves; you can still unlock people by hand below. Yoco takes payments of R2 or more, in rand.</p></div>
    ${apps.map((a) => { const e = j.apps[a.slug] || { cfg: null, people: [] }, c = e.cfg;
      return `<div class="card" data-app="${esc(a.slug)}"><div class="row spread"><h2>${esc(a.name)}</h2>${c ? '<span class="chip ok">locked, ' + esc(priceText(c)) + '</span>' : '<span class="chip">free for everyone</span>'}</div>
        <form class="pw-cfg kv"><label class="inline"><input type="checkbox" name="on" ${c ? 'checked' : ''}> Lock behind payment</label>
        <label>Access<select name="mode"><option value="period" ${!c || c.mode === 'period' ? 'selected' : ''}>For a number of days, then renew</option><option value="once" ${c && c.mode === 'once' ? 'selected' : ''}>One payment, permanent</option></select></label>
        <label>Days of access<input name="days" type="number" min="1" max="3650" value="${c ? c.days : 30}"></label>
        <label>Price for one person (R)<input name="price" inputmode="decimal" value="${c ? c.price / 100 : ''}" placeholder="49"></label>
        <label>Price for a whole household (R, optional)<input name="hprice" inputmode="decimal" value="${c && c.householdPrice ? c.householdPrice / 100 : ''}" placeholder="leave empty for no household option"></label>
        <div><button class="btn primary small">Save</button></div></form>
        ${e.people.length ? `<table><thead><tr><th>Person</th><th>How</th><th>Until</th><th></th></tr></thead><tbody>${e.people.map((p) => `<tr><td><b>${esc(p.name || p.username || p.email)}</b><br><span class="muted small">${esc(p.email)}</span></td><td>${esc(p.via)}</td><td>${p.until ? esc(fmtDay(p.until)) + (p.expired ? ' (ended)' : '') : 'permanent'}</td><td><button class="btn small danger" data-revoke="${esc(p.userId)}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nobody has been given access yet.</p>'}
        <form class="pw-grant row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><input name="who" placeholder="Email or username" autocapitalize="none" required><input name="days" type="number" min="1" placeholder="Days (empty = permanent)" style="max-width:190px"><button class="btn small">Give access</button></form></div>`; }).join('')}`;
  const redo = () => viewPaywall();
  $('#yoco').onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target.elements; await acctFetch('/admin/paywall', { action: 'yoco', secretKey: f.secretKey.value, publicUrl: f.publicUrl.value, webhookSecret: f.webhookSecret.value }); toast('Saved'); redo(); });
  $('#yreg').onclick = guard(async () => { const f = $('#yoco').elements; await acctFetch('/admin/paywall', { action: 'yoco', secretKey: f.secretKey.value, publicUrl: f.publicUrl.value }); const r = await acctFetch('/admin/paywall', { action: 'register' }); toast(r.hasSecret ? 'Webhook registered' : 'Registered. Paste the webhook secret Yoco shows you.'); redo(); });
  main().querySelectorAll('.pw-cfg').forEach((form) => {
    const slug = form.closest('[data-app]').dataset.app;
    form.onsubmit = guard(async (e) => {
      e.preventDefault(); const f = e.target.elements, had = !!(j.apps[slug] && j.apps[slug].cfg);
      if (!f.on.checked) { if (had && !confirm('Open this app to everyone again?')) return; await acctFetch('/admin/paywall', { action: 'config', slug, cfg: null }); toast('Unlocked for everyone'); return redo(); }
      const price = toCents(f.price.value), hp = f.hprice.value.trim() ? toCents(f.hprice.value) : null;
      if (!price) throw new Error('Enter a price in rand.');
      if (!had && !confirm('Everyone except you and people you choose will lose access until they pay. Continue?')) return;
      await acctFetch('/admin/paywall', { action: 'config', slug, cfg: { mode: f.mode.value, days: Number(f.days.value) || 30, price, householdPrice: hp } }); toast('Saved'); redo();
    });
  });
  main().querySelectorAll('.pw-grant').forEach((form) => {
    const slug = form.closest('[data-app]').dataset.app;
    form.onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target.elements; const r = await acctFetch('/admin/paywall', { action: 'grant', slug, identity: f.who.value, days: f.days.value ? Number(f.days.value) : 0 }); toast('Access given to ' + r.name); redo(); });
  });
  main().onclick = guard(async (e) => {
    const b = e.target.closest('[data-revoke]'); if (!b) return;
    if (!confirm('Remove this person’s access?')) return;
    await acctFetch('/admin/paywall', { action: 'revoke', slug: b.closest('[data-app]').dataset.app, userId: b.dataset.revoke }); toast('Removed'); redo();
  });
}

// Dates the way the person set them (their account's date format), falling back to their region's.
function fmtDay(v) {
  const d = new Date(v); if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0'), dd = p(d.getDate()), mm = p(d.getMonth() + 1), yy = d.getFullYear(), f = state.dateFormat || regionalDefaults().dateFormat;
  return f === 'MM/DD/YYYY' ? `${mm}/${dd}/${yy}` : f === 'YYYY-MM-DD' ? `${yy}-${mm}-${dd}` : `${dd}/${mm}/${yy}`;
}
async function loadDatePref() {
  if (!selfId()) return;
  try { const r = await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(selfId())} && app = "" && key = "pref.dateFormat"` }); if (r[0] && r[0].value) state.dateFormat = r[0].value; } catch { /* keep the regional default */ }
}

/* ---------- Regional defaults ----------
   A new account starts with settings that match where the person is (from the device language and time zone), e.g. South Africa gets
   metric, Celsius, DD/MM/YYYY, 24-hour, ZAR. They are saved once on the account (so every app reads the same values) and the person can change
   any of them in My settings; "Use my region" puts them back. */
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const TZ_REGION = { 'Africa/Johannesburg': 'ZA', 'Africa/Maputo': 'MZ', 'Africa/Harare': 'ZW', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Cairo': 'EG', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ', 'Asia/Dubai': 'AE', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Lisbon': 'PT', 'Europe/Amsterdam': 'NL', 'Europe/Rome': 'IT' };
function regionalDefaults() {
  let loc = 'en-ZA', tz = '';
  try { loc = (navigator.languages && navigator.languages[0]) || navigator.language || loc; } catch {}
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  let region = ((loc.split('-')[1] || '').match(/^[A-Za-z]{2}$/) || [''])[0].toUpperCase() || TZ_REGION[tz] || '';
  if (TZ_REGION[tz] === 'ZA') region = 'ZA';   // a device set to South Africa time is in South Africa, whatever language it runs in
  const lang = loc.split('-')[0].toLowerCase();
  const cur = { ZA: 'ZAR', US: 'USD', GB: 'GBP', AU: 'AUD', CA: 'CAD', AE: 'AED', IN: 'INR' }[region] || (EURO.includes(region) ? 'EUR' : '');
  const us = ['US', 'LR', 'MM'].includes(region);
  return {
    language: ['en', 'af', 'zu', 'xh', 'st', 'tn', 'fr', 'es', 'pt', 'ar'].includes(lang) ? lang : 'en',
    currency: cur, timezone: tz,
    dateFormat: ['US', 'PH', 'FM', 'PW'].includes(region) ? 'MM/DD/YYYY' : ['CN', 'JP', 'KR', 'TW', 'SE', 'LT', 'HU'].includes(region) ? 'YYYY-MM-DD' : 'DD/MM/YYYY',
    timeFormat: ['US', 'CA', 'AU', 'NZ', 'IN', 'PH', 'EG', 'SA', 'CO', 'PK', 'MY'].includes(region) ? '12h' : '24h',
    units: us ? 'imperial' : 'metric',
    temperature: ['US', 'BS', 'BZ', 'KY', 'PW', 'LR'].includes(region) ? 'F' : 'C',
  };
}
async function seedRegional() {
  const uid = selfId();
  const rows = await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(uid)} && app = "" && key ~ "pref."` });
  if (rows.some((r) => r.key === 'pref.regionSeeded')) return;
  const have = new Set(rows.map((r) => r.key.slice(5))), d = regionalDefaults();
  for (const [k, v] of Object.entries(d)) if (v && !have.has(k)) await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.' + k, value: v, secret: false });
  await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.regionSeeded', value: '1', secret: false });
}

/* ---------- My settings (regular JoolzApp users) ---------- */
// Open sign-ups, but never let a new account set its own isAdmin flag (ShutterWorth and others use that field).
// Sign-up is "open" when this rule exists. It can never be met from a browser: accounts are created only by this app's server (POST /signup),
// which checks date of birth and parent approval, so there is a single sign-up path for every JoolzApp app.
const SIGNUP_RULE = '@request.body.email:isset = false && @request.body.email:isset = true';
const DEL_REQ = '__account_deletion__', CHILD_REQ = '__child_account__', SPOUSE_REQ = '__spouse_account__';
const PREFS = [
  ['language', 'Language', [['en', 'English'], ['af', 'Afrikaans'], ['zu', 'isiZulu'], ['xh', 'isiXhosa'], ['st', 'Sesotho'], ['tn', 'Setswana'], ['fr', 'Français'], ['es', 'Español'], ['pt', 'Português'], ['ar', 'العربية']]],
  ['currency', 'Currency', [['ZAR', 'ZAR – South African rand'], ['USD', 'USD – US dollar'], ['EUR', 'EUR – Euro'], ['GBP', 'GBP – Pound sterling'], ['AUD', 'AUD – Australian dollar'], ['CAD', 'CAD – Canadian dollar'], ['AED', 'AED – UAE dirham'], ['INR', 'INR – Indian rupee']]],
  ['timezone', 'Time zone', null],
  ['dateFormat', 'Date format', [['DD/MM/YYYY', '31/12/2026'], ['MM/DD/YYYY', '12/31/2026'], ['YYYY-MM-DD', '2026-12-31']]],
  ['timeFormat', 'Time format', [['24h', '24-hour (14:30)'], ['12h', '12-hour (2:30 pm)']]],
  ['units', 'Distance and weight', [['metric', 'Metric (km, kg, litres)'], ['imperial', 'Imperial (mi, lb, gallons)']]],
  ['temperature', 'Temperature', [['C', 'Celsius (°C)'], ['F', 'Fahrenheit (°F)']]],
  ['theme', 'Theme', [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']]],
  ['background', 'Dashboard background', [['aurora', 'Aurora (default)'], ['sunset', 'Sunset'], ['ocean', 'Ocean'], ['forest', 'Forest'], ['violet', 'Violet'], ['plain', 'Plain (no colour glows)']]],
  ['backgroundMotion', 'Background motion', [['animated', 'Slowly moving (default)'], ['still', 'Still']]],
];
// The backdrop follows the person's account (pref.background / pref.backgroundMotion), so it is the same on every device.
function applyBg(style, motion) {
  const r = document.documentElement;
  r.dataset.bg = ['aurora', 'sunset', 'ocean', 'forest', 'violet', 'plain'].includes(style) ? style : 'aurora';
  r.dataset.motion = motion === 'still' ? 'still' : 'animated';
}
async function loadAppearance() {
  if (!selfId()) return;
  try {
    const rows = await listAll('portal_settings', { filter: `scope = "user" && user = ${fq(selfId())} && app = "" && (key = "pref.background" || key = "pref.backgroundMotion")` });
    const v = (k) => (rows.find((r) => r.key === k) || {}).value;
    applyBg(v('pref.background'), v('pref.backgroundMotion'));
  } catch { /* keep the default backdrop */ }
}
async function viewMe() {
  const uid = selfId() || state.uid;
  const [rows, reqs] = await Promise.all([
    listAll('portal_settings', { filter: `scope = "user" && user = ${fq(uid)} && app = "" && key ~ "pref."` }),
    listAll('portal_requests', { filter: `user = ${fq(uid)}`, sort: '-created' }).catch(() => null),
  ]);
  const cur = Object.fromEntries(rows.map((r) => [r.key.slice(5), r]));
  let zones; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Africa/Johannesburg', 'UTC']; }
  const detected = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  const delPend = (reqs || []).find((r) => r.app === DEL_REQ && r.status === 'pending'), delDenied = (reqs || []).find((r) => r.app === DEL_REQ && r.status === 'denied');
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const field = ([key, label, opts]) => {
    const v = cur[key] ? cur[key].value : '';
    const list = opts || zones.map((z) => [z, z]);
    return `<label>${esc(label)}<select name="${key}">${opt('', '— not set —', v === '')}${list.map(([val, l]) => opt(val, l, v === val)).join('')}</select></label>`;
  };
  main().innerHTML = `<h1>My settings</h1><p class="sub">Signed in as ${esc(state.actor)}. These settings apply to every JoolzApp app you use.</p>
    <div class="tabs"><button class="active" data-t="prefs">Preferences</button><button data-t="profile">Profile</button><button data-t="ai">AI</button><button data-t="account">Account</button></div>
    <div data-pane="profile" hidden><div class="card" id="pane-profile"><p class="muted">Loading…</p></div></div>
    <div data-pane="prefs"><form id="prefs" class="card"><h2>Preferences</h2><div class="kv">${PREFS.map(field).join('')}</div>
      ${detected ? `<p class="muted small">Your device time zone: ${esc(detected)}. Defaults follow your region.</p>` : ''}<div class="row" style="gap:8px"><button class="btn primary">Save preferences</button><button type="button" class="btn" id="regional">Use my region</button></div></form></div>
    <div data-pane="ai" hidden><form id="ai" class="card"><h2>AI (for apps that use it)</h2><p class="muted small">Pick your own AI provider, model and API key. Apps that read menus, photos or text with AI will use these instead of the shared key. Only you and the admin can see them.</p>
      <div class="kv"><label>Provider<select name="provider">${AI_PROVIDERS.map(([v, l]) => opt(v, l, (cur['ai.provider'] ? cur['ai.provider'].value : 'gemini') === v)).join('')}</select></label>
      <label>Model<input name="model" list="ai-models" value="${esc(cur['ai.model'] ? cur['ai.model'].value : '')}" placeholder="" autocomplete="off"><datalist id="ai-models"></datalist></label>
      <label>API key<input name="apiKey" type="password" autocomplete="off" placeholder="${cur['ai.apiKey'] && cur['ai.apiKey'].value ? 'Saved (ends …' + esc(String(cur['ai.apiKey'].value).slice(-4)) + '). Leave blank to keep it.' : 'Paste your API key'}"></label>
      <label id="ai-base-row">Base URL<input name="baseUrl" value="${esc(cur['ai.baseUrl'] ? cur['ai.baseUrl'].value : '')}" placeholder="https://your-host/v1" autocomplete="off"></label></div>
      <p class="muted small" id="ai-hint"></p>
      <div class="row" style="gap:8px"><button class="btn primary">Save AI settings</button>${cur['ai.apiKey'] ? ' <button type="button" class="btn danger" id="ai-clear">Remove my key</button>' : ''}</div></form></div>
    <div data-pane="account" hidden><div class="card"><h2>Delete my account</h2>${delPend
      ? `<p><span class="chip warn">deletion requested</span></p><p class="muted small">Sent ${esc(fmtDate(delPend.created))}. The admin will review it and confirm. Your account stays active until then.</p><button id="delcancel" class="btn">Cancel request</button>`
      : `<form id="del"><p class="muted small">This asks the admin to permanently delete your JoolzApp account and preferences from <b>every</b> Joolzapp app. Nothing is deleted until the admin confirms.</p>
      <div class="kv"><label>Type your email to confirm<input name="confirmText" autocomplete="off" required></label><label>Password<input name="pw" type="password" autocomplete="current-password" required></label></div>
      <label>Reason (optional)<input name="reason" maxlength="300"></label>
      <button class="btn danger">Request account deletion</button></form>`}${delDenied && !delPend ? '<p class="muted small">Your last deletion request was declined.</p>' : ''}</div></div>`;
  const showTab = (t) => { main().querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.t === t)); main().querySelectorAll('[data-pane]').forEach((x) => { x.hidden = x.dataset.pane !== t; }); };
  main().onclick = (e) => { const b = e.target.closest('.tabs button'); if (b) showTab(b.dataset.t); };

  // AI settings are stored as the person's own "pref.ai.*" rows, so every app can read them through the shared account.
  const setPref = async (key, val) => {
    const ex = cur[key];
    if ((val === '' || val == null) && ex) { await api('DELETE', `/api/collections/portal_settings/records/${ex.id}`); delete cur[key]; }
    else if (val !== '' && ex) { if (ex.value !== val) { await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value: val }); ex.value = val; } }
    else if (val !== '') cur[key] = await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.' + key, value: val, secret: false });
  };
  const aiForm = $('#ai'), aiShow = () => {
    const p = AI_PROVIDERS.find(([v]) => v === aiForm.provider.value) || AI_PROVIDERS[0];
    $('#ai-base-row').style.display = aiForm.provider.value === 'custom' ? '' : 'none';
    aiForm.model.placeholder = p[2]; $('#ai-hint').textContent = p[3];
    if (aiForm.provider.value === 'openrouter') loadOpenRouterModels();
  };
  let orModels = null;
  const loadOpenRouterModels = async () => {
    if (!orModels) { try { const r = await fetch('https://openrouter.ai/api/v1/models'); orModels = ((await r.json()).data || []).map((m) => m.id).filter(Boolean).sort(); } catch { orModels = []; } }
    $('#ai-models').innerHTML = orModels.map((m) => `<option value="${esc(m)}">`).join('');
  };
  aiForm.provider.onchange = aiShow; aiShow();
  aiForm.onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = e.target.elements, key = f.apiKey.value.trim(), base = f.baseUrl.value.trim();
    if (f.provider.value === 'custom' && !/^https?:\/\//i.test(base)) return toast('Enter the base URL for your custom provider', true);
    const model = f.model.value.trim() || (AI_PROVIDERS.find(([v]) => v === f.provider.value) || [])[4] || '';
    if (!model) return toast('Enter the model you want to use', true);
    if (!key && !cur['ai.apiKey']) return toast('Paste your API key', true);
    await setPref('ai.provider', f.provider.value); await setPref('ai.model', model);
    if (key) await setPref('ai.apiKey', key);
    await setPref('ai.baseUrl', f.provider.value === 'custom' ? base : '');
    toast('AI settings saved'); route();
  });
  if ($('#ai-clear')) $('#ai-clear').onclick = guard(async () => {
    if (!confirm('Remove your AI key and model? Apps will go back to the shared key, if there is one.')) return;
    for (const k of ['ai.apiKey', 'ai.model', 'ai.provider', 'ai.baseUrl']) await setPref(k, '');
    toast('AI settings removed'); route();
  });
  profilePane(uid);
  $('#prefs').onsubmit = guard(async (e) => {
    e.preventDefault();
    for (const [key] of PREFS) {
      const val = e.target.elements[key].value, ex = cur[key];
      if (val === '' && ex) { await api('DELETE', `/api/collections/portal_settings/records/${ex.id}`); delete cur[key]; }
      else if (val !== '' && ex) { if (ex.value !== val) { await api('PATCH', `/api/collections/portal_settings/records/${ex.id}`, { value: val }); ex.value = val; } }
      else if (val !== '') cur[key] = await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.' + key, value: val, secret: false });
    }
    applyBg(e.target.elements.background.value, e.target.elements.backgroundMotion.value);
    if (e.target.elements.dateFormat.value) state.dateFormat = e.target.elements.dateFormat.value;
    toast('Preferences saved');
  });
  $('#prefs').addEventListener('change', (e) => { if (e.target.name === 'background' || e.target.name === 'backgroundMotion') { const f = $('#prefs').elements; applyBg(f.background.value, f.backgroundMotion.value); } });   // see it straight away
  $('#regional').onclick = () => {
    const f = $('#prefs'), d = regionalDefaults();
    for (const [k, v] of Object.entries(d)) if (v && f.elements[k]) f.elements[k].value = v;
    f.requestSubmit();
  };
  if ($('#del')) $('#del').onsubmit = guard(async (e) => {
    e.preventDefault();
    if (reqs === null) throw new Error('Requests are not set up yet. Ask the admin.');
    if (e.target.confirmText.value.trim().toLowerCase() !== String(state.actor).toLowerCase()) throw new Error('Type your email address exactly to confirm.');
    await api('POST', `/api/collections/${state.usersColl}/auth-with-password`, { identity: state.actor, password: e.target.pw.value });
    await api('POST', '/api/collections/portal_requests/records', { user: uid, email: state.actor, app: DEL_REQ, message: e.target.reason.value.trim(), status: 'pending' });
    toast('Deletion request sent to the admin'); route();
  });
  if ($('#delcancel')) $('#delcancel').onclick = guard(async () => {
    await api('DELETE', `/api/collections/portal_requests/records/${delPend.id}`); toast('Request cancelled'); route();
  });
}


// ---- Account details and family: the one place they are managed. The apps only link here. ----
const acctFetch = async (path, body) => {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: state.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || 'That did not work.'); return j;
};
const fmtDob = (d) => { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? d : x.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); };
const ageFrom = (d) => { const b = new Date(d + 'T00:00:00'), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--; return a; };

async function profilePane(uid) {
  const box = $('#pane-profile'); if (!box) return;
  const [me, g] = await Promise.all([api('GET', `/api/collections/${state.usersColl}/records/${uid}`).catch(() => ({})), acctFetch('/guardians').catch(() => ({ minor: false, parents: [] }))]);
  box.innerHTML = `<h2>Profile</h2>
    <form id="pf-name" class="kv"><label>Name and surname<input name="name" value="${esc(me.name || '')}" maxlength="80" autocomplete="name" required pattern=".*\\S\\s+\\S.*" title="Enter your name and surname"></label><div><button class="btn primary small">Save name</button></div></form>
    <p class="muted small">Email: <b>${esc(state.actor)}</b></p>
    ${'username' in me ? `<form id="pf-user" class="kv"><label>Username<input name="u" value="${esc(me.username || '')}" placeholder="Choose a username" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="3" maxlength="30" required><span class="muted small">Sign in with your username or your email.</span></label><div><button class="btn primary small">Save username</button></div></form>` : ''}
    <h3>Change password</h3>
    <form id="pf-pass" class="kv"><label>Current password<input name="old" type="password" autocomplete="current-password" required></label><label>New password (min 8)<input name="pw" type="password" autocomplete="new-password" minlength="8" required></label><label>Confirm new password<input name="pw2" type="password" autocomplete="new-password" minlength="8" required></label><div><button class="btn primary small">Change password</button></div></form>
    <h3>Date of birth</h3>
    ${me.dob ? `<p>${esc(fmtDob(me.dob))}</p><p class="muted small">It can't be changed here. Ask an admin if it is wrong.</p>`
      : `<form id="pf-dob" class="kv"><p class="muted small">Every JoolzApp account has one. You can only enter it once. Under 18s need a parent or guardian's approval.</p><label>Date of birth<input name="dob" type="date" min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}" required></label>
        <label id="pf-dob-parent" hidden>Parent or guardian's JoolzApp email<input name="parent" type="email" autocomplete="off"></label><div><button class="btn primary small">Save date of birth</button></div></form>`}
    ${g.minor ? `<h3>Your parents</h3><p class="muted small">A parent approves your account and settings such as joining a family.</p>${g.parents.map((p) => `<div class="row spread"><span>${esc(p.name)}</span><span>${p.status === 'approved' ? 'approved' : p.status === 'pending' ? 'waiting' : 'declined'}</span></div>`).join('')}
      <form id="pf-parent" class="row" style="gap:6px;margin-top:8px"><input name="email" type="email" placeholder="Add another parent's email" required><button class="btn small">Add</button></form>` : ''}`;
  if ($('#pf-user')) $('#pf-user').onsubmit = guard(async (e) => { e.preventDefault(); const j = await acctFetch('/account/username', { username: e.target.u.value }); e.target.u.value = j.username; toast('Username saved'); });
  $('#pf-name').onsubmit = guard(async (e) => { e.preventDefault(); await api('PATCH', `/api/collections/${state.usersColl}/records/${uid}`, { name: e.target.name.value.trim() }); toast('Name saved'); });
  $('#pf-pass').onsubmit = guard(async (e) => {
    e.preventDefault(); const f = e.target.elements;
    if (f.pw.value !== f.pw2.value) throw new Error('The new passwords do not match.');
    await api('PATCH', `/api/collections/${state.usersColl}/records/${uid}`, { oldPassword: f.old.value, password: f.pw.value, passwordConfirm: f.pw2.value });
    toast('Password changed. Sign in again.'); setTimeout(() => $('#logout') && $('#logout').click(), 800);
  });
  if ($('#pf-dob')) {
    const f = $('#pf-dob');
    f.elements.dob.onchange = () => { const v = f.elements.dob.value; const kid = v && ageFrom(v) < 18; $('#pf-dob-parent').hidden = !kid; f.elements.parent.required = !!kid; };
    f.onsubmit = guard(async (e) => { e.preventDefault(); await acctFetch('/account/dob', { dob: f.elements.dob.value, parentEmails: f.elements.parent.value ? [f.elements.parent.value] : [] }); toast('Saved'); route(); });
  }
  if ($('#pf-parent')) $('#pf-parent').onsubmit = guard(async (e) => { e.preventDefault(); const j = await acctFetch('/account/guardian', { parentEmails: [e.target.email.value] }); toast(j.message); profilePane(uid); });
}

async function viewFamily() {
  main().innerHTML = '<h1>Family</h1><p class="sub">Your household, and relatives linked across every JoolzApp app.</p><div id="pane-family"><p class="muted">Loading…</p></div>';
  await familyPane(selfId() || state.uid);
}

// Everyone has a date of birth. Accounts that pre-date it are asked once, before anything else.
async function needDob() {
  if (state.dobOk || !selfId()) return false;
  const me = await api('GET', `/api/collections/${state.usersColl}/records/${selfId()}`).catch(() => null);
  if (!me || me.dob) { state.dobOk = true; return false; }
  const today = new Date().toISOString().slice(0, 10);
  main().innerHTML = `<h1>One more thing</h1><p class="sub">Every JoolzApp account now has a date of birth. It can only be entered once. Under 18s need a parent or guardian with a JoolzApp account to approve them.</p>
    <div class="card"><form id="dobreq" class="kv"><label>Date of birth<input name="dob" type="date" min="1900-01-01" max="${today}" required></label>
    <label id="dr-parent" hidden>Parent or guardian's JoolzApp email<input name="parent" type="email" autocomplete="off"></label><div><button class="btn primary">Save</button></div></form></div>`;
  const f = $('#dobreq');
  f.elements.dob.onchange = () => { const v = f.elements.dob.value, kid = !!v && ageFrom(v) < 18; $('#dr-parent').hidden = !kid; f.elements.parent.required = kid; };
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    await acctFetch('/account/dob', { dob: f.elements.dob.value, parentEmails: f.elements.parent.value ? [f.elements.parent.value] : [] });
    state.dobOk = true; toast('Saved'); route();
  });
  return true;
}

async function needUsername() {
  if (state.usernameOk || !selfId()) return false;
  const me = await api('GET', `/api/collections/${state.usersColl}/records/${selfId()}`).catch(() => null);
  if (!me || me.username || !('username' in me)) { state.usernameOk = true; return false; }   // no username field yet: nothing to ask
  const guess = String(me.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 30);
  main().innerHTML = `<h1>Choose a username</h1><p class="sub">You can now sign in to JoolzApp with a username as well as your email. Pick one that is easy to remember.</p>
    <div class="card"><form id="unreq" class="kv"><label>Username<input name="u" value="${esc(guess)}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="3" maxlength="30" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,29}" required>
    <span class="muted small">3 to 30 letters, numbers, dots, dashes or underscores.</span></label>
    <div class="row" style="gap:8px"><button class="btn primary">Save username</button><button type="button" class="btn" id="unlater">Later</button></div></form></div>`;
  $('#unlater').onclick = () => { state.usernameOk = true; route(); };
  $('#unreq').onsubmit = guard(async (e) => {
    e.preventDefault(); const j = await acctFetch('/account/username', { username: e.target.u.value });
    state.usernameOk = true; toast('Username saved: ' + j.username); route();
  });
  return true;
}

async function familyPane(uid) {
  const box = $('#pane-family'); if (!box) return;
  let data; try { data = await acctFetch('/family'); } catch (e) { box.innerHTML = `<div class="card"><p class="muted">Families couldn't load: ${esc(e.message)}</p></div>`; return; }
  const f = data.family, inv = data.invites || [], extIn = data.extendedIn || [];
  const taken = f ? new Set([...f.members, ...(f.extended || []), ...f.invited].flatMap((m) => [m.id, (m.email || '').toLowerCase()])) : new Set();
  const people = f ? (await acctFetch('/family/users').catch(() => ({ users: [] }))).users.filter((u) => !taken.has(u.id) && !taken.has(u.email.toLowerCase())) : [];
  const act = async (body) => { try { const j = await acctFetch('/family', body); if (j.notice) toast(j.notice); familyPane(uid); } catch (e) { toast(e.message, true); } };
  const relTxt = (r) => (r ? ' · ' + esc(r) : '');
  let h = inv.map((i) => `<div class="card"><b>${esc(i.ownerName || 'Someone')}</b> ${i.spouse ? 'asked to link you as their <b>spouse</b> in' : 'invited you'} ${i.spouse ? 'the household of' : i.tier === 'extended' ? `as <b>extended family</b>${i.relation ? ' (' + esc(i.relation) + ')' : ''} of` : 'to join the household of'} the <b>${esc(i.name)}</b> family.${i.tier === 'extended' ? '<div class="muted small">You keep your own household. You can be extended family of as many families as you like.</div>' : ''}<div class="row" style="gap:8px;margin-top:8px"><button class="btn primary small" data-fa="yes" data-id="${esc(i.id)}">Join</button><button class="btn small" data-fa="no" data-id="${esc(i.id)}">Decline</button></div></div>`).join('');
  if (!f) h += `<div class="card"><h2>Your household</h2><p class="muted small">A family on JoolzApp is one <b>household</b>: the people who live together and share family expenses. Create yours here, then invite the people who live with you. Relatives who live elsewhere, such as grandparents, are linked as <b>extended family</b> instead.</p>
    <form id="fam-new" class="row" style="gap:6px"><input name="name" placeholder="Family name (e.g. The Joolays)" maxlength="60" required><button class="btn primary">Create</button></form></div>`;
  else {
    const hrow = (m, pending) => `<div class="row spread" style="padding:6px 0;border-top:1px solid var(--line,#0002)"><span class="${pending ? 'muted' : ''}">${esc(m.name)}${relTxt(m.relation)}${m.id === f.owner ? ' <span class="chip">creator</span>' : m.manager ? ' <span class="chip">manager</span>' : ''}${m.id === uid ? ' <span class="muted">(you)</span>' : ''}${pending ? ` · invited${m.tier === 'extended' ? ' as extended family' : ''}` : ''}</span>
      <span>${f.isOwner && m.id !== uid && !pending ? `<button class="btn small" data-fa="mgr" data-id="${esc(m.id)}" data-v="${m.manager ? '' : '1'}">${m.manager ? 'Remove manager' : 'Make manager'}</button> ` : ''}${f.canManage && m.id !== uid && m.id !== f.owner && !pending && !m.manager ? `<button class="btn small" data-fa="tier" data-id="${esc(m.id)}" data-v="extended">Moved out</button> ` : ''}${f.canManage && m.id !== uid && m.id !== f.owner && (f.isOwner || !m.manager) ? `<button class="btn small" data-fa="rm" data-id="${esc(m.id)}">${pending ? 'Cancel' : 'Remove'}</button>` : ''}</span></div>`;
    const erow = (m) => `<div class="row spread" style="padding:6px 0;border-top:1px solid var(--line,#0002)"><span>${esc(m.name)}${relTxt(m.relation)}</span><span>${f.canManage ? `<button class="btn small" data-fa="tier" data-id="${esc(m.id)}" data-v="family">Lives with us now</button> <button class="btn small" data-fa="rm" data-id="${esc(m.id)}">Remove</button>` : ''}</span></div>`;
    const homePend = f.invited.filter((m) => m.tier !== 'extended'), extPend = f.invited.filter((m) => m.tier === 'extended');
    h += `<div class="card"><h2>${esc(f.name)}</h2>
      <h3>Household</h3><p class="muted small">Everyone who lives together. They share family expenses, such as family orders.</p>
      ${f.members.map((m) => hrow(m, false)).join('')}${homePend.map((m) => hrow(m, true)).join('')}
      <h3>Extended family</h3><p class="muted small">Relatives with their own accounts, such as grandparents, aunts and cousins. They are linked to this family but do not share its expenses. One person can be extended family of many families. If someone moves in, choose "Lives with us now".</p>
      ${(f.extended || []).map(erow).join('')}${extPend.map((m) => hrow(m, true)).join('')}${(f.extended || []).length || extPend.length ? '' : '<p class="muted small">Nobody yet.</p>'}
      ${f.canManage ? `<form id="fam-inv" class="kv" style="margin-top:12px"><label>Registered JoolzApp users<select name="pick"><option value="">Choose someone…</option>${people.map((u) => `<option value="${esc(u.email)}">${esc(u.name)} (${esc(u.email)})</option>`).join('')}</select></label><label>Or invite by email (they don't need an account yet)<input name="email" type="email"></label><label>They<select name="tier"><option value="family">Live in my household (share expenses)</option><option value="extended">Are extended family (live elsewhere)</option></select></label><label>Relationship (optional)<input name="relation" maxlength="40" placeholder="wife, grandmother, uncle…"></label><div><button class="btn primary small">Invite</button></div></form>` : ''}
      ${f.isOwner ? '<p class="muted small">Tip: make someone a manager and they can invite, remove and move members too.</p>' : ''}
      ${f.canManage && !data.minor ? `<details style="margin-top:12px"><summary><b>Create an account for your child</b></summary><form id="fam-child" class="kv" style="margin-top:8px"><p class="muted small">For under-18s. You approve them automatically; an admin still has to approve the new account before it can be used.</p>
        <label>Child's name and surname<input name="name" maxlength="80" required pattern=".*\\S\\s+\\S.*" title="Enter a name and surname"></label><label>Child's email (their sign-in)<input name="email" type="email" required autocomplete="off"></label>
        <label>Password (min 8)<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label>
        <label>Date of birth<input name="dob" type="date" min="${new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10)}" max="${new Date().toISOString().slice(0, 10)}" required></label>
        <label>Relationship (optional)<input name="relation" maxlength="40" placeholder="son, daughter…"></label><div><button class="btn primary small">Create account</button></div></form></details>` : ''}
      ${data.minor ? '' : f.spouse ? `<h3>Spouse</h3><div class="row spread"><span>${esc(f.spouse)} <span class="chip">spouse</span></span><button class="btn small" data-fa="unspouse">Unlink</button></div>` : f.invited.some((m) => m.spouseOf === uid) ? '<h3>Spouse</h3><p class="muted small">Your spouse request is waiting for them to accept. Cancel it from the household list above.</p>' : `<h3>Spouse</h3><p class="muted small">Link your spouse so you are connected as spouses. You can have one at a time.</p>
        <details><summary><b>Link an existing account</b></summary><form id="fam-sp-inv" class="kv" style="margin-top:8px"><label>Registered JoolzApp users<select name="pick"><option value="">Choose them…</option>${people.map((u) => `<option value="${esc(u.email)}">${esc(u.name)} (${esc(u.email)})</option>`).join('')}</select></label><label>Or their email<input name="email" type="email"></label><p class="muted small">They get a request and must accept it before you are linked.</p><div><button class="btn primary small">Send spouse request</button></div></form></details>
        <details style="margin-top:6px"><summary><b>Create a new account for your spouse</b></summary><form id="fam-sp-new" class="kv" style="margin-top:8px"><p class="muted small">You are linked straight away. An admin has to approve the new account before it can be used.</p>
        <label>Name and surname<input name="name" maxlength="80" required pattern=".*\\S\\s+\\S.*" title="Enter a name and surname"></label><label>Email (their sign-in)<input name="email" type="email" required autocomplete="off"></label>
        <label>Username<input name="username" minlength="3" maxlength="30" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,29}" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
        <label>Password (min 8)<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label>
        <label>Date of birth<input name="dob" type="date" max="${new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10)}" required></label><div><button class="btn primary small">Create spouse account</button></div></form></details>`}
      <p><button class="btn small" data-fa="leave">Leave this household</button></p></div>`;
  }
  if (extIn.length) h += `<div class="card"><h2>Extended family of</h2><p class="muted small">Families you are linked to as a relative. You can be linked to as many as you like, and you don't share their expenses.</p>${extIn.map((x) => `<div class="row spread" style="padding:6px 0;border-top:1px solid var(--line,#0002)"><span><b>${esc(x.name)}</b>${x.relation ? ' · you are ' + esc(x.relation) : ''}${x.ownerName ? ' <span class="muted small">(' + esc(x.ownerName) + ')</span>' : ''}</span><button class="btn small" data-fa="extleave" data-id="${esc(x.id)}">Leave</button></div>`).join('')}</div>`;
  box.innerHTML = h;
  if ($('#fam-new')) $('#fam-new').onsubmit = (e) => { e.preventDefault(); act({ action: 'create', name: e.target.name.value }); };
  if ($('#fam-inv')) $('#fam-inv').onsubmit = (e) => { e.preventDefault(); const f2 = e.target.elements; const em = (f2.pick.value || f2.email.value).trim(); if (!em) return toast('Choose someone or enter an email.', true); act({ action: 'invite', email: em, tier: f2.tier.value, relation: f2.relation.value }); };
  if ($('#fam-sp-inv')) $('#fam-sp-inv').onsubmit = (e) => { e.preventDefault(); const c = e.target.elements, em = (c.pick.value || c.email.value).trim(); if (!em) return toast('Choose someone or enter an email.', true); act({ action: 'inviteSpouse', email: em }); };
  if ($('#fam-sp-new')) $('#fam-sp-new').onsubmit = (e) => { e.preventDefault(); const c = e.target.elements; act({ action: 'createSpouse', name: c.name.value, email: c.email.value, username: c.username.value, password: c.pw.value, dob: c.dob.value }); };
  if ($('#fam-child')) $('#fam-child').onsubmit = (e) => { e.preventDefault(); const c = e.target.elements; act({ action: 'createChild', name: c.name.value, email: c.email.value, password: c.pw.value, dob: c.dob.value, relation: c.relation.value }); };
  box.onclick = (e) => {
    const b = e.target.closest('button[data-fa]'); if (!b) return; const a = b.dataset.fa, id = b.dataset.id, v = b.dataset.v;
    if (a === 'yes' || a === 'no') return act({ action: 'respond', familyId: id, accept: a === 'yes' });
    if (a === 'unspouse' && confirm('Unlink your spouse? You both stay in the household.')) return act({ action: 'unlinkSpouse' });
    if (a === 'mgr') return act({ action: 'manager', memberId: id, on: !!v });
    if (a === 'tier') return act({ action: 'tier', memberId: id, tier: v });
    if (a === 'rm') return act({ action: 'remove', memberId: id });
    if (a === 'extleave') return act({ action: 'leaveExt', familyId: id });
    if (a === 'leave' && confirm('Leave this household? Orders already filed stay with the family.')) return act({ action: 'leave' });
  };
}

/* ---------- Home screen (iPhone style) ---------- */
// Every JoolzApp app is an icon. Family and My settings are icons too; an admin's tools live in an Admin folder.
// Icons can be rearranged (long-press, or the pencil in the top bar), moved into the dock, or hidden. The layout is saved on the
// person's JoolzApp account (one "pref.home.layout" row), so it follows them to every device and survives updates.
const GRADS = [['#5b8cff', '#7c5cf0'], ['#fb923c', '#ec4899'], ['#10b981', '#0ea5e9'], ['#a855f7', '#6366f1'], ['#f43f5e', '#fb923c'], ['#14b8a6', '#22c55e'], ['#eab308', '#f97316'], ['#0ea5e9', '#6366f1']];
const hashN = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const GL = {
  family: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.4-3.4 2.7-5.2 5.5-5.2s5.1 1.8 5.5 5.2"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.5 14.2c2.4.1 4 1.6 4.3 4.3"/>',
  me: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  overview: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  global: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.2-3.6-8.5s1-6.1 3.6-8.5z"/>',
  paywall: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10.5h17M7 14.5h3.5"/>',
  apps: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 12.5l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"/>',
  users: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.5-4 3.2-6 7-6s6.5 2 7 6"/>',
  requests: '<path d="M4 13l2.5-7.5h11L20 13v5.5H4z"/><path d="M4 13h4.5l1 2.5h5l1-2.5H20"/>',
  cleanup: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/>',
  changes: '<path d="M5 8h10M12 5l3 3-3 3M19 16H9M12 13l-3 3 3 3"/>',
  audit: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  setup: '<path d="M14.5 5a4 4 0 0 0-4.7 5.2L4 16l4 4 5.8-5.8A4 4 0 0 0 19 9.5l-2.6 2.6-2.6-.7-.7-2.6z"/>',
};
const svgG = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${GL[k]}</svg>`;
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
const ICON_PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L18.2 9.3l-3.5-3.5z"/></svg>';
const ICON_ADD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="11" width="13" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg>';
const ADMIN_TOOLS = [
  ['overview', 'Overview', ['#5b8cff', '#7c5cf0']], ['global', 'Global settings', ['#94a3b8', '#475569']], ['apps', 'Apps', ['#a855f7', '#6366f1']],
  ['users', 'Users', ['#10b981', '#0ea5e9']], ['requests', 'Access requests', ['#f43f5e', '#fb923c']], ['cleanup', 'Cleanup', ['#14b8a6', '#22c55e']],
  ['paywall', 'Paid apps', ['#22c55e', '#0ea5e9']], ['audit', 'Audit log', ['#eab308', '#f97316']], ['changes', 'Changes', ['#8b5cf6', '#ec4899']], ['setup', 'Setup', ['#0ea5e9', '#6366f1']],
];
const VIEW_TITLES = { overview: 'Overview', global: 'Global settings', apps: 'Apps', users: 'Users', requests: 'Access requests', cleanup: 'Cleanup', audit: 'Audit log', changes: 'PocketBase changes', setup: 'Setup & integration', me: 'My settings', family: 'Family', paywall: 'Paid apps', paid: 'Payment' };
const PROTECTED = new Set(['sys:me', 'sys:admin']);
const canFolder = (id) => !PROTECTED.has(id) && !String(id).startsWith('folder:');   // folders hold apps and Family, never nest, never hide the way back to Settings/Admin   // can't be hidden, so nobody loses the way back to their settings

let HM = null, editing = false, saveChain = Promise.resolve();
const isAdminRole = () => state.role !== 'user';

let adminRow = null;   // where this person's Portal Admin lives (only an admin has the row; Portal Admin writes it when they use it)
async function homeModel() {
  const uid = selfId() || state.uid, isAdmin = isAdminRole();
  const [apps, reqs, acc, lrows, ssoRows, pend] = await Promise.all([
    listAll('portal_apps', { sort: 'name' }),
    isAdmin ? Promise.resolve([]) : listAll('portal_requests', { filter: `user = ${fq(uid)}`, sort: '-created' }).catch(() => null),
    isAdmin ? Promise.resolve([]) : listAll('portal_settings', { filter: 'key = "portal.access"' }),
    listAll('portal_settings', { filter: `scope = "user" && user = ${fq(uid)} && app = "" && (key = "pref.home.layout" || key = "pref.adminUrl")` }).catch(() => []).then((rs) => { adminRow = rs.find((r) => r.key === 'pref.adminUrl') || null; return rs.filter((r) => r.key === 'pref.home.layout'); }),
    listAll('portal_settings', { filter: 'scope = "app" && key = "app.sso"' }).catch(() => []),
    isAdmin ? count('portal_requests', 'status = "pending"').catch(() => 0) : Promise.resolve(0),
  ]);
  ssoSlugs = new Set(ssoRows.filter((r) => r.value === true).map((r) => r.app));
  const rank = (r) => r.scope === 'global' ? 0 : r.scope === 'app' ? 1 : (r.app ? 3 : 2);
  const allowed = (slug) => {
    if (isAdmin) return true;
    const rs = acc.filter((r) => r.scope === 'global' || (r.scope === 'app' && r.app === slug) || (r.scope === 'user' && (r.app === '' || r.app === slug))).sort((a, b) => rank(a) - rank(b));
    const last = rs[rs.length - 1]; return !(last && last.value === false);
  };
  const items = {};
  apps.forEach((a) => { items['app:' + a.slug] = { id: 'app:' + a.slug, kind: 'app', name: a.name, app: a, grad: GRADS[hashN(a.slug) % GRADS.length], letter: (a.name || '?').trim().charAt(0).toUpperCase(), ok: allowed(a.slug) }; });
  if (isAdmin) items['sys:admin'] = { id: 'sys:admin', kind: 'folder', name: 'Admin', grad: ['#64748b', '#334155'], badge: pend };
  if (!isAdmin || selfId()) {
    items['sys:family'] = { id: 'sys:family', kind: 'sys', name: 'Family', glyph: 'family', grad: ['#fb7185', '#f59e0b'], href: '#/family' };
    items['sys:me'] = { id: 'sys:me', kind: 'sys', name: 'Settings', glyph: 'me', grad: ['#94a3b8', '#475569'], href: '#/me' };
  }
  // On JoolzApp Portal an admin gets a way into Portal Admin (a separate app, reachable on their home network or tailnet only).
  if (!isAdmin && adminRow && /^https?:\/\//i.test(String(adminRow.value || '')) && String(adminRow.value) !== location.origin) items['sys:adminlink'] = { id: 'sys:adminlink', kind: 'sys', name: 'Admin', glyph: 'setup', grad: ['#64748b', '#334155'], href: String(adminRow.value) };
  let pw = null; if (selfId()) { try { pw = await acctFetch('/paywall'); } catch { pw = null; } }
  let saved = lrows[0] && lrows[0].value && typeof lrows[0].value === 'object' ? lrows[0].value : null;
  if (!saved) { try { saved = JSON.parse(store.lget('pa.layout.' + uid) || 'null'); } catch { saved = null; } }
  const fresh = !saved;
  saved = saved || { order: [], dock: isAdmin ? (selfId() ? ['sys:admin', 'sys:family', 'sys:me'] : ['sys:admin']) : ['sys:family', 'sys:me'], hidden: [] };
  const seen = new Set(), keep = (arr, f = () => true) => (Array.isArray(arr) ? arr : []).filter((id) => items[id] && f(id) && !seen.has(id) && seen.add(id));
  // Folders the person made: { id: { name, items: [ids] } }. Their apps are claimed first so they don't also show on the grid.
  const folders = {};
  for (const [fid, f] of Object.entries(saved.folders && typeof saved.folders === 'object' ? saved.folders : {})) {
    if (!/^[a-z0-9]{3,12}$/.test(fid) || !f || typeof f !== 'object') continue;
    folders[fid] = { name: String(f.name || 'Folder').slice(0, 30), items: [] };
    items['folder:' + fid] = { id: 'folder:' + fid, kind: 'ufolder', fid, name: folders[fid].name, grad: ['#64748b', '#334155'] };
  }
  for (const fid of Object.keys(folders)) folders[fid].items = keep((saved.folders[fid] || {}).items, (id) => canFolder(id));
  const dock = keep(saved.dock).slice(0, 4);
  const hidden = keep(saved.hidden, (id) => !PROTECTED.has(id));
  const order = keep(saved.order);
  Object.keys(items).forEach((id) => { if (!seen.has(id)) { order.push(id); seen.add(id); } });   // new apps appear at the end
  return { apps, reqs, items, ssoSlugs, isAdmin, uid, layout: { order, dock, hidden, folders, view: saved.view === 'icons' || saved.view === 'tiles' ? saved.view : '' }, lrow: lrows[0] || null, fresh, pend, pw };
}

function saveLayout() {
  const l = HM.layout, uid = HM.uid;
  store.lset('pa.layout.' + uid, JSON.stringify(l));
  saveChain = saveChain.then(async () => {
    try {
      if (HM.lrow) HM.lrow = await api('PATCH', `/api/collections/portal_settings/records/${HM.lrow.id}`, { value: l });
      else HM.lrow = await api('POST', '/api/collections/portal_settings/records', { scope: 'user', user: uid, app: '', key: 'pref.home.layout', value: l, secret: false });
    } catch (e) { toast('Could not save your layout: ' + e.message, true); }
  });
}

// Apps show the same icon as on the Umbrel dashboard (joolay-<slug>/icon.svg in the store repo). If it can't load, the lettered tile stays.
const ICON_BASE = 'https://raw.githubusercontent.com/joolay/umbrel-apps/main/';
function appIconUrl(a) { return /^https?:\/\//i.test(a.icon || '') ? a.icon : ICON_BASE + 'joolay-' + encodeURIComponent(a.slug) + '/icon.svg'; }
// Second source (Stremio and other apps that use a public dashboard-icons file), then give up and keep the letter.
function iconFail(img) {
  if (img.dataset.tried) { img.remove(); return; }
  img.dataset.tried = '1'; img.src = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/' + encodeURIComponent(img.dataset.slug) + '.svg';
}
window.iconFail = iconFail;
function tileInner(it) {
  if (it.glyph) return svgG(it.glyph);
  const img = it.app ? `<img class="ic-img" src="${esc(appIconUrl(it.app))}" alt="" draggable="false" loading="lazy" data-slug="${esc(it.app.slug)}" onerror="iconFail(this)">` : '';
  return `<b>${esc(it.letter)}</b>${img}`;
}
function ufMini(it) {
  const kids = ((HM && HM.layout.folders[it.fid]) || { items: [] }).items.map((id) => HM.items[id]).filter(Boolean).slice(0, 4);
  return `<span class="mini">${kids.map((k) => `<i style="--c1:${k.grad[0]};--c2:${k.grad[1]}">${tileInner(k)}</i>`).join('')}</span>`;
}
function folderMini() { return `<span class="mini">${ADMIN_TOOLS.slice(0, 4).map(([k, , g]) => `<i style="--c1:${g[0]};--c2:${g[1]}">${svgG(k)}</i>`).join('')}</span>`; }
// Tile view (desktop): a short description and a status line next to the icon. Hidden in the icon view.
function tileText(it) {
  const a = it.app; let d = '', st = '';
  if (it.kind === 'app') {
    d = a.description || '';
    const pcfg = HM && HM.pw && HM.pw.apps[a.slug];
    st = !a.enabled ? 'Off' : a.maintenance ? 'Maintenance' : !it.ok ? (pcfg ? priceText(pcfg) : 'Request access') : 'Open';
  } else if (it.kind === 'ufolder') { const n = ((HM && HM.layout.folders[it.fid]) || { items: [] }).items.length; d = n ? n + (n === 1 ? ' app' : ' apps') : 'Empty folder'; st = 'Open'; }
  else if (it.kind === 'folder') { d = 'Users, apps, requests and settings'; st = it.badge ? it.badge + ' waiting' : 'Open'; }
  else d = it.id === 'sys:family' ? 'Your household and relatives' : it.id === 'sys:adminlink' ? 'Portal Admin (home network or tailnet)' : 'Your preferences and account';
  return `<span class="ic-desc">${esc(d)}</span><span class="ic-state">${esc(st || 'Open')}</span>`;
}
const homeView = () => (HM && HM.layout.view) || (matchMedia('(min-width:900px)').matches ? 'tiles' : 'icons');
function applyView() {
  const sb = $('#sb'), v = homeView();
  if (sb) sb.classList.toggle('tiles', v === 'tiles');
  const b = $('#tb-view'); if (b) { b.dataset.v = v; b.title = v === 'tiles' ? 'Show as icons' : 'Show as tiles'; b.setAttribute('aria-label', b.title); }
}
function iconHTML(it, o = {}) {
  const a = it.app, c = `--c1:${it.grad[0]};--c2:${it.grad[1]};--d:${-(hashN(it.id) % 260)}ms`;
  let tile, st = '';
  if (it.kind === 'folder') tile = `<button class="ic-tile folder" data-folder="1" aria-label="Admin tools">${folderMini()}</button>`;
  else if (it.kind === 'ufolder') tile = `<button class="ic-tile folder" data-ufolder="${esc(it.fid)}" aria-label="Folder ${esc(it.name)}">${ufMini(it)}</button>`;
  else if (it.kind === 'sys') tile = `<a class="ic-tile" href="${esc(it.href)}" draggable="false" aria-label="${esc(it.name)}">${tileInner(it)}</a>`;
  else if (a.enabled && it.ok && !a.maintenance && /^https?:\/\//i.test(a.url || '')) tile = `<a class="ic-tile" href="${esc(a.url)}" data-open="${esc(a.slug)}" target="_blank" rel="noopener" draggable="false" aria-label="Open ${esc(a.name)}">${tileInner(it)}</a>`;
  else tile = `<button class="ic-tile" data-info="${esc(a.slug)}" aria-label="${esc(a.name)}">${tileInner(it)}</button>`;
  if (it.kind === 'app') {
    if (!a.enabled) st = '';
    else if (a.maintenance) st = `<span class="ic-st warn" title="Maintenance">${ICON_WARN}</span>`;
    else if (!it.ok) st = `<span class="ic-st" title="Request access">${ICON_LOCK}</span>`;
  }
  const badge = it.badge ? `<span class="ic-badge">${it.badge > 9 ? '9+' : it.badge}</span>` : '';
  const x = !o.tray && it.kind === 'ufolder' ? `<button class="ic-x" data-delfolder="${esc(it.fid)}" aria-label="Remove folder ${esc(it.name)}">${ICON_X}</button>` : !o.tray && !PROTECTED.has(it.id) ? `<button class="ic-x" data-hide="${esc(it.id)}" aria-label="Hide ${esc(it.name)}">${ICON_X}</button>` : '';
  const ed = !o.tray && isAdminRole() && it.kind === 'app' ? `<button class="ic-ed" data-edit-app="${esc(a.slug)}" aria-label="Edit ${esc(a.name)}">${ICON_PEN}</button>` : '';
  const add = o.tray ? `<button class="ic-add" data-show="${esc(it.id)}" aria-label="Add ${esc(it.name)} back">${ICON_ADD}</button>` : '';
  return `<div class="ic${a && !a.enabled ? ' off' : ''}" data-id="${esc(it.id)}" style="${c}"><div class="ic-w">${tile}${st}${badge}${x}${ed}${add}<span class="ic-label">${esc(it.name)}</span>${tileText(it)}</div></div>`;
}
function renderTray() {
  const l = HM.layout, hid = $('#hid'); if (!hid) return;
  hid.hidden = !editing;
  hid.innerHTML = `<p style="margin:0 0 10px"><button class="btn small" id="new-folder">New folder</button> <span class="muted small">Or hold one icon over another to make a folder.</span></p>` + (l.hidden.length ? `<h2>Hidden</h2><div class="sb">${l.hidden.map((id) => iconHTML(HM.items[id], { tray: true })).join('')}</div>` : '');
}
function renderSb() {
  const sb = $('#sb'); if (!sb) return;
  sb.innerHTML = HM.layout.order.map((id) => iconHTML(HM.items[id])).join('') || '<p class="muted">No apps have been added yet.</p>';
  applyView(); renderTray();
}
function renderDock() {
  const d = $('#dock'); if (!d) return;
  const l = HM && HM.layout; d.innerHTML = l ? l.dock.map((id) => iconHTML(HM.items[id])).join('') : '';
  d.classList.toggle('few', !!l && l.dock.length < 4);
}
function setEditing(on) {
  editing = !!on && !!$('#sb');
  document.body.classList.toggle('editing', editing);
  renderTicker(); $('#tb-edit').hidden = editing || !$('#sb'); $('#tb-done').hidden = !editing; if ($('#tb-view')) $('#tb-view').hidden = editing || !$('#sb');
  if (HM) renderTray();
}

/* Drag to rearrange: pointer events, so it works with a finger and a mouse. Icons move between the grid and the dock (max 4). */
let press = null, drag = null, suppress = false;
const allIcons = () => [...document.querySelectorAll('#sb .ic, #dock .ic')];
function flip(fn) {
  const els = allIcons().filter((e) => e !== (drag && drag.ic)), before = new Map(els.map((e) => [e, e.getBoundingClientRect()]));
  fn();
  els.forEach((e) => { const b = before.get(e), a = e.getBoundingClientRect(), dx = b.left - a.left, dy = b.top - a.top; if (!dx && !dy) return;
    e.style.transition = 'none'; e.style.transform = `translate(${dx}px,${dy}px)`; e.getBoundingClientRect(); e.style.transition = ''; e.style.transform = ''; });
}
function startDrag(e) {
  const ic = press.ic, r = ic.getBoundingClientRect(), clone = ic.cloneNode(true);
  clone.classList.add('drag-clone'); clone.style.width = r.width + 'px'; clone.querySelectorAll('button,a').forEach((x) => x.removeAttribute('href'));
  document.body.appendChild(clone); ic.classList.add('ghost');
  drag = { ic, clone, ox: e.clientX - r.left, oy: e.clientY - r.top }; suppress = true;
}
function moveDrag(e) {
  drag.clone.style.transform = `translate3d(${e.clientX - drag.ox}px,${e.clientY - drag.oy}px,0)`;
  if (e.clientY > innerHeight - 130) scrollBy(0, 12); else if (e.clientY < 110) scrollBy(0, -12);
  const dock = $('#dock'), dr = dock.getBoundingClientRect(), inDock = e.clientX > dr.left - 8 && e.clientX < dr.right + 8 && e.clientY > dr.top - 14 && e.clientY < dr.bottom + 14;
  const inDockNow = drag.ic.parentElement === dock, dockCount = [...dock.children].filter((c) => c !== drag.ic).length;
  if (inDock && dockCount < 4) {
    const sibs = [...dock.children].filter((c) => c !== drag.ic); let ref = null;
    for (const s of sibs) { const r = s.getBoundingClientRect(); if (e.clientX < r.left + r.width / 2) { ref = s; break; } }
    if (drag.ic.parentElement !== dock || drag.ic.nextSibling !== ref) flip(() => dock.insertBefore(drag.ic, ref));
    return;
  }
  if (inDock && !inDockNow) return;
  const sb = $('#sb'); let best = null, bd = 1e9;
  for (const el of sb.querySelectorAll('.ic')) { if (el === drag.ic) continue; const r = el.getBoundingClientRect(), d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)); if (d < bd) { bd = d; best = { el, r }; } }
  // Hold an icon over the middle of another for a moment to make a folder (or drop it into one), like on a phone.
  const cand = best && bd < Math.min(best.r.width, best.r.height) * 0.3 && canFolder(drag.ic.dataset.id) && (best.el.dataset.id.startsWith('folder:') || canFolder(best.el.dataset.id)) ? best.el : null;
  if ((cand && cand.dataset.id) !== drag.cand) {
    clearTimeout(drag.candT); drag.into = null; document.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into')); drag.cand = cand && cand.dataset.id;
    if (cand) drag.candT = setTimeout(() => { drag.into = cand.dataset.id; cand.classList.add('drop-into'); try { navigator.vibrate && navigator.vibrate(8); } catch {} }, 420);
  }
  if (cand) return;
  if (!best) { if (drag.ic.parentElement !== sb) flip(() => sb.appendChild(drag.ic)); return; }
  if (bd > best.r.width * 0.95 && drag.ic.parentElement === sb) return;
  const before = e.clientX < best.r.left + best.r.width / 2, ref = before ? best.el : best.el.nextSibling;
  if (drag.ic.parentElement !== sb || drag.ic.nextSibling !== ref) flip(() => sb.insertBefore(drag.ic, ref));
}
function endDrag() {
  if (drag) {
    drag.clone.remove(); drag.ic.classList.remove('ghost');
    const ids = (sel) => [...document.querySelectorAll(sel)].map((e) => e.dataset.id);
    HM.layout.order = ids('#sb .ic'); HM.layout.dock = ids('#dock .ic').slice(0, 4);
    if (drag.into) mergeInto(drag.ic.dataset.id, drag.into);
    clearTimeout(drag.candT); document.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into'));
    renderSb(); renderDock(); saveLayout();
  }
  if (press) clearTimeout(press.t);
  if (drag || (press && press.long)) { suppress = true; setTimeout(() => { suppress = false; }, 80); }
  press = null; drag = null;
}
document.addEventListener('pointerdown', (e) => {
  if (!$('#sb')) return;
  const ic = e.target.closest('#sb .ic, #dock .ic');
  if (!ic) { if (editing && !e.target.closest('.topbar,dialog,.hid,.ic')) setEditing(false); return; }
  if (e.target.closest('.ic-x,.ic-ed,.ic-add') || e.target.closest('.hid')) return;
  suppress = false; press = { ic, x: e.clientX, y: e.clientY, id: e.pointerId, long: false };
  if (!editing) press.t = setTimeout(() => { if (press && !drag) { press.long = true; try { navigator.vibrate && navigator.vibrate(12); } catch {} setEditing(true); } }, 520);
});
document.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
    if (!editing) { clearTimeout(press.t); press = null; return; }   // it was a scroll, not a long press
    startDrag(e);
  }
  moveDrag(e);
});
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.ic')) e.preventDefault(); });
document.addEventListener('click', (e) => {
  const ic = e.target.closest('.ic'); if (!ic) return;
  if ((editing || suppress) && !e.target.closest('.ic-x,.ic-ed,.ic-add')) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing) setEditing(false); });

/* ---------- Sheets (small dialogs over the home screen) ---------- */
function openSheet(html) {
  const d = $('#sheet');
  d.innerHTML = `<button class="sheet-x" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><div class="sheet-in">${html}</div>`;
  if (!d.open) d.showModal();
  return d;
}
document.addEventListener('change', (e) => {
  const n = e.target.closest && e.target.closest('[data-fname]'); if (!n || !HM) return;
  const f = HM.layout.folders[n.dataset.fname]; if (!f) return;
  f.name = n.value.trim().slice(0, 30) || 'Folder'; n.value = f.name; HM.items['folder:' + n.dataset.fname].name = f.name; renderSb(); renderDock(); saveLayout();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { const d = e.target.closest('dialog'); d && d.close(); return; }
  if (e.target.tagName === 'DIALOG') e.target.close();
});
/* ---------- Your own folders ---------- */
const newFid = () => Math.random().toString(36).slice(2, 8).padEnd(6, 'x');
function spotOf(id) { const l = HM.layout; return l.dock.includes(id) ? { arr: l.dock, i: l.dock.indexOf(id) } : { arr: l.order, i: l.order.indexOf(id) }; }
function takeOut(id) { const l = HM.layout; l.order = l.order.filter((x) => x !== id); l.dock = l.dock.filter((x) => x !== id); Object.values(l.folders).forEach((f) => { f.items = f.items.filter((x) => x !== id); }); }
function registerFolder(fid) { const f = HM.layout.folders[fid]; HM.items['folder:' + fid] = { id: 'folder:' + fid, kind: 'ufolder', fid, name: f.name, grad: ['#64748b', '#334155'] }; }
function mergeInto(dragId, targetId) {   // an icon dropped on another: onto a folder it joins it, onto an app they become a new folder
  const l = HM.layout; if (!canFolder(dragId)) return;
  if (targetId.startsWith('folder:')) { const f = l.folders[targetId.slice(7)]; if (!f || f.items.length >= 12) return; takeOut(dragId); f.items.push(dragId); return; }
  if (!canFolder(targetId) || !HM.items[targetId]) return;
  const fid = newFid(), at = spotOf(targetId);
  l.folders[fid] = { name: 'Folder', items: [targetId, dragId] }; registerFolder(fid);
  const dockHad = l.dock.includes(targetId);
  l.order = l.order.filter((x) => x !== dragId); l.dock = l.dock.filter((x) => x !== dragId);
  const arr = dockHad ? l.dock : l.order, i = arr.indexOf(targetId); arr[i] = 'folder:' + fid;
}
function renderAll() { renderSb(); renderDock(); saveLayout(); }
function removeFolder(fid) {   // its apps go back to the grid
  const l = HM.layout, f = l.folders[fid]; if (!f) return;
  const id = 'folder:' + fid, at = spotOf(id), kids = f.items.slice();
  delete l.folders[fid]; delete HM.items[id];
  at.arr.splice(at.i, 1, ...(at.arr === l.dock ? kids.slice(0, 4 - (l.dock.length - 1)) : kids)); 
  kids.forEach((k) => { if (!l.dock.includes(k) && !l.order.includes(k)) l.order.push(k); });
}
function ufolderSheet(fid) {
  const f = HM.layout.folders[fid]; if (!f) return;
  const kids = f.items.map((id) => HM.items[id]).filter(Boolean).map((it) => iconHTML(it, { tray: true, plain: true }).replace(/<button class="ic-add"[^>]*>.*?<\/button>/, '').replace(/<\/div><\/div>$/, `<button class="ic-out" data-out="${esc(it.id)}">Move out</button></div></div>`));
  const d = openSheet(`<input class="folder-name" data-fname="${esc(fid)}" value="${esc(f.name)}" maxlength="30" aria-label="Folder name"><div class="folder-grid">${kids.join('') || '<p class="muted">Empty. Drag an icon onto this folder while rearranging.</p>'}</div><p style="margin-top:14px"><button class="btn small danger" data-delfolder="${esc(fid)}">Remove folder</button></p>`);
  d.dataset.fid = fid;
  d.querySelectorAll('a.ic-tile').forEach((a) => a.addEventListener('click', () => d.close()));
}
function folderSheet() {
  const tools = ADMIN_TOOLS.map(([k, name, g]) => iconHTML({ id: 'tool:' + k, kind: 'sys', name, glyph: k, grad: g, href: '#/' + k, badge: k === 'requests' ? HM.pend : 0 }, { tray: true, plain: true }).replace(/<button class="ic-add"[^>]*>.*?<\/button>/, ''));
  openSheet(`<h2 style="margin:0 0 4px">Admin</h2><div class="folder-grid">${tools.join('')}</div>`);
  $('#sheet').querySelectorAll('a').forEach((a) => a.addEventListener('click', () => $('#sheet').close()));
}
const rand = (c) => 'R' + (c / 100).toFixed(c % 100 ? 2 : 0);
const priceText = (c) => rand(c.price) + (c.mode === 'once' ? ' once' : ' for ' + c.days + ' days');
function payBody(slug, renew) {
  const c = HM.pw.apps[slug];
  return `<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn primary" data-pay="${esc(slug)}" data-scope="person">${renew ? 'Renew' : 'Pay'} ${esc(priceText(c))}</button>${c.householdPrice && HM.pw.household ? `<button class="btn" data-pay="${esc(slug)}" data-scope="household">Whole household: ${esc(rand(c.householdPrice))}${c.mode === 'once' ? '' : ' / ' + c.days + ' days'}</button>` : ''}</div>`
    + (c.householdPrice && !HM.pw.household ? '<p class="muted small">Create a household under Family to pay once for everyone who lives with you.</p>' : '') + '<p class="muted small">Secure card payment by Yoco.</p>';
}
function infoSheet(slug, startEdit) {
  const it = HM.items['app:' + slug]; if (!it) return;
  const a = it.app, isAdmin = HM.isAdmin, reqs = HM.reqs;
  const pend = reqs && reqs.find((r) => r.app === a.slug && r.status === 'pending'), denied = reqs && reqs.find((r) => r.app === a.slug && r.status === 'denied');
  let body;
  if (!a.enabled) body = '<span class="chip bad">unavailable</span>';
  else if (a.maintenance) body = `<span class="chip warn">maintenance</span><p class="muted small">${esc(a.message || 'Back soon.')}</p>`;
  else if (it.ok) body = /^https?:\/\//i.test(a.url || '') ? `<a class="btn primary" href="${esc(a.url)}" data-open="${esc(a.slug)}" target="_blank" rel="noopener">Open ${esc(a.name)}</a>` : '<span class="muted small">No address set yet</span>';
  else body = HM.reqs === null ? '<span class="muted small">Ask the admin for access</span>' : pend ? '<span class="chip warn">request pending</span>'
    : `<div class="req-row"><input data-msg="${esc(a.slug)}" placeholder="Why do you need it? (optional)" maxlength="300"><button class="btn small primary" data-req="${esc(a.slug)}">Request access</button></div>${denied ? '<div class="muted small" style="margin-top:6px">Your last request was denied.</div>' : ''}`;
  const pcfg = HM.pw && HM.pw.ready && HM.pw.apps[a.slug];
  if (!it.ok && a.enabled && !a.maintenance && pcfg) body = `<p>This app is a paid app: <b>${esc(priceText(pcfg))}</b>.</p>` + payBody(a.slug) + `<p class="muted small" style="margin-top:10px">Or ask the admin to unlock it for you.</p>` + body;
  const mine = HM.pw && HM.pw.mine[a.slug];
  if (it.ok && pcfg && mine && mine.until) body += `<p class="muted small" style="margin-top:10px">Your access runs until ${esc(fmtDay(mine.until))}.</p>` + payBody(a.slug, true);
  const desc = isAdmin
    ? `<div data-desc><textarea rows="3" maxlength="300" placeholder="What is this app for?" aria-label="Description for ${esc(a.name)}">${esc(a.description || '')}</textarea><div class="row" style="gap:6px;margin-top:6px"><button class="btn small" data-dsave="${esc(a.slug)}">Save description</button></div></div>`
    : `<p class="muted">${esc(a.description || '')}</p>`;
  const d = openSheet(`<div class="sheet-head"><span class="ic-tile" style="--c1:${it.grad[0]};--c2:${it.grad[1]}">${tileInner(it)}</span><h2>${esc(a.name)}</h2></div>${desc}<div style="margin-top:12px">${body}</div>`);
  if (startEdit) { const t = d.querySelector('textarea'); t && t.focus(); }
}
document.addEventListener('click', guard(async (e) => {
  const uf = e.target.closest('[data-ufolder]'); if (uf && !editing) return ufolderSheet(uf.dataset.ufolder);
  const df = e.target.closest('[data-delfolder]');
  if (df && HM) { const fid = df.dataset.delfolder; if (!HM.layout.folders[fid]) return; if ((HM.layout.folders[fid].items.length) && !confirm('Remove this folder? Its apps go back to your home screen.')) return; removeFolder(fid); if ($('#sheet').open) $('#sheet').close(); renderAll(); return; }
  const outb = e.target.closest('[data-out]');
  if (outb && HM) { const id = outb.dataset.out, fid = ($('#sheet').dataset.fid || ''), l = HM.layout, f = l.folders[fid]; if (!f) return;
    f.items = f.items.filter((x) => x !== id); if (!l.order.includes(id)) l.order.push(id);
    if (!f.items.length) { removeFolder(fid); $('#sheet').close(); } else ufolderSheet(fid);
    renderAll(); return; }
  const nf = e.target.closest('#new-folder');
  if (nf && HM) { const fid = newFid(); HM.layout.folders[fid] = { name: 'Folder', items: [] }; registerFolder(fid); HM.layout.order.push('folder:' + fid); renderAll(); return; }
  const di = e.target.closest('[data-info]'); if (di && !editing) return infoSheet(di.dataset.info);
  if (e.target.closest('[data-folder]') && !editing) return folderSheet();
  const ea = e.target.closest('[data-edit-app]'); if (ea) return infoSheet(ea.dataset.editApp, true);
  const hide = e.target.closest('[data-hide]');
  if (hide && HM) { const id = hide.dataset.hide, l = HM.layout; l.order = l.order.filter((x) => x !== id); l.dock = l.dock.filter((x) => x !== id); if (!l.hidden.includes(id)) l.hidden.push(id); renderSb(); renderDock(); saveLayout(); return; }
  const show = e.target.closest('[data-show]');
  if (show && HM) { const id = show.dataset.show, l = HM.layout; l.hidden = l.hidden.filter((x) => x !== id); l.order.push(id); renderSb(); saveLayout(); return; }
  const pay = e.target.closest('[data-pay]');
  if (pay) { pay.disabled = true; try { const j = await acctFetch('/pay', { slug: pay.dataset.pay, scope: pay.dataset.scope }); location.href = j.redirectUrl; } catch (err) { pay.disabled = false; throw err; } return; }
  const ds = e.target.closest('[data-dsave]');
  if (ds) {
    const app = HM.apps.find((x) => x.slug === ds.dataset.dsave); if (!app) return;
    const val = ds.closest('[data-desc]').querySelector('textarea').value.trim().slice(0, 300);
    await api('PATCH', `/api/collections/portal_apps/records/${app.id}`, { description: val });
    await audit('app.update', app.slug, { description: val }); app.description = val; toast('Description saved'); return;
  }
  const rb = e.target.closest('button[data-req]');
  if (rb) {
    e.preventDefault(); const slug = rb.dataset.req, msg = $('#sheet').querySelector(`input[data-msg="${slug}"]`).value.trim();
    await api('POST', '/api/collections/portal_requests/records', { user: state.uid, email: state.actor, app: slug, message: msg, status: 'pending' });
    $('#sheet').close(); toast('Request sent'); route();
  }
}));
$('#tb-edit').onclick = () => setEditing(true);
$('#tb-view').onclick = () => { if (!HM) return; HM.layout.view = homeView() === 'tiles' ? 'icons' : 'tiles'; applyView(); saveLayout(); };
// Clicking anywhere on a tile card opens it (the whole card, not just the icon).
document.addEventListener('click', (e) => {
  const w = e.target.closest('.sb.tiles .ic-w'); if (!w || editing || suppress || e.target.closest('a,button')) return;
  const t = w.querySelector('.ic-tile'); if (t) t.click();
});
$('#tb-done').onclick = () => setEditing(false);
// Dock icons grow as the mouse nears them (mouse only; neighbours slide aside so nothing overlaps).
(() => {
  const d = $('#dock'); if (!d || !matchMedia('(hover:hover)').matches) return;
  const reset = () => d.querySelectorAll('.ic-w').forEach((w) => { w.style.transform = ''; });
  d.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || editing || drag) return reset();
    const ics = [...d.querySelectorAll('.ic')]; if (!ics.length) return;
    const REACH = 120, MAX = 0.75, ex = ics.map((ic) => { const r = ic.getBoundingClientRect(), t = Math.max(0, 1 - Math.abs(e.clientX - (r.left + r.width / 2)) / REACH), s = 1 + MAX * t * t * (3 - 2 * t); return { s, extra: r.width * (s - 1) }; });
    const total = ex.reduce((a, x) => a + x.extra, 0); let before = 0;
    ics.forEach((ic, i) => { const w = ic.querySelector('.ic-w'); if (!w) return; w.style.transform = `translateX(${(-total / 2 + before + ex[i].extra / 2).toFixed(1)}px) scale(${ex[i].s.toFixed(3)})`; before += ex[i].extra; });
  });
  d.addEventListener('pointerleave', reset);
})();
$('#tb-me').onclick = () => { $('#acct').showModal(); };
$('#tb-back').onclick = () => { location.hash = '#/home'; };

function setBar(view) {
  const home = view === 'home', sh = $('#shell');
  sh.classList.toggle('home-page', home); sh.classList.toggle('sub-page', !home);
  $('#tb-back').hidden = home; $('#tb-brand').hidden = !home; $('#tb-title').hidden = home;
  $('#tb-title').textContent = VIEW_TITLES[view] || '';
  $('#tb-me').textContent = (state.actor || '?').trim().charAt(0).toUpperCase();
  if (!home) { setEditing(false); $('#tb-edit').hidden = true; $('#tb-done').hidden = true; $('#tb-view').hidden = true; } else { $('#tb-edit').hidden = editing; }
  $('#tb-view').hidden = !home || editing; renderTicker();
}

// The landing page: apps as icons. Open goes to the app (signed in already where the app supports it);
// apps the person isn't approved for open a small request form instead.
async function viewHome() {
  const uid = selfId() || state.uid, isAdmin = isAdminRole(), hasSelf = !!selfId();
  HM = await homeModel();
  const g = !hasSelf ? null : await fetch('/guardians', { headers: { authorization: state.token }, cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fam = !hasSelf ? null : await acctFetch('/family').catch(() => null);
  if (fam && fam.invites && fam.invites.length && HM.items['sys:family']) HM.items['sys:family'].badge = fam.invites.length;
  const acc = !isAdmin ? await listAll('portal_settings', { filter: 'key = "portal.access"' }).catch(() => []) : [];
  const userRow = acc.find((r) => r.scope === 'user' && r.app === ''), globalBlock = acc.find((r) => r.scope === 'global' && r.value === false);
  const banner = isAdmin ? '' : userRow && userRow.value === false ? 'Your account access has been turned off. Contact the admin.' : (globalBlock && !userRow ? 'The admin approves access to each app separately. Tap an app with a lock to request access.' : '');
  const famInv = fam && fam.invites && fam.invites.length ? `<div class="card"><b>You've been invited to a family.</b> <a href="#/family">Open Family</a> to join or decline.</div>` : '';
  const guardCard = (!g ? '' : [
    g.adminPending ? `<div class="card"><b>Your account is waiting for an admin to approve it.</b> Once they do, you can use the apps.</div>` : '',
    g.minor && g.parents.length && !g.adminPending ? `<div class="card"><b>Your account needs a parent's approval.</b> ${g.parents.map((p) => `${esc(p.name)}: ${p.status === 'approved' ? 'approved' : p.status === 'pending' ? 'waiting' : 'declined'}`).join(' · ')}</div>` : '',
    g.pending.length ? `<div class="card"><h2>Needs your approval</h2>${g.pending.map((x) => `<div class="row spread" style="padding:6px 0"><span>${esc(x.label)}</span><span><button class="btn primary small" data-gact="yes" data-id="${esc(x.id)}">Approve</button> <button class="btn small" data-gact="no" data-id="${esc(x.id)}">Decline</button></span></div>`).join('')}</div>` : '',
    g.kids.length ? `<div class="card"><h2>Kids you look after</h2>${g.kids.map((k) => `<div class="row spread" style="padding:6px 0"><span>${esc(k.childName)}</span><button class="btn small" data-gact="revoke" data-id="${esc(k.childId)}">Withdraw approval</button></div>`).join('')}</div>` : '',
  ].join('')) + famInv;
  main().innerHTML = `<div class="widgets">${banner ? `<div class="card"><span class="chip warn">${esc(banner)}</span></div>` : ''}${guardCard}</div><section id="sb" class="sb" aria-label="Apps"></section><section id="hid" class="hid" hidden></section>`;
  renderSb(); renderDock(); setBar('home'); setEditing(editing);
  main().onclick = guard(async (e) => {
    const gb = e.target.closest('button[data-gact]'); if (!gb) return;
    e.preventDefault();
    if (gb.dataset.gact === 'revoke' && !confirm('Withdraw your approval? They will be locked out of JoolzApp apps until a parent approves again.')) return;
    const body = gb.dataset.gact === 'revoke' ? { action: 'revoke', childId: gb.dataset.id } : { action: 'decide', id: gb.dataset.id, approve: gb.dataset.gact === 'yes' };
    const r = await fetch('/guardians', { method: 'POST', headers: { authorization: state.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'That did not work.');
    toast('Done'); return route();
  });
}

let chgNotes = { id: '', notes: [] };
async function viewChanges() {
  let r;
  try { r = await Promise.race([acctFetch('/admin/changes'), new Promise((_, rej) => setTimeout(() => rej(new Error('Portal Admin did not answer in time.')), 60000))]); }
  catch (e) { main().innerHTML = `<h1>PocketBase changes</h1><div class="card"><p class="error">${esc(e.message)}</p><button class="btn primary" id="chg-retry">Try again</button></div>`; $('#chg-retry').onclick = () => route(); return; }
  const chip = (c) => c.status === 'done' ? '<span class="chip ok">up to date</span>' : c.status === 'error' ? '<span class="chip bad">problem</span>' : `<span class="chip warn">${c.plan.length} to do</span>`;
  main().innerHTML = `<h1>PocketBase changes</h1><p class="sub">Changes that ship with Portal Admin. Each one shows exactly what it will do to PocketBase. Nothing happens until you press Apply, and applying twice is harmless.</p>
    ${r.changes.map((c) => `<div class="card" data-id="${esc(c.id)}"><div class="row spread"><h2>${esc(c.title)}</h2>${chip(c)}</div><p class="muted small">${esc(c.summary)}</p>
      ${c.error ? `<p class="error">${esc(c.error)}</p>` : c.plan.length ? `<ul>${c.plan.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><button class="btn primary" data-apply>Apply ${c.plan.length} change${c.plan.length === 1 ? '' : 's'}</button>` : '<p class="muted small">Nothing to do.</p>'}
      <div class="chg-out">${chgNotes.id === c.id ? chgNotes.notes.map((n) => `<p class="muted small">${esc(n)}</p>`).join('') : ''}</div></div>`).join('') || '<p class="muted">No changes are waiting.</p>'}
    ${r.history.length ? `<div class="card"><h2>Recent</h2><table><tbody>${r.history.map((h) => `<tr><td class="small">${esc(fmtDay(h.at))}</td><td><code>${esc(h.id)}</code></td><td>${h.ok ? '<span class="chip ok">done</span>' : '<span class="chip warn">partly</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  main().onclick = guard(async (e) => {
    const b = e.target.closest('[data-apply]'); if (!b) return; const card = b.closest('.card'); b.disabled = true; b.textContent = 'Applying…';
    const j = await acctFetch('/admin/changes/apply', { id: card.dataset.id });
    await audit('pocketbase.change', card.dataset.id, { did: j.did, left: j.left });
    toast(j.ok ? 'Applied' : 'Applied, but some items are still pending', !j.ok);
    chgNotes = { id: card.dataset.id, notes: j.notes || [] }; await viewChanges();
  });
}

async function viewAudit() {
  if (await needSetup()) return;
  const r = await api('GET', '/api/collections/portal_audit/records?perPage=200&sort=-created');
  main().innerHTML = `<h1>Audit log</h1><p class="sub">Every change made through this panel.</p><div class="card"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${r.items.map((a) => `<tr><td class="small muted" style="white-space:nowrap">${esc(fmtDate(a.created))}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.target)}</td><td class="small"><code>${esc(JSON.stringify(a.detail))}</code></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No activity yet.</td></tr>'}</tbody></table></div>`;
}

async function viewSetup() {
  const st = await schemaStatus(); const cfg = await (await fetch('/config')).json();
  const uColl = await api('GET', `/api/collections/${state.usersColl}`).catch(() => null);
  // Harden: an open create rule with no guard would let anyone register themselves as an admin straight through PocketBase's API.
  if (uColl && uColl.createRule !== null && uColl.createRule !== SIGNUP_RULE) { try { await api('PATCH', `/api/collections/${state.usersColl}`, { createRule: SIGNUP_RULE }); uColl.createRule = SIGNUP_RULE; } catch {} }
  main().innerHTML = `<h1>Setup &amp; integration</h1><p class="sub">Connection details and how your apps consume these settings.</p>
    <div class="card"><h2>Connection</h2><p>PocketBase: <code>${esc(cfg.pbUrl)}</code> <span class="chip">${cfg.custom ? 'set by PB_URL' : 'built in: your Umbrel PocketBase'}</span></p>
      <label>Users collection<input id="uc" value="${esc(state.usersColl)}" style="max-width:260px"></label><button id="su" class="btn">Save</button></div>
    <div class="card"><h2>Sign-ups</h2><label class="inline"><input type="checkbox" id="su-open" disabled> Allow new users to create an account from the sign-in page</label>
      <p class="muted small">Changes who can create records in the <code>${esc(state.usersColl)}</code> collection, so it applies to every Joolzapp app that uses these accounts.</p></div>
    <div class="card"><h2>Account approval</h2><label class="inline"><input type="checkbox" id="ap-req" disabled> Require admin approval per app for new accounts</label>
      <p class="muted small">Turning this on sets <code>portal.access = false</code> globally, so every app is closed by default. Existing users keep access to all apps. New sign-ups request each app separately and you approve them one app at a time under Access requests. Apps must honour <code>portal.access</code>.</p></div>
    <div class="card"><h2>Collections</h2><ul>${st.map((s) => `<li><code>${s.name}</code> ${s.ok ? '<span class="chip ok">ready</span>' : '<span class="chip bad">missing</span>'}</li>`).join('')}</ul>
      <button id="mk" class="btn primary">${st.every((s) => s.ok) ? 'Re-check' : 'Create missing collections'}</button></div>
    <div class="card"><h2>Using the settings from your apps</h2>
      <p class="muted">Signed-in app users can read non-secret settings directly from PocketBase. Resolve with precedence <b>global → app → user (all apps) → user × app</b>:</p>
<pre>${esc(`// slug = this app's id, pb = PocketBase client already signed in as the user
async function portalConfig(pb, slug) {
  const uid = pb.authStore.record.id;
  const rows = await pb.collection('portal_settings').getFullList({
    filter: pb.filter('scope = "global" || (scope = "app" && app = {:s}) || (scope = "user" && (app = "" || app = {:s}))', { s: slug }),
  });
  const rank = r => r.scope === 'global' ? 0 : r.scope === 'app' ? 1 : (r.app ? 3 : 2);
  const cfg = {};
  rows.sort((a, b) => rank(a) - rank(b)).forEach(r => { cfg[r.key] = r.value; });
  const app = await pb.collection('portal_apps').getFirstListItem(pb.filter('slug = {:s}', { s: slug }));
  return { cfg, app, allowed: app.enabled && !app.maintenance && cfg['portal.access'] !== false };
}`)}</pre>
      <p class="muted small">The collection rules already restrict users to their own per-user rows, and hide settings flagged <i>secret</i>. Reserved keys: ${RESERVED.map((r) => `<code>${r[0]}</code> (${esc(r[2])})`).join('; ')}.</p></div>`;
  $('#su').onclick = () => { state.usersColl = $('#uc').value.trim() || 'users'; store.lset('pa.usersColl', state.usersColl); toast('Saved'); };
  $('#mk').onclick = guard(async () => { await ensureSchema(); toast('Collections ready'); viewSetup(); });
  const apr = $('#ap-req');
  approvalState().then((st) => {
    apr.disabled = false; apr.checked = st.required;
    apr.onchange = guard(async () => {
      try {
        if (apr.checked) {
          if (!confirm('Require per-app approval for new accounts? Existing users keep access to all apps.')) { apr.checked = false; return; }
          for (const u of await awaitingApproval()) await setAccess(u.id, '', true);
          await api('POST', '/api/collections/portal_settings/records', { scope: 'global', app: '', user: '', key: 'portal.access', value: false, note: 'Require admin approval for new accounts' });
        } else {
          const cur = await approvalState(); if (cur.row) await api('DELETE', `/api/collections/portal_settings/records/${cur.row.id}`);
        }
      } catch (e) { apr.checked = !apr.checked; throw e; }
      await audit(apr.checked ? 'approval.require' : 'approval.off', 'global'); toast(apr.checked ? 'New accounts need approval per app' : 'New accounts no longer need approval');
    });
  }).catch(() => {});
  const so = $('#su-open');
  if (uColl) {
    so.disabled = false; so.checked = uColl.createRule !== null;
    so.onchange = guard(async () => {
      try { await api('PATCH', `/api/collections/${state.usersColl}`, { createRule: so.checked ? SIGNUP_RULE : null }); }
      catch (e) { so.checked = !so.checked; throw e; }
      await audit(so.checked ? 'signups.open' : 'signups.close', state.usersColl); toast(so.checked ? 'Sign-ups open' : 'Sign-ups closed');
    });
  }
}

boot();
