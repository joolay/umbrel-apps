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
const state = { token: sess('token'), actor: sess('actor'), role: sess('role') || 'admin', uid: sess('uid'), usersColl: store.lget('pa.usersColl', 'users') };
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RESERVED = [
  ['portal.access', 'boolean', 'false blocks a user (all apps, or one app) from using the app'],
  ['portal.url', 'string', 'Address of this dashboard, used by the "Back to Dashboard" button in apps (blank = same address with port 3892)'],
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
    const r = await fetch('/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, name: $('#signup-name').value.trim(), dob: $('#signup-dob').value, parentEmails: kidMode() ? [$('#signup-parent').value] : [] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Could not create that account.');
    Object.assign(state, await signIn(email, password));
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
const ADMIN_NAV = $('#nav').innerHTML;
// People who sign in here are users of the JoolzApp apps, not admins, so the page is branded JoolzApp for them
// and on the public address (the server tells us which one we are on through /config).
function setBrand(name) { document.querySelectorAll('.brand span').forEach((n) => { n.textContent = name; }); document.title = name; }
fetch('/config').then((r) => r.json()).then((c) => { state.public = !!c.public; if (state.public) setBrand('JoolzApp'); }).catch(() => {});
function showShell() {
  $('#nav').innerHTML = state.role === 'user' ? '<a href="#/home" data-route="home">Dashboard</a><a href="#/family" data-route="family">Family</a><a href="#/me" data-route="me">My settings</a>' : ADMIN_NAV;
  setBrand(state.role === 'user' || state.public ? 'JoolzApp' : 'Portal Admin');
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#who').textContent = state.actor; route(); startDetecting();
}
const SESSION_KEYS = ['token', 'actor', 'role', 'uid'];
function saveSession(remember) { SESSION_KEYS.forEach((k) => { store.set('pa.' + k, state[k]); store.lset('pa.' + k, remember ? state[k] : null); }); }
function logout() { SESSION_KEYS.forEach((k) => { state[k] = ''; store.set('pa.' + k, null); store.lset('pa.' + k, null); }); state.role = 'admin'; showLogin(); }
async function signIn(identity, password) {
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
$('#logout').onclick = logout;
$('#login-form').onsubmit = async (e) => {
  e.preventDefault(); $('#login-err').textContent = '';
  try {
    const email = $('#login-email').value.trim();
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
  const email = $('#login-email').value.trim();
  if (!email) { $('#login-err').textContent = 'Enter your email above first.'; $('#login-email').focus(); return; }
  try {
    await api('POST', '/api/collections/_superusers/request-password-reset', { email });
    await api('POST', `/api/collections/${state.usersColl}/request-password-reset`, { email }).catch(() => {});
    $('#login-ok').textContent = 'If that account exists, a password reset email has been sent.';
  } catch (err) { $('#login-err').textContent = err.message; }
};

/* ---------- Router ---------- */
window.addEventListener('hashchange', () => { if (resetToken()) return showReset(); state.token && route(); });
function route() {
  let [, view = 'overview', arg] = location.hash.split('/');
  if (state.role === 'user') view = (view === 'me' || view === 'family') ? view : 'home';
  const v = { home: viewHome, overview: viewOverview, global: viewGlobal, apps: viewApps, users: viewUsers, requests: viewRequests, cleanup: viewCleanup, audit: viewAudit, setup: viewSetup, me: viewMe, family: viewFamily }[view] || viewOverview;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
  main().innerHTML = '<p class="muted">Loading…</p>';
  guard(async (a) => { if (await needDob()) return; await v(a); })(arg ? decodeURIComponent(arg) : undefined);
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
async function detectApps() {
  if (state.role === 'user' || !state.token) return null;
  try {
    const r = await fetch('/umbrel-apps', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.available) return { available: false, added: [], pending: [] };
    const have = new Set((await listAll('portal_apps')).map((a) => a.slug));
    const added = [], pending = [];
    for (const a of d.apps) {
      if (a.slug) {
        if (have.has(a.slug)) continue;
        try {
          await api('POST', '/api/collections/portal_apps/records', { slug: a.slug, name: a.pbName || a.name, description: a.tagline || '', enabled: true });
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

let detectTimer;
function startDetecting() {
  clearInterval(detectTimer);
  if (state.role === 'user') return;
  detectApps().then((r) => { if (r && (r.added.length || r.schemaApplied.length) && location.hash.startsWith('#/apps')) route(); });
  detectTimer = setInterval(() => {
    if (!state.token || state.role === 'user' || document.hidden) return;
    detectApps().then((r) => { if (r && (r.added.length || r.schemaApplied.length) && location.hash.startsWith('#/apps')) route(); });
  }, 5 * 60 * 1000);
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
  const needConnect = found && found.available ? found.apps.filter((a) => /^joolay-/.test(a.id) && a.slug && a.env !== 'present') : [];
  if (needConnect.length) {
    main().insertAdjacentHTML('beforeend', `<div class="card"><h2>Connect to PocketBase</h2><p class="muted small">These apps of yours have no PocketBase login yet, so they can't sign people in. Enter your PocketBase superuser login once; it is checked, then saved in the app's own data folder.</p>
      ${needConnect.map((a) => `<form class="row" data-connect="${esc(a.id)}" style="gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center"><b style="min-width:110px">${esc(a.name)}</b>
        <input name="email" type="email" required value="${esc(state.actor || '')}" placeholder="Superuser email" autocomplete="username" style="flex:1;min-width:160px">
        <input name="password" type="password" required placeholder="Password" autocomplete="current-password" style="flex:1;min-width:120px">
        <button class="btn primary" ${a.env === 'no-data-dir' ? 'disabled title="Open the app once first"' : ''}>Connect</button></form>`).join('')}</div>`);
    main().querySelectorAll('form[data-connect]').forEach((f) => f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const a = needConnect.find((x) => x.id === f.dataset.connect), btn = f.querySelector('button'); btn.disabled = true;
      try {
        const r = await fetch('/connect-app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id, email: f.email.value.trim(), password: f.password.value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || 'Could not connect');
        await audit('app.connect', a.id, { email: f.email.value.trim() });
        toast(a.name + ' connected. Restart the app once so it picks this up.'); route();
      } finally { btn.disabled = false; f.password.value = ''; }
    }));
  }
  if (found && !found.available) main().insertAdjacentHTML('beforeend', '<p class="muted small">Portal Admin can\'t see which apps are installed on this Umbrel (the app list isn\'t mounted), so new apps aren\'t detected automatically.</p>');
  main().onclick = guard(async (e) => {
    const ap = e.target.closest('[data-apply]');
    if (ap) { const pl = schemaPending[+ap.dataset.apply]; if (!pl) return; await applyPlan(pl); toast('PocketBase updated for ' + pl.app.name); return route(); }
    const add = e.target.closest('[data-add]'), hide = e.target.closest('[data-hide]');
    if (add || hide) {
      const a = found.pending.find((x) => x.id === (add || hide).dataset[add ? 'add' : 'hide']); if (!a) return;
      if (hide) { localStorage.setItem('pa.hiddenApps', JSON.stringify([...hiddenApps(), a.id])); return route(); }
      const body = { slug: slugOf(a.id), name: a.name, description: a.tagline || '', enabled: true };
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
      <label>Email<input name="email" type="email" required></label><label>Name<input name="name"></label>
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
    const targets = [{ slug: '', name: 'All apps' }, ...apps];
    $('#tab').innerHTML = `<div class="card"><p class="muted small">Untick to block this user. Apps check the <code>portal.access</code> setting (see Setup &amp; integration).</p>
      <table><tbody>${targets.map((t) => `<tr><td><b>${esc(t.name)}</b>${t.slug ? `<div class="muted small">${esc(t.slug)}</div>` : ''}</td>
        <td>${t.slug && !t.enabled ? '<span class="chip bad">app disabled</span>' : ''}${t.slug && all && !all.inherited ? ' <span class="chip">blocked by "All apps"</span>' : ''}${ap.required && !recs.find((r) => r.app === t.slug) ? ' <span class="chip">approval required</span>' : ''}</td>
        <td style="width:90px"><label class="inline" style="margin:0"><input type="checkbox" data-slug="${esc(t.slug)}"${blockedFor(t.slug) ? '' : ' checked'}> allowed</label></td></tr>`).join('')}</tbody></table></div>`;
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
    reqs.filter((r) => (usersKnown && !userIds.has(r.user)) || (r.app !== DEL_REQ && !slugs.has(r.app))).map((r) => rec('portal_requests', r, (r.email || r.user) + ' → ' + (r.app === DEL_REQ ? 'account deletion' : r.app), r.status || '')));
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
  else {
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
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn danger" data-do="delete">Delete selected</button> <button class="btn" data-do="keep">Keep (hide)</button></div></div>`).join('') || '<div class="card"><p class="muted">Nothing to clean up. 🎉</p></div>'}`;
  main().onclick = guard(async (e) => {
    const b = e.target.closest('[data-do]'); if (!b) return;
    const card = b.closest('[data-g]'), g = groups.find((x) => x.id === card.dataset.g);
    const keys = [...card.querySelectorAll('input[data-k]:checked')].map((i) => i.dataset.k);
    if (!keys.length) return toast('Tick at least one item first', true);
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
  const appName = (slug) => slug === DEL_REQ ? 'Account deletion' : (apps.find((a) => a.slug === slug) || {}).name || slug;
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

/* ---------- My settings (regular JoolzApp users) ---------- */
// Open sign-ups, but never let a new account set its own isAdmin flag (ShutterWorth and others use that field).
// Sign-up is "open" when this rule exists. It can never be met from a browser: accounts are created only by this app's server (POST /signup),
// which checks date of birth and parent approval, so there is a single sign-up path for every JoolzApp app.
const SIGNUP_RULE = '@request.body.email:isset = false && @request.body.email:isset = true';
const DEL_REQ = '__account_deletion__';
const PREFS = [
  ['language', 'Language', [['en', 'English'], ['af', 'Afrikaans'], ['zu', 'isiZulu'], ['xh', 'isiXhosa'], ['st', 'Sesotho'], ['tn', 'Setswana'], ['fr', 'Français'], ['es', 'Español'], ['pt', 'Português'], ['ar', 'العربية']]],
  ['currency', 'Currency', [['ZAR', 'ZAR – South African rand'], ['USD', 'USD – US dollar'], ['EUR', 'EUR – Euro'], ['GBP', 'GBP – Pound sterling'], ['AUD', 'AUD – Australian dollar'], ['CAD', 'CAD – Canadian dollar'], ['AED', 'AED – UAE dirham'], ['INR', 'INR – Indian rupee']]],
  ['timezone', 'Time zone', null],
  ['dateFormat', 'Date format', [['DD/MM/YYYY', '31/12/2026'], ['MM/DD/YYYY', '12/31/2026'], ['YYYY-MM-DD', '2026-12-31']]],
  ['timeFormat', 'Time format', [['24h', '24-hour (14:30)'], ['12h', '12-hour (2:30 pm)']]],
  ['units', 'Units', [['metric', 'Metric (km, kg, °C)'], ['imperial', 'Imperial (mi, lb, °F)']]],
  ['theme', 'Theme', [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']]],
];
async function viewMe() {
  const uid = state.uid;
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
      ${detected ? `<p class="muted small">Your device time zone: ${esc(detected)}</p>` : ''}<button class="btn primary">Save preferences</button></form></div>
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
    toast('Preferences saved');
  });
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
    <form id="pf-name" class="kv"><label>Name<input name="name" value="${esc(me.name || '')}" maxlength="80" autocomplete="name"></label><div><button class="btn primary small">Save name</button></div></form>
    <p class="muted small">Email: <b>${esc(state.actor)}</b></p>
    <h3>Change password</h3>
    <form id="pf-pass" class="kv"><label>Current password<input name="old" type="password" autocomplete="current-password" required></label><label>New password (min 8)<input name="pw" type="password" autocomplete="new-password" minlength="8" required></label><label>Confirm new password<input name="pw2" type="password" autocomplete="new-password" minlength="8" required></label><div><button class="btn primary small">Change password</button></div></form>
    <h3>Date of birth</h3>
    ${me.dob ? `<p>${esc(fmtDob(me.dob))}</p><p class="muted small">It can't be changed here. Ask an admin if it is wrong.</p>`
      : `<form id="pf-dob" class="kv"><p class="muted small">Every JoolzApp account has one. You can only enter it once. Under 18s need a parent or guardian's approval.</p><label>Date of birth<input name="dob" type="date" min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}" required></label>
        <label id="pf-dob-parent" hidden>Parent or guardian's JoolzApp email<input name="parent" type="email" autocomplete="off"></label><div><button class="btn primary small">Save date of birth</button></div></form>`}
    ${g.minor ? `<h3>Your parents</h3><p class="muted small">A parent approves your account and settings such as joining a family.</p>${g.parents.map((p) => `<div class="row spread"><span>${esc(p.name)}</span><span>${p.status === 'approved' ? 'approved' : p.status === 'pending' ? 'waiting' : 'declined'}</span></div>`).join('')}
      <form id="pf-parent" class="row" style="gap:6px;margin-top:8px"><input name="email" type="email" placeholder="Add another parent's email" required><button class="btn small">Add</button></form>` : ''}`;
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
  main().innerHTML = '<h1>Family</h1><p class="sub">Linked across every JoolzApp app.</p><div id="pane-family"><p class="muted">Loading…</p></div>';
  await familyPane(state.uid);
}

// Everyone has a date of birth. Accounts that pre-date it are asked once, before anything else.
async function needDob() {
  if (state.dobOk || !state.uid) return false;
  const me = await api('GET', `/api/collections/${state.usersColl}/records/${state.uid}`).catch(() => null);
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

async function familyPane(uid) {
  const box = $('#pane-family'); if (!box) return;
  let data; try { data = await acctFetch('/family'); } catch (e) { box.innerHTML = `<div class="card"><p class="muted">Families couldn't load: ${esc(e.message)}</p></div>`; return; }
  const f = data.family, inv = data.invites || [];
  const act = async (body) => { try { const j = await acctFetch('/family', body); if (j.notice) toast(j.notice); familyPane(uid); } catch (e) { toast(e.message, true); } };
  let h = inv.map((i) => `<div class="card"><b>${esc(i.ownerName || 'Someone')}</b> invited you to the <b>${esc(i.name)}</b> family.<div class="row" style="gap:8px;margin-top:8px"><button class="btn primary small" data-fa="yes" data-id="${esc(i.id)}">Join</button><button class="btn small" data-fa="no" data-id="${esc(i.id)}">Decline</button></div></div>`).join('');
  if (!f) h += `<div class="card"><h2>Family</h2><p class="muted small">Link up with your family on JoolzApp. The link works in every JoolzApp app. Immediate family can share joint expenses; extended family (cousins, grandparents…) are linked for future apps.</p>
    <form id="fam-new" class="row" style="gap:6px"><input name="name" placeholder="Family name (e.g. The Joolays)" maxlength="60" required><button class="btn primary">Create</button></form></div>`;
  else {
    const row = (m, pending) => `<div class="row spread" style="padding:6px 0;border-top:1px solid var(--line,#0002)"><span class="${pending ? 'muted' : ''}">${esc(m.name)}${m.relation ? ' · ' + esc(m.relation) : ''}${m.id === f.owner ? ' <span class="chip">creator</span>' : m.manager ? ' <span class="chip">manager</span>' : ''}${m.id === uid ? ' <span class="muted">(you)</span>' : ''}${pending ? ' · invited' : ''}</span>
      <span>${f.isOwner && m.id !== uid && !pending ? `<button class="btn small" data-fa="mgr" data-id="${esc(m.id)}" data-v="${m.manager ? '' : '1'}">${m.manager ? 'Remove manager' : 'Make manager'}</button> ` : ''}${f.canManage && m.id !== uid && m.id !== f.owner && !pending ? `<button class="btn small" data-fa="tier" data-id="${esc(m.id)}" data-v="${m.tier === 'extended' ? 'family' : 'extended'}">${m.tier === 'extended' ? 'Make immediate' : 'Make extended'}</button> ` : ''}${f.canManage && m.id !== uid && m.id !== f.owner && (f.isOwner || !m.manager) ? `<button class="btn small" data-fa="rm" data-id="${esc(m.id)}">${pending ? 'Cancel' : 'Remove'}</button>` : ''}</span></div>`;
    const grp = (t, title, note) => { const ms = f.members.filter((m) => m.tier === t), ps = f.invited.filter((m) => m.tier === t); return `<h3>${title}</h3><p class="muted small">${note}</p>${ms.map((m) => row(m, false)).join('')}${ps.map((m) => row(m, true)).join('')}${ms.length || ps.length ? '' : '<p class="muted small">Nobody yet.</p>'}`; };
    h += `<div class="card"><h2>${esc(f.name)}</h2>${f.myTier === 'extended' ? '<p class="muted small">You are linked as extended family. Family expenses are only shared with immediate family.</p>' : ''}
      ${grp('family', 'Immediate family', 'Shares joint expenses, such as family orders.')}${grp('extended', 'Extended family', 'Cousins, grandparents, aunts and uncles… linked for future apps.')}
      ${f.canManage ? `<form id="fam-inv" class="kv" style="margin-top:12px"><label>Invite by email (they don't need an account yet)<input name="email" type="email" required></label><label>Link as<select name="tier"><option value="family">Immediate family</option><option value="extended">Extended family</option></select></label><label>Relationship (optional)<input name="relation" maxlength="40" placeholder="cousin, grandmother…"></label><div><button class="btn primary small">Invite</button></div></form>` : ''}
      ${f.isOwner ? '<p class="muted small">Tip: make someone a manager and they can invite, remove and move members too.</p>' : ''}
      <p><button class="btn small" data-fa="leave">Leave this family</button></p></div>`;
  }
  box.innerHTML = h;
  if ($('#fam-new')) $('#fam-new').onsubmit = (e) => { e.preventDefault(); act({ action: 'create', name: e.target.name.value }); };
  if ($('#fam-inv')) $('#fam-inv').onsubmit = (e) => { e.preventDefault(); const f2 = e.target.elements; act({ action: 'invite', email: f2.email.value, tier: f2.tier.value, relation: f2.relation.value }); };
  box.onclick = (e) => {
    const b = e.target.closest('button[data-fa]'); if (!b) return; const a = b.dataset.fa, id = b.dataset.id, v = b.dataset.v;
    if (a === 'yes' || a === 'no') return act({ action: 'respond', familyId: id, accept: a === 'yes' });
    if (a === 'mgr') return act({ action: 'manager', memberId: id, on: !!v });
    if (a === 'tier') return act({ action: 'tier', memberId: id, tier: v });
    if (a === 'rm') return act({ action: 'remove', memberId: id });
    if (a === 'leave' && confirm('Leave this family? Orders already filed stay with the family.')) return act({ action: 'leave' });
  };
}

// The landing page: every JoolzApp app as a tile. Open goes to the app (signed in already where the app supports it);
// apps the person isn't approved for show a request form instead.
async function viewHome() {
  const uid = state.uid, isAdmin = state.role !== 'user';
  const [apps, reqs, acc] = await Promise.all([
    listAll('portal_apps', { sort: 'name' }),
    isAdmin ? Promise.resolve([]) : listAll('portal_requests', { filter: `user = ${fq(uid)}`, sort: '-created' }).catch(() => null),
    isAdmin ? Promise.resolve([]) : listAll('portal_settings', { filter: 'key = "portal.access"' }),
  ]);
  const ssoSlugs = new Set((await listAll('portal_settings', { filter: 'scope = "app" && key = "app.sso"' }).catch(() => [])).filter((r) => r.value === true).map((r) => r.app));
  const rank = (r) => r.scope === 'global' ? 0 : r.scope === 'app' ? 1 : (r.app ? 3 : 2);
  const allowed = (slug) => {
    if (isAdmin) return true;
    const rs = acc.filter((r) => r.scope === 'global' || (r.scope === 'app' && r.app === slug) || (r.scope === 'user' && (r.app === '' || r.app === slug))).sort((a, b) => rank(a) - rank(b));
    const last = rs[rs.length - 1]; return !(last && last.value === false);
  };
  const userRow = acc.find((r) => r.scope === 'user' && r.app === ''), globalBlock = acc.find((r) => r.scope === 'global' && r.value === false);
  const banner = isAdmin ? '' : userRow && userRow.value === false ? 'Your account access has been turned off. Contact the admin.' : (globalBlock && !userRow ? 'The admin approves access to each app separately. Request access to the apps you need below.' : '');
  const tile = (a) => {
    let body;
    if (!a.enabled) body = '<span class="chip bad">unavailable</span>';
    else if (allowed(a.slug)) {
      const open = /^https?:\/\//i.test(a.url || '') ? `<a class="btn primary" href="${esc(a.url)}" data-open="${esc(a.slug)}" target="_blank" rel="noopener">Open</a>` : '<span class="muted small">No address set yet</span>';
      body = `${a.maintenance ? `<span class="chip warn">maintenance</span> <span class="muted small">${esc(a.message || '')}</span>` : open}`;
    } else {
      const pend = reqs && reqs.find((r) => r.app === a.slug && r.status === 'pending'), denied = reqs && reqs.find((r) => r.app === a.slug && r.status === 'denied');
      body = reqs === null ? '<span class="muted small">Ask the admin for access</span>' : pend ? '<span class="chip warn">request pending</span>'
        : `<div class="req-row"><input data-msg="${esc(a.slug)}" placeholder="Why do you need it? (optional)" maxlength="300"><button class="btn small" data-req="${esc(a.slug)}">Request access</button></div>${denied ? '<div class="muted small">Your last request was denied.</div>' : ''}`;
    }
    return `<div class="tile${a.enabled ? '' : ' off'}"><div class="tile-head"><span class="tile-ic">${esc((a.name || '?').trim().charAt(0).toUpperCase())}</span><div><b>${esc(a.name)}</b>${a.description ? `<div class="muted small">${esc(a.description)}</div>` : ''}</div></div><div class="tile-body">${body}</div></div>`;
  };
  // Parents: approve kids' accounts and settings here. Kids: see who has been asked.
  const g = isAdmin ? null : await fetch('/guardians', { headers: { authorization: state.token }, cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fam = isAdmin ? null : await acctFetch('/family').catch(() => null);
  const famInv = fam && fam.invites && fam.invites.length ? `<div class="card"><b>You've been invited to a family.</b> <a href="#/family">Open the Family page</a> to join or decline.</div>` : '';
  const guardCard = (!g ? '' : [
    g.minor && g.parents.length ? `<div class="card"><b>Your account needs a parent's approval.</b> ${g.parents.map((p) => `${esc(p.name)}: ${p.status === 'approved' ? 'approved' : p.status === 'pending' ? 'waiting' : 'declined'}`).join(' · ')}</div>` : '',
    g.pending.length ? `<div class="card"><h2>Needs your approval</h2>${g.pending.map((x) => `<div class="row spread" style="padding:6px 0"><span>${esc(x.label)}</span><span><button class="btn primary small" data-gact="yes" data-id="${esc(x.id)}">Approve</button> <button class="btn small" data-gact="no" data-id="${esc(x.id)}">Decline</button></span></div>`).join('')}</div>` : '',
    g.kids.length ? `<div class="card"><h2>Kids you look after</h2>${g.kids.map((k) => `<div class="row spread" style="padding:6px 0"><span>${esc(k.childName)}</span><button class="btn small" data-gact="revoke" data-id="${esc(k.childId)}">Withdraw approval</button></div>`).join('')}</div>` : '',
  ].join('')) + famInv;
  main().innerHTML = `<h1>Dashboard</h1><p class="sub">${isAdmin ? 'This is the page your users see.' : 'All your JoolzApp apps in one place. One account works in every one.'}</p>
    ${banner ? `<div class="card"><span class="chip warn">${esc(banner)}</span></div>` : ''}${guardCard}
    <div class="tiles">${apps.map(tile).join('') || '<p class="muted">No apps have been added yet.</p>'}</div>`;
  bindOpen(main(), ssoSlugs);
  main().onclick = guard(async (e) => {
    const gb = e.target.closest('button[data-gact]');
    if (gb) {
      e.preventDefault();
      if (gb.dataset.gact === 'revoke' && !confirm('Withdraw your approval? They will be locked out of JoolzApp apps until a parent approves again.')) return;
      const body = gb.dataset.gact === 'revoke' ? { action: 'revoke', childId: gb.dataset.id } : { action: 'decide', id: gb.dataset.id, approve: gb.dataset.gact === 'yes' };
      const r = await fetch('/guardians', { method: 'POST', headers: { authorization: state.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'That did not work.');
      toast('Done'); return route();
    }
    const b = e.target.closest('button[data-req]'); if (!b) return; e.preventDefault();
    const slug = b.dataset.req; const msg = main().querySelector(`input[data-msg="${slug}"]`).value.trim();
    await api('POST', '/api/collections/portal_requests/records', { user: uid, email: state.actor, app: slug, message: msg, status: 'pending' });
    toast('Request sent'); route();
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
