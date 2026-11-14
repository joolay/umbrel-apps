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
  if (state.token) { try { await api('GET', '/api/collections/portal_apps/records?perPage=1').catch((e) => { if (e.status !== 404) throw e; }); return showShell(); } catch {} }
  showLogin();
}
function showLogin() { $('#shell').classList.add('hidden'); $('#reset').classList.add('hidden'); $('#signup').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function resetToken() { const m = location.hash.match(/^#\/(?:reset|auth\/confirm-password-reset)\/([^/?]+)/); return m ? decodeURIComponent(m[1]) : ''; }
$('#login-signup').onclick = (e) => { e.preventDefault(); $('#login').classList.add('hidden'); $('#signup').classList.remove('hidden'); $('#signup-err').textContent = ''; $('#signup-email').value = $('#login-email').value; $('#signup-email').focus(); };
$('#signup-cancel').onclick = (e) => { e.preventDefault(); showLogin(); };
$('#signup-form').onsubmit = async (e) => {
  e.preventDefault(); $('#signup-err').textContent = '';
  const email = $('#signup-email').value.trim(), password = $('#signup-pass').value;
  if (password !== $('#signup-pass2').value) { $('#signup-err').textContent = 'Passwords do not match.'; return; }
  try {
    const body = { email, password, passwordConfirm: password, emailVisibility: true };
    if ($('#signup-name').value.trim()) body.name = $('#signup-name').value.trim();
    try { await api('POST', `/api/collections/${state.usersColl}/records`, body); }
    catch (err) { throw new Error(err.status === 403 || err.status === 404 ? 'Sign-ups are currently closed. Ask the admin for an account.' : err.message); }
    Object.assign(state, await signIn(email, password));
    saveSession(false);
    ['#signup-pass', '#signup-pass2'].forEach((id) => { $(id).value = ''; });
    $('#signup').classList.add('hidden'); showShell();
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
function showShell() {
  $('#nav').innerHTML = state.role === 'user' ? '<a href="#/me" data-route="me">My settings</a>' : ADMIN_NAV;
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#who').textContent = state.actor; route();
}
const SESSION_KEYS = ['token', 'actor', 'role', 'uid'];
function saveSession(remember) { SESSION_KEYS.forEach((k) => { store.set('pa.' + k, state[k]); store.lset('pa.' + k, remember ? state[k] : null); }); }
function logout() { SESSION_KEYS.forEach((k) => { state[k] = ''; store.set('pa.' + k, null); store.lset('pa.' + k, null); }); state.role = 'admin'; showLogin(); }
async function signIn(identity, password) {
  try {
    const r = await api('POST', '/api/collections/_superusers/auth-with-password', { identity, password });
    return { token: r.token, actor: r.record.email, role: 'admin', uid: r.record.id };
  } catch (err) { if (![400, 401, 403].includes(err.status)) throw err; }
  const r = await api('POST', `/api/collections/${state.usersColl}/auth-with-password`, { identity, password });
  return { token: r.token, actor: r.record.email, role: 'user', uid: r.record.id };
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
  if (state.role === 'user') view = 'me';
  const v = { overview: viewOverview, global: viewGlobal, apps: viewApps, users: viewUsers, requests: viewRequests, audit: viewAudit, setup: viewSetup, me: viewMe }[view] || viewOverview;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
  main().innerHTML = '<p class="muted">Loading…</p>';
  guard(v)(arg ? decodeURIComponent(arg) : undefined);
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

async function viewApps(slug) {
  if (await needSetup()) return;
  return slug ? appDetail(slug) : appList();
}
async function appList() {
  const apps = await listAll('portal_apps', { sort: 'name' });
  main().innerHTML = `<div class="row spread"><div><h1>Apps</h1><p class="sub">Register each custom app so you can control it here.</p></div><button id="new" class="btn primary">+ Register app</button></div>
    <div class="card"><table><thead><tr><th>App</th><th>Status</th><th>URL</th></tr></thead><tbody>${apps.map((a) => `
      <tr class="click" data-slug="${esc(a.slug)}"><td><b>${esc(a.name)}</b><div class="muted small">${esc(a.slug)}</div></td>
      <td>${a.enabled ? '<span class="chip ok">enabled</span>' : '<span class="chip bad">disabled</span>'} ${a.maintenance ? '<span class="chip warn">maintenance</span>' : ''}</td>
      <td class="muted small">${esc(a.url)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No apps yet.</td></tr>'}</tbody></table></div>`;
  $('#new').onclick = () => { location.hash = '#/apps/__new'; };
  main().onclick = (e) => { const tr = e.target.closest('tr[data-slug]'); if (tr) location.hash = '#/apps/' + encodeURIComponent(tr.dataset.slug); };
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
      <label>URL<input name="url" type="url" value="${esc(rec.url)}"></label>
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
      <div class="row"><button class="btn primary">Save</button><button type="button" id="rs" class="btn">Send password reset email</button><button type="button" id="del" class="btn danger">Delete user</button></div></form>`;
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const body = { email: f.get('email'), verified: e.target.verified.checked }; if ('name' in u || f.get('name')) body.name = f.get('name');
      await api('PATCH', `/api/collections/${state.usersColl}/records/${id}`, body); await audit('user.update', id, body); toast('Saved');
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
const SIGNUP_RULE = '@request.body.isAdmin:isset = false';
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
  const [rows, apps, reqs, acc] = await Promise.all([
    listAll('portal_settings', { filter: `scope = "user" && user = ${fq(uid)} && app = "" && key ~ "pref."` }),
    listAll('portal_apps', { sort: 'name' }),
    listAll('portal_requests', { filter: `user = ${fq(uid)}`, sort: '-created' }).catch(() => null),
    listAll('portal_settings', { filter: 'key = "portal.access"' }),
  ]);
  const cur = Object.fromEntries(rows.map((r) => [r.key.slice(5), r]));
  let zones; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Africa/Johannesburg', 'UTC']; }
  const detected = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  const rank = (r) => r.scope === 'global' ? 0 : r.scope === 'app' ? 1 : (r.app ? 3 : 2);
  const allowed = (slug) => {
    const rs = acc.filter((r) => r.scope === 'global' || (r.scope === 'app' && r.app === slug) || (r.scope === 'user' && (r.app === '' || r.app === slug))).sort((a, b) => rank(a) - rank(b));
    const last = rs[rs.length - 1]; return !(last && last.value === false);
  };
  const delPend = (reqs || []).find((r) => r.app === DEL_REQ && r.status === 'pending'), delDenied = (reqs || []).find((r) => r.app === DEL_REQ && r.status === 'denied');
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const field = ([key, label, opts]) => {
    const v = cur[key] ? cur[key].value : '';
    const list = opts || zones.map((z) => [z, z]);
    return `<label>${esc(label)}<select name="${key}">${opt('', '— not set —', v === '')}${list.map(([val, l]) => opt(val, l, v === val)).join('')}</select></label>`;
  };
  const userRow = acc.find((r) => r.scope === 'user' && r.app === ''), globalBlock = acc.find((r) => r.scope === 'global' && r.value === false);
  const banner = userRow && userRow.value === false ? 'Your account access has been turned off. Contact the admin.' : (globalBlock && !userRow ? 'The admin approves access to each app separately. Request access to the apps you need below.' : '');
  main().innerHTML = `<h1>My settings</h1><p class="sub">Signed in as ${esc(state.actor)}. These preferences apply to every Joolzapp app you use.</p>
    ${banner ? `<div class="card"><span class="chip warn">${esc(banner)}</span></div>` : ''}
    <form id="prefs" class="card"><h2>Preferences</h2><div class="kv">${PREFS.map(field).join('')}</div>
      ${detected ? `<p class="muted small">Your device time zone: ${esc(detected)}</p>` : ''}<button class="btn primary">Save preferences</button></form>
    <div class="card"><h2>Joolzapp services</h2>${reqs === null ? '<p class="muted">Access requests are not set up yet. Ask the admin.</p>' : `<table><tbody>${apps.map((a) => {
      const pend = reqs.find((r) => r.app === a.slug && r.status === 'pending'), denied = reqs.find((r) => r.app === a.slug && r.status === 'denied');
      let right;
      if (!a.enabled) right = '<span class="chip bad">unavailable</span>';
      else if (allowed(a.slug)) right = '<span class="chip ok">access granted</span>';
      else if (pend) right = '<span class="chip warn">request pending</span>';
      else right = `<div class="req-row"><input data-msg="${esc(a.slug)}" placeholder="Why do you need it? (optional)" maxlength="300"><button class="btn small" data-req="${esc(a.slug)}">Request access</button></div>${denied ? '<div class="muted small">Your last request was denied.</div>' : ''}`;
      return `<tr><td><b>${esc(a.name)}</b>${a.description ? `<div class="muted small">${esc(a.description)}</div>` : ''}</td><td>${right}</td></tr>`;
    }).join('') || '<tr><td class="muted">No services registered yet.</td></tr>'}</tbody></table>`}</div>
    <div class="card"><h2>Delete my account</h2>${delPend
      ? `<p><span class="chip warn">deletion requested</span></p><p class="muted small">Sent ${esc(fmtDate(delPend.created))}. The admin will review it and confirm. Your account stays active until then.</p><button id="delcancel" class="btn">Cancel request</button>`
      : `<form id="del"><p class="muted small">This asks the admin to permanently delete your JoolzApp account and preferences from <b>every</b> Joolzapp app. Nothing is deleted until the admin confirms.</p>
      <div class="kv"><label>Type your email to confirm<input name="confirmText" autocomplete="off" required></label><label>Password<input name="pw" type="password" autocomplete="current-password" required></label></div>
      <label>Reason (optional)<input name="reason" maxlength="300"></label>
      <button class="btn danger">Request account deletion</button></form>`}${delDenied && !delPend ? '<p class="muted small">Your last deletion request was declined.</p>' : ''}</div>`;

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
  main().onclick = guard(async (e) => {
    const b = e.target.closest('button[data-req]'); if (!b) return; e.preventDefault();
    const slug = b.dataset.req; const msg = main().querySelector(`input[data-msg="${slug}"]`).value.trim();
    await api('POST', '/api/collections/portal_requests/records', { user: uid, email: state.actor, app: slug, message: msg, status: 'pending' });
    toast('Request sent'); route();
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

async function viewAudit() {
  if (await needSetup()) return;
  const r = await api('GET', '/api/collections/portal_audit/records?perPage=200&sort=-created');
  main().innerHTML = `<h1>Audit log</h1><p class="sub">Every change made through this panel.</p><div class="card"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${r.items.map((a) => `<tr><td class="small muted" style="white-space:nowrap">${esc(fmtDate(a.created))}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.target)}</td><td class="small"><code>${esc(JSON.stringify(a.detail))}</code></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No activity yet.</td></tr>'}</tbody></table></div>`;
}

async function viewSetup() {
  const st = await schemaStatus(); const cfg = await (await fetch('/config')).json();
  const uColl = await api('GET', `/api/collections/${state.usersColl}`).catch(() => null);
  // Harden: an open create rule with no guard would let anyone register themselves as an admin straight through PocketBase's API.
  if (uColl && uColl.createRule === '') { try { await api('PATCH', `/api/collections/${state.usersColl}`, { createRule: SIGNUP_RULE }); uColl.createRule = SIGNUP_RULE; } catch {} }
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
